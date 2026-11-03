import { describe, expect, it } from 'vitest';
import { EditLogs } from '../src/editLog';
import { formatReference, selectionLines } from '../src/reference';

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
    expect(selectionLines({ line: 41 }, { line: 58, character: 0 })).toEqual([42, 58]);
    expect(selectionLines({ line: 41 }, { line: 57, character: 3 })).toEqual([42, 58]);
    expect(selectionLines({ line: 9 }, { line: 9, character: 4 })).toEqual([10, 10]);
  });
  it('formats a whole-file reference without lines', () => {
    expect(formatReference('@${relativePath}', { relativePath: 'paper/main.tex', absolutePath: '/w/paper/main.tex' })).toBe('@paper/main.tex');
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

  it('attributes edits after the save-participant version to the formatter', () => {
    const logs = new EditLogs();
    logs.markClean('a');
    logs.onChange('a', [{ rangeOffset: 0, rangeLength: 0, text: 'x' }], true, 2);
    logs.onChange('a', [{ rangeOffset: 3, rangeLength: 1, text: ' ' }, { rangeOffset: 1, rangeLength: 0, text: ' ' }], true, 3);
    expect(logs.get('a', 2)!.map((e) => e.origin)).toEqual(['user', 'formatter', 'formatter']);
    expect(logs.get('a')!.map((e) => e.origin)).toEqual(['user', 'user', 'user']);
  });

  it('remembers the last clean text, and a hold ignores everything until the next save', () => {
    const logs = new EditLogs();
    logs.markClean('a', 'v1\n');
    expect(logs.cleanText('a')).toBe('v1\n');
    logs.onChange('a', [{ rangeOffset: 0, rangeLength: 0, text: 'x' }], true, 2);
    expect(logs.cleanText('a')).toBe('v1\n'); // still the text the edits started from
    logs.hold('a');
    expect(logs.get('a')).toBeUndefined();
    logs.onChange('a', [{ rangeOffset: 0, rangeLength: 3, text: 'v2\n' }], false, 3, 'v2\n'); // reload from disk
    logs.onChange('a', [{ rangeOffset: 0, rangeLength: 3, text: 'merged\n' }], true, 4); // the merge result
    expect(logs.get('a')).toBeUndefined();
    expect(logs.cleanText('a')).toBe('v2\n');
    logs.markClean('a', 'merged\n'); // saved
    expect(logs.get('a')).toEqual([]);
  });
});
