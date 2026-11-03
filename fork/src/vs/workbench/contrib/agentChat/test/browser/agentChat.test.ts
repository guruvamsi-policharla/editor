/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agent chat's Cmd/Ctrl+L goes to a chat the user can see. Closing a chat's editor tab doesn't dispose its
// widget (the editor pane is kept for the next chat tab), so the last focused widget can be one that isn't shown
// anywhere: a reference inserted there is lost. The real ChatWidgetService decides.

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IRange } from '../../../../../editor/common/core/range.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ChatDynamicVariableModel } from '../../../chat/browser/attachments/chatDynamicVariables.js';
import { ChatViewId, IChatWidget, IChatWidgetService } from '../../../chat/browser/chat.js';
import { ChatWidgetService } from '../../../chat/browser/widget/chatWidgetService.js';
import { chatSetUpForSessionsList } from '../../../chat/browser/widgetHosts/viewPane/chatViewPane.js';
import { AgentChatModelPicks, MODEL_PICKED_COMMAND } from '../../browser/agentChat.contribution.js';

interface FakeWidget {
	readonly widget: IChatWidget;
	readonly references: string[];
	readonly sent: string[];
	focus(): void;
	text(): string;
}

suite('AgentChat: Cmd/Ctrl+L goes to a chat that is shown', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let disposables: DisposableStore;
	let instantiationService: TestInstantiationService;
	let widgets: ChatWidgetService;
	let viewWidget: FakeWidget;
	let openedViews: string[];

	/** A chat widget: in the chat view (`viewId`), or in an editor whose tab was closed (no session, not a view). */
	function fakeWidget(viewId?: string): FakeWidget {
		const model = disposables.add(createTextModel(''));
		const focused = disposables.add(new Emitter<void>());
		const references: string[] = [];
		const sent: string[] = [];
		const editor = {
			getModel: () => model,
			getPosition: () => model.getFullModelRange().getEndPosition(),
			setPosition: () => { },
			executeEdits: (_source: string, edits: { range: IRange; text: string }[]) => { model.applyEdits(edits); return true; },
		};
		const variables = { variables: [], addReference: (ref: { fullName: string }) => references.push(ref.fullName) };
		const widget = {
			viewModel: undefined,
			viewContext: viewId ? { viewId } : {},
			inputEditor: editor,
			getContrib: (id: string) => (id === ChatDynamicVariableModel.ID ? variables : undefined),
			focusInput: () => { },
			refreshParsedInput: () => { },
			acceptInput: async (text: string) => { sent.push(text); return {}; },
			onDidFocus: focused.event,
			onDidShow: Event.None,
			onDidHide: Event.None,
			onDidChangeViewModel: Event.None,
		} as unknown as IChatWidget;
		disposables.add(widgets.register(widget));
		return { widget, references, sent, focus: () => focused.fire(), text: () => model.getValue() };
	}

	setup(() => {
		disposables = store.add(new DisposableStore());
		openedViews = [];
		instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(IChatWidgetService, {});
		const views = {
			openView: async (id: string) => { openedViews.push(id); return id === ChatViewId ? { widget: viewWidget.widget, focus: () => { } } : undefined; },
			getViewWithId: () => undefined,
		};
		widgets = disposables.add(new ChatWidgetService(
			{ groups: [] } as never, views as never, { sessionResource: undefined } as never, {} as never, {} as never, { getSession: () => undefined } as never, new NullLogService(),
		));
		instantiationService.set(IChatWidgetService, widgets);
		viewWidget = fakeWidget(ChatViewId);
	});

	function run(id: string, ...args: unknown[]): Promise<unknown> {
		return Promise.resolve(instantiationService.invokeFunction<unknown>(accessor => CommandsRegistry.getCommand(id)!.handler(accessor, ...args)));
	}

	test('a reference goes to the chat view when the last focused chat was in a closed editor tab', async () => {
		const closedTab = fakeWidget();
		closedTab.focus();
		assert.strictEqual(widgets.lastFocusedWidget, closedTab.widget);

		const inserted = await run('_agentChat.insertReference', '@notes.md:L1', URI.file('/ws/notes.md'), { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 });

		assert.strictEqual(inserted, true);
		assert.deepStrictEqual(openedViews, [ChatViewId]);
		assert.strictEqual(viewWidget.text(), '@notes.md:L1 ');
		assert.deepStrictEqual(viewWidget.references, ['@notes.md:L1']);
		assert.strictEqual(closedTab.text(), '');
		assert.deepStrictEqual(closedTab.references, []);
	});

	test('a reference goes to the last focused chat when it is still shown', async () => {
		viewWidget.focus();
		await run('_agentChat.insertReference', '@notes.md:L2', URI.file('/ws/notes.md'));
		assert.strictEqual(viewWidget.text(), '@notes.md:L2 ');
	});

});

suite('AgentChat: the chat view lists past chats', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('with Copilot hidden (our chat, no Copilot setup), the empty chat view shows the sessions list', () => {
		assert.strictEqual(chatSetUpForSessionsList({ hidden: true }, false), true);
	});

	test('while Copilot setup is pending, it still makes room for setup', () => {
		assert.strictEqual(chatSetUpForSessionsList({}, false), false);
		assert.strictEqual(chatSetUpForSessionsList({ completed: true }, false), true);
		assert.strictEqual(chatSetUpForSessionsList({}, true), true);
	});
});

suite('AgentChat: a model picked in an extension\'s chat is reported at once', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	type Model = { identifier: string; metadata: { targetChatSessionType?: string } };

	test('only models the extension targets at the chat\'s session type, once per pick', () => {
		const disposables = store.add(new DisposableStore());
		const reported: [string, string][] = [];
		disposables.add(CommandsRegistry.registerCommand(MODEL_PICKED_COMMAND, () => undefined));
		const commands = { executeCommand: async (id: string, resource: URI, model: string) => { reported.push([resource.toString(), model]); return undefined; } };
		const selected = observableValue<Model | undefined>('model', undefined);
		const added = disposables.add(new Emitter<IChatWidget>());
		const widget = { input: { selectedLanguageModel: selected }, viewModel: { model: { sessionResource: URI.parse('agent-tact:/untitled-1') } } } as unknown as IChatWidget;
		const widgetService = { getAllWidgets: () => [], onDidAddWidget: added.event } as unknown as IChatWidgetService;
		disposables.add(new AgentChatModelPicks(widgetService, commands as never));
		added.fire(widget);

		selected.set({ identifier: 'agent-chat/agent-tact:claude-opus-5-5', metadata: { targetChatSessionType: 'agent-tact' } }, undefined);
		selected.set({ identifier: 'agent-chat/agent-tact:claude-opus-5-5', metadata: { targetChatSessionType: 'agent-tact' } }, undefined);
		selected.set({ identifier: 'copilot/gpt', metadata: {} }, undefined);
		selected.set({ identifier: 'other/x', metadata: { targetChatSessionType: 'other-type' } }, undefined);
		selected.set({ identifier: 'agent-chat/agent-tact:gpt-6.1-sol', metadata: { targetChatSessionType: 'agent-tact' } }, undefined);

		assert.deepStrictEqual(reported, [
			['agent-tact:/untitled-1', 'agent-chat/agent-tact:claude-opus-5-5'],
			['agent-tact:/untitled-1', 'agent-chat/agent-tact:gpt-6.1-sol'],
		]);
	});
});
