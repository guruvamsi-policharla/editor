// The harness's model choices, shown in core's native model picker.
//
// Core resolves `request.model` for every chat request and throws "Language model unavailable" when no model
// exists, and a contributed session type's Send is disabled without one. So each session type declares
// `requiresCustomModels` and we register its harness's models, targeted at that type. They are labels only:
// the choice is forwarded to the harness (the ACP `model` option); the editor never calls a model.
import * as vscode from 'vscode';

export interface ModelChoice {
	id: string;
	name: string;
	description?: string;
}

export class HarnessModels implements vscode.LanguageModelChatProvider {
	private readonly byType = new Map<string, { items: ModelChoice[]; current: string }>();
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.changed.event;

	set(sessionType: string, items: ModelChoice[], current: string): void {
		const prev = this.byType.get(sessionType);
		if (prev && prev.current === current && JSON.stringify(prev.items) === JSON.stringify(items)) {
			return;
		}
		this.byType.set(sessionType, { items, current });
		this.changed.fire();
	}

	/** `request.model.id` (`<type>:<value>`) → the harness's model value, if it's one of ours. */
	static valueOf(model: vscode.LanguageModelChat | undefined, sessionType: string): string | undefined {
		return model?.id.startsWith(`${sessionType}:`) ? model.id.slice(sessionType.length + 1) : undefined;
	}

	provideLanguageModelChatInformation(): vscode.LanguageModelChatInformation[] {
		return [...this.byType].flatMap(([type, { items, current }]) => items.map(i => ({
			id: `${type}:${i.id}`,
			name: i.name,
			...(i.description ? { tooltip: i.description, detail: i.description } : {}),
			family: type,
			version: '1',
			maxInputTokens: 0,
			maxOutputTokens: 0,
			capabilities: {},
			targetChatSessionType: type,
			isUserSelectable: true,
			isDefault: i.id === current,
		})));
	}

	/** Other extensions can see these models through `vscode.lm`; answer them instead of failing obscurely. */
	async provideLanguageModelChatResponse(model: vscode.LanguageModelChatInformation, _messages: unknown, _options: unknown, progress: vscode.Progress<vscode.LanguageModelResponsePart>): Promise<void> {
		progress.report(new vscode.LanguageModelTextPart(`"${model.name}" is a model choice for an agent harness in the chat panel. The editor doesn't call models itself.`));
	}

	provideTokenCount(): Thenable<number> {
		return Promise.resolve(0);
	}
}
