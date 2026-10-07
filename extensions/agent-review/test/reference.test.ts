import { describe, expect, it } from 'vitest';
import { EditLogs } from '../src/editLog';
import { bracketedPaste, formatReference, selectionLines } from '../src/reference';

describe('Ctrl/Cmd+L reference', () => {
  const sel = { relativePath: 'paper/main.tex', absolutePath: '/w/paper/main.tex', startLine: 42, endLine: 58 };
  it('formats the default @path:L42-58', () => {
    expect(formatReference('@${relativePath}:${range}', sel)).toBe('@paper/main.tex:L42-58');
    expect(formatReference('@${relativePath}:${range}', { ...sel, endLine: 42 })).toBe('@paper/main.tex:L42');
  });
  it('supports the other placeholders and leaves unknown ones', () => {
    expect(formatReference('${absolutePath}#${startLine}-${endLine} ${nope}', sel)).toBe('/w/paper/main.tex#42-58 ${nope}');
  });
  it('excludes the next line for a full-line selection', () => {
    expect(selectionLines({ line: 41 }, { line: 58, character: 0 }, false)).toEqual([42, 58]);
    expect(selectionLines({ line: 41 }, { line: 57, character: 3 }, false)).toEqual([42, 58]);
    expect(selectionLines({ line: 9 }, { line: 9, character: 0 }, true)).toEqual([10, 10]);
  });
  it('wraps text as a bracketed paste', () => {
    expect(bracketedPaste('a\nb')).toBe('\x1b[200~a\nb\x1b[201~');
  });
});

describe('EditLogs', () => {
  it('logs edits from a clean start and restarts when the buffer matches the disk', () => {
    const logs = new EditLogs();
    expect(logs.get('a')).toBeUndefined();
    logs.onChange('a', [{ rangeOffset: 0, rangeLength: 0, text: 'x' }], true);
    expect(logs.get('a')).toBeUndefined(); // never saw it clean
    logs.markClean('a');
    logs.onChange('a', [{ rangeOffset: 0, rangeLength: 0, text: 'x' }], true);
    expect(logs.get('a')).toEqual([{ offset: 0, length: 0, text: 'x', origin: 'user' }]);
    logs.onChange('a', [{ rangeOffset: 0, rangeLength: 5, text: 'agent' }], false); // reload from disk
    expect(logs.get('a')).toEqual([]);
  });
});
