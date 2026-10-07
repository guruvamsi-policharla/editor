/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Phase 0 spike: holds one AgentReviewEntry per file with pending agent changes and exposes them to
// the existing chat-editing review UI by registering an IChatEditReviewSession. Registering the
// session is all it takes for the core UI to pick the entries up: the editor overlay (file i of n,
// change j of m), per-hunk Accept/Reject widgets, deleted lines as real rows (view zones),
// keybindings, and explorer badges.

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { IObservable, IReader, observableValue } from '../../../../base/common/observable.js';
import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelContentProvider, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IChatEditReviewSession, IChatEditingService, IModifiedFileEntry } from '../../chat/common/editing/chatEditingService.js';
import { AGENT_REVIEW_BASELINE_SCHEME, AgentReviewEntry, IAgentReviewHunkEvent } from './agentReviewEntry.js';

export const IAgentReviewService = createDecorator<IAgentReviewService>('agentReviewService');

export interface IAgentReviewService {
	readonly _serviceBrand: undefined;
	readonly session: IChatEditReviewSession;
	readonly onDidHunkAction: Event<IAgentReviewHunkEvent>;
	/** Show `uri` as pending against `baseline`. Creates or updates the entry. */
	setBaseline(uri: URI, baseline: string): Promise<AgentReviewEntry | undefined>;
	/** Stop reviewing `uri` (nothing pending any more). */
	remove(uri: URI): void;
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

	private readonly _onDidHunkAction = this._register(new Emitter<IAgentReviewHunkEvent>());
	readonly onDidHunkAction = this._onDidHunkAction.event;

	constructor(
		@IChatEditingService chatEditingService: IChatEditingService,
		@ITextModelService private readonly _textModelService: ITextModelService,
		@IModelService private readonly _modelService: IModelService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this._register(chatEditingService.registerEditReviewSession(this._session));

		// Lets "open side-by-side diff" (toggleDiff) resolve the in-memory baseline model.
		const modelService = this._modelService;
		this._register(_textModelService.registerTextModelContentProvider(AGENT_REVIEW_BASELINE_SCHEME, new class implements ITextModelContentProvider {
			async provideTextContent(resource: URI): Promise<ITextModel | null> {
				return modelService.getModel(resource);
			}
		}));
	}

	getEntry(uri: URI): AgentReviewEntry | undefined {
		return this._entries.get(uri)?.entry;
	}

	async setBaseline(uri: URI, baseline: string): Promise<AgentReviewEntry | undefined> {
		const existing = this._entries.get(uri);
		if (existing) {
			await existing.entry.setBaseline(baseline);
			return existing.entry;
		}
		let pending = this._pending.get(uri);
		if (!pending) {
			pending = this._createEntry(uri, baseline).finally(() => this._pending.delete(uri));
			this._pending.set(uri, pending);
		}
		return pending;
	}

	private async _createEntry(uri: URI, baseline: string): Promise<AgentReviewEntry | undefined> {
		const ref = await this._textModelService.createModelReference(uri);
		if (this._store.isDisposed) {
			ref.dispose();
			return undefined;
		}
		const entry = this._instantiationService.createInstance(AgentReviewEntry, ref, baseline);
		const listener = entry.onDidHunkAction(e => this._onDidHunkAction.fire(e));
		this._entries.set(uri, { entry, listener });
		this._session.entriesObs.set([...this._session.entriesObs.get(), entry], undefined);
		return entry;
	}

	remove(uri: URI): void {
		const item = this._entries.get(uri);
		if (!item) {
			return;
		}
		this._entries.delete(uri);
		this._session.entriesObs.set(this._session.entriesObs.get().filter(e => e !== item.entry), undefined);
		item.listener.dispose();
		item.entry.dispose();
	}

	override dispose(): void {
		for (const uri of [...this._entries.keys()]) {
			this.remove(uri);
		}
		super.dispose();
	}
}
