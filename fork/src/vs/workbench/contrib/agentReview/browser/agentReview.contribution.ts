/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agent review wiring. The built-in agent-review extension (which hosts the review engine) talks to
// this contribution through internal commands, so no extension-host protocol changes are needed:
//   extension -> core: `_agentReview.setBaseline(uri, baselineText, kind)`, `_agentReview.remove(uri)`, `_agentReview.clear()`,
//                      `_agentReview.openMerge(uri, baseText)` (agent write vs. unsaved edits, see agentReviewMerge.ts)
//   core -> extension: `agentReview.ext.onDidHunkAction({ uri, kind, baseline? })`,
//                      `agentReview.ext.onWillWrite({ uri, userVersion, version })` (see agentReviewSaveParticipant.ts)
// A typed proposed API can replace the commands later.

import './media/agentReview.css';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { AgentReviewKind } from './agentReviewEntry.js';
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
			isActive.set(!!uri && !!agentReviewService.getEntry(uri));
		};
		this._register(editorService.onDidActiveEditorChange(updateActive));
		this._register(autorun(r => {
			agentReviewService.entries.read(r);
			updateActive();
		}));
	}
}
registerWorkbenchContribution2(AgentReviewEditorState.ID, AgentReviewEditorState, WorkbenchPhase.AfterRestored);
