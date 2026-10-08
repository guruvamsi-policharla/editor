/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agent review: holds one AgentReviewEntry per file with pending agent changes and exposes them to
// the existing chat-editing review UI by registering an IChatEditReviewSession. Registering the
// session is all it takes for the core UI to pick the entries up: the editor overlay (file i of n,
// change j of m), per-hunk Keep/Undo widgets, deleted lines as real rows (view zones),
// keybindings, and explorer decorations.

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, IDisposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { IObservable, IReader, observableValue } from '../../../../base/common/observable.js';
import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelContentProvider, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IUndoRedoService, UndoRedoElementType } from '../../../../platform/undoRedo/common/undoRedo.js';
import { IChatEditReviewSession, IChatEditingService, IModifiedFileEntry } from '../../chat/common/editing/chatEditingService.js';
import { SaveReason } from '../../../common/editor.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { AGENT_REVIEW_BASELINE_SCHEME, AgentReviewEntry, baselineWithUnsavedEdits, AgentReviewKind, AgentReviewUndoHistory, IAgentReviewHunkEvent } from './agentReviewEntry.js';
import { openAgentReviewMerge } from './agentReviewMerge.js';

export const IAgentReviewService = createDecorator<IAgentReviewService>('agentReviewService');

export interface IAgentReviewService {
	readonly _serviceBrand: undefined;
	readonly session: IChatEditReviewSession;
	readonly onDidHunkAction: Event<IAgentReviewHunkEvent>;
	/** All entries; changes whenever a file starts or stops having pending changes. */
	readonly entries: IObservable<readonly AgentReviewEntry[]>;
	/** Show `uri` as pending against `baseline`. Creates or updates the entry. */
	setBaseline(uri: URI, baseline: string, kind?: AgentReviewKind): Promise<AgentReviewEntry | undefined>;
	/** Stop reviewing `uri` (nothing pending any more). */
	remove(uri: URI): void;
	/** Remove every entry (the extension re-pushes everything it knows when it starts). */
	clear(): void;
	/**
	 * Resolve an agent write that hit unsaved edits in the 3-way merge editor (base, agent's version on disk,
	 * the user's buffer). False if there is nothing to merge (no unsaved edits).
	 */
	openMerge(uri: URI, base: string): Promise<boolean>;
	getEntry(uri: URI): AgentReviewEntry | undefined;
}

class AgentReviewSession extends Disposable implements IChatEditReviewSession {

	// `true` so that the editor overlay (ChatEditingOverlayController) shows for our entries.
	readonly isGlobalEditingSession = true;
	readonly chatSessionResource = URI.from({ scheme: 'agent-review', path: '/session' });

	private readonly _onDidDispose = this._register(new Emitter<void>());
	readonly onDidDispose = this._onDidDispose.event;

	readonly entriesObs = observableValue<readonly AgentReviewEntry[]>(this, []);
	readonly entries: IObservable<readonly IModifiedFileEntry[]> = this.entriesObs;

	getEntry(uri: URI): IModifiedFileEntry | undefined {
		return this.entriesObs.get().find(e => isEqual(e.modifiedURI, uri));
	}

	readEntry(uri: URI, reader: IReader): IModifiedFileEntry | undefined {
		return this.entriesObs.read(reader).find(e => isEqual(e.modifiedURI, uri));
	}

	async accept(...uris: URI[]): Promise<void> {
		await Promise.all(this._select(uris).map(e => e.accept()));
	}

	async reject(...uris: URI[]): Promise<void> {
		await Promise.all(this._select(uris).map(e => e.reject()));
	}

	private _select(uris: URI[]): AgentReviewEntry[] {
		const all = this.entriesObs.get();
		return uris.length === 0 ? [...all] : all.filter(e => uris.some(u => isEqual(u, e.modifiedURI)));
	}

	override dispose(): void {
		this._onDidDispose.fire();
		super.dispose();
	}
}

export class AgentReviewService extends Disposable implements IAgentReviewService {

	declare readonly _serviceBrand: undefined;

	private readonly _session = this._register(new AgentReviewSession());
	readonly session: IChatEditReviewSession = this._session;

	private readonly _entries = new ResourceMap<{ entry: AgentReviewEntry; listener: IDisposable }>();
	private readonly _pending = new ResourceMap<Promise<AgentReviewEntry | undefined>>();
	/** Latest request per resource while the entry is being created (requests can arrive back to back). */
	private readonly _latest = new ResourceMap<{ baseline: string; kind: AgentReviewKind } | null>();

	get entries(): IObservable<readonly AgentReviewEntry[]> {
		return this._session.entriesObs;
	}

	private readonly _onDidHunkAction = this._register(new Emitter<IAgentReviewHunkEvent>());
	readonly onDidHunkAction = this._onDidHunkAction.event;

	private readonly _undoHistory = new AgentReviewUndoHistory();
	private readonly _undoHistoryListeners = this._register(new DisposableMap<string>());

	constructor(
		@IChatEditingService chatEditingService: IChatEditingService,
		@ITextModelService private readonly _textModelService: ITextModelService,
		@IModelService private readonly _modelService: IModelService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IUndoRedoService private readonly _undoRedoService: IUndoRedoService,
		@ITextFileService private readonly _textFileService: ITextFileService,
	) {
		super();
		this._register(this._undoHistory);
		this._register(this._undoHistory.onDidRemember(model => this._watchUndoOfUndo(model)));
		this._register(chatEditingService.registerEditReviewSession(this._session));

		// Lets "open side-by-side diff" (toggleDiff) resolve the in-memory baseline model.
		const modelService = this._modelService;
		this._register(_textModelService.registerTextModelContentProvider(AGENT_REVIEW_BASELINE_SCHEME, new class implements ITextModelContentProvider {
			async provideTextContent(resource: URI): Promise<ITextModel | null> {
				return modelService.getModel(resource);
			}
		}));
	}

	async openMerge(uri: URI, base: string): Promise<boolean> {
		const merge = await this._instantiationService.invokeFunction(openAgentReviewMerge, uri, { base });
		return !!merge;
	}

	getEntry(uri: URI): AgentReviewEntry | undefined {
		return this._entries.get(uri)?.entry;
	}

	async setBaseline(uri: URI, baseline: string, kind: AgentReviewKind = 'modified'): Promise<AgentReviewEntry | undefined> {
		const existing = this._entries.get(uri);
		if (existing) {
			await existing.entry.setBaseline(baseline, kind);
			return existing.entry;
		}
		this._latest.set(uri, { baseline, kind });
		let pending = this._pending.get(uri);
		if (!pending) {
			pending = this._createEntry(uri).finally(() => {
				this._pending.delete(uri);
				this._latest.delete(uri);
			});
			this._pending.set(uri, pending);
		}
		return pending;
	}

	private async _createEntry(uri: URI): Promise<AgentReviewEntry | undefined> {
		const ref = await this._textModelService.createModelReference(uri);
		const latest = this._latest.get(uri);
		if (this._store.isDisposed || !latest) {
			// disposed, or removed while the model was resolving
			ref.dispose();
			return undefined;
		}
		const baseline = await this._instantiationService.invokeFunction(baselineWithUnsavedEdits, uri, latest.baseline);
		if (this._store.isDisposed || this._latest.get(uri) !== latest) {
			ref.dispose();
			return this._store.isDisposed || !this._latest.get(uri) ? undefined : this._createEntry(uri);
		}
		const entry = this._instantiationService.createInstance(AgentReviewEntry, ref, baseline, latest.kind, this._undoHistory);
		const listener = entry.onDidHunkAction(e => {
			this._onDidHunkAction.fire(e);
			this._pushUndoForKeep(e);
		});
		this._entries.set(uri, { entry, listener });
		this._session.entriesObs.set([...this._session.entriesObs.get(), entry], undefined);
		return entry;
	}

	/**
	 * Ctrl+Z after an Undo that was saved: save again, so that the disk shows the agent's text, pending, as the editor
	 * does. With the entry gone (the Undo was the file's last change), the save is what brings the change back: the
	 * engine sees an external write.
	 */
	private _watchUndoOfUndo(model: ITextModel): void {
		const key = model.uri.toString();
		if (this._undoHistoryListeners.has(key)) {
			return;
		}
		const listener = model.onDidChangeContent(e => {
			if (!this._undoHistory.match(model, e)?.saved) {
				return;
			}
			setTimeout(() => { // not while the model is still dispatching this change
				const entry = this.getEntry(model.uri);
				if (entry) {
					entry.saveUndo();
				} else if (!model.isDisposed()) {
					this._textFileService.save(model.uri, { reason: SaveReason.EXPLICIT, skipSaveParticipants: true });
				}
			}, 0);
		});
		const disposeListener = model.onWillDispose(() => {
			this._undoHistory.forget(model.uri);
			this._undoHistoryListeners.deleteAndDispose(key);
		});
		this._undoHistoryListeners.set(key, { dispose: () => { listener.dispose(); disposeListener.dispose(); } });
	}

	/**
	 * Ctrl+Z after a Keep (hunk or file, in the editor) puts the change back up for review: the engine's baseline goes
	 * back to what it was, and the change is pushed back in. Ctrl+Shift+Z keeps it again. The element lives on the
	 * file's own undo stack, so it interleaves with typing and Undo, and works after the last Keep removed the entry.
	 */
	private _pushUndoForKeep(e: IAgentReviewHunkEvent): void {
		if ((e.kind !== 'accepted' && e.kind !== 'acceptFile') || e.previousBaseline === undefined) {
			return;
		}
		const { uri, previousBaseline } = e;
		const redo: IAgentReviewHunkEvent = e.kind === 'accepted' ? { uri, kind: 'restore', baseline: e.baseline } : { uri, kind: 'acceptFile' };
		this._undoRedoService.pushElement({
			type: UndoRedoElementType.Resource,
			resource: uri,
			label: localize('agentReview.keepUndoLabel', "Keep Agent Change"),
			code: 'agentReview.keep',
			undo: () => this._onDidHunkAction.fire({ uri, kind: 'restore', baseline: previousBaseline }),
			redo: () => this._onDidHunkAction.fire(redo),
		});
	}

	remove(uri: URI): void {
		if (this._pending.has(uri)) {
			this._latest.set(uri, null);
		}
		const item = this._entries.get(uri);
		if (!item) {
			return;
		}
		this._entries.delete(uri);
		this._session.entriesObs.set(this._session.entriesObs.get().filter(e => e !== item.entry), undefined);
		item.listener.dispose();
		item.entry.dispose();
	}

	clear(): void {
		for (const uri of [...this._entries.keys(), ...this._pending.keys()]) {
			this.remove(uri);
		}
	}

	override dispose(): void {
		this.clear();
		super.dispose();
	}
}
