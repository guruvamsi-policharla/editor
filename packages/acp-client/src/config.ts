/**
 * ACP session config options → UI controls. The `model` category goes to the editor's native model picker; every
 * other select option becomes a picker, in the agent's order, with exactly the choices the agent offers for the
 * session as it is now (the agent drops the ones the current model doesn't have). An option with a single choice is
 * a setting that can't change now (fixed once the chat has started): it's shown locked. Options the client can't
 * render (booleans, which we don't negotiate, or unknown types) are skipped.
 */
import type * as acp from '@agentclientprotocol/sdk';
import { optionTiming, type HarnessProfile, type OptionTiming } from './profiles.js';

export interface ConfigChoice {
	id: string;
	name: string;
	description?: string;
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
	/** Only one choice is offered: the value can't be changed now (the description says why, when the agent does). */
	locked?: boolean;
}

type SelectOption = acp.SessionConfigOption & { type: 'select' };

function flatChoices(o: SelectOption): { value: string; name: string; description?: string | null }[] {
	return o.options.flatMap(x => ('options' in x ? x.options : [x]));
}

export function configControls(options: readonly acp.SessionConfigOption[] | null | undefined, profile: HarnessProfile): ConfigControl[] {
	return (options ?? [])
		.filter((o): o is SelectOption => o.type === 'select')
		.map(o => {
			const choices = flatChoices(o).map(c => ({ id: c.value, name: c.name, ...(c.description ? { description: c.description } : {}) }));
			return {
				id: o.id,
				name: o.name,
				...(o.description ? { description: o.description } : {}),
				...(o.category ? { category: o.category } : {}),
				placement: o.category === 'model' ? 'model' as const : 'picker' as const,
				choices,
				current: String(o.currentValue),
				timing: optionTiming(profile, o.id),
				...(choices.length === 1 ? { locked: true } : {}),
			};
		})
		.filter(c => c.choices.length > 0);
}

/** Whether the select option `id` offers `value`. */
export function offers(options: readonly acp.SessionConfigOption[] | null | undefined, id: string, value: string): boolean {
	const o = options?.find(x => x.id === id);
	return o?.type === 'select' && flatChoices(o).some(c => c.value === value);
}

/** The profile defaults the agent actually offers and that differ from the current values (applied after session/new). */
export function pendingDefaults(options: readonly acp.SessionConfigOption[] | null | undefined, profile: HarnessProfile): { id: string; value: string }[] {
	const out: { id: string; value: string }[] = [];
	for (const [id, value] of Object.entries(profile.defaults ?? {})) {
		const o = options?.find(x => x.id === id);
		if (o?.type === 'select' && String(o.currentValue) !== value && offers(options, id, value)) {
			out.push({ id, value });
		}
	}
	return out;
}

/** The select options' current values, by option id (a chat's settings, saved with it). */
export function optionValues(options: readonly acp.SessionConfigOption[] | null | undefined): Record<string, string> {
	return Object.fromEntries((options ?? []).filter((o): o is SelectOption => o.type === 'select').map(o => [o.id, String(o.currentValue)]));
}

/** The options with these values selected (a value an option doesn't offer leaves it as it is). */
export function withValues(options: readonly acp.SessionConfigOption[] | null | undefined, values: Readonly<Record<string, string>>): acp.SessionConfigOption[] {
	return (options ?? []).map(o => {
		const value = values[o.id];
		return o.type === 'select' && value !== undefined && offers([o], o.id, value) ? { ...o, currentValue: value } : o;
	});
}

/** One option the agent changed by itself after another one was set (a model change resetting the speed). */
export interface ConfigReset {
	id: string;
	name: string;
	from: { id: string; name: string };
	/** Undefined: the option is gone (the new model has no choice in it). */
	to?: { id: string; name: string };
}

/**
 * What changed in `after` besides the option the user set (`changed`): values the agent reset, and options that
 * appeared without the old value or went away. The chat says so, so a choice is never dropped silently.
 */
export function configResets(before: readonly acp.SessionConfigOption[] | null | undefined, after: readonly acp.SessionConfigOption[] | null | undefined, changed: string): ConfigReset[] {
	const named = (o: SelectOption, value: string) => ({ id: value, name: flatChoices(o).find(c => c.value === value)?.name ?? value });
	const out: ConfigReset[] = [];
	for (const b of (before ?? []).filter((o): o is SelectOption => o.type === 'select')) {
		if (b.id === changed || b.category === 'model' || flatChoices(b).length < 2) {
			continue;
		}
		const a = (after ?? []).find((o): o is SelectOption => o.id === b.id && o.type === 'select');
		const from = named(b, String(b.currentValue));
		if (!a) {
			// Gone: worth saying unless it was on its first choice (the base tier, which a model without the choice runs).
			if (String(b.currentValue) !== flatChoices(b)[0]!.value) {
				out.push({ id: b.id, name: b.name, from });
			}
		} else if (String(a.currentValue) !== String(b.currentValue)) {
			out.push({ id: b.id, name: b.name, from, to: named(a, String(a.currentValue)) });
		}
	}
	return out;
}
