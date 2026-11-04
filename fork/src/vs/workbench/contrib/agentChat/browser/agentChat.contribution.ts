/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agent chat (the built-in agent-chat extension), through internal commands:
// - `_agentChat.openChat(uri, where)` opens a chat session (from the extension's chat search) in the chat view in
//   the side bar, or in an editor tab.
// - A model picked in an extension's chat session (one of the models it targets at the session's type) is reported
//   to the extension at once (`agentChat.modelPicked`), so it can apply it and show the pickers that model has.
// - Cmd/Ctrl+L inserts a reference to the selection at the cursor
// of the last focused chat input, as an inline pill (core's dynamic variable, the same as `#selection`), so a
// message can say "in this part <ref>, fold in this argument <ref>". The request then carries the text with the
// reference in place, plus a reference with its range (a Location) for the extension.
// - The Cmd/Ctrl+L keybinding itself (`AGENT_CHAT_CMD_L`), above every extension's default keybindings.

import { raceTimeout } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { IRange, Range } from '../../../../editor/common/core/range.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IKeybindingRule, KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ChatDynamicVariableModel } from '../../chat/browser/attachments/chatDynamicVariables.js';
import { ChatViewPaneTarget, IChatWidget, IChatWidgetService } from '../../chat/browser/chat.js';
import { getChatSessionType } from '../../chat/common/model/chatUri.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ACTIVE_GROUP } from '../../../services/editor/common/editorService.js';
import { referenceInsertionOffset, referencePrefix } from './insertPlan.js';

/**
 * Cmd+L (Ctrl+L on Windows/Linux) in a text editor: agent-review's "Send Selection to Agent", which inserts the
 * reference into the agent chat. Registered here rather than in the extension's package.json: a built-in
 * extension's keybindings rank below every installed extension's, and LaTeX Workshop binds `cmd+l cmd+b` (`ctrl+l
 * ctrl+b` on Linux) and a dozen more chords in LaTeX files by default, so Cmd+L in a .tex file only started a
 * chord. This weight is above any extension default (`ExternalExtension` + the binding's index in its
 * extension); the user's keybindings.json still overrides it. Only while the built-in chat is on
 * (`agentChat.tact.enabled`): otherwise Cmd/Ctrl+L keeps its default meaning.
 */
export const AGENT_CHAT_CMD_L: IKeybindingRule = {
	id: 'agentReview.sendSelectionToAgent',
	weight: KeybindingWeight.ExternalExtension + 100_000,
	when: ContextKeyExpr.and(EditorContextKeys.editorTextFocus, ContextKeyExpr.equals('config.agentChat.tact.enabled', true)),
	primary: KeyMod.CtrlCmd | KeyCode.KeyL,
};
KeybindingsRegistry.registerKeybindingRule(AGENT_CHAT_CMD_L);

CommandsRegistry.registerCommand('_agentChat.openChat', async (accessor, uri: UriComponents | undefined, where: unknown) => {
	if (!uri) {
		return false;
	}
	const widget = await accessor.get(IChatWidgetService).openSession(URI.revive(uri), where === 'editor' ? ACTIVE_GROUP : ChatViewPaneTarget);
	widget?.focusInput();
	return !!widget;
});

/** How long a chat view that is still opening may take to show its chat before a reference goes in anyway. */
export const CHAT_BIND_TIMEOUT = 5000;

/**
 * Waits until `widget` shows a chat. A chat view that a reveal has just created (the chat was closed or hidden)
 * shows its input at once but binds its chat (restored or new) a moment later, and binding replaces the input: with
 * the chat's saved draft, which drops anything put in before, or with that text as plain text, which drops the pill.
 * Returns the text typed into the input while it waited (it has focus meanwhile), taken out of the input if binding
 * kept it, so the caller can put it after the reference.
 */
async function chatBound(widget: IChatWidget): Promise<string> {
	if (widget.viewModel) {
		return '';
	}
	const editor = widget.inputEditor;
	const before = editor.getValue();
	let typed = before;
	const typing = editor.onDidChangeModelContent(e => {
		if (!e.isFlush && !widget.viewModel) {
			typed = editor.getValue();
		}
	});
	const bound = Event.toPromise(widget.onDidChangeViewModel);
	try {
		await raceTimeout(bound, CHAT_BIND_TIMEOUT);
	} finally {
		bound.cancel();
		typing.dispose();
	}
	const added = typed.startsWith(before) ? typed.slice(before.length) : typed;
	const model = editor.getModel();
	// Binding keeps what was typed only into a chat without a draft, as the whole input.
	if (added && model && model.getValue() === typed) {
		editor.executeEdits('agentChat.insertReference', [{ range: Range.fromPositions(model.getPositionAt(typed.length - added.length), model.getFullModelRange().getEndPosition()), text: '' }]);
	}
	return added;
}

/**
 * `_agentChat.insertReference(text, uri, range?)`: inserts `text` (e.g. `@main.tex:L16-18`) at the cursor of the
 * last focused chat input (revealing it, and waiting for its chat when the reveal opened it), as a reference pill
 * for `uri` (and `range`, 1-based lines), followed by a space. A caret inside an existing pill inserts after that
 * pill, so several references can sit in one sentence. Keyboard focus ends in that input, with the caret right
 * after the reference (and after anything typed while the chat was opening, which follows the reference). Returns
 * whether it was inserted.
 */
CommandsRegistry.registerCommand('_agentChat.insertReference', async (accessor, text: unknown, uri: UriComponents | undefined, range: IRange | undefined) => {
	if (typeof text !== 'string' || !text || !uri) {
		return false;
	}
	// The last focused chat when it can be shown, else the chat view's. (A chat whose editor tab was closed keeps its
	// widget, with no chat in it, as the last focused one: a reference inserted there would be lost.)
	const widget = await accessor.get(IChatWidgetService).revealWidget();
	if (!widget) {
		return false;
	}
	const typed = await chatBound(widget);
	const editor = widget.inputEditor;
	const model = editor.getModel();
	const variables = widget.getContrib<ChatDynamicVariableModel>(ChatDynamicVariableModel.ID);
	if (!model || !variables) {
		return false;
	}
	const at = editor.getPosition() ?? model.getFullModelRange().getEndPosition();
	const value = model.getValue();
	const pills = variables.variables.filter(v => Range.isIRange(v.range)).map(v => ({
		start: model.getOffsetAt({ lineNumber: v.range.startLineNumber, column: v.range.startColumn }),
		end: model.getOffsetAt({ lineNumber: v.range.endLineNumber, column: v.range.endColumn }),
	}));
	const insertAt = referenceInsertionOffset(value, model.getOffsetAt(at), pills);
	const prefix = referencePrefix(value, insertAt);
	const position = model.getPositionAt(insertAt);
	if (!editor.executeEdits('agentChat.insertReference', [{ range: Range.fromPositions(position), text: `${prefix}${text} ${typed}` }])) {
		return false;
	}
	// The pill covers exactly the inserted reference, read back from the model so a listener that
	// shifted the text cannot leave the range one character short or overlapping the previous pill.
	const inserted = model.getValue();
	let pillOffset = insertAt + prefix.length;
	if (inserted.substring(pillOffset, pillOffset + text.length) !== text) {
		const found = inserted.indexOf(text, insertAt);
		if (found < 0) {
			return false;
		}
		pillOffset = found;
	}
	const pill = Range.fromPositions(model.getPositionAt(pillOffset), model.getPositionAt(pillOffset + text.length));
	const resource = URI.revive(uri);
	variables.addReference({
		// Unique per pill: the request's references are keyed by id.
		id: `agentChat.reference:${resource.toString()}:${range?.startLineNumber ?? 0}-${range?.endLineNumber ?? 0}:${Date.now()}`,
		fullName: text,
		isFile: true,
		range: pill,
		data: range ? { uri: resource, range: Range.lift(range) } : resource,
	});
	editor.setPosition(model.getPositionAt(Math.min(pillOffset + text.length + 1 + typed.length, model.getValueLength())));
	widget.focusInput();
	widget.refreshParsedInput();
	return true;
});

/** The extension command a model pick is reported to: `(sessionResource, modelIdentifier)`. */
export const MODEL_PICKED_COMMAND = 'agentChat.modelPicked';

/**
 * Reports each chat input's selected model to the agent-chat extension when it changes to a model the extension
 * targets at the chat's session type (`targetChatSessionType`): a tact chat's thinking and speed pickers depend on
 * its model, so the extension applies the model at once instead of at the next message. Models of other session
 * types (and core's own) aren't reported. A pick that repeats the last one reported for the same chat isn't either.
 */
export class AgentChatModelPicks extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.agentChatModelPicks';

	private readonly widgets = this._register(new DisposableMap<IChatWidget>());

	constructor(
		@IChatWidgetService widgetService: IChatWidgetService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		widgetService.getAllWidgets().forEach(w => this.watch(w));
		this._register(widgetService.onDidAddWidget(w => this.watch(w)));
	}

	private watch(widget: IChatWidget): void {
		if (this.widgets.has(widget)) {
			return;
		}
		let last: string | undefined;
		this.widgets.set(widget, autorun(reader => {
			const model = widget.input.selectedLanguageModel.read(reader);
			const resource = widget.viewModel?.model.sessionResource;
			const type = model?.metadata.targetChatSessionType;
			if (!model || !resource || !type || getChatSessionType(resource) !== type) {
				return;
			}
			const key = `${resource.toString()} ${model.identifier}`;
			if (key === last || !CommandsRegistry.getCommand(MODEL_PICKED_COMMAND)) {
				return;
			}
			last = key;
			this.commandService.executeCommand(MODEL_PICKED_COMMAND, resource, model.identifier).catch(() => undefined);
		}));
	}
}

registerWorkbenchContribution2(AgentChatModelPicks.ID, AgentChatModelPicks, WorkbenchPhase.AfterRestored);

