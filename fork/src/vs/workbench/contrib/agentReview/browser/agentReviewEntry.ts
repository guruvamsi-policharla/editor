/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agent review: one entry per file with pending agent changes. The "original" side is the review
// engine's accepted baseline (pushed in from the built-in agent-review extension, which owns the
// engine) and the "modified" side is the live text model of the file. Rendering, per-hunk Keep/Undo
// widgets, navigation and the editor overlay are the chat-editing UI (ChatEditingCodeEditorIntegration).
//
// Who decides what: the engine is authoritative (pending = disk - baseline). This entry only
// reports what the user did in the UI so the engine can follow:
//   Keep hunk  -> original model edited here -> 'accepted' with the full new baseline
//   Undo hunk  -> buffer edited here -> saved (when it was clean) -> the engine sees disk == baseline there
//   Keep file  -> 'acceptFile';  Undo file -> buffer restored + saved, or 'rejectFile' for a created file
// Undo writes the file, so the disk matches what the reviewer sees and the agent can't read the undone text
// back. The one exception is a buffer with the user's own unsaved edits: it's never saved for them, so the
// undo stays in the buffer (dirty) until they save. Keep never writes: the agent's text is already on disk.

import { toAction } from '../../../../base/common/actions.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, IReference } from '../../../../base/common/lifecycle.js';
import { constObservable, derived, IObservable, observableValue } from '../../../../base/common/observable.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { getCodeEditor, ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IDocumentDiff } from '../../../../editor/common/diff/documentDiffProvider.js';
import { DetailedLineRangeMapping } from '../../../../editor/common/diff/rangeMapping.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { EndOfLinePreference, ITextModel } from '../../../../editor/common/model.js';
import { createTextBufferFactory } from '../../../../editor/common/model/textModel.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IResolvedTextEditorModel } from '../../../../editor/common/services/resolverService.js';
import { IModelContentChangedEvent } from '../../../../editor/common/textModelEvents.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IEditorPane, SaveReason } from '../../../common/editor.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { ChatEditingCodeEditorIntegration, IDocumentDiff2 } from '../../chat/browser/chatEditing/chatEditingCodeEditorIntegration.js';
import { ChatEditingTextModelChangeService } from '../../chat/browser/chatEditing/chatEditingTextModelChangeService.js';
import { IModifiedFileEntry, IModifiedFileEntryEditorIntegration, ModifiedFileEntryState } from '../../chat/common/editing/chatEditingService.js';
import { IChatResponseModel } from '../../chat/common/model/chatModel.js';

export const AGENT_REVIEW_BASELINE_SCHEME = 'agent-review-baseline';

/** How the file differs from the baseline: `created` files have an empty baseline and no file there before. */
export type AgentReviewKind = 'modified' | 'created';

export interface IAgentReviewHunkEvent {
	readonly uri: URI;
	/**
	 * - `accepted`: one hunk kept; `baseline` is the full new baseline text.
	 * - `rejected`: one hunk undone in the buffer (the engine follows from the save).
	 * - `acceptFile`: everything in the file kept (accept the file as it is on disk).
	 * - `rejectFile`: undo a created file, i.e. delete it.
	 */
	readonly kind: 'accepted' | 'rejected' | 'acceptFile' | 'rejectFile';
	readonly baseline?: string;
}

/** Content changes caused by reloading the file from disk are agent (external) edits. */
export function isDiskReload(e: IModelContentChangedEvent): boolean {
	return e.detailedReasons.some(r => r.metadata.source === 'reloadFromDisk');
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
	/** Read by ChatEditingCodeEditorIntegration: each hunk's Keep/Undo toolbar gets its own row below the hunk. */
	readonly hunkToolbarRows = true;
	readonly autoAcceptController = constObservable<{ total: number; remaining: number; cancel(): void } | undefined>(undefined);

	private readonly _changeService: ChatEditingTextModelChangeService;
	private readonly _integrations = this._register(new DisposableMap<IEditorPane, IModifiedFileEntryEditorIntegration>());

	/** The save of the last Undo, while it runs, and the buffer version it writes. */
	private _undoSave: { readonly versionId: number; readonly done: Promise<void> } | undefined;

	private readonly _onDidHunkAction = this._register(new Emitter<IAgentReviewHunkEvent>());
	readonly onDidHunkAction = this._onDidHunkAction.event;

	readonly diffInfo: IObservable<IDocumentDiff2>;

	private _kind: AgentReviewKind;
	get kind(): AgentReviewKind { return this._kind; }

	constructor(
		modifiedRef: IReference<IResolvedTextEditorModel>,
		baseline: string,
		kind: AgentReviewKind,
		@IModelService modelService: IModelService,
		@ILanguageService languageService: ILanguageService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@ILogService private readonly _logService: ILogService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();
		this._kind = kind;
		this.modifiedModel = this._register(modifiedRef).object.textEditorModel;
		this.modifiedURI = this.modifiedModel.uri;
		this.originalURI = URI.from({ scheme: AGENT_REVIEW_BASELINE_SCHEME, path: this.modifiedURI.path, query: this.entryId });
		this.originalModel = this._register(modelService.createModel(
			createTextBufferFactory(baseline),
			languageService.createById(this.modifiedModel.getLanguageId()),
			this.originalURI,
			false
		));

		this._changeService = this._register(this._instantiationService.createInstance(
			ChatEditingTextModelChangeService,
			this.originalModel,
			this.modifiedModel,
			this._stateObs,
			// Disk reloads are agent edits: keep them pending instead of folding them into the baseline.
			// Typing in the editor is a user edit: folded into the baseline where it does not touch a pending change.
			isDiskReload,
		));
		this._changeService.extendToSubwords = true;
		this._changeService.preserveShortMatchingLines = true;

		this._register(this._changeService.onDidAcceptOrRejectAllHunks(state => {
			this._stateObs.set(state, undefined);
		}));

		// Hunk actions from the widgets, keybindings and commands all go through diffInfo.keep/undo.
		this.diffInfo = this._changeService.diffInfo.map(diff => ({
			...diff,
			keep: (change: DetailedLineRangeMapping) => this._keepHunk(diff, change),
			undo: (change: DetailedLineRangeMapping) => this._undoHunk(diff, change),
		} satisfies IDocumentDiff2));
	}

	private async _keepHunk(diff: IDocumentDiff2, change: DetailedLineRangeMapping): Promise<boolean> {
		const done = await diff.keep(change);
		if (done) {
			this._onDidHunkAction.fire({ uri: this.modifiedURI, kind: 'accepted', baseline: this.originalModel.getValue() });
		}
		return done;
	}

	private async _undoHunk(diff: IDocumentDiff2, change: DetailedLineRangeMapping): Promise<boolean> {
		const wasDirty = this._hasUnsavedUserEdits();
		const done = await diff.undo(change);
		if (!done) {
			return false;
		}
		if (this._kind === 'created' && this.modifiedModel.getValueLength() === 0) {
			// Undoing everything the agent wrote in a new file: the file should not exist.
			this._onDidHunkAction.fire({ uri: this.modifiedURI, kind: 'rejectFile' });
			return true;
		}
		this._onDidHunkAction.fire({ uri: this.modifiedURI, kind: 'rejected' });
		if (!wasDirty) {
			await this._saveUndo();
		}
		return true;
	}

	/**
	 * Whether the buffer has unsaved edits other than an Undo that is being saved right now. (Pressing
	 * Undo twice quickly must save both: the first one's save makes the buffer dirty until it finishes.)
	 */
	private _hasUnsavedUserEdits(): boolean {
		if (!this._textFileService.isDirty(this.modifiedURI)) {
			return false;
		}
		return this._undoSave?.versionId !== this.modifiedModel.getAlternativeVersionId();
	}

	/**
	 * Write the undone text to disk so that the file matches what the reviewer sees. Skips save
	 * participants: formatters must not rewrite the agent's other pending lines as a side effect.
	 * Unsaved user edits are never saved for them; in that case the undo is saved with their next save.
	 * If the write fails, the user is told: the agent would otherwise still read its own text on disk.
	 */
	private async _saveUndo(): Promise<void> {
		const previous = this._undoSave?.done;
		const versionId = this.modifiedModel.getAlternativeVersionId();
		const done = (async () => {
			await previous;
			let error: unknown;
			try {
				const saved = await this._textFileService.save(this.modifiedURI, { reason: SaveReason.EXPLICIT, skipSaveParticipants: true });
				if (saved || !this._textFileService.isDirty(this.modifiedURI)) {
					return;
				}
			} catch (err) {
				error = err;
			}
			this._logService.error('[agentReview] could not save after undo', error);
			this._notificationService.notify({
				severity: Severity.Warning,
				message: localize('agentReview.undoNotSaved', "Undo in {0} isn't on disk yet, so an agent reading the file still sees its own text. Save the file to write it.", basename(this.modifiedURI)),
				actions: {
					primary: [toAction({
						id: 'agentReview.saveUndo',
						label: localize('agentReview.save', "Save"),
						run: () => this._textFileService.save(this.modifiedURI, { reason: SaveReason.EXPLICIT, skipSaveParticipants: true }),
					})],
				},
			});
		})();
		this._undoSave = { versionId, done };
		await done;
		if (this._undoSave?.done === done) {
			this._undoSave = undefined;
		}
	}

	readonly changesCount: IObservable<number> = derived(r => this._changeService.diffInfo.read(r).changes.length);
	readonly linesAdded: IObservable<number> = derived(r => this._changeService.diffInfo.read(r).changes.reduce((n, c) => n + c.modified.length, 0));
	readonly linesRemoved: IObservable<number> = derived(r => this._changeService.diffInfo.read(r).changes.reduce((n, c) => n + c.original.length, 0));

	getDiffInfo(): Promise<IDocumentDiff> {
		return this._changeService.getDiffInfo();
	}

	/** The engine moved the baseline (user save folded in, git op, keep from the list, external write). */
	async setBaseline(baseline: string, kind: AgentReviewKind): Promise<void> {
		this._kind = kind;
		const stateChanged = this._stateObs.get() !== ModifiedFileEntryState.Modified;
		this._stateObs.set(ModifiedFileEntryState.Modified, undefined);
		// Models keep one EOL, so a baseline that differs only in line endings (mixed CRLF/LF files) is the same here.
		if (!stateChanged && this.originalModel.getValue(EndOfLinePreference.LF) === baseline.replace(/\r\n/g, '\n')) {
			return; // e.g. the echo of a Keep that this entry reported itself
		}
		await this._changeService.resetDocumentValues(baseline, undefined);
	}

	async accept(): Promise<void> {
		this._changeService.keep();
		this._stateObs.set(ModifiedFileEntryState.Accepted, undefined);
		this._onDidHunkAction.fire({ uri: this.modifiedURI, kind: 'acceptFile' });
	}

	async reject(): Promise<void> {
		await this.rejectFile();
	}

	/**
	 * Undo every pending change of the file. Modified files: the buffer goes back to the baseline (text the
	 * user typed outside the changes stays, it is part of the baseline) and is saved if it had no other
	 * unsaved edits. Created files: the extension deletes the file.
	 * @returns where the undo is: `saved` to disk, only in the buffer (`unsaved`, the user's unsaved edits
	 * keep it dirty), or `deleted` (created file, removed by the extension).
	 */
	async rejectFile(): Promise<'saved' | 'unsaved' | 'deleted'> {
		if (this._kind === 'created') {
			this._stateObs.set(ModifiedFileEntryState.Rejected, undefined);
			this._onDidHunkAction.fire({ uri: this.modifiedURI, kind: 'rejectFile' });
			return 'deleted';
		}
		const wasDirty = this._hasUnsavedUserEdits();
		this._changeService.undo();
		this._stateObs.set(ModifiedFileEntryState.Rejected, undefined);
		this._onDidHunkAction.fire({ uri: this.modifiedURI, kind: 'rejected' });
		if (wasDirty) {
			return 'unsaved';
		}
		await this._saveUndo();
		return this._textFileService.isDirty(this.modifiedURI) ? 'unsaved' : 'saved';
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

	createEditorIntegration(codeEditor: ICodeEditor): ChatEditingCodeEditorIntegration {
		// renderDiffImmediately=true: there is no "streaming" phase for agent review.
		return this._instantiationService.createInstance(ChatEditingCodeEditorIntegration, this, codeEditor, this.diffInfo, true);
	}
}
