/**
 * Permission requests from the agent (`session/request_permission`).
 *
 * Rules:
 * - only an explicit answer from the user selects an option; the broker never picks one itself;
 * - with nobody to ask (no UI attached for the session), or on cancel, the answer is `cancelled`, as the spec requires;
 * - an answer must be one of the offered option ids;
 * - every decision is reported to the audit listeners.
 */
import type * as acp from '@agentclientprotocol/sdk';

export interface PermissionChoice {
	optionId: string;
	label: string;
	kind: acp.PermissionOptionKind;
	/** Set when choosing it writes a standing rule (shown next to the button). */
	persistent?: string;
}

export interface PermissionPrompt {
	sessionId: string;
	toolCallId: string;
	/** Short: "Run a command?", "Edit notes.txt?". */
	title: string;
	/** The exact command, when the tool runs one. */
	command?: string;
	/** Paths the tool touches. */
	paths: string[];
	/** What the agent says it's for (the tool input's `description`). */
	description?: string;
	toolKind?: acp.ToolKind;
	/** In button order: allow once, reject, then the "always" ones. */
	choices: PermissionChoice[];
}

const KIND_ORDER: Record<string, number> = { allow_once: 0, reject_once: 1, allow_always: 2, reject_always: 3 };

/**
 * Button order for the native confirmation, which shows the first button as primary, the second beside it and
 * the rest in a dropdown: Yes, No, then the "always" variants.
 */
export function orderChoices(options: readonly acp.PermissionOption[]): acp.PermissionOption[] {
	return [...options].sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9));
}

function str(v: unknown): string | undefined {
	return typeof v === 'string' && v.trim() ? v : undefined;
}

/** Where a harness's "always" answers are written, so the button can say so. */
export type PersistenceHint = (option: acp.PermissionOption, request: acp.RequestPermissionRequest) => string | undefined;

export function describePermission(request: acp.RequestPermissionRequest, persistence?: PersistenceHint): PermissionPrompt {
	const call = request.toolCall;
	const input = (call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {}) as Record<string, unknown>;
	const command = str(input.command) ?? (Array.isArray(input.command) ? input.command.join(' ') : undefined);
	const paths = [...new Set([
		...(call.locations ?? []).map(l => l.path),
		...['file_path', 'path', 'notebook_path'].map(k => str(input[k])).filter((p): p is string => !!p),
	])];
	const description = str(input.description) ?? (call.content ?? []).flatMap(c => (c.type === 'content' && c.content.type === 'text' ? [c.content.text] : []))[0];
	const title = command ? 'Run this command?'
		: call.kind === 'edit' || call.kind === 'delete' || call.kind === 'move' ? `${call.title ?? 'Edit files'}?`
			: call.kind === 'fetch' ? `${call.title ?? 'Fetch'}?`
				: `${call.title ?? 'Use a tool'}?`;
	return {
		sessionId: request.sessionId,
		toolCallId: call.toolCallId,
		title,
		...(command ? { command } : {}),
		paths,
		...(description && description !== command ? { description } : {}),
		...(call.kind ? { toolKind: call.kind } : {}),
		choices: orderChoices(request.options).map(o => {
			const persistent = persistence?.(o, request);
			return { optionId: o.optionId, label: o.name, kind: o.kind, ...(persistent ? { persistent } : {}) };
		}),
	};
}

/** Shows a prompt and returns the chosen option id, or undefined for dismissed/cancelled. */
export type PermissionAsker = (prompt: PermissionPrompt, signal: AbortSignal) => Promise<string | undefined>;

export interface PermissionAudit {
	at: Date;
	sessionId: string;
	toolCallId: string;
	title: string;
	command?: string;
	outcome: 'selected' | 'cancelled';
	optionId?: string;
	optionKind?: acp.PermissionOptionKind;
	reason?: 'no-ui' | 'dismissed' | 'cancelled' | 'invalid-answer';
}

export class PermissionBroker {
	private readonly askers = new Map<string, PermissionAsker>();
	private readonly pending = new Map<string, Set<AbortController>>();
	private readonly auditListeners = new Set<(a: PermissionAudit) => void>();

	constructor(private readonly persistence?: PersistenceHint) { }

	/** Attach the UI that answers this session's prompts (for the length of a turn). */
	setAsker(sessionId: string, asker: PermissionAsker): () => void {
		this.askers.set(sessionId, asker);
		return () => {
			if (this.askers.get(sessionId) === asker) {
				this.askers.delete(sessionId);
			}
		};
	}

	onAudit(listener: (a: PermissionAudit) => void): () => void {
		this.auditListeners.add(listener);
		return () => this.auditListeners.delete(listener);
	}

	pendingCount(sessionId: string): number {
		return this.pending.get(sessionId)?.size ?? 0;
	}

	/** Answer every open prompt of the session with `cancelled` (Stop, adapter exit). */
	cancelSession(sessionId: string): void {
		for (const ctrl of this.pending.get(sessionId) ?? []) {
			ctrl.abort();
		}
	}

	async handle(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
		const prompt = describePermission(request, this.persistence);
		const audit = (a: Omit<PermissionAudit, 'at' | 'sessionId' | 'toolCallId' | 'title' | 'command'>) => {
			const entry: PermissionAudit = { at: new Date(), sessionId: prompt.sessionId, toolCallId: prompt.toolCallId, title: prompt.title, ...(prompt.command ? { command: prompt.command } : {}), ...a };
			for (const listener of [...this.auditListeners]) {
				listener(entry);
			}
		};
		const cancelled = (reason: PermissionAudit['reason']): acp.RequestPermissionResponse => {
			audit({ outcome: 'cancelled', reason });
			return { outcome: { outcome: 'cancelled' } };
		};

		const asker = this.askers.get(request.sessionId);
		if (!asker) {
			return cancelled('no-ui');
		}
		const ctrl = new AbortController();
		let set = this.pending.get(request.sessionId);
		if (!set) {
			set = new Set();
			this.pending.set(request.sessionId, set);
		}
		set.add(ctrl);
		try {
			const aborted = new Promise<'aborted'>(resolve => ctrl.signal.addEventListener('abort', () => resolve('aborted'), { once: true }));
			const answer = await Promise.race([asker(prompt, ctrl.signal).catch(() => undefined), aborted]);
			if (answer === 'aborted' || ctrl.signal.aborted) {
				return cancelled('cancelled');
			}
			if (answer === undefined) {
				return cancelled('dismissed');
			}
			const option = request.options.find(o => o.optionId === answer);
			if (!option) {
				return cancelled('invalid-answer');
			}
			audit({ outcome: 'selected', optionId: option.optionId, optionKind: option.kind });
			return { outcome: { outcome: 'selected', optionId: option.optionId } };
		} finally {
			set.delete(ctrl);
			if (!set.size) {
				this.pending.delete(request.sessionId);
			}
		}
	}
}
