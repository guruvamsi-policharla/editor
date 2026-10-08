// Chat history for one workspace: an index of chats (harness, ACP session id, title, times) plus one transcript
// file per chat, in the extension's global storage under a hash of the folder. It outlives window reloads and
// app restarts; core's own cache of session items doesn't (each refresh replaces it with what the extension
// reports). No vscode import.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { matchChat, type TranscriptTurn } from './transcript.js';

export interface ChatEntry {
	/** The chat's resource (`agent-claude:/…`), as a string. */
	resource: string;
	/** The harness profile id. */
	harness: string;
	/** The ACP session behind the chat, once it has one. */
	sessionId?: string;
	title: string;
	created: number;
	updated: number;
	turns: number;
}

export interface SearchHit {
	entry: ChatEntry;
	/** Where the query matched in the chat's text ('' when it matched the title only). */
	snippet: string;
}

const INDEX = 'index.json';
/** Chats kept; the oldest beyond this are dropped. */
const MAX_CHATS = 500;

function safeName(resource: string): string {
	return `${resource.replace(/[^\w.-]+/g, '_').slice(0, 120)}.json`;
}

export class ChatHistory {
	private entries: ChatEntry[] | undefined;
	private readonly texts = new Map<string, string>();

	constructor(private readonly dir: string) { }

	private index(): ChatEntry[] {
		if (!this.entries) {
			try {
				this.entries = (JSON.parse(readFileSync(join(this.dir, INDEX), 'utf8')) as ChatEntry[]).filter(e => e && typeof e.resource === 'string');
			} catch {
				this.entries = [];
			}
		}
		return this.entries;
	}

	private write(name: string, data: unknown): void {
		mkdirSync(this.dir, { recursive: true });
		const tmp = join(this.dir, `.${name}.tmp`);
		writeFileSync(tmp, JSON.stringify(data));
		renameSync(tmp, join(this.dir, name));
	}

	/** Newest first. */
	list(harness?: string): ChatEntry[] {
		return this.index().filter(e => !harness || e.harness === harness).sort((a, b) => b.updated - a.updated);
	}

	get(resource: string): ChatEntry | undefined {
		return this.index().find(e => e.resource === resource);
	}

	bySession(harness: string, sessionId: string): ChatEntry | undefined {
		return this.index().find(e => e.harness === harness && e.sessionId === sessionId);
	}

	transcript(resource: string): TranscriptTurn[] | undefined {
		try {
			return (JSON.parse(readFileSync(join(this.dir, safeName(resource)), 'utf8')) as { turns: TranscriptTurn[] }).turns;
		} catch {
			return undefined;
		}
	}

	/** Saves the chat's entry and (when given) its transcript and searchable text. */
	save(entry: ChatEntry, turns?: readonly TranscriptTurn[], text?: string): void {
		const entries = this.index().filter(e => e.resource !== entry.resource);
		entries.push(entry);
		entries.sort((a, b) => b.updated - a.updated);
		for (const dropped of entries.splice(MAX_CHATS)) {
			this.remove(dropped.resource, false);
		}
		this.entries = entries;
		if (turns) {
			this.write(safeName(entry.resource), { turns, text: text ?? '' });
			this.texts.set(entry.resource, text ?? '');
		}
		this.write(INDEX, entries);
	}

	remove(resource: string, writeIndex = true): void {
		rmSync(join(this.dir, safeName(resource)), { force: true });
		this.texts.delete(resource);
		if (writeIndex) {
			this.entries = this.index().filter(e => e.resource !== resource);
			this.write(INDEX, this.entries);
		}
	}

	private text(resource: string): string {
		let text = this.texts.get(resource);
		if (text === undefined) {
			try {
				text = (JSON.parse(readFileSync(join(this.dir, safeName(resource)), 'utf8')) as { text?: string }).text ?? '';
			} catch {
				text = '';
			}
			this.texts.set(resource, text);
		}
		return text;
	}

	/** Chats whose title or text contains every word of the query, newest first. An empty query lists all. */
	search(query: string): SearchHit[] {
		const out: SearchHit[] = [];
		for (const entry of this.list()) {
			const snippet = query.trim() ? matchChat(query, entry.title, this.text(entry.resource)) : '';
			if (snippet !== undefined) {
				out.push({ entry, snippet });
			}
		}
		return out;
	}
}
