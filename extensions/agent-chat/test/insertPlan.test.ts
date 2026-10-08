import { describe, expect, it } from 'vitest';
import { referenceInsertionOffset, referencePrefix } from '../../../fork/src/vs/workbench/contrib/agentChat/browser/insertPlan.ts';

const first = '@sections/intro.tex:L2 ';
const pill = [{ start: 0, end: first.indexOf(' ') }]; // the reference, not the trailing space

describe('inline reference insertion', () => {
  it('does not splice a second reference into the first pill', () => {
    // Caret on the colon of `@sections/intro.tex:L2`, which is inside the pill.
    const cursor = first.indexOf(':');
    const at = referenceInsertionOffset(first, cursor, pill);
    const prefix = referencePrefix(first, at);
    const second = '@sections/intro.tex:L6-7';
    const next = first.slice(0, at) + prefix + second + ' ' + first.slice(at);
    expect(next).toBe('@sections/intro.tex:L2 @sections/intro.tex:L6-7 ');
    expect(next).not.toContain('ections/intro.tex:L6-7 :L2');
  });

  it('inserts after the pill when the caret is already past it', () => {
    const at = referenceInsertionOffset(first, first.length, pill);
    expect(at).toBe(first.length);
    expect(referencePrefix(first, at)).toBe('');
  });

  it('keeps a caret that is between pills where it is', () => {
    const line = 'in this part @main.tex:L7-8 fold in this argument ';
    const start = line.indexOf('@');
    const end = line.indexOf(' ', start);
    const cursor = line.indexOf('fold');
    expect(referenceInsertionOffset(line, cursor, [{ start, end }])).toBe(cursor);
    expect(referencePrefix(line, cursor)).toBe('');
  });
});
