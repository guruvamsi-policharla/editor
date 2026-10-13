/**
 * Being the terminal tact's UI runs in. tact (crossterm, ratatui-image) asks its terminal what it supports at start:
 * the kitty keyboard protocol (`CSI ? u`), kitty graphics (`APC G … a=q`), the cell size (`CSI 16t`), device status
 * (`CSI 5n`), each followed by primary device attributes (`CSI c`) as the sentinel every terminal answers. In the
 * hidden pty nobody answers, so tact waits for each query to time out (2 s on Linux), and on macOS it waited past
 * the adapter's 30 s start timeout. The adapter answers the way a plain VT220-class terminal would: DA1 without
 * sixel, no kitty protocols (the DA1 reply tells tact so), a fixed cell and window size, dark default colors.
 *
 * And keeping tact's terminal output readable for error messages: every escape sequence (CSI with private
 * parameters like `CSI > 7 u`, OSC, DCS, APC like the kitty graphics query, two-byte ESC sequences) is removed.
 */

/** One complete escape sequence: CSI, a string sequence (OSC, DCS, APC, PM, SOS) ended by ST or BEL, or ESC + final. */
const SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]P_^X][\s\S]*?(?:\x07|\x1b\\)|[ -/]*[0-OQ-WYZ\\`-~])/g;

/** An escape sequence that hasn't ended yet, at the end of the text. */
const PARTIAL = /\x1b(?:\[[0-?]*[ -/]*|[\]P_^X][\s\S]*|[ -/]*)$/;

/**
 * Terminal output → plain text: escape sequences removed (a sequence cut off at the end too), CR LF → LF, other
 * control characters dropped. Also the `^D` BSD script(1) echoed when its stdin ended (before the UI's first
 * escape sequence).
 */
export function stripAnsi(text: string): string {
	return text
		.replace(/\^D(?=\x1b)/g, '')
		.replace(SEQUENCE, '')
		.replace(PARTIAL, '')
		.replace(/\r+\n/g, '\n')
		.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

export interface TerminalSize {
	rows: number;
	cols: number;
}

/** The pty's size (set with stty before tact starts) and what the replies report. */
export const PTY_SIZE: TerminalSize = { rows: 48, cols: 160 };
const CELL = { height: 16, width: 8 };

/** The reply to one query, or undefined for output that isn't one (or a query a terminal may leave unanswered). */
export function reply(sequence: string, size: TerminalSize = PTY_SIZE): string | undefined {
	const csi = /^\x1b\[([0-?]*)([ -/]*)([@-~])$/.exec(sequence);
	if (csi) {
		const [, params, intermediates, final] = csi as unknown as [string, string, string, string];
		const query = `${params}${intermediates}${final}`;
		switch (query) {
			case 'c':
			case '0c':
				return '\x1b[?62;22c'; // DA1: VT220 with ANSI color, no sixel
			case '>c':
			case '>0c':
				return '\x1b[>1;10;0c'; // DA2
			case '5n':
				return '\x1b[0n'; // device status: OK
			case '6n':
				return '\x1b[1;1R'; // cursor position
			case '?6n':
				return '\x1b[?1;1;1R';
			case '14t':
				return `\x1b[4;${size.rows * CELL.height};${size.cols * CELL.width}t`; // text area in pixels
			case '16t':
				return `\x1b[6;${CELL.height};${CELL.width}t`; // cell size in pixels
			case '18t':
				return `\x1b[8;${size.rows};${size.cols}t`; // text area in cells
			case '>q':
			case '>0q':
				return '\x1bP>|tact-acp\x1b\\'; // XTVERSION
		}
		// DECRQM (`CSI ? 2026 $ p`): mode not recognized.
		const decrqm = /^(\??)(\d+)\$p$/.exec(query);
		if (decrqm) {
			return `\x1b[${decrqm[1]}${decrqm[2]};0$y`;
		}
		// `CSI ? u` (kitty keyboard flags) and the rest: the DA1 reply after it says "not supported".
		return undefined;
	}
	// OSC 10/11/12 color queries: light gray on dark gray.
	const osc = /^\x1b\](1[012]);\?(\x07|\x1b\\)$/.exec(sequence);
	if (osc) {
		const color = { 10: 'd4d4/d4d4/d4d4', 11: '1e1e/1e1e/1e1e', 12: 'd4d4/d4d4/d4d4' }[osc[1] as '10' | '11' | '12'];
		return `\x1b]${osc[1]};rgb:${color}${osc[2]}`;
	}
	// Kitty graphics query (`APC G … a=q …`): no reply; the DA1 reply after it says "not supported".
	return undefined;
}

/**
 * Answers the queries in a terminal's output stream. Output arrives in chunks that can split a sequence, so an
 * unfinished one is held until the next chunk (up to a few KB; a longer one is dropped).
 */
export class TerminalResponder {
	private pending = '';

	constructor(private readonly write: (data: string) => void, private readonly size: TerminalSize = PTY_SIZE) { }

	feed(chunk: string): void {
		const text = this.pending + chunk;
		this.pending = '';
		let replies = '';
		let end = 0;
		for (const m of text.matchAll(SEQUENCE)) {
			replies += reply(m[0], this.size) ?? '';
			end = m.index + m[0].length;
		}
		const partial = PARTIAL.exec(text.slice(end));
		if (partial && partial[0].length < 4096) {
			this.pending = partial[0];
		}
		if (replies) {
			this.write(replies);
		}
	}
}
