// ACP session config options ↔ the chat input's pickers. Pure, so it's unit-tested without VS Code.
import type * as vscode from 'vscode';
import type { acp } from '@editor/acp-client';

export interface Picker {
	id: string;
	name: string;
	items: { id: string; name: string; description?: string }[];
	selected: string;
}

function choices(o: acp.SessionConfigOption & { type: 'select' }): { id: string; name: string; description?: string }[] {
	return o.options.flatMap(x => ('options' in x ? x.options : [x])).map(x => ({ id: x.value, name: x.name, description: x.description ?? undefined }));
}

/**
 * Select options → pickers, in the agent's order. Boolean options aren't negotiated, so fast arrives as on/off.
 * The `model` category goes to the native model picker instead (see `modelChoices`).
 */
export function pickersFromConfig(options: readonly acp.SessionConfigOption[] | null | undefined): Picker[] {
	return (options ?? [])
		.filter((o): o is acp.SessionConfigOption & { type: 'select' } => o.type === 'select' && o.category !== 'model')
		.map(o => ({ id: o.id, name: o.name, items: choices(o), selected: o.currentValue }));
}

/** The `model` category option's choices and current value, for the native model picker. */
export function modelChoices(options: readonly acp.SessionConfigOption[] | null | undefined): { items: { id: string; name: string }[]; current: string } | undefined {
	const model = options?.find(o => o.category === 'model');
	return model?.type === 'select' ? { items: choices(model).map(({ id, name }) => ({ id, name })), current: model.currentValue } : undefined;
}

/** `previous`: the input state of the untitled chat being committed; its selections carry over. */
export function toGroups(pickers: Picker[], previous?: Pick<vscode.ChatSessionInputState, 'groups'>): vscode.ChatSessionProviderOptionGroup[] {
	return pickers.map(p => {
		const items = p.items.map(i => ({ id: i.id, name: i.name, description: i.description }));
		const selected = previous?.groups.find(g => g.id === p.id)?.selected?.id ?? p.selected;
		return { id: p.id, name: p.name, items, selected: items.find(i => i.id === selected) ?? items[0] };
	});
}
