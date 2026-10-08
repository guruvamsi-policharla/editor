/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agent chat (the built-in agent-chat extension), through internal commands:
// - `_agentChat.openChat(uri, where)` opens a chat session (from the extension's chat search) in the chat view in
//   the side bar, or in an editor tab.
// - Cmd/Ctrl+L inserts a reference to the selection at the cursor
// of the last focused chat input, as an inline pill (core's dynamic variable, the same as `#selection`), so a
// message can say "in this part <ref>, fold in this argument <ref>". The request then carries the text with the
// reference in place, plus a reference with its range (a Location) for the extension.

import { URI, UriComponents } from '../../../../base/common/uri.js';
import { IRange, Range } from '../../../../editor/common/core/range.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ChatDynamicVariableModel } from '../../chat/browser/attachments/chatDynamicVariables.js';
import { ChatViewPaneTarget, IChatWidgetService } from '../../chat/browser/chat.js';
import { ACTIVE_GROUP } from '../../../services/editor/common/editorService.js';

CommandsRegistry.registerCommand('_agentChat.openChat', async (accessor, uri: UriComponents | undefined, where: unknown) => {
	if (!uri) {
		return false;
	}
	const widget = await accessor.get(IChatWidgetService).openSession(URI.revive(uri), where === 'editor' ? ACTIVE_GROUP : ChatViewPaneTarget);
	widget?.focusInput();
	return !!widget;
});

/**
 * `_agentChat.insertReference(text, uri, range?)`: inserts `text` (e.g. `@main.tex:L16-18`) at the cursor of the
 * last focused chat input (revealing it), as a reference pill for `uri` (and `range`, 1-based lines), followed by
 * a space. Returns whether it was inserted.
 */
CommandsRegistry.registerCommand('_agentChat.insertReference', async (accessor, text: unknown, uri: UriComponents | undefined, range: IRange | undefined) => {
	if (typeof text !== 'string' || !text || !uri) {
		return false;
	}
	const widgetService = accessor.get(IChatWidgetService);
	const widget = widgetService.lastFocusedWidget ?? await widgetService.revealWidget();
	if (!widget) {
		return false;
	}
	await widgetService.reveal(widget);
	const editor = widget.inputEditor;
	const model = editor.getModel();
	const variables = widget.getContrib<ChatDynamicVariableModel>(ChatDynamicVariableModel.ID);
	if (!model || !variables) {
		return false;
	}
	const at = editor.getPosition() ?? model.getFullModelRange().getEndPosition();
	const before = at.column > 1 ? model.getValueInRange(new Range(at.lineNumber, at.column - 1, at.lineNumber, at.column)) : '';
	const prefix = before && !/\s/.test(before) ? ' ' : '';
	if (!editor.executeEdits('agentChat.insertReference', [{ range: Range.fromPositions(at), text: `${prefix}${text} ` }])) {
		return false;
	}
	const start = at.column + prefix.length;
	const pill = new Range(at.lineNumber, start, at.lineNumber, start + text.length);
	const resource = URI.revive(uri);
	variables.addReference({
		// Unique per pill: the request's references are keyed by id.
		id: `agentChat.reference:${resource.toString()}:${range?.startLineNumber ?? 0}-${range?.endLineNumber ?? 0}:${Date.now()}`,
		fullName: text,
		isFile: true,
		range: pill,
		data: range ? { uri: resource, range: Range.lift(range) } : resource,
	});
	editor.setPosition({ lineNumber: pill.endLineNumber, column: pill.endColumn + 1 });
	widget.focusInput();
	widget.refreshParsedInput();
	return true;
});
