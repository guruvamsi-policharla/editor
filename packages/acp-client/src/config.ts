/**
 * ACP session config options → UI controls. The `model` category goes to the editor's native model picker; every
 * other select option becomes a picker, in the agent's order. Hidden values are dropped, dangerous ones flagged,
 * and each control says when a change takes effect. Options the client can't render (booleans, which we don't
 * negotiate, or unknown types) are skipped.
 */
import type * as acp from '@agentclientprotocol/sdk';
import { optionTiming, type HarnessProfile, type OptionTiming } from './profiles.js';

export interface ConfigChoice {
	id: string;
	name: string;
	description?: string;
	dangerous?: boolean;
}

export interface ConfigControl {
	id: string;
	name: string;
	description?: string;
	category?: string;
	placement: 'model' | 'picker';
	choices: ConfigChoice[];
	current: string;
	timing: OptionTiming;
	/** This control is where plan mode lives. */
	plan?: string;
}

type SelectOption = acp.SessionConfigOption & { type: 'select' };

function flatChoices(o: SelectOption): { value: string; name: string; description?: string | null }[] {
	return o.options.flatMap(x => ('options' in x ? x.options : [x]));
}

export function configControls(options: readonly acp.SessionConfigOption[] | null | undefined, profile: HarnessProfile): ConfigControl[] {
	return (options ?? [])
		.filter((o): o is SelectOption => o.type === 'select')
		.map(o => {
			const hidden = new Set(profile.hiddenValues?.[o.id] ?? []);
			const dangerous = new Set(profile.dangerousValues?.[o.id] ?? []);
			const choices = flatChoices(o)
				.filter(c => !hidden.has(c.value) || c.value === o.currentValue)
				.map(c => ({ id: c.value, name: c.name, ...(c.description ? { description: c.description } : {}), ...(dangerous.has(c.value) ? { dangerous: true } : {}) }));
			return {
				id: o.id,
				name: o.name,
				...(o.description ? { description: o.description } : {}),
				...(o.category ? { category: o.category } : {}),
				placement: o.category === 'model' ? 'model' as const : 'picker' as const,
				choices,
				current: String(o.currentValue),
				timing: optionTiming(profile, o.id),
				...(profile.planOption?.configId === o.id ? { plan: profile.planOption.value } : {}),
			};
		})
		.filter(c => c.choices.length > 0);
}

export function isDangerous(profile: HarnessProfile, configId: string, value: string): boolean {
	return profile.dangerousValues?.[configId]?.includes(value) ?? false;
}

export function isHidden(profile: HarnessProfile, configId: string, value: string): boolean {
	return profile.hiddenValues?.[configId]?.includes(value) ?? false;
}

/** The profile defaults the agent actually offers and that differ from the current values (applied after session/new). */
export function pendingDefaults(options: readonly acp.SessionConfigOption[] | null | undefined, profile: HarnessProfile): { id: string; value: string }[] {
	const out: { id: string; value: string }[] = [];
	for (const [id, value] of Object.entries(profile.defaults ?? {})) {
		const o = options?.find(x => x.id === id);
		if (o?.type === 'select' && String(o.currentValue) !== value && flatChoices(o).some(c => c.value === value)) {
			out.push({ id, value });
		}
	}
	return out;
}
