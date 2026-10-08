/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agent write vs. unsaved edits: the 3-way merge (base, agent's version on disk, the user's buffer)
// runs in VS Code's merge editor. Neither side is lost or written, and the result starts as the
// auto-merge with only the true conflict left to resolve.

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IEditorWorkerService } from '../../../../../editor/common/services/editorWorker.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { TextFileEditorModelManager } from '../../../../services/textfile/common/textFileEditorModelManager.js';
import { ITextFileEditorModel } from '../../../../services/textfile/common/textfiles.js';
import { TestServiceAccessor, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { TestWorkerService } from '../../../inlineChat/test/browser/testWorkerService.js';
import { MergeEditorInput } from '../../../mergeEditor/browser/mergeEditorInput.js';
import { AGENT_REVIEW_MERGE_SCHEME, closeOrphanedAgentReviewMerges, openAgentReviewMerge } from '../../browser/agentReviewMerge.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { INotification, INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IEditorIdentifier } from '../../../../common/editor.js';

suite('AgentReview: 3-way merge for agent writes under unsaved edits', () => {

	const disposables = new DisposableStore();
	const uri = URI.file('/ws/paper.tex');
	const BASE = 'Title.\n\nIntro.\n\nMethods.\n\nResults.\n';
	// The agent rewrote Intro and Results; the user, with unsaved edits, rewrote Title and Results.
	const AGENT = 'Title.\n\nA better intro.\n\nMethods.\n\nAgent results.\n';
	const YOURS = 'My title.\n\nIntro.\n\nMethods.\n\nMy results.\n';

	let insta: IInstantiationService;
	let accessor: TestServiceAccessor;
	let model: ITextFileEditorModel;

	setup(async () => {
		const base = workbenchInstantiationService(undefined, disposables);
		insta = disposables.add(base.createChild(new ServiceCollection([IEditorWorkerService, new SyncDescriptor(TestWorkerService)])));
		disposables.add(insta.invokeFunction(a => a.get(IEditorWorkerService)) as TestWorkerService);
		accessor = insta.createInstance(TestServiceAccessor);
		disposables.add(<TextFileEditorModelManager>accessor.textFileService.files);

		accessor.fileService.setContent(BASE);
		model = await accessor.textFileService.files.resolve(uri);
		model.textEditorModel!.setValue(YOURS); // unsaved edits
		accessor.fileService.setContent(AGENT); // the agent writes the file; the dirty buffer is not reloaded
	});

	teardown(() => disposables.clear());

	ensureNoDisposablesAreLeakedInTestSuite();

	const models = () => insta.invokeFunction(a => a.get(IModelService));

	/** Closing the merge editor disposes its input; the snapshots go right after. */
	async function close(input: MergeEditorInput) {
		input.dispose();
		await Promise.resolve();
	}

	function open(base = BASE) {
		return insta.invokeFunction(openAgentReviewMerge, uri, { base, noOpen: true });
	}

	test('both sides are snapshotted, nothing is written, and the result is the auto-merge with one conflict', async () => {
		const writesBefore = accessor.fileService.writeOperations.length;
		const merge = (await open())!;

		assert.strictEqual(merge.yours, YOURS, 'the user\'s buffer is kept as input 2');
		assert.strictEqual(merge.theirs, AGENT, 'the agent\'s version is input 1');
		assert.strictEqual(merge.input.input1.uri.scheme, AGENT_REVIEW_MERGE_SCHEME);
		assert.strictEqual(models().getModel(merge.input.input2.uri)?.getValue(), YOURS);
		assert.strictEqual(models().getModel(merge.input.base)?.getValue(), BASE);
		assert.strictEqual(merge.input.result.toString(), uri.toString(), 'the result is the file itself');
		assert.strictEqual(accessor.fileService.writeOperations.length, writesBefore, 'nothing is written before the merge is completed');

		// Auto-merge: the user's title and the agent's intro are both in; Results (changed by both) is a conflict at base.
		const inputModel = await merge.input.resolve();
		assert.strictEqual(model.textEditorModel!.getValue(), 'My title.\n\nA better intro.\n\nMethods.\n\nResults.\n');
		assert.strictEqual(inputModel.model.unhandledConflictsCount.get(), 1);
		assert.ok(model.isDirty(), 'the merge result is unsaved until the user completes the merge');
		await close(merge.input);
		await model.revert(); // "Don't Save"
	});

	test('nothing to merge without unsaved edits', async () => {
		await model.revert();
		assert.strictEqual(await open(), undefined);
		assert.strictEqual(model.textEditorModel!.getValue(), AGENT);
	});

	test('the merge models go away with the merge editor', async () => {
		const merge = (await open())!;
		const resources = [merge.input.base, merge.input.input1.uri, merge.input.input2.uri];
		await close(merge.input);
		await model.revert();
		for (const r of resources) {
			assert.strictEqual(models().getModel(r), null);
		}
	});

	test('a merge restored after a restart (its snapshots gone) is closed, with a message, instead of failing to open', async () => {
		const merge = (await insta.invokeFunction(openAgentReviewMerge, uri, { base: BASE, noOpen: true }))!;
		const closed: unknown[] = [];
		const notifications: INotification[] = [];
		const child = insta.createChild(new ServiceCollection(
			[IEditorService, new class extends mock<IEditorService>() {
				override getEditors() { return [{ editor: merge.input, groupId: 1 }]; }
				override async closeEditors(editors: readonly IEditorIdentifier[]) { closed.push(...editors.map(e => e.editor)); }
			}()],
			[INotificationService, new class extends mock<INotificationService>() {
				override notify(n: INotification) { notifications.push(n); return undefined!; }
			}()],
		));
		try {
			assert.strictEqual(await child.invokeFunction(closeOrphanedAgentReviewMerges), 0, 'a merge whose snapshots exist stays');
			await close(merge.input); // as after a restart: the restored input's snapshots don't exist
			assert.strictEqual(await child.invokeFunction(closeOrphanedAgentReviewMerges), 1);
			assert.deepStrictEqual(closed, [merge.input]);
			assert.match(String(notifications[0].message), /paper\.tex could not be reopened/);
		} finally {
			child.dispose();
			await model.revert();
		}
	});
});
