/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agent review wiring. The built-in agent-review extension (which hosts the review engine) talks to
// this contribution through internal commands, so no extension-host protocol changes are needed:
//   extension -> core: `_agentReview.setBaseline(uri, baselineText, kind)`, `_agentReview.remove(uri)`, `_agentReview.clear()`,
//                      `_agentReview.openMerge(uri, baseText)` (agent write vs. unsaved edits, see agentReviewMerge.ts),
//                      `_agentReview.pushUndo(uri, label, action)` (Ctrl+Z of a review action done in the extension)
//   core -> extension: `agentReview.ext.onDidHunkAction({ uri, kind, baseline? })`,
//                      `agentReview.ext.onWillWrite({ uri, userVersion, version, userText?, baseline? })` (see agentReviewSaveParticipant.ts),
//                      `agentReview.ext.undoRedo(action, 'undo' | 'redo')`
// A typed proposed API can replace the commands later.

import './media/agentReview.css';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { RedoCommand, UndoCommand } from '../../../../editor/browser/editorExtensions.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { AgentReviewKind, MERGE_EDITOR_ID } from './agentReviewEntry.js';
import { closeOrphanedAgentReviewMerges } from './agentReviewMerge.js';
import { AgentReviewSaveParticipants } from './agentReviewSaveParticipant.js';
import { AgentReviewService, IAgentReviewService } from './agentReviewService.js';

registerSingleton(IAgentReviewService, AgentReviewService, InstantiationType.Delayed);

/** True when the active editor shows a file with pending agent changes. */
export const ctxAgentReviewIsActive = new RawContextKey<boolean>('agentReview.isActive', false, localize('agentReview.isActive', "Whether the active editor has pending agent changes"));

CommandsRegistry.registerCommand('_agentReview.setBaseline', async (accessor: ServicesAccessor, uri: UriComponents, baseline: string, kind?: AgentReviewKind) => {
	await accessor.get(IAgentReviewService).setBaseline(URI.revive(uri), baseline, kind === 'created' ? 'created' : 'modified');
});

CommandsRegistry.registerCommand('_agentReview.remove', (accessor: ServicesAccessor, uri: UriComponents) => {
	accessor.get(IAgentReviewService).remove(URI.revive(uri));
});

CommandsRegistry.registerCommand('_agentReview.clear', (accessor: ServicesAccessor) => {
	accessor.get(IAgentReviewService).clear();
});

/**
 * Undo all pending changes of a file in its editor buffer (as the overlay's file Undo). Used by the extension
 * for files with unsaved edits, which it must not write itself. Returns 'saved', 'unsaved' (the undo is in the
 * buffer only; the user's unsaved edits keep it dirty), 'deleted' (created file), or undefined (not shown).
 */
CommandsRegistry.registerCommand('_agentReview.reject', (accessor: ServicesAccessor, uri: UriComponents): Promise<'saved' | 'unsaved' | 'deleted' | 'cancelled'> | undefined => {
	return accessor.get(IAgentReviewService).getEntry(URI.revive(uri))?.rejectFile();
});

/**
 * Put a review action the extension did (Keep Deletion, Restore File, Keep/Undo from the Agent Changes list) on the
 * file's undo stack. Ctrl+Z / Ctrl+Shift+Z run `agentReview.ext.undoRedo(action, 'undo' | 'redo')` in the extension.
 */
CommandsRegistry.registerCommand('_agentReview.pushUndo', (accessor: ServicesAccessor, uri: UriComponents, label: string, action: unknown) => {
	const commandService = accessor.get(ICommandService);
	const run = (which: 'undo' | 'redo') => commandService.executeCommand('agentReview.ext.undoRedo', action, which);
	accessor.get(IAgentReviewService).pushUndo(URI.revive(uri), label, () => run('undo'), () => run('redo'));
});

// Ctrl+Z / Ctrl+Shift+Z where no file's text editor has focus (the Agent Changes list, the Explorer, a deletion's review):
// the latest review action. In a file's editor, its own undo stack has them in order with the typing. Below the
// Explorer's own file operations (110).
const UNDO_PRIORITY = 105;
/**
 * Whether a text editor with a file of its own has focus (then Ctrl+Z is that file's). The extension's read-only views
 * (a deletion's review, the accepted text) have no undo of their own: there it is the review's.
 */
function hasEditorFocus(accessor: ServicesAccessor): boolean {
	const scheme = accessor.get(ICodeEditorService).getFocusedCodeEditor()?.getModel()?.uri.scheme;
	return scheme !== undefined && scheme !== 'agent-review-deleted' && scheme !== 'agent-review-accepted';
}

UndoCommand.addImplementation(UNDO_PRIORITY, 'agentReview', (accessor: ServicesAccessor) => {
	if (hasEditorFocus(accessor)) {
		return false;
	}
	return accessor.get(IAgentReviewService).undoOutsideEditors(false) ?? false;
});
RedoCommand.addImplementation(UNDO_PRIORITY, 'agentReview', (accessor: ServicesAccessor) => {
	if (hasEditorFocus(accessor)) {
		return false;
	}
	return accessor.get(IAgentReviewService).undoOutsideEditors(true) ?? false;
});

CommandsRegistry.registerCommand('_agentReview.openMerge', (accessor: ServicesAccessor, uri: UriComponents, base: string): Promise<boolean> => {
	return accessor.get(IAgentReviewService).openMerge(URI.revive(uri), base);
});

class AgentReviewBridge extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.agentReviewBridge';
	constructor(
		@IAgentReviewService agentReviewService: IAgentReviewService,
		@ICommandService commandService: ICommandService,
		@ILogService logService: ILogService,
	) {
		super();
		this._register(agentReviewService.onDidHunkAction(e => {
			commandService.executeCommand('agentReview.ext.onDidHunkAction', { uri: e.uri, kind: e.kind, baseline: e.baseline })
				.catch(err => logService.warn('[agentReview] hunk action not delivered to the agent-review extension', err));
		}));
	}
}
registerWorkbenchContribution2(AgentReviewBridge.ID, AgentReviewBridge, WorkbenchPhase.AfterRestored);

// Tells the extension which buffer edits of a save were made by save participants (formatters), not the user.
registerWorkbenchContribution2(AgentReviewSaveParticipants.ID, AgentReviewSaveParticipants, WorkbenchPhase.BlockRestore);

/** Keeps `agentReview.isActive` in sync with the active editor (enables the ↑/↓ navigation without chat). */
class AgentReviewEditorState extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.agentReviewEditorState';

	constructor(
		@IAgentReviewService agentReviewService: IAgentReviewService,
		@IEditorService editorService: IEditorService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		const isActive = ctxAgentReviewIsActive.bindTo(contextKeyService);
		const updateActive = () => {
			const uri = editorService.activeEditor?.resource;
			isActive.set(!!uri && !!agentReviewService.getEntry(uri) && editorService.activeEditorPane?.getId() !== MERGE_EDITOR_ID);
		};
		this._register(editorService.onDidActiveEditorChange(updateActive));
		this._register(autorun(r => {
			agentReviewService.entries.read(r);
			updateActive();
		}));
	}
}
registerWorkbenchContribution2(AgentReviewEditorState.ID, AgentReviewEditorState, WorkbenchPhase.AfterRestored);

/** Closes 3-way merges of agent writes restored from before a reload or restart (see agentReviewMerge.ts). */
class AgentReviewOrphanedMerges implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.agentReviewOrphanedMerges';
	constructor(@IInstantiationService instantiationService: IInstantiationService) {
		instantiationService.invokeFunction(closeOrphanedAgentReviewMerges);
	}
}
registerWorkbenchContribution2(AgentReviewOrphanedMerges.ID, AgentReviewOrphanedMerges, WorkbenchPhase.AfterRestored);
