/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Phase 0 spike: a review entry whose "original" side is the agent-review engine's accepted
// baseline (pushed in from the built-in extension) and whose "modified" side is the live text
// model of the file. Rendering, per-hunk Accept/Reject widgets, navigation and the editor overlay
// are reused unchanged from the chat-editing UI (ChatEditingCodeEditorIntegration).

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, IReference } from '../../../../base/common/lifecycle.js';
import { constObservable, derived, IObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { getCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IDocumentDiff } from '../../../../editor/common/diff/documentDiffProvider.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { createTextBufferFactory } from '../../../../editor/common/model/textModel.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IResolvedTextEditorModel } from '../../../../editor/common/services/resolverService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorPane } from '../../../common/editor.js';
import { ChatEditingCodeEditorIntegration, IDocumentDiff2 } from '../../chat/browser/chatEditing/chatEditingCodeEditorIntegration.js';
import { ChatEditingTextModelChangeService } from '../../chat/browser/chatEditing/chatEditingTextModelChangeService.js';
import { IModifiedFileEntry, IModifiedFileEntryEditorIntegration, ModifiedFileEntryState } from '../../chat/common/editing/chatEditingService.js';
import { IChatResponseModel } from '../../chat/common/model/chatModel.js';

export const AGENT_REVIEW_BASELINE_SCHEME = 'agent-review-baseline';

export interface IAgentReviewHunkEvent {
	readonly uri: URI;
	readonly kind: 'accepted' | 'rejected';
	/** Full baseline text after the action (accept moves the baseline; reject leaves it). */
	readonly baseline: string;
	/** Full buffer text after the action (reject rewrites the buffer; accept leaves it). */
	readonly current: string;
}

export class AgentReviewEntry extends Disposable implements IModifiedFileEntry {

	private static _idPool = 0;

	readonly entryId = `agent-review-${AgentReviewEntry._idPool++}`;
	readonly originalURI: URI;
	readonly modifiedURI: URI;
	readonly lastModifyingRequestId = 'agent-review';

	readonly originalModel: ITextModel;
	readonly modifiedModel: ITextModel;

	private readonly _stateObs = observableValue<ModifiedFileEntryState>(this, ModifiedFileEntryState.Modified);
	readonly state: IObservable<ModifiedFileEntryState> = this._stateObs;

	// The chat-specific parts of IModifiedFileEntry are constant for agent review:
	// there is no streaming request, no auto-accept timer, and review mode is always on.
	readonly isCurrentlyBeingModifiedBy = constObservable<{ responseModel: IChatResponseModel; undoStopId: string | undefined } | undefined>(undefined);
	readonly lastModifyingResponse = constObservable<IChatResponseModel | undefined>(undefined);
	readonly rewriteRatio = constObservable(1);
	readonly waitsForLastEdits = constObservable(false);
	readonly reviewMode = constObservable(true);
	readonly autoAcceptController = constObservable<{ total: number; remaining: number; cancel(): void } | undefined>(undefined);

	private readonly _changeService: ChatEditingTextModelChangeService;
	private readonly _integrations = this._register(new DisposableMap<IEditorPane, IModifiedFileEntryEditorIntegration>());

	/** True while the text model is being updated by a reload from disk (an external/agent write). */
	private _diskReloadInProgress = false;

	private readonly _onDidHunkAction = this._register(new Emitter<IAgentReviewHunkEvent>());
	readonly onDidHunkAction = this._onDidHunkAction.event;

	constructor(
		modifiedRef: IReference<IResolvedTextEditorModel>,
		baseline: string,
		@IModelService modelService: IModelService,
		@ILanguageService languageService: ILanguageService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this.modifiedModel = this._register(modifiedRef).object.textEditorModel;
		this.modifiedURI = this.modifiedModel.uri;
		this.originalURI = URI.from({ scheme: AGENT_REVIEW_BASELINE_SCHEME, path: this.modifiedURI.path, query: this.entryId });
		this.originalModel = this._register(modelService.createModel(
			createTextBufferFactory(baseline),
			languageService.createById(this.modifiedModel.getLanguageId()),
			this.originalURI,
			false
		));

		// Must be registered BEFORE the change service so that the flag is set when the service's
		// own onDidChangeContent listener runs (emitters deliver in registration order).
		// Production: replace with a predicate on the event inside ChatEditingTextModelChangeService.
		this._register(this.modifiedModel.onDidChangeContent(e => {
			this._diskReloadInProgress = e.detailedReasons.some(r => r.metadata.source === 'reloadFromDisk');
		}));

		this._changeService = this._register(this._instantiationService.createInstance(
			ChatEditingTextModelChangeService,
			this.originalModel,
			this.modifiedModel,
			this._stateObs,
			// Disk reloads are agent edits: keep them pending instead of folding them into the baseline.
			() => this._diskReloadInProgress,
		));

		this._register(this._changeService.onDidAcceptOrRejectLines(e => {
			this._onDidHunkAction.fire({ uri: this.modifiedURI, kind: e.state, baseline: this.originalModel.getValue(), current: this.modifiedModel.getValue() });
		}));
		this._register(this._changeService.onDidAcceptOrRejectAllHunks(state => {
			this._stateObs.set(state, undefined);
		}));
	}

	get diffInfo(): IObservable<IDocumentDiff2> {
		return this._changeService.diffInfo;
	}

	readonly changesCount: IObservable<number> = derived(r => this._changeService.diffInfo.read(r).changes.length);
	readonly linesAdded: IObservable<number> = derived(r => this._changeService.diffInfo.read(r).changes.reduce((n, c) => n + c.modified.length, 0));
	readonly linesRemoved: IObservable<number> = derived(r => this._changeService.diffInfo.read(r).changes.reduce((n, c) => n + c.original.length, 0));

	getDiffInfo(): Promise<IDocumentDiff> {
		return this._changeService.getDiffInfo();
	}

	/** Called when the engine moves the baseline (user save folded in, git op, accept from the review list). */
	async setBaseline(baseline: string): Promise<void> {
		this._stateObs.set(ModifiedFileEntryState.Modified, undefined);
		await this._changeService.resetDocumentValues(baseline, undefined);
	}

	async accept(): Promise<void> {
		this._changeService.keep();
		this._stateObs.set(ModifiedFileEntryState.Accepted, undefined);
		this._onDidHunkAction.fire({ uri: this.modifiedURI, kind: 'accepted', baseline: this.originalModel.getValue(), current: this.modifiedModel.getValue() });
	}

	async reject(): Promise<void> {
		this._changeService.undo();
		this._stateObs.set(ModifiedFileEntryState.Rejected, undefined);
		this._onDidHunkAction.fire({ uri: this.modifiedURI, kind: 'rejected', baseline: this.originalModel.getValue(), current: this.modifiedModel.getValue() });
	}

	enableReviewModeUntilSettled(): void {
		// review mode is always on
	}

	getEditorIntegration(pane: IEditorPane): IModifiedFileEntryEditorIntegration {
		let value = this._integrations.get(pane);
		if (!value) {
			const codeEditor = getCodeEditor(pane.getControl());
			if (!codeEditor) {
				throw new Error('agent review needs a code editor');
			}
			value = this.createEditorIntegration(codeEditor);
			this._integrations.set(pane, value);
		}
		return value;
	}

	createEditorIntegration(codeEditor: ReturnType<typeof getCodeEditor> & {}): ChatEditingCodeEditorIntegration {
		// renderDiffImmediately=true: there is no "streaming" phase for agent review.
		return this._instantiationService.createInstance(ChatEditingCodeEditorIntegration, this, codeEditor, this._changeService.diffInfo, true);
	}
}
