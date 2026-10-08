/**
 * The protocol-neutral session view model and the ACP v1 reducer that feeds it. Every `session/update` kind is
 * handled; unknown kinds (a newer protocol, `_`-prefixed extensions) are counted and ignored, never thrown on.
 * A v2 reducer can feed the same model later.
 *
 * `apply` returns what changed, so a UI that can only append (VS Code's chat stream) knows what to render.
 */
import type * as acp from '@agentclientprotocol/sdk';

export type Role = 'user' | 'agent' | 'thought';

export interface TextEntry {
	type: 'text';
	role: Role;
	messageId?: string;
	text: string;
}

export interface ToolEntry {
	type: 'tool';
	id: string;
}

export type Entry = TextEntry | ToolEntry;

export interface ToolCallView {
	id: string;
	title: string;
	kind: acp.ToolKind;
	status: acp.ToolCallStatus;
	/** The programmatic tool name (`Bash`, `Edit`), when the agent says. */
	name?: string;
	content: acp.ToolCallContent[];
	locations: acp.ToolCallLocation[];
	rawInput?: unknown;
	rawOutput?: unknown;
}

export interface PlanItem {
	content: string;
	priority: acp.PlanEntryPriority;
	status: acp.PlanEntryStatus;
}

export interface UsageView {
	used: number;
	size: number;
	cost?: { amount: number; currency: string };
}

export interface SessionViewState {
	entries: Entry[];
	toolCalls: Map<string, ToolCallView>;
	plan: PlanItem[];
	commands: acp.AvailableCommand[];
	modeId?: string;
	configOptions: acp.SessionConfigOption[];
	title?: string;
	usage?: UsageView;
	/** Updates whose kind this reducer doesn't know. */
	ignored: number;
}

export type Change =
	| { kind: 'text'; role: Role; delta: string; content: acp.ContentBlock; entry: TextEntry; newEntry: boolean }
	| { kind: 'tool'; call: ToolCallView; isNew: boolean }
	| { kind: 'plan'; plan: PlanItem[] }
	| { kind: 'commands'; commands: acp.AvailableCommand[] }
	| { kind: 'mode'; modeId: string }
	| { kind: 'config'; options: acp.SessionConfigOption[] }
	| { kind: 'info'; title?: string }
	| { kind: 'usage'; usage: UsageView }
	| { kind: 'ignored'; sessionUpdate: string };

export function emptyState(): SessionViewState {
	return { entries: [], toolCalls: new Map(), plan: [], commands: [], configOptions: [], ignored: 0 };
}

/** A content block as display text. Non-text blocks become a short markdown placeholder or link. */
export function contentText(block: acp.ContentBlock): string {
	switch (block.type) {
		case 'text':
			return block.text;
		case 'resource_link':
			return `[${block.title ?? block.name}](${block.uri})`;
		case 'resource':
			return 'text' in block.resource ? block.resource.text : `[${block.resource.uri}](${block.resource.uri})`;
		case 'image':
			return '[image]';
		case 'audio':
			return '[audio]';
		default:
			return '';
	}
}

const ROLE: Record<string, Role> = {
	user_message_chunk: 'user',
	agent_message_chunk: 'agent',
	agent_thought_chunk: 'thought',
};

export class SessionView {
	readonly state: SessionViewState = emptyState();

	/** Seed the config options from `session/new` / `set_config_option` responses. */
	setConfigOptions(options: readonly acp.SessionConfigOption[] | null | undefined): Change {
		this.state.configOptions = [...(options ?? [])];
		const mode = this.state.configOptions.find(o => o.category === 'mode');
		if (mode) {
			this.state.modeId = String(mode.currentValue);
		}
		return { kind: 'config', options: this.state.configOptions };
	}

	apply(update: acp.SessionUpdate): Change {
		const s = this.state;
		switch (update.sessionUpdate) {
			case 'user_message_chunk':
			case 'agent_message_chunk':
			case 'agent_thought_chunk':
				return this.text(ROLE[update.sessionUpdate]!, update.content, update.messageId ?? undefined);
			case 'tool_call': {
				const existing = s.toolCalls.get(update.toolCallId);
				const call: ToolCallView = {
					id: update.toolCallId,
					title: update.title,
					kind: update.kind ?? 'other',
					status: update.status ?? 'pending',
					name: update.name ?? existing?.name,
					content: [...(update.content ?? [])],
					locations: [...(update.locations ?? [])],
					rawInput: update.rawInput,
					rawOutput: update.rawOutput,
				};
				s.toolCalls.set(call.id, call);
				if (!existing) {
					s.entries.push({ type: 'tool', id: call.id });
				}
				return { kind: 'tool', call, isNew: !existing };
			}
			case 'tool_call_update': {
				let call = s.toolCalls.get(update.toolCallId);
				const isNew = !call;
				if (!call) {
					// An update for a call we never saw (joined mid-turn): create it rather than drop it.
					call = { id: update.toolCallId, title: update.title ?? 'Tool', kind: 'other', status: 'pending', content: [], locations: [] };
					s.toolCalls.set(call.id, call);
					s.entries.push({ type: 'tool', id: call.id });
				}
				// Fields present in the update replace the old values; absent ones are kept.
				if (update.title !== undefined && update.title !== null) {
					call.title = update.title;
				}
				if (update.kind) {
					call.kind = update.kind;
				}
				if (update.status) {
					call.status = update.status;
				}
				if (update.name) {
					call.name = update.name;
				}
				if (update.content) {
					call.content = [...update.content];
				}
				if (update.locations) {
					call.locations = [...update.locations];
				}
				if (update.rawInput !== undefined) {
					call.rawInput = update.rawInput;
				}
				if (update.rawOutput !== undefined) {
					call.rawOutput = update.rawOutput;
				}
				return { kind: 'tool', call, isNew };
			}
			case 'plan':
				s.plan = update.entries.map(e => ({ content: e.content, priority: e.priority, status: e.status }));
				return { kind: 'plan', plan: s.plan };
			case 'available_commands_update':
				s.commands = [...update.availableCommands];
				return { kind: 'commands', commands: s.commands };
			case 'current_mode_update': {
				s.modeId = update.currentModeId;
				// Keep the mode config option in step (adapters send both, or only this one).
				const mode = s.configOptions.find(o => o.category === 'mode');
				if (mode && mode.type === 'select') {
					mode.currentValue = update.currentModeId;
				}
				return { kind: 'mode', modeId: update.currentModeId };
			}
			case 'config_option_update':
				return this.setConfigOptions(update.configOptions);
			case 'session_info_update':
				if (update.title !== undefined) {
					s.title = update.title ?? undefined;
				}
				return { kind: 'info', title: s.title };
			case 'usage_update':
				s.usage = { used: update.used, size: update.size, ...(update.cost ? { cost: { amount: update.cost.amount, currency: update.cost.currency } } : {}) };
				return { kind: 'usage', usage: s.usage };
			default:
				s.ignored++;
				return { kind: 'ignored', sessionUpdate: String((update as { sessionUpdate?: unknown }).sessionUpdate) };
		}
	}

	private text(role: Role, content: acp.ContentBlock, messageId: string | undefined): Change {
		const delta = contentText(content);
		const last = this.state.entries.at(-1);
		// One entry per message: same role, and the same message id when both have one.
		if (last?.type === 'text' && last.role === role && (!messageId || !last.messageId || last.messageId === messageId)) {
			last.text += delta;
			last.messageId ??= messageId;
			return { kind: 'text', role, delta, content, entry: last, newEntry: false };
		}
		const entry: TextEntry = { type: 'text', role, text: delta, ...(messageId ? { messageId } : {}) };
		this.state.entries.push(entry);
		return { kind: 'text', role, delta, content, entry, newEntry: true };
	}
}

/** All text of one role, in order (tests, transcripts). */
export function textOf(state: SessionViewState, role: Role): string {
	return state.entries.filter((e): e is TextEntry => e.type === 'text' && e.role === role).map(e => e.text).join('');
}
