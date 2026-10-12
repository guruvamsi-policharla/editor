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
import { AgentReviewSaveParticipants, IAgentReviewWillWriteEvent } from '../../browser/agentReviewSaveParticipant.js';
import { IAgentReviewService } from '../../browser/agentReviewService.js';
import { AgentReviewEntry } from '../../browser/agentReviewEntry.js';

suite('AgentReview: save attribution with format on save', () => {

	const disposables = new DisposableStore();
	let instantiationService: TestInstantiationService;
	let accessor: TestServiceAccessor;
	let events: { event: IAgentReviewWillWriteEvent; text: string }[];
	let model: IResolvedTextFileEditorModel;
	/** The review's baseline of the file, when it has pending changes. */
	let reviewBaseline: string | undefined;

	setup(async function () {
		events = [];
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
		}));

		model = disposables.add(instantiationService.createInstance(TextFileEditorModel, toResource.call(this, '/path/settings.ini'), 'utf8', undefined) as IResolvedTextFileEditorModel);
		await model.resolve();
		model.textEditorModel.setValue('alpha=1\nbeta = 2\n');
		await model.save({ reason: SaveReason.EXPLICIT });
		events.length = 0;
	});

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
		assert.strictEqual(model.textEditorModel.getValue(), 'alpha=1\n');
	});
});
