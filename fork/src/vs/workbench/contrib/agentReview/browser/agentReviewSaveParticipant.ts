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
// (edits on no line of a pending change folded in, the rest pending with their change), so the engine
// takes it as is and both agree on what is pending. Saving never accepts any part of a change.

import { raceTimeout } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { URI } from '../../../../base/common/uri.js';
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
}

/** Same budget the extension host gets for onWillSaveTextDocument. */
const WILL_WRITE_TIMEOUT_MS = 1750;

export class AgentReviewSaveParticipants extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agentReviewSaveParticipants';
	static readonly FIRST = -1_000_000;
	static readonly LAST = 1_000_000;

	private readonly _userVersions = new ResourceMap<{ readonly version: number; readonly text: string }>();

	constructor(
		@ITextFileService textFileService: ITextFileService,
		@ICommandService private readonly _commandService: ICommandService,
		@ILogService private readonly _logService: ILogService,
		@IAgentReviewService private readonly _agentReviewService: IAgentReviewService,
	) {
		super();
		this._register(textFileService.files.addSaveParticipant({
			ordinal: AgentReviewSaveParticipants.FIRST,
			participate: async model => this._willParticipate(model),
		}));
		this._register(textFileService.files.addSaveParticipant({
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
		if (user === undefined || !model.textEditorModel) {
			return;
		}
		const version = model.textEditorModel.getVersionId();
		const baseline = this._agentReviewService.getEntry(model.resource)?.originalModel.getValue();
		const event: IAgentReviewWillWriteEvent = {
			uri: model.resource,
			userVersion: user.version,
			version,
			...(version === user.version ? {} : { userText: user.text }),
			...(baseline === undefined ? {} : { baseline }),
		};
		try {
			// Bounded: a slow or missing extension must never block saving.
			await raceTimeout(this._commandService.executeCommand('agentReview.ext.onWillWrite', event), WILL_WRITE_TIMEOUT_MS);
		} catch (err) {
			this._logService.trace('[agentReview] onWillWrite not delivered', err);
		}
	}
}
