// Each chat's own settings (model, effort, speed, …), and which chat a picker change belongs to. Pure (no vscode
// import), for unit tests.
//
// - A chat's settings are its session's option values, saved with the chat in history (history.ts). A reopened
//   chat shows them and gets them back on its first message (`AcpSession.applySettings`: a resume starts from the
//   agent's defaults); a new chat starts from the profile's defaults, never from another chat's.
// - Core tells every chat's input state about a picker change made in any chat (extHostChatSessions'
//   `$provideHandleOptionsChange`: "propagated to all input states … until we can make this session-specific"),
//   including the values we set ourselves and the ones core sets when it opens a chat. So a change is only taken
//   as the user's in the chat it was reported to when that's unambiguous (see `attributeChanges`); every message
//   still runs with what its chat's pickers show (core keeps those per chat, `initialSessionOptions`).

export type ChatSettings = Record<string, string>;

export interface PickerChange {
	id: string;
	value: string;
}

/** A change core reported to one input state. */
export interface PickerEvent<T> {
	target: T;
	/** The chat the input state belongs to (undefined: a new chat). */
	chat: string | undefined;
	changes: PickerChange[];
}

/** Values we (or core, opening a chat) put in a chat's pickers: core reports them to the other chats too. */
export interface PickerPush<T> {
	target: T | undefined;
	chat: string | undefined;
	values: ChatSettings;
	at: number;
}

/** How long a value we set counts as the source of the same value reported to another chat. */
export const ECHO_MS = 3000;

function isEcho<T>(event: PickerEvent<T>, change: PickerChange, pushes: readonly PickerPush<T>[], now: number): boolean {
	return pushes.some(p => now - p.at < ECHO_MS && p.values[change.id] === change.value
		&& p.target !== event.target && !(p.chat !== undefined && p.chat === event.chat));
}

/**
 * Which reported changes are the user's, per input state. Changes that repeat a value just set elsewhere are
 * echoes. One chat with changes left: they're its. Several (core reported one change to all of them): the source
 * is unknown, so none is applied on a guess; each chat's next message runs with what its own pickers show.
 */
export function attributeChanges<T>(events: readonly PickerEvent<T>[], pushes: readonly PickerPush<T>[], now: number): { target: T; changes: PickerChange[] }[] {
	const left = events
		.map(e => ({ event: e, changes: e.changes.filter(c => !isEcho(e, c, pushes, now)) }))
		.filter(x => x.changes.length);
	return left.length === 1 ? [{ target: left[0]!.event.target, changes: left[0]!.changes }] : [];
}

/** Core's per-chat picker values (`initialSessionOptions`) as settings. */
export function shownSettings(options: readonly { optionId: string; value: string | { id: string } }[] | undefined): ChatSettings {
	return Object.fromEntries((options ?? []).map(o => [o.optionId, typeof o.value === 'string' ? o.value : o.value.id]));
}

/** Settings without the given option ids (the model goes through the model picker, not the option pickers). */
export function without(settings: ChatSettings, ids: readonly string[]): ChatSettings {
	return Object.fromEntries(Object.entries(settings).filter(([id]) => !ids.includes(id)));
}

/**
 * The values a chat's pickers start from before its session runs: a saved chat's own; a new chat's are the profile's
 * defaults, never another chat's.
 */
export function startValues(saved: { settings?: ChatSettings } | undefined, defaults: Readonly<ChatSettings> | undefined): ChatSettings {
	return { ...(saved ? saved.settings : defaults) };
}

/** The language model vendor the harnesses' models are registered under (models.ts). */
export const MODEL_VENDOR = 'agent-chat';

/**
 * A harness model value as core's language model identifier (`<vendor>/<id>`, the id being `<session type>:<value>`),
 * which a history request's `modelId` names: core selects it in a reopened chat's model picker.
 */
export function modelIdentifier(sessionType: string, value: string): string {
	return `${MODEL_VENDOR}/${sessionType}:${value}`;
}
