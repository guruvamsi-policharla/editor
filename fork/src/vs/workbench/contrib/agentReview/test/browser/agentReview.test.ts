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
import { timeout } from '../../../../../base/common/async.js';
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
import { INotification, INotificationHandle, INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IChatWidgetService } from '../../../chat/browser/chat.js';
import { IChatEditingExplanationModelManager } from '../../../chat/browser/chatEditing/chatEditingExplanationModelManager.js';
import { IChatEditReviewSession, IChatEditingService, IModifiedFileEntryChangeHunk } from '../../../chat/common/editing/chatEditingService.js';
import { TestWorkerService } from '../../../inlineChat/test/browser/testWorkerService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IResourceDiffEditorInput } from '../../../../common/editor.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { IAction2Options } from '../../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
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
	// Opt-in, more realistic saves: dirty until a save of the current buffer finishes; saves can be held or fail.
	let trackSaves: boolean;
	let savedVersion: number;
	let holdSave: Promise<void> | undefined;
	let saveOutcome: 'ok' | 'cancelled' | 'error';
	let notifications: INotification[];

	setup(() => {
		zones = new Map();
		overlays = new Set();
		registeredSessions = [];
		hunkEvents = [];
		dirty = false;
		saves = [];
		trackSaves = false;
		savedVersion = -1;
		holdSave = undefined;
		saveOutcome = 'ok';
		notifications = [];

		const collection = new ServiceCollection();
		collection.set(IEditorWorkerService, new SyncDescriptor(TestWorkerService));
		collection.set(ITextModelService, new class extends mock<ITextModelService>() {
			override async createModelReference(resource: URI): Promise<IReference<IResolvedTextEditorModel>> {
				return { dispose: () => { }, object: { textEditorModel: modelService.getModel(resource) ?? model, getLanguageId: () => 'latex' } as IResolvedTextEditorModel };
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
				return dirty || (trackSaves && model.getAlternativeVersionId() !== savedVersion);
			}
			override async save(resource: URI, options?: ITextFileSaveOptions): Promise<URI | undefined> {
				saves.push(options);
				const version = model.getAlternativeVersionId();
				await holdSave;
				if (saveOutcome === 'error') {
					throw new Error('disk full');
				}
				if (saveOutcome === 'cancelled') {
					return undefined;
				}
				savedVersion = version;
				return resource;
			}
		}());
		collection.set(IChatWidgetService, new class extends mock<IChatWidgetService>() { }());
		collection.set(INotificationService, new class extends mock<INotificationService>() {
			override notify(notification: INotification): INotificationHandle {
				notifications.push(notification);
				return new class extends mock<INotificationHandle>() { }();
			}
		}());
		collection.set(IViewsService, new class extends mock<IViewsService>() {
			override readonly onDidChangeViewVisibility = Event.None;
		}());

		insta = store.add(store.add(workbenchInstantiationService(undefined, store)).createChild(collection));
		store.add(insta.get(IEditorWorkerService) as TestWorkerService);
		modelService = insta.get(IModelService);
		model = store.add(modelService.createModel(DISK, null, uri, false));
		service = store.add(insta.createInstance(AgentReviewService));

		editor = createEditor(insta);

		store.add(service.onDidHunkAction(e => hunkEvents.push(e)));
	});

	teardown(() => store.clear());

	/** A code editor without a DOM view: records view zones and overlay widgets instead. */
	function createEditor(instantiationService: TestInstantiationService): ITestCodeEditor {
		const e = store.add(instantiateTestCodeEditor(instantiationService, model));
		let zoneIds = 0;
		const accessor: IViewZoneChangeAccessor = {
			addZone: zone => { const id = String(++zoneIds); zones.set(id, zone); return id; },
			removeZone: id => { zones.delete(id); },
			layoutZone: () => { },
		};
		e.changeViewZones = callback => { callback(accessor); };
		e.addOverlayWidget = w => { overlays.add(w); };
		e.removeOverlayWidget = w => { overlays.delete(w); };
		e.layoutOverlayWidget = () => { };
		e.getTopForLineNumber = line => (line - 1) * 20;
		e.getScrollTop = () => 0;
		return e;
	}

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

	test('with word wrap on, deleted lines wrap like the editor\'s lines (a long LaTeX paragraph is not cut off)', async () => {
		editor.updateOptions({ wordWrap: 'wordWrapColumn', wordWrapColumn: 20 });
		await showPending('Intro sentence.\n' + 'This long paragraph was deleted by the agent, and all of it must stay readable.\n' + 'Closing sentence.\n');
		const deleted = [...zones.values()].filter(z => z.domNode.classList.contains('line-delete'));
		assert.strictEqual(deleted.length, 1);
		assert.ok(deleted[0].heightInLines! >= 4, `wrapped into several rows (got ${deleted[0].heightInLines})`);
	});

	test('a few words changed in a long line show as track changes (no red copy of the line); a rewrite keeps the red rows', async () => {
		const paragraph = 'We present a batched threshold encryption scheme in which the committee never runs a key generation protocol.';
		model.setValue(`Intro.\n${paragraph.replace('never runs', 'does not run')}\nUnchanged middle sentence.\nA completely different closing sentence.\n`);
		await showPending(`Intro.\n${paragraph}\nUnchanged middle sentence.\nClosing.\n`);
		const deletedZones = () => [...zones.values()].filter(z => z.domNode.classList.contains('line-delete'));
		const struck = model.getAllDecorations().filter(d => d.options.before?.inlineClassName === 'inline-deleted-text');

		assert.deepStrictEqual(struck.map(d => d.range.startLineNumber), [2], 'the deleted words, in the line');
		assert.ok(struck.map(d => d.options.before?.content).join('').includes('never'));
		assert.deepStrictEqual(deletedZones().map(z => z.afterLineNumber), [3], 'only the rewritten closing line gets red rows');
		assert.strictEqual(hunkWidgets().length, 2, 'both still have Keep/Undo');
	});

	test('a Keep/Undo toolbar with no room at the end of its hunk has its own row below it, so it never covers text', async () => {
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

	test('the toolbar sits at the end of the hunk\'s last line when it fits there, else in its own row', async () => {
		// A 7px-wide monospace font in an 800px-wide editor: about 110 columns.
		const getOption = editor.getOption.bind(editor);
		editor.getOption = (id => id === EditorOption.fontInfo ? { ...getOption(EditorOption.fontInfo), typicalHalfwidthCharacterWidth: 7 } : getOption(id)) as typeof editor.getOption;
		editor.getLayoutInfo = () => ({ ...getOption(EditorOption.layoutInfo), contentLeft: 50, contentWidth: 800, verticalScrollbarWidth: 14 });
		const long = 'x'.repeat(100);
		model.setValue(`a one\nb TWO\nc three\n${long} LONG\ne five\n`);
		await showPending(`a one\nb two\nc three\n${long} long\ne five\n`);

		const rows = [...zones.values()].filter(z => z.domNode.classList.contains('agent-review-hunk-toolbar-row'));
		assert.deepStrictEqual(rows.map(r => r.afterLineNumber), [4], 'only the line that runs to the edge gets a toolbar row');
		const widgets = hunkWidgets();
		assert.strictEqual(widgets.length, 2);
		const atEnd = widgets.filter(w => w.getDomNode().classList.contains('at-line-end'));
		assert.strictEqual(atEnd.length, 1);
		const position = atEnd[0].getPosition()?.preference;
		assert.ok(position && typeof position === 'object');
		assert.ok(position.left > 50 + 'b TWO'.length * 7, 'right of the text');
		assert.ok(position.top < editor.getTopForLineNumber(3), 'on line 2, not below it');
	});

	test('Ctrl+Y/Ctrl+N context: "cursor in a change" follows the file the editor shows, not the last integration created', async () => {
		// A real (scoped) context key service: the test default (MockContextKeyService) has no scopes.
		const contextKeys = store.add(new ContextKeyService(new TestConfigurationService()));
		editor = createEditor(store.add(insta.createChild(new ServiceCollection([IContextKeyService, contextKeys]))));
		const editorContext = editor.invokeWithinContext(accessor => accessor.get(IContextKeyService));
		const cursorInChange = () => editorContext.getContextKeyValue<boolean>('chatEdits.cursorInChangeRange');
		const { entry } = await showPending(); // paper.tex: the deleted line sits before line 2
		editor.setPosition({ lineNumber: 2, column: 1 });
		assert.strictEqual(cursorInChange(), true);

		// A second reviewed file is shown in the same editor (another tab in the group), then the first again.
		const uri2 = URI.parse('test:/notes.tex');
		const model2 = store.add(modelService.createModel('Kept.\nAgent line.\n', null, uri2, false));
		const entry2 = (await service.setBaseline(uri2, 'Kept.\n'))!;
		await waitForState(entry2.diffInfo.map(d => d.changes.length > 0 ? d : undefined));
		editor.setModel(model2);
		store.add(entry2.createEditorIntegration(editor));
		editor.setPosition({ lineNumber: 1, column: 1 });
		assert.strictEqual(cursorInChange(), false, 'line 1 of notes.tex is unchanged');
		editor.setPosition({ lineNumber: 2, column: 1 });
		assert.strictEqual(cursorInChange(), true);

		editor.setModel(model);
		editor.setPosition({ lineNumber: 2, column: 1 });
		assert.strictEqual(cursorInChange(), true, 'the integration of the hidden notes.tex must not reset it');
		editor.setPosition({ lineNumber: 1, column: 1 });
		assert.strictEqual(cursorInChange(), false);
		assert.ok(entry);
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

	test('Ctrl+Z after Keep puts the change back up for review (restore the previous baseline); Ctrl+Shift+Z keeps it again', async () => {
		const { integration } = await showPending();
		await integration.acceptNearestChange(hunkWidgets()[0]);
		assert.deepStrictEqual(hunkEvents.map(e => [e.kind, e.baseline]), [['accepted', DISK]]);

		await model.undo();
		assert.strictEqual(model.getValue(), DISK, 'the buffer is not touched');
		assert.deepStrictEqual(hunkEvents.slice(1).map(e => [e.kind, e.baseline]), [['restore', BASELINE]]);
		await model.redo();
		assert.deepStrictEqual(hunkEvents.slice(2).map(e => [e.kind, e.baseline]), [['restore', DISK]]);
		assert.deepStrictEqual(saves, []);
	});

	test('Ctrl+Z after Undo brings the agent text back as a pending change (saved, like the Undo), not as user typing', async () => {
		trackSaves = true;
		savedVersion = model.getAlternativeVersionId();
		const { entry, integration } = await showPending();
		await integration.rejectNearestChange(hunkWidgets()[0]);
		assert.strictEqual(model.getValue(), BASELINE);
		assert.strictEqual(saves.length, 1);

		await model.undo();
		assert.strictEqual(model.getValue(), DISK);
		await waitForState(entry.diffInfo.map(d => d.changes.length === 1 ? d : undefined));
		assert.strictEqual(entry.originalModel.getValue(), BASELINE, 'not folded into the baseline as if the user typed it');
		await timeout(10);
		assert.strictEqual(saves.length, 2, 'saved, so the disk shows the change again');
		assert.strictEqual(saves[1]?.skipSaveParticipants, true);

		await model.redo();
		assert.strictEqual(model.getValue(), BASELINE);
		await waitForState(entry.diffInfo.map(d => d.changes.length === 0 ? d : undefined));
		await timeout(10);
		assert.strictEqual(saves.length, 3);

		// The extension removes the entry once nothing is pending. Ctrl+Z still saves the agent text back to
		// disk, where the engine sees it as an external write and pushes the change again.
		service.remove(uri);
		await model.undo();
		assert.strictEqual(model.getValue(), DISK);
		await timeout(10);
		assert.strictEqual(saves.length, 4);
	});

	test('Undo never saves a buffer that has unsaved user edits', async () => {
		const { integration } = await showPending();
		dirty = true;
		await integration.rejectNearestChange(hunkWidgets()[0]);
		assert.strictEqual(model.getValue(), BASELINE);
		assert.deepStrictEqual(saves, []);
	});

	test('pressing Undo twice quickly saves both (the first save is still running)', async () => {
		model.setValue('a one\nb TWO\nc three\ne five\n');
		trackSaves = true;
		savedVersion = model.getAlternativeVersionId();
		const baseline = 'a one\nb two\nc three\nd four\ne five\n';
		const { entry, integration } = await showPending(baseline);
		assert.strictEqual(entry.changesCount.get(), 2);

		let release!: () => void;
		holdSave = new Promise<void>(r => release = r);
		const first = integration.rejectNearestChange(hunkWidgets()[0]);
		await waitForState(entry.diffInfo.map(d => d.changes.length === 1 ? d : undefined));
		for (let i = 0; i < 100 && saves.length === 0; i++) {
			await timeout(1);
		}
		assert.strictEqual(saves.length, 1, 'the first save has started');
		assert.ok(insta.get(ITextFileService).isDirty(uri), 'dirty while the first save runs');

		const second = integration.rejectNearestChange(hunkWidgets()[0]);
		release();
		await Promise.all([first, second]);
		assert.strictEqual(model.getValue(), baseline);
		assert.strictEqual(saves.length, 2, 'the second Undo is saved too');
		assert.strictEqual(insta.get(ITextFileService).isDirty(uri), false, 'disk matches the buffer');
		assert.deepStrictEqual(notifications, []);
	});

	test('if the save after Undo fails or is cancelled, the user is told the disk still has the agent text', async () => {
		trackSaves = true;
		savedVersion = model.getAlternativeVersionId();
		for (const outcome of ['cancelled', 'error'] as const) {
			saveOutcome = outcome;
			notifications.length = 0;
			model.setValue(DISK);
			savedVersion = model.getAlternativeVersionId();
			const { entry, integration } = await showPending();
			await integration.rejectNearestChange(hunkWidgets()[0]);
			assert.strictEqual(model.getValue(), BASELINE, 'the undo is in the buffer');
			assert.strictEqual(notifications.length, 1, outcome);
			assert.strictEqual(notifications[0].severity, Severity.Warning);
			assert.match(String(notifications[0].message), /isn't on disk yet/);
			integration.dispose();
			service.remove(uri);
			assert.ok(!service.getEntry(uri) && entry);
		}
	});

	test('file Undo with unsaved user edits stays in the buffer (dirty), keeps those edits, and says so', async () => {
		const { entry } = await showPending();
		// the user types on line 1, outside the change: folded into the baseline model, not pending
		model.applyEdits([EditOperation.replace(new Range(1, 1, 1, 6), 'Opening')]);
		await waitForState(entry.diffInfo.map(d => entry.originalModel.getValue().startsWith('Opening') ? d : undefined));
		dirty = true;

		assert.strictEqual(await entry.rejectFile(), 'unsaved');
		assert.strictEqual(model.getValue(), 'Opening sentence.\nThis sentence was deleted by the agent.\nClosing sentence.\n');
		assert.deepStrictEqual(saves, [], 'never saved for the user');

		dirty = false;
		await service.setBaseline(uri, BASELINE);
		model.setValue(DISK);
		await waitForState(entry.diffInfo.map(d => d.changes.length > 0 ? d : undefined));
		assert.strictEqual(await entry.rejectFile(), 'saved');
		assert.strictEqual(saves.length, 1);
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
