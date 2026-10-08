/**
 * Myers O((N+M)D) diff over arbitrary sequences.
 *
 * The result is a list of change *regions*: maximal runs where `a[aStart,aEnd)`
 * was replaced by `b[bStart,bEnd)`. Everything between regions is equal and
 * pairs up in order. Regions are sorted and never adjacent (at least one equal
 * element separates two regions), which is exactly the "line-sized hunk" shape.
 */

export interface Region {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

export interface DiffOptions {
  /**
   * Upper bound on the edit distance explored before giving up and reporting
   * the (prefix/suffix-trimmed) middle as a single region. Keeps memory bounded
   * on pathological inputs. Default 4000.
   */
  maxEditDistance?: number;
}

const DEFAULT_MAX_D = 4000;

/** Diff two sequences of strings (e.g. lines or tokens). */
export function diffRegions(a: readonly string[], b: readonly string[], options: DiffOptions = {}): Region[] {
  // Intern values to small integers so the inner loop compares numbers.
  const ids = new Map<string, number>();
  const intern = (s: string): number => {
    let id = ids.get(s);
    if (id === undefined) {
      id = ids.size;
      ids.set(s, id);
    }
    return id;
  };
  const ai = Int32Array.from(a, intern);
  const bi = Int32Array.from(b, intern);
  return diffInts(ai, bi, options.maxEditDistance ?? DEFAULT_MAX_D);
}

function diffInts(a: Int32Array, b: Int32Array, maxD: number): Region[] {
  const n = a.length;
  const m = b.length;
  // Trim common prefix and suffix; Myers only runs on the middle.
  let pre = 0;
  while (pre < n && pre < m && a[pre] === b[pre]) { pre++; }
  let suf = 0;
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) { suf++; }
  const A = a.subarray(pre, n - suf);
  const B = b.subarray(pre, m - suf);
  if (A.length === 0 && B.length === 0) { return []; }
  if (A.length === 0 || B.length === 0) {
    return [{ aStart: pre, aEnd: pre + A.length, bStart: pre, bEnd: pre + B.length }];
  }

  const N = A.length;
  const M = B.length;
  const max = N + M;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  const limit = Math.min(max, maxD);

  outer: for (let d = 0; d <= limit; d++) {
    // Snapshot of v as it was *before* step d, restricted to k in [-d-1, d+1].
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) { x = v[offset + k + 1]!; }
      else { x = v[offset + k - 1]! + 1; }
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= N && y >= M) {
        found = d;
        break outer;
      }
    }
  }

  if (found < 0) {
    // Too expensive: report the whole middle as one region.
    return [{ aStart: pre, aEnd: pre + N, bStart: pre, bEnd: pre + M }];
  }

  // Backtrack to mark deleted (A) and inserted (B) elements.
  const del = new Uint8Array(N);
  const ins = new Uint8Array(M);
  let x = N;
  let y = M;
  for (let d = found; d > 0; d--) {
    const snap = trace[d]!; // state before step d; index k maps to snap[k + d + 1]
    const get = (k: number): number => snap[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
    }
    if (x === prevX) { ins[prevY] = 1; }
    else { del[prevX] = 1; }
    x = prevX;
    y = prevY;
  }

  const regions: Region[] = [];
  let i = 0;
  let j = 0;
  while (i < N || j < M) {
    if (i < N && j < M && !del[i] && !ins[j]) {
      i++;
      j++;
      continue;
    }
    const i0 = i;
    const j0 = j;
    for (;;) {
      const i1 = i;
      const j1 = j;
      while (i < N && del[i]) { i++; }
      while (j < M && ins[j]) { j++; }
      if (i === i1 && j === j1) { break; }
    }
    regions.push({ aStart: pre + i0, aEnd: pre + i, bStart: pre + j0, bEnd: pre + j });
  }
  return regions;
}

/** Replace `a`'s side of the given regions with `b`'s side (i.e. apply them to `a`). */
export function applyRegions<T>(a: readonly T[], b: readonly T[], regions: readonly Region[]): T[] {
  const out: T[] = [];
  let pos = 0;
  for (const r of regions) {
    for (let i = pos; i < r.aStart; i++) { out.push(a[i]!); }
    for (let j = r.bStart; j < r.bEnd; j++) { out.push(b[j]!); }
    pos = r.aEnd;
  }
  for (let i = pos; i < a.length; i++) { out.push(a[i]!); }
  return out;
}

/** Replace `b`'s side of the given regions with `a`'s side (i.e. revert them in `b`). */
export function revertRegions<T>(a: readonly T[], b: readonly T[], regions: readonly Region[]): T[] {
  const out: T[] = [];
  let pos = 0;
  for (const r of regions) {
    for (let j = pos; j < r.bStart; j++) { out.push(b[j]!); }
    for (let i = r.aStart; i < r.aEnd; i++) { out.push(a[i]!); }
    pos = r.bEnd;
  }
  for (let j = pos; j < b.length; j++) { out.push(b[j]!); }
  return out;
}
