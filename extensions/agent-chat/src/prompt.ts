// A chat request → ACP prompt content blocks. The text goes as typed (references like `@main.tex:L42-58`
// stay in it, in place, which every harness understands); each referenced file is also sent as a
// `resource_link` (inline ones in text order), which ACP requires every agent to accept. Pure, for unit tests.
import type { acp } from '@editor/acp-client';

export interface PromptReference {
	/** Absolute path of a referenced file. */
	path: string;
	startLine?: number;
	endLine?: number;
	/** Where an inline reference (a Cmd/Ctrl+L pill, `#file`) sits in the prompt text. */
	at?: number;
}

export interface PromptInput {
	prompt: string;
	/** A slash command core parsed out of the prompt (`/compact`). */
	command?: string;
	references: PromptReference[];
	/** Workspace root, to resolve `@relative/path` mentions in the text. */
	root?: string;
	/** Whether a path exists (mentions of files that don't are left as text only). */
	exists: (path: string) => boolean;
}

const MENTION = /(?:^|\s)@((?:[\w.\-/]|\\ )+?)(?::L(\d+)(?:-(\d+))?)?(?=[\s,;:)]|$)/g;

/** `@path`, `@path:L42`, `@path:L42-58` mentions in the prompt text, resolved against the workspace root. */
export function mentions(text: string, root: string | undefined, exists: (path: string) => boolean): PromptReference[] {
	const out: PromptReference[] = [];
	for (const m of text.matchAll(MENTION)) {
		const rel = m[1]!.replace(/\\ /g, ' ');
		const path = rel.startsWith('/') ? rel : root ? `${root.replace(/\/$/, '')}/${rel}` : undefined;
		if (path && exists(path)) {
			out.push({ path, ...(m[2] ? { startLine: Number(m[2]), endLine: Number(m[3] ?? m[2]) } : {}) });
		}
	}
	return out;
}

function fileUri(path: string): string {
	return `file://${path.split('/').map(encodeURIComponent).join('/')}`;
}

function linkName(ref: PromptReference, root: string | undefined): string {
	const rel = root && ref.path.startsWith(`${root.replace(/\/$/, '')}/`) ? ref.path.slice(root.replace(/\/$/, '').length + 1) : ref.path;
	if (!ref.startLine) {
		return rel;
	}
	return ref.endLine && ref.endLine !== ref.startLine ? `${rel}:L${ref.startLine}-${ref.endLine}` : `${rel}:L${ref.startLine}`;
}

export function promptBlocks(input: PromptInput): acp.ContentBlock[] {
	const text = input.command ? `/${input.command}${input.prompt ? ` ${input.prompt}` : ''}` : input.prompt;
	const blocks: acp.ContentBlock[] = [{ type: 'text', text }];
	const seen = new Set<string>();
	// Inline references in the order they appear in the text, then attached files and the active editor.
	const refs = [...input.references].sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
	for (const ref of [...refs, ...mentions(input.prompt, input.root, input.exists)]) {
		const name = linkName(ref, input.root);
		if (seen.has(name)) {
			continue;
		}
		seen.add(name);
		blocks.push({ type: 'resource_link', uri: fileUri(ref.path), name, ...(ref.startLine ? { description: `Lines ${ref.startLine}–${ref.endLine ?? ref.startLine}` } : {}) });
	}
	return blocks;
}
