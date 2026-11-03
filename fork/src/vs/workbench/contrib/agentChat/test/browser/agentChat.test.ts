/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agent chat's Cmd/Ctrl+L goes to a chat the user can see. Closing a chat's editor tab doesn't dispose its
// widget (the editor pane is kept for the next chat tab), so the last focused widget can be one that isn't shown
// anywhere: a reference inserted there is lost. The real ChatWidgetService decides.
// Keyboard focus ends in that chat's input with the caret right after the reference, also when the chat was closed
// or hidden: the chat view the reveal creates then binds its chat after a moment, which replaces the input.

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IPosition } from '../../../../../editor/common/core/position.js';
import { IRange, Range } from '../../../../../editor/common/core/range.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ChatDynamicVariableModel } from '../../../chat/browser/attachments/chatDynamicVariables.js';
import { ChatViewId, IChatWidget, IChatWidgetService } from '../../../chat/browser/chat.js';
import { ChatWidgetService } from '../../../chat/browser/widget/chatWidgetService.js';
import { chatSetUpForSessionsList } from '../../../chat/browser/widgetHosts/viewPane/chatViewPane.js';
import { AgentChatModelPicks, CHAT_BIND_TIMEOUT, MODEL_PICKED_COMMAND } from '../../browser/agentChat.contribution.js';

interface FakeWidget {
	readonly widget: IChatWidget;
	readonly references: string[];
	readonly sent: string[];
	/** Where the caret was each time the input got keyboard focus (offset in its text). */
	readonly focusedAt: number[];
	focus(): void;
	text(): string;
	caret(): number;
	/** The user types at the caret. */
	type(text: string): void;
	/**
	 * The chat view binds its chat, as `ChatWidget.setModel` and `setModelPreservingInputTypedWhileLoading` do: the
	 * input becomes the chat's draft (caret at its end), or, without a draft, what was typed meanwhile, as plain text.
	 */
	bind(draft?: string): void;
}

suite('AgentChat: Cmd/Ctrl+L goes to a chat that is shown', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let disposables: DisposableStore;
	let instantiationService: TestInstantiationService;
	let widgets: ChatWidgetService;
	let viewWidget: FakeWidget;
	let openedViews: string[];

	/**
	 * A chat widget: in the chat view (`viewId`), or in an editor whose tab was closed (no session, not a view).
	 * `bound`: it shows a chat already (an open chat), rather than one the view binds after a moment.
	 */
	function fakeWidget(viewId?: string, bound = true): FakeWidget {
		const model = disposables.add(createTextModel(''));
		const focused = disposables.add(new Emitter<void>());
		const viewModelChanged = disposables.add(new Emitter<unknown>());
		const references: string[] = [];
		const sent: string[] = [];
		const focusedAt: number[] = [];
		let caret: number | undefined;
		const caretOffset = () => Math.min(caret ?? model.getValueLength(), model.getValueLength());
		const editor = {
			getModel: () => model,
			getValue: () => model.getValue(),
			getPosition: () => model.getPositionAt(caretOffset()),
			setPosition: (position: IPosition) => { caret = model.getOffsetAt(position); },
			executeEdits: (_source: string, edits: { range: IRange; text: string }[]) => { model.applyEdits(edits); return true; },
			onDidChangeModelContent: (listener: (e: { isFlush: boolean }) => void) => model.onDidChangeContent(listener),
		};
		const variables = { variables: [], addReference: (ref: { fullName: string }) => references.push(ref.fullName) };
		const widget = {
			viewModel: bound ? { sessionResource: URI.parse('agent-tact:/chat-1') } : undefined,
			viewContext: viewId ? { viewId } : {},
			inputEditor: editor,
			getContrib: (id: string) => (id === ChatDynamicVariableModel.ID ? variables : undefined),
			focusInput: () => { focusedAt.push(caretOffset()); },
			refreshParsedInput: () => { },
			acceptInput: async (text: string) => { sent.push(text); return {}; },
			onDidFocus: focused.event,
			onDidShow: disposables.add(new Emitter<void>()).event,
			onDidHide: disposables.add(new Emitter<void>()).event,
			onDidChangeViewModel: viewModelChanged.event,
		} as unknown as IChatWidget;
		disposables.add(widgets.register(widget));
		return {
			widget, references, sent, focusedAt,
			focus: () => focused.fire(),
			text: () => model.getValue(),
			caret: caretOffset,
			type: text => {
				const at = caretOffset();
				model.applyEdits([{ range: Range.fromPositions(model.getPositionAt(at)), text }]);
				caret = at + text.length;
			},
			bind: draft => {
				const typedWhileLoading = model.getValue();
				model.setValue(draft ?? '');
				(widget as { viewModel: unknown }).viewModel = { sessionResource: URI.parse('agent-tact:/chat-1') };
				viewModelChanged.fire({});
				if (typedWhileLoading && !draft) {
					model.setValue(typedWhileLoading);
				}
				caret = undefined;
			},
		};
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
	});

	/** The chat view's widget: showing a chat (open), or one that binds its chat after a moment (closed, hidden). */
	function chatView(bound = true): FakeWidget {
		viewWidget = fakeWidget(ChatViewId, bound);
		return viewWidget;
	}

	function run(id: string, ...args: unknown[]): Promise<unknown> {
		return Promise.resolve(instantiationService.invokeFunction<unknown>(accessor => CommandsRegistry.getCommand(id)!.handler(accessor, ...args)));
	}

	test('a reference goes to the chat view when the last focused chat was in a closed editor tab', async () => {
		chatView();
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
		chatView().focus();
		await run('_agentChat.insertReference', '@notes.md:L2', URI.file('/ws/notes.md'));
		assert.strictEqual(viewWidget.text(), '@notes.md:L2 ');
	});

	test('chat open: focus ends in its input, the caret right after the reference and its space', async () => {
		chatView().focus();
		viewWidget.type('in this part  fold in the argument');
		const typed = viewWidget.widget.inputEditor.getModel()!;
		viewWidget.widget.inputEditor.setPosition(typed.getPositionAt('in this part '.length));

		assert.strictEqual(await run('_agentChat.insertReference', '@main.tex:L7-8', URI.file('/ws/main.tex')), true);

		assert.strictEqual(viewWidget.text(), 'in this part @main.tex:L7-8  fold in the argument');
		const end = 'in this part @main.tex:L7-8 '.length;
		assert.strictEqual(viewWidget.caret(), end);
		assert.strictEqual(viewWidget.focusedAt.at(-1), end);
		assert.deepStrictEqual(openedViews, [ChatViewId]);
	});

	test('chat closed or hidden: the reference waits for the chat the view binds, then focus and caret follow it', async () => {
		const view = chatView(false);

		const inserted = run('_agentChat.insertReference', '@main.tex:L13-14', URI.file('/ws/main.tex'));
		await timeout(0);
		assert.strictEqual(view.text(), '', 'nothing goes into the input before its chat is bound');
		view.bind();

		assert.strictEqual(await inserted, true);
		assert.deepStrictEqual(openedViews, [ChatViewId]);
		assert.strictEqual(view.text(), '@main.tex:L13-14 ');
		assert.deepStrictEqual(view.references, ['@main.tex:L13-14']);
		assert.strictEqual(view.caret(), '@main.tex:L13-14 '.length);
		assert.strictEqual(view.focusedAt.at(-1), '@main.tex:L13-14 '.length);
	});

	test('chat closed or hidden with a saved draft: the draft stays and the reference goes in at its caret', async () => {
		const view = chatView(false);

		const inserted = run('_agentChat.insertReference', '@main.tex:L13-14', URI.file('/ws/main.tex'));
		await timeout(0);
		view.bind('compare with');

		assert.strictEqual(await inserted, true);
		assert.strictEqual(view.text(), 'compare with @main.tex:L13-14 ');
		assert.strictEqual(view.focusedAt.at(-1), view.text().length);
	});

	for (const draft of [undefined, 'draft']) {
		test(`text typed while the chat opens follows the reference (${draft ? 'dropped by the bind, which keeps the draft' : 'kept by the bind'})`, async () => {
			const view = chatView(false);
			const inserted = run('_agentChat.insertReference', '@main.tex:L13-14', URI.file('/ws/main.tex'));
			await timeout(0);
			view.type('fix this');
			view.bind(draft);

			assert.strictEqual(await inserted, true);
			const expected = `${draft ? `${draft} ` : ''}@main.tex:L13-14 fix this`;
			assert.strictEqual(view.text(), expected);
			assert.deepStrictEqual(view.references, ['@main.tex:L13-14']);
			assert.strictEqual(view.caret(), expected.length);
			assert.strictEqual(view.focusedAt.at(-1), expected.length);
		});
	}

	test('a chat that never binds still gets the reference, after a while', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const view = chatView(false);
		const inserted = run('_agentChat.insertReference', '@main.tex:L13-14', URI.file('/ws/main.tex'));
		await timeout(CHAT_BIND_TIMEOUT + 1);
		assert.strictEqual(await inserted, true);
		assert.strictEqual(view.text(), '@main.tex:L13-14 ');
		assert.strictEqual(view.focusedAt.at(-1), '@main.tex:L13-14 '.length);
	}));

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
