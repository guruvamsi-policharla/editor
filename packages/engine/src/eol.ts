/**
 * Line endings for text that came back from an editor buffer. Editors such as VS Code normalize a file's
 * line endings to one EOL in memory, so text they compute (e.g. a new baseline after keeping one hunk) loses
 * the per-line "\r\n" / "\n" of a file with mixed line endings. Comparing that text with the disk would turn
 * every line with the other ending into a change.
 */
import { diffRegions } from './diff/myers.js';
import { splitLines } from './text.js';

function eolOf(line: string): string {
  return line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '';
}

function stripEol(line: string): string {
  return line.slice(0, line.length - eolOf(line).length);
}

/**
 * Give each line of `text` the line ending of the line it matches (same content, ignoring the ending) in the
 * first source that has it, in order. Lines without a match, and a last line without a terminator, keep their
 * own. With one-EOL `text` and the sources it was derived from, this restores the original endings.
 */
export function restoreLineEndings(text: string, sources: readonly string[]): string {
  const lines = splitLines(text);
  const bare = lines.map(stripEol);
  const out: (string | undefined)[] = new Array(lines.length).fill(undefined);
  let missing = lines.length;
  for (const source of sources) {
    if (missing === 0) { break; }
    const srcLines = splitLines(source);
    let i = 0;
    let j = 0;
    const take = (iEnd: number) => {
      for (; i < iEnd; i++, j++) {
        if (out[i] !== undefined) { continue; }
        const own = eolOf(lines[i]!);
        const theirs = eolOf(srcLines[j]!);
        out[i] = own && theirs ? bare[i]! + theirs : lines[i]!;
        missing--;
      }
    };
    for (const r of diffRegions(bare, srcLines.map(stripEol))) {
      take(r.aStart);
      i = r.aEnd;
      j = r.bEnd;
    }
    take(lines.length);
  }
  return out.map((l, k) => l ?? lines[k]!).join('');
}

/** True if `a` and `b` differ at most in their line endings. */
export function equalIgnoringEol(a: string, b: string): boolean {
  return a === b || a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
}

/** The line ending used by every terminated line of `text`, or undefined if it has none or mixes them. */
export function uniformEol(text: string): '\n' | '\r\n' | undefined {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  if (lf === 0) { return undefined; }
  if (crlf === lf) { return '\r\n'; }
  return crlf === 0 ? '\n' : undefined;
}

/** `text` with every line ending replaced by `eol`. */
export function convertEol(text: string, eol: '\n' | '\r\n'): string {
  const lf = text.replace(/\r\n/g, '\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}
