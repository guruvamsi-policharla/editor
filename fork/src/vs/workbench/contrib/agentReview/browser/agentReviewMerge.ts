/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agent review: an agent wrote a file while the user has unsaved edits in it. Resolve the conflict in
// VS Code's 3-way merge editor:
//   base   = the text both sides started from (the extension passes it: the last text the buffer and the
//            disk agreed on, or the accepted baseline)
//   input1 = the agent's version (the file on disk)
//   input2 = the user's unsaved buffer
//   result = the file itself
// Neither side is lost: both are snapshotted into read-only models before anything changes. The merge
// editor saves its result file before it starts, so the file model is first reloaded from disk (the
// user's text lives on in input2); nothing is written until the user completes the merge. The result
// then starts as the merge editor's own auto-merge (non-conflicting changes from both sides applied,
// conflicts left to the user).

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { waitForState } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { createTextBufferFactory } from '../../../../editor/common/model/textModel.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { MergeEditorInput, MergeEditorInputData } from '../../mergeEditor/browser/mergeEditorInput.js';

export const AGENT_REVIEW_MERGE_SCHEME = 'agent-review-merge';

export interface IAgentReviewMergeOptions {
	/** The common ancestor of the disk and buffer versions. */
	readonly base: string;
	/** Do not open the editor, only prepare the merge (tests). */
	readonly noOpen?: boolean;
}

export interface IAgentReviewMerge {
	readonly input: MergeEditorInput;
	/** The agent's version, as it was on disk. */
	readonly theirs: string;
	/** The user's unsaved buffer, as it was. */
	readonly yours: string;
}

let mergeIds = 0;

/**
 * Open the 3-way merge editor for a file with unsaved edits that changed on disk. Returns undefined
 * if there is nothing to merge (the file has no unsaved edits, or isn't a text file model).
 */
export async function openAgentReviewMerge(accessor: ServicesAccessor, uri: URI, options: IAgentReviewMergeOptions): Promise<IAgentReviewMerge | undefined> {
	const textFileService = accessor.get(ITextFileService);
	const modelService = accessor.get(IModelService);
	const languageService = accessor.get(ILanguageService);
	const editorService = accessor.get(IEditorService);
	const instantiationService = accessor.get(IInstantiationService);
	const textModelService = accessor.get(ITextModelService);

	const fileModel = textFileService.files.get(uri);
	if (!fileModel?.textEditorModel || !fileModel.isDirty()) {
		return undefined;
	}
	const textModel = fileModel.textEditorModel;
	const store = new DisposableStore();
	// The merge editor resolves its inputs through the text model service.
	store.add(textModelService.registerTextModelContentProvider(AGENT_REVIEW_MERGE_SCHEME, {
		provideTextContent: async resource => modelService.getModel(resource),
	}));
	const id = ++mergeIds;
	const snapshot = (side: string, text: string) => {
		const resource = URI.from({ scheme: AGENT_REVIEW_MERGE_SCHEME, path: uri.path, query: `${side}-${id}` });
		return store.add(modelService.createModel(createTextBufferFactory(text), languageService.createById(textModel.getLanguageId()), resource, false)).uri;
	};

	const yours = textModel.getValue();
	let reverted = false;
	try {
		const yoursUri = snapshot('yours', yours);
		// Reload from disk. The merge editor saves its result before it starts: it must not save the buffer.
		await fileModel.revert();
		reverted = true;
		if (fileModel.isDirty()) {
			throw new Error(`could not reload ${uri.toString()} from disk`);
		}
		const theirs = textModel.getValue();
		const theirsUri = snapshot('theirs', theirs);
		const baseUri = snapshot('base', options.base);

		const input = instantiationService.createInstance(
			MergeEditorInput,
			baseUri,
			new MergeEditorInputData(theirsUri, localize('agentReview.merge.theirs', "Agent"), undefined, localize('agentReview.merge.theirsDescription', "on disk")),
			new MergeEditorInputData(yoursUri, localize('agentReview.merge.yours', "Yours"), undefined, localize('agentReview.merge.yoursDescription', "unsaved edits")),
			uri,
		);
		// After the merge model lets go of them (the input disposes it right after this event, synchronously).
		store.add(input.onWillDispose(() => queueMicrotask(() => store.dispose())));
		const inputModel = await input.resolve();
		await inputModel.model.reset(); // start from the auto-merge, not from the agent's version
		await waitForState(inputModel.model.isUpToDate, upToDate => upToDate); // open with the result diffed: no flicker
		if (!options.noOpen) {
			await editorService.openEditor(input, { pinned: true });
		}
		return { input, theirs, yours };
	} catch (err) {
		if (reverted) {
			// Put the user's text back (undoable) rather than losing it with the snapshot.
			textModel.pushEditOperations(null, [{ range: textModel.getFullModelRange(), text: yours }], () => null);
		}
		store.dispose();
		throw err;
	}
}
