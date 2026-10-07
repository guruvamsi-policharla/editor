/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Phase 0 spike test: proves that an engine-style baseline pushed into core renders through the
// reused chat-editing UI as (1) a view zone holding the deleted baseline lines as real editor rows
// and (2) a per-hunk Accept/Reject widget, and that Accept moves the baseline while Reject rewrites
// the buffer. Also checks that a reload from disk (an agent write) stays pending.

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, IReference } from '../../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { constObservable, waitForState } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IOverlayWidget, IViewZone, IViewZoneChangeAccessor } from '../../../../../editor/browser/editorBrowser.js';
import { EditOperation } from '../../../../../editor/common/core/editOperation.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IEditorWorkerService } from '../../../../../editor/common/services/editorWorker.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IResolvedTextEditorModel, ITextModelContentProvider, ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { EditSources } from '../../../../../editor/common/textModelEditSource.js';
import { instantiateTestCodeEditor, ITestCodeEditor } from '../../../../../editor/test/browser/testCodeEditor.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { IChatWidgetService } from '../../../chat/browser/chat.js';
import { IChatEditingExplanationModelManager } from '../../../chat/browser/chatEditing/chatEditingExplanationModelManager.js';
import { IChatEditReviewSession, IChatEditingService, IModifiedFileEntryChangeHunk } from '../../../chat/common/editing/chatEditingService.js';
import { TestWorkerService } from '../../../inlineChat/test/browser/testWorkerService.js';
import { IAgentReviewHunkEvent } from '../../browser/agentReviewEntry.js';
import { AgentReviewService } from '../../browser/agentReviewService.js';

suite('AgentReview spike: engine baseline rendered by chat-editing UI', () => {

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

	setup(() => {
		zones = new Map();
		overlays = new Set();
		registeredSessions = [];
		hunkEvents = [];

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
		collection.set(IChatWidgetService, new class extends mock<IChatWidgetService>() { }());
		collection.set(IViewsService, new class extends mock<IViewsService>() {
			override readonly onDidChangeViewVisibility = Event.None;
		}());

		const insta = store.add(store.add(workbenchInstantiationService(undefined, store)).createChild(collection));
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

	async function showPending() {
		const entry = (await service.setBaseline(uri, BASELINE))!;
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

	test('deleted baseline lines render as real rows in a view zone, with one Accept/Reject widget', async () => {
		await showPending();

		assert.strictEqual(zones.size, 1, 'one view zone for the deleted block');
		const zone = [...zones.values()][0];
		assert.strictEqual(zone.afterLineNumber, 1, 'deleted block sits after line 1');
		assert.strictEqual(zone.heightInLines, 1, 'one deleted row');
		assert.ok(zone.domNode.classList.contains('line-delete'));
		assert.ok(zone.domNode.classList.contains('view-lines'), 'rendered with editor line markup (renderLines)');
		// the line renderer emits non-breaking spaces, exactly like real editor rows
		assert.ok(zone.domNode.textContent?.replace(/\u00a0/g, ' ').includes('This sentence was deleted by the agent.'));

		assert.strictEqual(hunkWidgets().length, 1, 'one per-hunk toolbar');
	});

	test('Accept folds the hunk into the baseline and leaves the buffer alone', async () => {
		const { entry, integration } = await showPending();
		await integration.acceptNearestChange(hunkWidgets()[0]);

		assert.strictEqual(entry.originalModel.getValue(), DISK);
		assert.strictEqual(model.getValue(), DISK);
		assert.strictEqual(entry.changesCount.get(), 0);
		assert.strictEqual(zones.size, 0);
		assert.deepStrictEqual(hunkEvents.map(e => [e.kind, e.baseline]), [['accepted', DISK]]);
	});

	test('Reject writes the baseline text back into the buffer', async () => {
		const { entry, integration } = await showPending();
		await integration.rejectNearestChange(hunkWidgets()[0]);

		assert.strictEqual(model.getValue(), BASELINE);
		assert.strictEqual(entry.originalModel.getValue(), BASELINE);
		assert.strictEqual(entry.changesCount.get(), 0);
		assert.strictEqual(hunkEvents.at(-1)?.kind, 'rejected');
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
