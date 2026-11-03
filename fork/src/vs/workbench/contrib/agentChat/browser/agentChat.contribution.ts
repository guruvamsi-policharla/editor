/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agent chat (the built-in agent-chat extension), through internal commands:
// - `_agentChat.openChat(uri, where)` opens a chat session (from the extension's chat search) in the chat view in
//   the side bar, or in an editor tab.
// - `_agentChat.resend(uri, text)` sends a message again in a chat session (Retry on a failed turn's card).
// - Cmd/Ctrl+L inserts a reference to the selection at the cursor
// of the last focused chat input, as an inline pill (core's dynamic variable, the same as `#selection`), so a
// message can say "in this part <ref>, fold in this argument <ref>". The request then carries the text with the
// reference in place, plus a reference with its range (a Location) for the extension.
// - The Cmd/Ctrl+L keybinding itself (`AGENT_CHAT_CMD_L`), above every extension's default keybindings.

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { IRange, Range } from '../../../../editor/common/core/range.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IKeybindingRule, KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ChatDynamicVariableModel } from '../../chat/browser/attachments/chatDynamicVariables.js';
import { ChatViewPaneTarget, IChatWidgetService } from '../../chat/browser/chat.js';
import { ACTIVE_GROUP } from '../../../services/editor/common/editorService.js';
import { referenceInsertionOffset, referencePrefix } from './insertPlan.js';

/**
 * Cmd+L (Ctrl+L on Windows/Linux) in a text editor: agent-review's "Send Selection to Agent", which inserts the
 * reference into the agent chat. Registered here rather than in the extension's package.json: a built-in
 * extension's keybindings rank below every installed extension's, and LaTeX Workshop binds `cmd+l cmd+b` (`ctrl+l
 * ctrl+b` on Linux) and a dozen more chords in LaTeX files by default, so Cmd+L in a .tex file only started a
 * chord. This weight is above any extension default (`ExternalExtension` + the binding's index in its
 * extension); the user's keybindings.json still overrides it.
 */
export const AGENT_CHAT_CMD_L: IKeybindingRule = {
	id: 'agentReview.sendSelectionToAgent',
	weight: KeybindingWeight.ExternalExtension + 100_000,
	when: EditorContextKeys.editorTextFocus,
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

/**
 * `_agentChat.resend(uri, text)`: sends `text` again in the chat session `uri` (its open widget, in the side bar or an
 * editor tab; opened in the side bar when it isn't open), as if the user typed it: Retry on a failed turn's card.
 * Without `uri` (a chat that has no resource yet), the last focused chat if it can be shown, else the side bar's.
 * Returns whether it was sent.
 */
CommandsRegistry.registerCommand('_agentChat.resend', async (accessor, uri: UriComponents | undefined, text: unknown) => {
	if (typeof text !== 'string' || !text) {
		return false;
	}
	const widgetService = accessor.get(IChatWidgetService);
	const resource = uri ? URI.revive(uri) : undefined;
	const open = resource && widgetService.getWidgetBySessionResource(resource);
	const widget = open && await widgetService.reveal(open)
		? open
		: resource ? await widgetService.openSession(resource, ChatViewPaneTarget) : await widgetService.revealWidget();
	if (!widget) {
		return false;
	}
	return !!await widget.acceptInput(text);
});

/**
 * `_agentChat.insertReference(text, uri, range?)`: inserts `text` (e.g. `@main.tex:L16-18`) at the cursor of the
 * last focused chat input (revealing it), as a reference pill for `uri` (and `range`, 1-based lines), followed by
 * a space. A caret inside an existing pill inserts after that pill, so several references can sit in one sentence.
 * Returns whether it was inserted.
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
	if (!editor.executeEdits('agentChat.insertReference', [{ range: Range.fromPositions(position), text: `${prefix}${text} ` }])) {
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
	editor.setPosition(model.getPositionAt(Math.min(pillOffset + text.length + 1, model.getValueLength())));
	widget.focusInput();
	widget.refreshParsedInput();
	return true;
});
