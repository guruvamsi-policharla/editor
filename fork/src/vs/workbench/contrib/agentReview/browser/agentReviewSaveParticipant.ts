/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agent review: attribution of edits made while a file is being saved. Save participants (format on
// save, code actions on save, trim whitespace, other extensions' onWillSave edits) run in registration
// order, and the extension host's participant usually runs after the core ones. So by the time the
// agent-review extension hears about a save, formatter edits are already in the buffer and look like
// the user's typing.
//
// Two participants bracket all others: the first records the model's version and text before any
// participant runs; the last tells the extension `agentReview.ext.onWillWrite({ uri, userVersion,
// version, userText })` right before the write. Buffer edits after `userVersion` were made by the
// editor during the save, not by the user: the engine keeps them pending inside agent hunks and folds
// them in elsewhere. `userText` lets the engine find them by diffing (user text -> written text) even
// when the extension's edit log or document version can't be trusted. `baseline` is the review's own
// baseline (the original side) when the file is under review: it followed the typing and formatting live
// (edits that don't touch a pending change folded in, the rest pending with their change), so the engine
// takes it as is and both agree on what is pending. Saving never accepts any part of a change.
//
// The user can keep typing while the extension is told: VS Code writes the buffer as it is once the
// participants are done (it reads the version again after them), not as it was reported. Keystrokes
// that landed in between reached the disk unreported, and the engine took them for an agent's write
// (pending agent text in the middle of the user's sentence, and a false "changed on disk" conflict).
// So the report is repeated (`again`) until the buffer stays as reported, and after the write
// `agentReview.ext.onDidWrite({ uri, text?, baseline? })` says that the write happened; `text` is what
// was written when it may differ from the last report (it timed out, or the user kept typing through
// every repeat), so the extension can report it before the file watcher sees the write.

import { raceTimeout } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { URI } from '../../../../base/common/uri.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ITextFileEditorModel, ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IAgentReviewService } from './agentReviewService.js';

/** Payload of `agentReview.ext.onWillWrite`. */
export interface IAgentReviewWillWriteEvent {
	readonly uri: URI;
	/** Model version before save participants ran: edits up to here are the user's. */
	readonly userVersion: number;
	/** Model version about to be written. */
	readonly version: number;
	/** The text at `userVersion` (as the user left it), when save participants changed it; else omitted. */
	readonly userText?: string;
	/** The review's baseline (original side) as of this write, when the file has pending changes; else omitted. */
	readonly baseline?: string;
	/**
	 * A repeat of this save's report: the user typed while the previous one was delivered, so the buffer that is
	 * written has more than the previous report. The text since that report is the user's typing.
	 */
	readonly again?: boolean;
}

/** Payload of `agentReview.ext.onDidWrite`: a save reported with `onWillWrite` was written. */
export interface IAgentReviewDidWriteEvent {
	readonly uri: URI;
	/** What was written, when it may differ from the last `onWillWrite` report; else omitted (it was exactly that). */
	readonly text?: string;
	/** With `text`, the review's baseline when it is exactly for `text` (the buffer is still as written). */
	readonly baseline?: string;
}

/** Same budget the extension host gets for onWillSaveTextDocument (all the reports of one save together). */
const WILL_WRITE_TIMEOUT_MS = 1750;
/** Reports of one save at most, while the user keeps typing during them. */
const MAX_WILL_WRITE_REPORTS = 4;

export class AgentReviewSaveParticipants extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agentReviewSaveParticipants';
	static readonly FIRST = -1_000_000;
	static readonly LAST = 1_000_000;

	private readonly _userVersions = new ResourceMap<{ readonly version: number; readonly text: string }>();
	/** Saves reported to the extension and not written yet. `exact`: the buffer stayed as last reported. */
	private readonly _reported = new ResourceMap<{ readonly exact: boolean }>();
	/** Per file: waits for the write of the save reported last. */
	private readonly _writeListeners = this._register(new DisposableMap<string>());

	constructor(
		@ITextFileService private readonly _textFileService: ITextFileService,
		@ICommandService private readonly _commandService: ICommandService,
		@ILogService private readonly _logService: ILogService,
		@IAgentReviewService private readonly _agentReviewService: IAgentReviewService,
	) {
		super();
		this._register(_textFileService.files.addSaveParticipant({
			ordinal: AgentReviewSaveParticipants.FIRST,
			participate: async model => this._willParticipate(model),
		}));
		this._register(_textFileService.files.addSaveParticipant({
			ordinal: AgentReviewSaveParticipants.LAST,
			participate: model => this._willWrite(model),
		}));
	}

	private _willParticipate(model: ITextFileEditorModel): void {
		if (model.textEditorModel) {
			this._userVersions.set(model.resource, { version: model.textEditorModel.getVersionId(), text: model.textEditorModel.getValue() });
		}
	}

	private async _willWrite(model: ITextFileEditorModel): Promise<void> {
		const user = this._userVersions.get(model.resource);
		this._userVersions.delete(model.resource);
		this._reported.delete(model.resource);
		if (user === undefined || !model.textEditorModel) {
			return;
		}
		// Bounded: a slow or missing extension must never block saving.
		const deadline = Date.now() + WILL_WRITE_TIMEOUT_MS;
		for (let report = 0; ; report++) {
			const textModel: ITextModel | null = model.textEditorModel;
			if (!textModel) {
				return;
			}
			const version: number = textModel.getVersionId();
			const baseline = this._agentReviewService.getEntry(model.resource)?.originalModel.getValue();
			const event: IAgentReviewWillWriteEvent = {
				uri: model.resource,
				userVersion: user.version,
				version,
				...(version === user.version ? {} : { userText: user.text }),
				...(baseline === undefined ? {} : { baseline }),
				...(report === 0 ? {} : { again: true }),
			};
			let delivered: boolean;
			try {
				delivered = await raceTimeout(this._commandService.executeCommand('agentReview.ext.onWillWrite', event).then(() => true), Math.max(0, deadline - Date.now())) === true;
			} catch (err) {
				this._logService.trace('[agentReview] onWillWrite not delivered', err);
				return; // no extension to tell
			}
			// Exact when nothing was typed meanwhile: from here to the write there is no room for a keystroke.
			const exact = delivered && model.textEditorModel?.getVersionId() === version;
			if (exact || !delivered || report + 1 >= MAX_WILL_WRITE_REPORTS) {
				this._reported.set(model.resource, { exact });
				this._writeListeners.set(model.resource.toString(), Event.once(model.onDidSave)(() => {
					this._writeListeners.deleteAndDispose(model.resource.toString());
					this._didWrite(model);
				}));
				return;
			}
			// The user typed while the extension was told. VS Code writes the buffer as it is now: report it again.
		}
	}

	/** A save we reported was written: tell the extension, with what was written if the report may not match it. */
	private async _didWrite(model: ITextFileEditorModel): Promise<void> {
		const reported = this._reported.get(model.resource);
		if (!reported) {
			return; // not reported (a save that skipped participants: an Undo in the review UI)
		}
		this._reported.delete(model.resource);
		let event: IAgentReviewDidWriteEvent = { uri: model.resource };
		if (!reported.exact) {
			// A clean buffer is what was written; one typed in since then isn't, so read the file.
			const buffer = !model.isDirty() ? model.textEditorModel?.getValue() : undefined;
			let text = buffer;
			if (text === undefined) {
				try {
					text = (await this._textFileService.read(model.resource)).value;
				} catch (err) {
					this._logService.trace('[agentReview] could not read what was written', err);
				}
			}
			const baseline = buffer === undefined ? undefined : this._agentReviewService.getEntry(model.resource)?.originalModel.getValue();
			event = { uri: model.resource, ...(text === undefined ? {} : { text }), ...(baseline === undefined ? {} : { baseline }) };
		}
		try {
			await this._commandService.executeCommand('agentReview.ext.onDidWrite', event);
		} catch (err) {
			this._logService.trace('[agentReview] onDidWrite not delivered', err);
		}
	}
}
