/** Formatting of the `@path:L42-58` reference that Ctrl/Cmd+L sends to the agent terminal or chat. */

export interface SelectionInfo {
  relativePath: string;
  absolutePath: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
}

export function formatReference(format: string, s: SelectionInfo): string {
  const range = s.startLine === s.endLine ? `L${s.startLine}` : `L${s.startLine}-${s.endLine}`;
  const values: Record<string, string> = {
    relativePath: s.relativePath,
    absolutePath: s.absolutePath,
    range,
    startLine: String(s.startLine),
    endLine: String(s.endLine),
  };
  return format.replace(/\$\{(\w+)\}/g, (m, name: string) => values[name] ?? m);
}

/** The selected text as a bracketed paste, so TUIs take newlines literally instead of submitting. */
export function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

/**
 * Line range for a selection: a selection ending at column 1 of the next line (a full-line selection)
 * doesn't include that line.
 */
export function selectionLines(start: { line: number }, end: { line: number; character: number }, isEmpty: boolean): [number, number] {
  const first = start.line + 1;
  let last = end.line + 1;
  if (!isEmpty && end.character === 0 && end.line > start.line) { last -= 1; }
  return [first, last];
}

export type AgentTarget = 'auto' | 'terminal' | 'chat';

/**
 * Where Ctrl/Cmd+L sends the reference. `auto`: whichever of the agent terminal and the agent chat was used last
 * (timestamps; the chat's comes from agent-chat), else the terminal.
 */
export function chooseTarget(setting: AgentTarget | undefined, last: { terminal?: number; chat?: number }): 'terminal' | 'chat' {
  if (setting === 'terminal' || setting === 'chat') { return setting; }
  return last.chat !== undefined && (last.terminal === undefined || last.chat > last.terminal) ? 'chat' : 'terminal';
}
