import { describe, expect, it } from 'vitest';
import { IgnoreRules } from '../src/ignore.js';
import { memWorkspace, ROOT } from './helpers.js';

function rules(files: Record<string, string>, opts = {}, excluded: string[] = []) {
  const ws = memWorkspace(files);
  return new IgnoreRules(ws.fs, ROOT, opts, excluded);
}

describe('IgnoreRules defaults', () => {
  const r = rules({ 'paper/main.tex': '', 'paper/main.pdf': '', 'paper/figs/plot.pdf': '', 'notes.pdf': '' });

  it.each([
    ['node_modules/pkg/index.js', true],
    ['packages/a/node_modules/x.js', true],
    ['dist/out.js', true],
    ['build/x', true],
    ['paper/main.aux', true],
    ['paper/main.log', true],
    ['paper/main.out', true],
    ['paper/main.toc', true],
    ['paper/main.bbl', true],
    ['paper/main.blg', true],
    ['paper/main.fls', true],
    ['paper/main.fdb_latexmk', true],
    ['paper/main.synctex.gz', true],
    ['.git/config', true],
    ['sub/.git', true],
    ['paper/main.tex', false],
    ['src/index.ts', false],
    // Claude Code's "always allow" answers, not agent edits
    ['.claude/settings.local.json', true],
    ['sub/project/.claude/settings.local.json', true],
    ['.claude/settings.json', false],
    ['.claude/commands/review.md', false],
  ])('%s ignored=%s', async (p, expected) => {
    expect(await r.isIgnored(p)).toBe(expected);
  });

  it('ignores only the build-output PDF next to a .tex file', async () => {
    expect(await r.isIgnored('paper/main.pdf')).toBe(true);
    expect(await r.isIgnored('paper/figs/plot.pdf')).toBe(false);
    expect(await r.isIgnored('notes.pdf')).toBe(false);
  });

  it('a user pattern can re-include .claude/settings.local.json', async () => {
    const r2 = rules({}, { patterns: ['!.claude/settings.local.json'] });
    expect(await r2.isIgnored('.claude/settings.local.json')).toBe(false);
  });

  it('can turn defaults off', async () => {
    const r2 = rules({ 'a.tex': '' }, { useDefaults: false });
    expect(await r2.isIgnored('dist/x.js')).toBe(false);
    expect(await r2.isIgnored('a.pdf')).toBe(false);
  });
});

describe('IgnoreRules .gitignore', () => {
  it('respects root and nested .gitignore files with negation', async () => {
    const r = rules({
      '.gitignore': '*.tmp\nsecret/\n',
      'sub/.gitignore': '!keep.tmp\nlocal.txt\n',
    });
    expect(await r.isIgnored('a.tmp')).toBe(true);
    expect(await r.isIgnored('sub/x.tmp')).toBe(true);
    expect(await r.isIgnored('sub/keep.tmp')).toBe(false);
    expect(await r.isIgnored('sub/local.txt')).toBe(true);
    expect(await r.isIgnored('local.txt')).toBe(false);
    expect(await r.isIgnored('secret/a.txt')).toBe(true);
  });

  it('cannot re-include a file inside an ignored directory', async () => {
    const r = rules({ '.gitignore': 'logs/\n!logs/keep.txt\n' });
    expect(await r.isIgnored('logs/keep.txt')).toBe(true);
  });

  it('lets a .gitignore re-include a default-ignored directory', async () => {
    const r = rules({ '.gitignore': '!build/\n' });
    expect(await r.isIgnored('build/x.c')).toBe(false);
  });

  it('can be disabled', async () => {
    const r = rules({ '.gitignore': '*.tmp\n' }, { useGitignore: false });
    expect(await r.isIgnored('a.tmp')).toBe(false);
  });
});

describe('IgnoreRules user config', () => {
  it('adds patterns with the highest precedence', async () => {
    const r = rules({ '.gitignore': '!*.keep\n' }, { patterns: ['drafts/', '*.keep', '!out/'] });
    expect(await r.isIgnored('drafts/a.md')).toBe(true);
    expect(await r.isIgnored('x.keep')).toBe(true);
    expect(await r.isIgnored('out/report.txt')).toBe(false); // user re-included a default
  });

  it('always excludes configured directories (engine storage, nested roots)', async () => {
    const r = rules({}, {}, ['/ws/.review']);
    expect(await r.isIgnored('.review/state.json')).toBe(true);
    expect(await r.isIgnored('.reviewer/x')).toBe(false);
  });
});
