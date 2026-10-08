/**
 * Which workspace paths are reviewable.
 *
 * Precedence, lowest to highest (a later decisive match wins, like git):
 *   1. built-in defaults (build dirs, LaTeX artifacts, the build-output PDF next to a .tex)
 *   2. `.git/info/exclude` of the enclosing repository
 *   3. `.gitignore` files from the workspace root down to the path's directory
 *   4. the user's configured patterns
 * A path inside an ignored directory is ignored, whatever deeper rules say.
 * `.git` directories and the engine's own storage are always ignored.
 */
import ignore, { type Ignore } from 'ignore';
import * as path from 'node:path';
import type { FileSystem } from './fs.js';

/** LaTeX auxiliary file patterns from PLAN.md §5.1. */
export const LATEX_ARTIFACT_PATTERNS = [
  '*.aux',
  '*.log',
  '*.out',
  '*.toc',
  '*.bbl',
  '*.blg',
  '*.fls',
  '*.fdb_latexmk',
  '*.synctex.gz',
  '*.synctex(busy)',
];

/** Dependency and build-output directories. */
export const BUILD_DIR_PATTERNS = [
  'node_modules/',
  'dist/',
  'build/',
  'out/',
  'target/',
  '.next/',
  '__pycache__/',
  'coverage/',
];

export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [...BUILD_DIR_PATTERNS, ...LATEX_ARTIFACT_PATTERNS];

export interface IgnoreOptions {
  /** Respect `.gitignore` files and `.git/info/exclude`. Default true. */
  useGitignore?: boolean;
  /** Apply DEFAULT_IGNORE_PATTERNS and the LaTeX output-PDF rule. Default true. */
  useDefaults?: boolean;
  /** Extra gitignore-syntax patterns, relative to the workspace root. Highest precedence (`!pattern` re-includes). */
  patterns?: readonly string[];
}

type Verdict = boolean | undefined; // true = ignored, false = explicitly re-included, undefined = no opinion

export class IgnoreRules {
  private readonly defaults: Ignore;
  private readonly user: Ignore;
  private infoExclude: Ignore | null | undefined;
  /** dir (workspace-relative, '' for root) -> parsed .gitignore, or null if none. */
  private gitignores = new Map<string, Ignore | null>();
  private readonly useGitignore: boolean;
  private readonly useDefaults: boolean;

  constructor(
    private readonly fs: FileSystem,
    /** Real path of the workspace root. */
    private readonly root: string,
    options: IgnoreOptions = {},
    /** Absolute paths that are always excluded (engine storage, nested workspace roots). */
    private readonly excludedDirs: readonly string[] = [],
    /** Path of the enclosing repository's info/exclude file, if any. */
    private readonly infoExcludePath?: string,
  ) {
    this.useGitignore = options.useGitignore ?? true;
    this.useDefaults = options.useDefaults ?? true;
    this.defaults = ignore().add(this.useDefaults ? [...DEFAULT_IGNORE_PATTERNS] : []);
    this.user = ignore().add([...(options.patterns ?? [])]);
    this.patterns = [...(options.patterns ?? [])];
  }

  readonly patterns: readonly string[];

  /** Forget cached .gitignore contents (all, or for one directory). */
  invalidate(dirRel?: string): void {
    if (dirRel === undefined) {
      this.gitignores.clear();
      this.infoExclude = undefined;
    } else { this.gitignores.delete(dirRel); }
  }

  /** Is `rel` (posix, workspace-relative) ignored? Checks ancestors too. */
  async isIgnored(rel: string, isDir = false): Promise<boolean> {
    if (rel === '' || rel === '.') { return false; }
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (await this.isIgnoredSelf(parts.slice(0, i).join('/'), true)) { return true; }
    }
    return this.isIgnoredSelf(rel, isDir);
  }

  /** Ignore check for `rel` itself, assuming its ancestors are not ignored. */
  async isIgnoredSelf(rel: string, isDir: boolean): Promise<boolean> {
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    if (base === '.git') { return true; }
    const abs = path.join(this.root, ...rel.split('/'));
    for (const dir of this.excludedDirs) {
      if (abs === dir || abs.startsWith(dir + path.sep)) { return true; }
    }

    let verdict: Verdict;
    const apply = (v: Verdict) => {
      if (v !== undefined) { verdict = v; }
    };
    const probe = isDir ? `${rel}/` : rel;

    if (this.useDefaults) {
      apply(test(this.defaults, probe));
      if (!isDir && (await this.isLatexOutputPdf(rel))) { verdict = true; }
    }
    if (this.useGitignore) {
      apply(test(await this.loadInfoExclude(), probe));
      const parts = rel.split('/');
      for (let i = 0; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        const ig = await this.loadGitignore(dir);
        if (!ig) { continue; }
        const sub = parts.slice(i).join('/');
        apply(test(ig, isDir ? `${sub}/` : sub));
      }
    }
    apply(test(this.user, probe));
    return verdict === true;
  }

  /** `foo.pdf` is a build artifact when `foo.tex` sits next to it. */
  async isLatexOutputPdf(rel: string): Promise<boolean> {
    if (!/\.pdf$/i.test(rel)) { return false; }
    const texRel = rel.replace(/\.pdf$/i, '.tex');
    const st = await this.fs.stat(path.join(this.root, ...texRel.split('/')));
    return st?.type === 'file';
  }

  private async loadGitignore(dir: string): Promise<Ignore | null> {
    if (this.gitignores.has(dir)) { return this.gitignores.get(dir)!; }
    const file = path.join(this.root, ...(dir ? dir.split('/') : []), '.gitignore');
    const ig = await this.readIgnoreFile(file);
    this.gitignores.set(dir, ig);
    return ig;
  }

  private async loadInfoExclude(): Promise<Ignore | null> {
    if (this.infoExclude !== undefined) { return this.infoExclude; }
    this.infoExclude = this.infoExcludePath ? await this.readIgnoreFile(this.infoExcludePath) : null;
    return this.infoExclude;
  }

  private async readIgnoreFile(file: string): Promise<Ignore | null> {
    const st = await this.fs.stat(file);
    if (st?.type !== 'file') { return null; }
    const text = new TextDecoder().decode(await this.fs.readFile(file));
    return ignore().add(text);
  }
}

/**
 * One matcher's verdict on `probe` itself. The `ignore` package also reports a
 * path as ignored when one of its parent directories matches; those inherited
 * verdicts were already weighed (against higher-precedence matchers) when the
 * ancestor directory itself was checked, so they count as "no opinion" here.
 */
function test(ig: Ignore | null, probe: string): Verdict {
  if (!ig) { return undefined; }
  const r = ig.test(probe);
  if (r.ignored) {
    const parts = probe.replace(/\/$/, '').split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = ig.test(`${parts.slice(0, i).join('/')}/`);
      if (parent.ignored && parent.rule?.pattern === r.rule?.pattern) { return undefined; }
    }
    return true;
  }
  if (r.unignored) { return false; }
  return undefined;
}
