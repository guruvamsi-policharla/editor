// Chat history for one workspace: an index of chats (harness, ACP session id, title, times) plus one transcript
// file per chat, in the extension's global storage under a hash of the folder. It outlives window reloads and
// app restarts; core's own cache of session items doesn't (each refresh replaces it with what the extension
// reports). Several windows can share it (the same folder twice, or windows without a folder): each change is
// made to the index as it is on disk, and a list read after another window's change sees it. No vscode import.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
	/**
	 * The chat's own option values (mode, model, effort, …; ACP config option id → value), as its session last
	 * had them: a reopened chat shows them and gets them back (settings.ts). Missing in chats saved before.
	 */
	settings?: Record<string, string>;
}

export interface SearchHit {
	entry: ChatEntry;
	/** Where the query matched in the chat's text ('' when it matched the title only). */
	snippet: string;
}

const INDEX = 'index.json';
/** Agent sessions removed from history (`<harness>:<session id>`): not listed again from `session/list`. */
const REMOVED = 'removed.json';
const MAX_REMOVED = 2000;
/** Chats kept; the oldest beyond this are dropped. */
const MAX_CHATS = 500;

function safeName(resource: string): string {
	return `${resource.replace(/[^\w.-]+/g, '_').slice(0, 120)}.json`;
}

export class ChatHistory {
	private entries: ChatEntry[] | undefined;
	/** The index file as `entries` were read from it (another window's write changes it). */
	private entriesStamp = '';
	private removedIds: string[] | undefined;
	private removedStamp = '';
	private readonly texts = new Map<string, string>();
	/** Chats removed in this window: a turn still running in one doesn't save it again when it ends. */
	private readonly removedChats = new Set<string>();

	constructor(private readonly dir: string) { }

	private stamp(name: string): string {
		try {
			const s = statSync(join(this.dir, name));
			return `${s.ino}:${s.mtimeMs}:${s.size}`;
		} catch {
			return '';
		}
	}

	/** The index; read again when it changed on disk (`fresh`: always, before a change is written). */
	private index(fresh = false): ChatEntry[] {
		const stamp = this.stamp(INDEX);
		if (!this.entries || fresh || stamp !== this.entriesStamp) {
			try {
				this.entries = (JSON.parse(readFileSync(join(this.dir, INDEX), 'utf8')) as ChatEntry[]).filter(e => e && typeof e.resource === 'string');
			} catch {
				this.entries = [];
			}
			if (stamp !== this.entriesStamp) {
				this.texts.clear();
			}
			this.entriesStamp = stamp;
		}
		return this.entries;
	}

	private write(name: string, data: unknown): void {
		mkdirSync(this.dir, { recursive: true });
		const tmp = join(this.dir, `.${name}.${process.pid}.tmp`);
		writeFileSync(tmp, JSON.stringify(data));
		renameSync(tmp, join(this.dir, name));
	}

	private writeIndex(entries: ChatEntry[]): void {
		this.entries = entries;
		this.write(INDEX, entries);
		this.entriesStamp = this.stamp(INDEX);
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

	/** Saves the chat's entry and (when given) its transcript and searchable text. A removed chat isn't saved again. */
	save(entry: ChatEntry, turns?: readonly TranscriptTurn[], text?: string): void {
		if (this.removedChats.has(entry.resource)) {
			return;
		}
		const entries = this.index(true).filter(e => e.resource !== entry.resource);
		entries.push(entry);
		entries.sort((a, b) => b.updated - a.updated);
		for (const dropped of entries.splice(MAX_CHATS)) {
			this.remove(dropped.resource, false);
		}
		if (turns) {
			this.write(safeName(entry.resource), { turns, text: text ?? '' });
		}
		this.writeIndex(entries);
		if (turns) {
			this.texts.set(entry.resource, text ?? '');
		}
	}

	/** Updates a saved chat's settings (no-op for a chat that isn't saved yet). */
	saveSettings(resource: string, settings: Record<string, string>): void {
		this.update(resource, e => (JSON.stringify(e.settings) !== JSON.stringify(settings) ? { ...e, settings } : e));
	}

	/** A saved chat's new title (the agent's own, which comes after the turn it names is saved). */
	rename(resource: string, title: string): void {
		this.update(resource, e => (e.title !== title ? { ...e, title } : e));
	}

	private update(resource: string, change: (e: ChatEntry) => ChatEntry): void {
		const entries = this.index(true);
		const i = entries.findIndex(e => e.resource === resource);
		const changed = i >= 0 ? change(entries[i]!) : undefined;
		if (changed && changed !== entries[i]) {
			this.writeIndex(entries.map((e, j) => (j === i ? changed : e)));
		}
	}

	/**
	 * Removes a chat: its entry and transcript. Its agent session (when it has one) is remembered as removed, so the
	 * agent's own list (`session/list`, which still has it) doesn't bring it back.
	 */
	remove(resource: string, writeIndex = true): void {
		rmSync(join(this.dir, safeName(resource)), { force: true });
		this.texts.delete(resource);
		if (writeIndex) {
			this.removedChats.add(resource);
			const entries = this.index(true);
			const entry = entries.find(e => e.resource === resource);
			this.writeIndex(entries.filter(e => e.resource !== resource));
			if (entry?.sessionId) {
				this.forgetSession(entry.harness, entry.sessionId);
			}
		}
	}

	/** Remembers an agent session as removed from history (one the agent lists, or a removed chat's). */
	forgetSession(harness: string, sessionId: string): void {
		const id = `${harness}:${sessionId}`;
		const removed = this.removed(true);
		if (!removed.includes(id)) {
			this.removedIds = [...removed, id].slice(-MAX_REMOVED);
			this.write(REMOVED, this.removedIds);
			this.removedStamp = this.stamp(REMOVED);
		}
	}

	isRemoved(harness: string, sessionId: string): boolean {
		return this.removed().includes(`${harness}:${sessionId}`);
	}

	private removed(fresh = false): string[] {
		const stamp = this.stamp(REMOVED);
		if (!this.removedIds || fresh || stamp !== this.removedStamp) {
			try {
				this.removedIds = (JSON.parse(readFileSync(join(this.dir, REMOVED), 'utf8')) as unknown[]).filter((x): x is string => typeof x === 'string');
			} catch {
				this.removedIds = [];
			}
			this.removedStamp = stamp;
		}
		return this.removedIds;
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

/** A resource as a Uri or its components (what the sessions list's context menu passes). */
export interface ResourceLike {
	scheme: string;
	path: string;
	authority?: string;
	query?: string;
	fragment?: string;
}

/**
 * The chat the sessions list's context menu means. Core marshals `{ session: { resource }, $mid }`; the extension
 * host turns that into our ChatSessionItem (`resource`) when it finds the item, else passes it on as is (the
 * resource as URI components). A resource itself works too.
 */
export function menuTarget(arg: unknown): ResourceLike | undefined {
	const resource = (v: unknown): ResourceLike | undefined => (v && typeof v === 'object' && typeof (v as ResourceLike).scheme === 'string' && typeof (v as ResourceLike).path === 'string' ? v as ResourceLike : undefined);
	const a = (arg && typeof arg === 'object' ? arg : {}) as { resource?: unknown; session?: { resource?: unknown } };
	return resource(arg) ?? resource(a.resource) ?? resource(a.session?.resource);
}
