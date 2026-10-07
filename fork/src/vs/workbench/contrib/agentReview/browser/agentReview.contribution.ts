/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Phase 0 spike: wiring. The built-in extension (which hosts the review engine) talks to this
// contribution through internal commands, so the spike needs no extension-host protocol changes:
//   extension -> core: `_agentReview.setBaseline(uri, baselineText)`, `_agentReview.remove(uri)`
//   core -> extension: `agentReview.ext.onDidHunkAction({ uri, kind, baseline, current })`
// A typed `agentReview` proposed API can replace the commands later (see docs/phase0-rendering.md).

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { getCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { AgentReviewService, IAgentReviewService } from './agentReviewService.js';

registerSingleton(IAgentReviewService, AgentReviewService, InstantiationType.Delayed);

CommandsRegistry.registerCommand('_agentReview.setBaseline', async (accessor: ServicesAccessor, uri: UriComponents, baseline: string) => {
	await accessor.get(IAgentReviewService).setBaseline(URI.revive(uri), baseline);
});

CommandsRegistry.registerCommand('_agentReview.remove', (accessor: ServicesAccessor, uri: UriComponents) => {
	accessor.get(IAgentReviewService).remove(URI.revive(uri));
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
			commandService.executeCommand('agentReview.ext.onDidHunkAction', { uri: e.uri, kind: e.kind, baseline: e.baseline, current: e.current })
				.catch(err => logService.trace('[agentReview] no extension handler for hunk action', err));
		}));
	}
}
registerWorkbenchContribution2(AgentReviewBridge.ID, AgentReviewBridge, WorkbenchPhase.AfterRestored);

// Spike/demo: fake a pending agent change in the active editor. The baseline is the current text
// plus a hardcoded block that the "agent" deleted, and with the first line rewritten, so the editor
// shows real red rows for the deleted block, a word-level modified line, and Accept/Reject per hunk.
registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'agentReview.debug.showSample', title: localize2('agentReview.showSample', 'Agent Review: Show Sample Pending Change (spike)'), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editor = getCodeEditor(accessor.get(IEditorService).activeTextEditorControl);
		const model = editor?.getModel();
		if (!model) {
			return;
		}
		const lines = model.getLinesContent();
		const baseline = [
			`${lines[0] ?? ''} (before the agent edit)`,
			'This sentence was deleted by the agent.',
			'So was this one, which is why it renders as a red row.',
			...lines.slice(1),
		].join(model.getEOL());
		await accessor.get(IAgentReviewService).setBaseline(model.uri, baseline);
	}
});
