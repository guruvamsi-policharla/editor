/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agent review in core: an engine baseline pushed in from the extension renders through the reused
// chat-editing UI as (1) a view zone holding the deleted baseline lines as real editor rows and (2) a
// per-hunk Keep/Undo widget. Keep moves the baseline and reports it; Undo rewrites the buffer and
// saves it (only when the buffer had no unsaved edits). A reload from disk (an agent write) stays
// pending, a keystroke outside the hunks folds into the baseline, created files are deleted on Undo,
// and hunks stay as granular as the line diff, with word-level inner changes.

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, IReference } from '../../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { constObservable, waitForState } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IOverlayWidget, IViewZone, IViewZoneChangeAccessor } from '../../../../../editor/browser/editorBrowser.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { EditOperation } from '../../../../../editor/common/core/editOperation.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IEditorWorkerService } from '../../../../../editor/common/services/editorWorker.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IResolvedTextEditorModel, ITextModelContentProvider, ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { EditSources } from '../../../../../editor/common/textModelEditSource.js';
import { instantiateTestCodeEditor, ITestCodeEditor } from '../../../../../editor/test/browser/testCodeEditor.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { ITextFileSaveOptions, ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { IChatWidgetService } from '../../../chat/browser/chat.js';
import { IChatEditingExplanationModelManager } from '../../../chat/browser/chatEditing/chatEditingExplanationModelManager.js';
import { IChatEditReviewSession, IChatEditingService, IModifiedFileEntryChangeHunk } from '../../../chat/common/editing/chatEditingService.js';
import { TestWorkerService } from '../../../inlineChat/test/browser/testWorkerService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IResourceDiffEditorInput } from '../../../../common/editor.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { IAction2Options } from '../../../../../platform/actions/common/actions.js';
import { AcceptAction, AcceptAllEditsAction, AcceptHunkAction, NavigateAction, RejectAction, RejectHunkAction, ToggleAccessibleDiffViewAction, ToggleDiffAction } from '../../../chat/browser/chatEditing/chatEditingEditorActions.js';
import { AgentReviewKind, IAgentReviewHunkEvent } from '../../browser/agentReviewEntry.js';
import { AgentReviewService } from '../../browser/agentReviewService.js';

suite('AgentReview: engine baseline rendered by the chat-editing UI', () => {

	const store = new DisposableStore();
	const uri = URI.parse('test:/paper.tex');
	const BASELINE = 'Intro sentence.\nThis sentence was deleted by the agent.\nClosing sentence.\n';
	const DISK = 'Intro sentence.\nClosing sentence.\n';

	let service: AgentReviewService;
	let model: ITextModel;
	let modelService: IModelService;
	let editor: ITestCodeEditor;
	let zones: Map<string, IViewZone>;
	let overlays: Set<IOverlayWidget>;
	let registeredSessions: IChatEditReviewSession[];
	let hunkEvents: IAgentReviewHunkEvent[];
	let dirty: boolean;
	let saves: (ITextFileSaveOptions | undefined)[];
	let insta: TestInstantiationService;

	setup(() => {
		zones = new Map();
		overlays = new Set();
		registeredSessions = [];
		hunkEvents = [];
		dirty = false;
		saves = [];

		const collection = new ServiceCollection();
		collection.set(IEditorWorkerService, new SyncDescriptor(TestWorkerService));
		collection.set(ITextModelService, new class extends mock<ITextModelService>() {
			override async createModelReference(resource: URI): Promise<IReference<IResolvedTextEditorModel>> {
				return { dispose: () => { }, object: { textEditorModel: model, getLanguageId: () => 'latex' } as IResolvedTextEditorModel };
			}
			override registerTextModelContentProvider(_scheme: string, _provider: ITextModelContentProvider): IDisposable {
				return Disposable.None;
			}
		}());
		collection.set(IChatEditingService, new class extends mock<IChatEditingService>() {
			override registerEditReviewSession(session: IChatEditReviewSession): IDisposable {
				registeredSessions.push(session);
				return Disposable.None;
			}
		}());
		collection.set(IChatEditingExplanationModelManager, new class extends mock<IChatEditingExplanationModelManager>() {
			override readonly state = constObservable(new ResourceMap<never>());
		}());
		collection.set(ITextFileService, new class extends mock<ITextFileService>() {
			override isDirty(): boolean {
				return dirty;
			}
			override async save(resource: URI, options?: ITextFileSaveOptions): Promise<URI | undefined> {
				saves.push(options);
				return resource;
			}
		}());
		collection.set(IChatWidgetService, new class extends mock<IChatWidgetService>() { }());
		collection.set(IViewsService, new class extends mock<IViewsService>() {
			override readonly onDidChangeViewVisibility = Event.None;
		}());

		insta = store.add(store.add(workbenchInstantiationService(undefined, store)).createChild(collection));
		store.add(insta.get(IEditorWorkerService) as TestWorkerService);
		modelService = insta.get(IModelService);
		model = store.add(modelService.createModel(DISK, null, uri, false));
		service = store.add(insta.createInstance(AgentReviewService));

		// A code editor without a DOM view: record view zones and overlay widgets instead.
		editor = store.add(instantiateTestCodeEditor(insta, model));
		let zoneIds = 0;
		const accessor: IViewZoneChangeAccessor = {
			addZone: zone => { const id = String(++zoneIds); zones.set(id, zone); return id; },
			removeZone: id => { zones.delete(id); },
			layoutZone: () => { },
		};
		editor.changeViewZones = callback => { callback(accessor); };
		editor.addOverlayWidget = w => { overlays.add(w); };
		editor.removeOverlayWidget = w => { overlays.delete(w); };
		editor.layoutOverlayWidget = () => { };
		editor.getTopForLineNumber = line => (line - 1) * 20;
		editor.getScrollTop = () => 0;

		store.add(service.onDidHunkAction(e => hunkEvents.push(e)));
	});

	teardown(() => store.clear());

	ensureNoDisposablesAreLeakedInTestSuite();

	async function showPending(baseline = BASELINE, kind: AgentReviewKind = 'modified') {
		const entry = (await service.setBaseline(uri, baseline, kind))!;
		await waitForState(entry.diffInfo.map(d => d.changes.length > 0 ? d : undefined));
		const integration = store.add(entry.createEditorIntegration(editor));
		return { entry, integration };
	}

	function hunkWidgets(): (IOverlayWidget & IModifiedFileEntryChangeHunk)[] {
		return [...overlays].filter(w => w.getDomNode().classList.contains('chat-diff-change-content-widget')) as (IOverlayWidget & IModifiedFileEntryChangeHunk)[];
	}

	test('registers a review session that the chat-editing UI picks up', async () => {
		await showPending();
		assert.strictEqual(registeredSessions.length, 1);
		assert.strictEqual(registeredSessions[0].isGlobalEditingSession, true);
		assert.ok(registeredSessions[0].getEntry(uri));
	});

	test('deleted baseline lines render as real rows in a view zone, with one Keep/Undo widget', async () => {
		await showPending();

		const deleted = [...zones.values()].filter(z => z.domNode.classList.contains('line-delete'));
		assert.strictEqual(deleted.length, 1, 'one view zone for the deleted block');
		const zone = deleted[0];
		assert.strictEqual(zone.afterLineNumber, 1, 'deleted block sits after line 1');
		assert.strictEqual(zone.heightInLines, 1, 'one deleted row');
		assert.ok(zone.domNode.classList.contains('line-delete'));
		assert.ok(zone.domNode.classList.contains('view-lines'), 'rendered with editor line markup (renderLines)');
		// the line renderer emits non-breaking spaces, exactly like real editor rows
		assert.ok(zone.domNode.textContent?.replace(/\u00a0/g, ' ').includes('This sentence was deleted by the agent.'));

		assert.strictEqual(hunkWidgets().length, 1, 'one per-hunk toolbar');
	});

	test('each Keep/Undo toolbar has its own row below its hunk, so it never covers text', async () => {
		model.setValue('a one\nb TWO, rewritten by the agent\nc three\ne five\n');
		const { entry } = await showPending('a one\nb two\nc three\nd four\ne five\n');
		assert.strictEqual(entry.diffInfo.get().changes.length, 2, 'a rewrite and a pure deletion');

		const rows = [...zones.values()].filter(z => z.domNode.classList.contains('agent-review-hunk-toolbar-row'));
		const deleted = [...zones.values()].filter(z => z.domNode.classList.contains('line-delete'));
		const widgets = hunkWidgets();
		assert.strictEqual(rows.length, 2, 'one row per hunk');
		assert.strictEqual(widgets.length, 2);
		assert.ok(widgets.every(w => w.getDomNode().classList.contains('in-own-row')));

		// Rewrite of line 2: the row follows the rewritten line. Pure deletion before line 4: the row
		// follows the deleted rows (same line, higher ordinal).
		assert.deepStrictEqual(rows.map(r => r.afterLineNumber).sort(), [2, 3]);
		const deletionRow = rows.find(r => r.afterLineNumber === 3)!;
		const deletionZone = deleted.find(z => z.afterLineNumber === 3)!;
		assert.ok(deletionRow.ordinal! > deletionZone.ordinal!, 'row comes after the deleted lines');
		assert.ok(rows.every(r => r.heightInPx! >= editor.getOption(EditorOption.lineHeight)), 'a full row, not an overlay on text');

		// The toolbar sits where its row is (as the editor reports it while scrolling), at the text's left edge.
		const row = rows.find(r => r.afterLineNumber === 2)!;
		row.onDomNodeTop!(137);
		const position = widgets.map(w => w.getPosition()?.preference).find(p => p && typeof p === 'object' && p.top >= 137);
		assert.ok(position && typeof position === 'object', 'widget moved to its row');
		assert.ok(position.top < 137 + row.heightInPx!, 'inside the row');
		assert.strictEqual(position.left, editor.getLayoutInfo().contentLeft);
	});

	test('Keep folds the hunk into the baseline, reports the full baseline, and leaves the buffer alone', async () => {
		const { entry, integration } = await showPending();
		await integration.acceptNearestChange(hunkWidgets()[0]);

		assert.strictEqual(entry.originalModel.getValue(), DISK);
		assert.strictEqual(model.getValue(), DISK);
		assert.strictEqual(entry.changesCount.get(), 0);
		assert.strictEqual(zones.size, 0);
		assert.deepStrictEqual(hunkEvents.map(e => [e.kind, e.baseline]), [['accepted', DISK]]);
		assert.deepStrictEqual(saves, []);
	});

	test('Undo writes the baseline text back into the buffer and saves it (without save participants)', async () => {
		const { entry, integration } = await showPending();
		await integration.rejectNearestChange(hunkWidgets()[0]);

		assert.strictEqual(model.getValue(), BASELINE);
		assert.strictEqual(entry.originalModel.getValue(), BASELINE);
		assert.strictEqual(entry.changesCount.get(), 0);
		assert.deepStrictEqual(hunkEvents.map(e => e.kind), ['rejected']);
		assert.strictEqual(saves.length, 1);
		assert.strictEqual(saves[0]?.skipSaveParticipants, true);
	});

	test('Undo never saves a buffer that has unsaved user edits', async () => {
		const { integration } = await showPending();
		dirty = true;
		await integration.rejectNearestChange(hunkWidgets()[0]);
		assert.strictEqual(model.getValue(), BASELINE);
		assert.deepStrictEqual(saves, []);
	});

	test('file Keep reports acceptFile; file Undo restores and saves', async () => {
		const { entry } = await showPending();
		await entry.accept();
		assert.deepStrictEqual(hunkEvents.map(e => e.kind), ['acceptFile']);
		assert.strictEqual(entry.originalModel.getValue(), DISK);

		await service.setBaseline(uri, BASELINE);
		await waitForState(entry.diffInfo.map(d => d.changes.length > 0 ? d : undefined));
		await entry.reject();
		assert.strictEqual(model.getValue(), BASELINE);
		assert.deepStrictEqual(hunkEvents.map(e => e.kind), ['acceptFile', 'rejected']);
		assert.strictEqual(saves.length, 1);
	});

	test('a created file (empty baseline): undoing everything asks for the file to be deleted', async () => {
		const { entry, integration } = await showPending('', 'created');
		assert.strictEqual(entry.kind, 'created');
		await integration.rejectNearestChange(hunkWidgets()[0]);
		assert.strictEqual(model.getValue(), '');
		assert.deepStrictEqual(hunkEvents.map(e => e.kind), ['rejectFile']);
		assert.deepStrictEqual(saves, [], 'no empty file is written');

		hunkEvents.length = 0;
		model.setValue(DISK);
		await service.setBaseline(uri, '', 'created');
		await entry.reject();
		assert.deepStrictEqual(hunkEvents.map(e => e.kind), ['rejectFile']);
		assert.strictEqual(model.getValue(), DISK, 'file-level Undo of a created file leaves deletion to the engine');
	});

	test('setBaseline with an unchanged baseline (line endings aside) is a no-op; remove and clear drop entries', async () => {
		const { entry } = await showPending();
		const version = entry.originalModel.getVersionId();
		await service.setBaseline(uri, BASELINE);
		assert.strictEqual(entry.originalModel.getVersionId(), version);
		await service.setBaseline(uri, BASELINE.replace(/\n/g, '\r\n'), 'modified');
		assert.strictEqual(entry.originalModel.getVersionId(), version, 'a baseline that differs only in line endings is the same');
		service.remove(uri);
		assert.strictEqual(service.getEntry(uri), undefined);
		assert.strictEqual(registeredSessions[0].entries.get().length, 0);
		const again = await service.setBaseline(uri, BASELINE);
		await again!.getDiffInfo();
		service.clear();
		assert.strictEqual(registeredSessions[0].entries.get().length, 0);
	});

	test('hunks separated by a short unchanged line stay separate, with word-level inner changes', async () => {
		model.setValue('ONE\nTWO\nTHREE\n}\nThe quick red fox\n');
		const { entry } = await showPending('one\ntwo\nthree\n}\nThe quick brown fox\n');
		const changes = entry.diffInfo.get().changes;
		assert.strictEqual(changes.length, 2, 'not joined across the "}" line');
		const inner = changes[1].innerChanges!;
		assert.deepStrictEqual(inner.map(c => model.getValueInRange(c.modifiedRange)), ['red']);
	});

	test('the side-by-side diff is titled with agent-review wording', async () => {
		const { integration } = await showPending();
		const opened: IResourceDiffEditorInput[] = [];
		const editorService = insta.get(IEditorService);
		editorService.openEditor = (async (input: IResourceDiffEditorInput) => { opened.push(input); return undefined; }) as typeof editorService.openEditor;
		await integration.toggleDiff(undefined, true);
		assert.deepStrictEqual(opened.map(i => i.label), ['paper.tex (agent changes)']);
	});

	test('review commands use agent-review wording and the Agent Review category; Keep/Undo labels and keybindings are unchanged', () => {
		const desc = (action: { desc: Readonly<IAction2Options> }) => {
			const kb = action.desc.keybinding;
			const title = action.desc.title;
			return {
				title: typeof title === 'string' ? title : title.value,
				short: action.desc.shortTitle && (typeof action.desc.shortTitle === 'string' ? action.desc.shortTitle : action.desc.shortTitle.value),
				key: (Array.isArray(kb) ? kb[0] : kb)?.primary,
			};
		};
		const category = (action: { desc: Readonly<IAction2Options> }) => {
			const c = action.desc.category;
			return typeof c === 'string' ? c : c?.value;
		};
		const next = new (class extends NavigateAction { constructor() { super(true); } })();
		const prev = new (class extends NavigateAction { constructor() { super(false); } })();
		const actions = [next, prev, new AcceptAction(), new RejectAction(), new AcceptAllEditsAction(), new AcceptHunkAction(), new RejectHunkAction(), new ToggleDiffAction(), new ToggleAccessibleDiffViewAction()];
		assert.deepStrictEqual(actions.map(category), actions.map(() => 'Agent Review'), 'listed under "Agent Review", not "Chat"');
		assert.deepStrictEqual(
			actions.map(desc),
			[
				{ title: 'Go to Next Agent Change', short: undefined, key: KeyMod.Alt | KeyCode.F5 },
				{ title: 'Go to Previous Agent Change', short: undefined, key: KeyMod.Alt | KeyMod.Shift | KeyCode.F5 },
				{ title: 'Keep Agent Changes', short: 'Keep', key: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyY },
				{ title: 'Undo Agent Changes', short: 'Undo', key: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyN },
				{ title: 'Keep All Agent Changes', short: undefined, key: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyY },
				{ title: 'Keep this Change', short: 'Keep', key: KeyMod.CtrlCmd | KeyCode.KeyY },
				{ title: 'Undo this Change', short: 'Undo', key: KeyMod.CtrlCmd | KeyCode.KeyN },
				{ title: 'Toggle Diff Editor for Agent Changes', short: undefined, key: KeyMod.Alt | KeyMod.Shift | KeyCode.F7 },
				{ title: 'Show Accessible Diff View for Agent Changes', short: undefined, key: KeyCode.F7 },
			]);
	});

	test('a reload from disk (agent write) stays pending; a user keystroke outside hunks folds in', async () => {
		const { entry } = await showPending();

		// agent appends a line on disk -> TextFileEditorModel reloads via IModelService.updateModel(..., EditSources.reloadFromDisk())
		modelService.updateModel(model, DISK + 'Agent line.\n', EditSources.reloadFromDisk());
		await waitForState(entry.diffInfo.map(d => d.changes.length === 2 ? d : undefined));
		assert.ok(!entry.originalModel.getValue().includes('Agent line.'), 'agent write is not in the baseline');

		// user types on line 1 (outside any hunk) -> rebased into the baseline, not shown as pending
		model.applyEdits([EditOperation.replace(new Range(1, 1, 1, 6), 'Opening')]);
		await waitForState(entry.diffInfo.map(d => d.changes.length === 2 && entry.originalModel.getValue().startsWith('Opening') ? d : undefined));
		assert.ok(entry.originalModel.getValue().startsWith('Opening sentence.'));
	});
});
