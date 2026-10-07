/**
 * Text helpers. Lines always keep their terminator ("\n" or "\r\n"), so
 * `joinLines(splitLines(s)) === s` for every string, including files without a
 * trailing newline and files with mixed line endings.
 */

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Split text into lines, keeping each line's terminator. `""` has zero lines. */
export function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) break;
    lines.push(text.slice(start, nl + 1));
    start = nl + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

export function joinLines(lines: readonly string[]): string {
  return lines.join('');
}

/** Bytes git inspects when guessing binary-ness. */
const BINARY_SNIFF_BYTES = 8000;

/**
 * A file is binary if it has a NUL byte in its first 8000 bytes (git's
 * heuristic) or if it isn't valid UTF-8 (so decoding/re-encoding it would not
 * round-trip and hunk-level edits could corrupt it).
 */
export function isBinary(data: Uint8Array): boolean {
  const n = Math.min(data.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (data[i] === 0) return true;
  return decodeText(data) === undefined;
}

/** Strict UTF-8 decode that preserves a BOM. Returns undefined on invalid UTF-8. */
export function decodeText(data: Uint8Array): string | undefined {
  try {
    return strictDecoder.decode(data);
  } catch {
    return undefined;
  }
}

export function encodeText(text: string): Uint8Array {
  return encoder.encode(text);
}

export function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? encodeText(content) : content;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
