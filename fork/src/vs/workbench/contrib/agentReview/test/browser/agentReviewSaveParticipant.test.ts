/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agent review save attribution with format on save enabled: the real save participants (including
// FormatOnSaveParticipant and a registered formatter) run between our first and last participants, so
// the extension learns which buffer versions were the user's and which were made by the formatter.

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite, toResource } from '../../../../../base/test/common/utils.js';
import { EditOperation } from '../../../../../editor/common/core/editOperation.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { TextEdit } from '../../../../../editor/common/languages.js';
import { IEditorWorkerService } from '../../../../../editor/common/services/editorWorker.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { FormattingConflicts } from '../../../../../editor/contrib/format/browser/format.js';
import { TestCommandService } from '../../../../../editor/test/browser/editorTestServices.js';
import { TestEditorWorkerService } from '../../../../../editor/test/common/services/testEditorWorkerService.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { SaveReason } from '../../../../common/editor.js';
import { TextFileEditorModel } from '../../../../services/textfile/common/textFileEditorModel.js';
import { TextFileEditorModelManager } from '../../../../services/textfile/common/textFileEditorModelManager.js';
import { IResolvedTextFileEditorModel, ITextFileSaveParticipant } from '../../../../services/textfile/common/textfiles.js';
import { TestServiceAccessor, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { SaveParticipantsContribution } from '../../../codeEditor/browser/saveParticipants.js';
import { AgentReviewSaveParticipants, IAgentReviewDidWriteEvent, IAgentReviewWillWriteEvent } from '../../browser/agentReviewSaveParticipant.js';
import { IAgentReviewService } from '../../browser/agentReviewService.js';
import { AgentReviewEntry } from '../../browser/agentReviewEntry.js';

suite('AgentReview: save attribution with format on save', () => {

	const disposables = new DisposableStore();
	let instantiationService: TestInstantiationService;
	let accessor: TestServiceAccessor;
	let events: { event: IAgentReviewWillWriteEvent; text: string }[];
	let didWrites: IAgentReviewDidWriteEvent[];
	/** Runs inside the extension's onWillWrite handler (e.g. the user typing while it is delivered). */
	let onWillWrite: (() => Promise<void> | void) | undefined;
	let model: IResolvedTextFileEditorModel;
	/** The review's baseline of the file, when it has pending changes. */
	let reviewBaseline: string | undefined;

	setup(async function () {
		events = [];
		didWrites = [];
		onWillWrite = undefined;
		reviewBaseline = undefined;
		instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.stub(IAgentReviewService, {
			getEntry: () => reviewBaseline === undefined ? undefined : { originalModel: { getValue: () => reviewBaseline } } as unknown as AgentReviewEntry,
		});
		accessor = instantiationService.createInstance(TestServiceAccessor);
		instantiationService.stub(ICommandService, new TestCommandService(instantiationService));
		instantiationService.stub(IEditorWorkerService, new class extends TestEditorWorkerService {
			override async computeMoreMinimalEdits(_resource: URI, edits: TextEdit[] | null | undefined) { return edits ?? undefined; }
		});
		disposables.add(<TextFileEditorModelManager>accessor.textFileService.files);

		// Format on save: on, whole file, with a formatter that normalizes `a=b` to `a = b`.
		accessor.testConfigurationService.setUserConfiguration('editor', { formatOnSave: true, formatOnSaveMode: 'file' });
		disposables.add(instantiationService.invokeFunction(a => a.get(ILanguageFeaturesService)).documentFormattingEditProvider.register('*', {
			provideDocumentFormattingEdits: m => {
				const edits = [];
				for (let line = 1; line <= m.getLineCount(); line++) {
					const text = m.getLineContent(line);
					const formatted = text.replace(/\s*=\s*/, ' = ');
					if (formatted !== text) {
						edits.push({ range: new Range(line, 1, line, text.length + 1), text: formatted });
					}
				}
				return edits;
			}
		}));

		// The workbench installs a selector that picks the default formatter; take the only one.
		disposables.add(FormattingConflicts.setFormatterSelector(async formatters => formatters[0]));

		// The real core save participants (format on save, trim whitespace, ...), then ours.
		disposables.add(instantiationService.createInstance(SaveParticipantsContribution));
		disposables.add(instantiationService.createInstance(AgentReviewSaveParticipants));

		disposables.add(CommandsRegistry.registerCommand('agentReview.ext.onWillWrite', (_accessor, event: IAgentReviewWillWriteEvent) => {
			events.push({ event, text: model.textEditorModel.getValue() });
			return onWillWrite?.();
		}));
		disposables.add(CommandsRegistry.registerCommand('agentReview.ext.onDidWrite', (_accessor, event: IAgentReviewDidWriteEvent) => {
			didWrites.push(event);
		}));

		model = disposables.add(instantiationService.createInstance(TextFileEditorModel, toResource.call(this, '/path/settings.ini'), 'utf8', undefined) as IResolvedTextFileEditorModel);
		await model.resolve();
		model.textEditorModel.setValue('alpha=1\nbeta = 2\n');
		await model.save({ reason: SaveReason.EXPLICIT });
		events.length = 0;
		didWrites.length = 0;
	});

	/** A keystroke at the end of the buffer, as the user typing on. */
	function type(text: string): void {
		model.textEditorModel.applyEdits([EditOperation.insert(model.textEditorModel.getFullModelRange().getEndPosition(), text)]);
	}

	teardown(() => disposables.clear());

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the formatter runs between the user version and the written version', async () => {
		// The user edits line 2 by hand (unformatted); format on save then rewrites it.
		model.textEditorModel.applyEdits([EditOperation.replace(new Range(2, 1, 2, 9), 'gamma=3')]);
		const userVersion = model.textEditorModel.getVersionId();
		await model.save({ reason: SaveReason.EXPLICIT });

		assert.strictEqual(events.length, 1);
		const [{ event, text }] = events;
		assert.strictEqual(event.uri.toString(), model.resource.toString());
		assert.strictEqual(event.userVersion, userVersion, 'the version before save participants is the last user edit');
		assert.ok(event.version > userVersion, 'the formatter edit comes after the user version');
		assert.strictEqual(event.version, model.textEditorModel.getVersionId(), 'nothing changes after the report');
		assert.strictEqual(text, 'alpha = 1\ngamma = 3\n', 'reported right before the write, with the formatter edits applied');
		assert.strictEqual(event.userText, 'alpha = 1\ngamma=3\n', 'the text as the user left it, before the formatter');
	});

	test('no userText when no participant changed the buffer', async () => {
		model.textEditorModel.applyEdits([EditOperation.replace(new Range(2, 1, 2, 9), 'gamma = 3')]);
		await model.save({ reason: SaveReason.EXPLICIT });
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].event.userVersion, events[0].event.version);
		assert.strictEqual(events[0].event.userText, undefined);
	});

	test('runs after participants added later, so their edits are reported too', async () => {
		const late: ITextFileSaveParticipant = {
			participate: async m => { m.textEditorModel?.applyEdits([EditOperation.insert(m.textEditorModel.getFullModelRange().getEndPosition(), '# end\n')]); }
		};
		disposables.add(accessor.textFileService.files.addSaveParticipant(late));
		model.textEditorModel.applyEdits([EditOperation.insert(model.textEditorModel.getFullModelRange().getEndPosition(), 'delta = 4\n')]);
		const userVersion = model.textEditorModel.getVersionId();
		await model.save({ reason: SaveReason.EXPLICIT });

		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].event.userVersion, userVersion);
		assert.strictEqual(events[0].text, 'alpha = 1\nbeta = 2\ndelta = 4\n# end\n');
	});

	test('a file under review: the review\'s baseline is reported with the write (the engine takes it as the new baseline)', async () => {
		model.textEditorModel.applyEdits([EditOperation.replace(new Range(2, 1, 2, 9), 'gamma = 3')]);
		await model.save({ reason: SaveReason.EXPLICIT });
		assert.strictEqual(events[0].event.baseline, undefined, 'not under review: no baseline');

		reviewBaseline = 'alpha = 1\nbeta = 2\n';
		model.textEditorModel.applyEdits([EditOperation.replace(new Range(2, 1, 2, 10), 'gamma = 4')]);
		await model.save({ reason: SaveReason.EXPLICIT });
		assert.strictEqual(events[1].event.baseline, 'alpha = 1\nbeta = 2\n');
	});

	test('saves that skip participants (an Undo in the review UI) are not reported', async () => {
		model.textEditorModel.setValue('alpha=1\n');
		await model.save({ reason: SaveReason.EXPLICIT, skipSaveParticipants: true });
		assert.deepStrictEqual(events, []);
		assert.deepStrictEqual(didWrites, []);
		assert.strictEqual(model.textEditorModel.getValue(), 'alpha=1\n');
	});

	test('after the write, the extension hears that it happened; nothing more when the write is what was reported', async () => {
		type('gamma = 3\n');
		await model.save({ reason: SaveReason.EXPLICIT });
		assert.strictEqual(events.length, 1);
		assert.deepStrictEqual(didWrites.map(e => [e.uri.toString(), e.text]), [[model.resource.toString(), undefined]]);
	});

	test('typing while the extension is told: the save is reported again, so the report is what is written', async () => {
		type('gamma = 3\n');
		let typed = false;
		onWillWrite = () => {
			if (!typed) {
				typed = true;
				type('delta'); // a keystroke while the report is delivered
			}
		};
		await model.save({ reason: SaveReason.EXPLICIT });
		assert.strictEqual(events.length, 2);
		assert.strictEqual(events[0].event.again, undefined);
		assert.strictEqual(events[1].event.again, true, 'a repeat of the same save');
		assert.strictEqual(events[1].text, 'alpha = 1\nbeta = 2\ngamma = 3\ndelta', 'with the typing');
		assert.strictEqual(events[1].event.version, model.textEditorModel.getVersionId());
		assert.strictEqual(model.isDirty(), false, 'the written version is the one reported last');
		assert.deepStrictEqual(didWrites.map(e => e.text), [undefined], 'the last report was exact');
	});

	test('typing through every repeat: the extension gets the written text after the write', async () => {
		type('gamma = 3\n');
		onWillWrite = () => type('x');
		await model.save({ reason: SaveReason.EXPLICIT });
		assert.strictEqual(events.length, 4, 'bounded');
		assert.strictEqual(model.isDirty(), false);
		assert.strictEqual(model.textEditorModel.getValue(), 'alpha = 1\nbeta = 2\ngamma = 3\nxxxx');
		assert.deepStrictEqual(didWrites.map(e => e.text), ['alpha = 1\nbeta = 2\ngamma = 3\nxxxx'], 'what was written, not the last report');
	});

	test('a report that times out: the extension gets the written text after the write, with the review\'s baseline', async function () {
		this.timeout(10_000);
		reviewBaseline = 'alpha = 1\nbeta = 2\n';
		type('gamma = 3\n');
		onWillWrite = () => new Promise<void>(() => { }); // the extension host is busy
		await model.save({ reason: SaveReason.EXPLICIT });
		assert.strictEqual(events.length, 1);
		assert.deepStrictEqual(didWrites.map(e => [e.text, e.baseline]), [['alpha = 1\nbeta = 2\ngamma = 3\n', 'alpha = 1\nbeta = 2\n']]);
	});
});
