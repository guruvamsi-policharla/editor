// Config controls (from @editor/acp-client) ↔ the chat input's option pickers. Type-only vscode import, so
// it's unit-tested without VS Code.
import type * as vscode from 'vscode';
import type { ConfigControl, HarnessProfile } from '@editor/acp-client';

/** A ThemeIcon-shaped value (the class isn't available in unit tests). */
export type IconFactory = (id: string) => vscode.ThemeIcon;

const NEXT_TURN = 'Applies from your next message';
/** Added to a dangerous choice's description (Claude's Bypass permissions, Codex's Full access). */
export const RISKY = 'Risky: runs commands and edits files without asking; you confirm it each time';

const CATEGORY_ICON: Record<string, string> = {
	mode: 'shield',
	thought_level: 'lightbulb',
	model_config: 'zap',
	collaboration_mode: 'checklist',
};

/** The id of the sign-in group shown while the harness isn't logged in. */
export const SIGN_IN_GROUP = '_signin';

export function groupsFromControls(controls: readonly ConfigControl[], icon?: IconFactory, previous?: Pick<vscode.ChatSessionInputState, 'groups'>): vscode.ChatSessionProviderOptionGroup[] {
	return controls.filter(c => c.placement === 'picker').map(c => {
		const nextTurn = c.timing === 'next-turn';
		const iconId = c.category ? CATEGORY_ICON[c.category] : undefined;
		const items: vscode.ChatSessionProviderOptionItem[] = c.choices.map(ch => {
			const description = [ch.description, ch.dangerous ? RISKY : undefined, nextTurn ? NEXT_TURN : undefined].filter(Boolean).join(' · ');
			// The footer shows the selected item's icon and name, not the group's: each choice carries its group's icon,
			// so a bare "Default" or "Off" still says what it sets (effort's lightbulb, fast mode's bolt; the group's
			// name is the tooltip). Prefixing the group's name ("Effort: Default") didn't fit the side bar's width.
			// A dangerous one (Bypass permissions) has the warning icon instead, in the list and in the footer.
			const itemIcon = ch.dangerous ? 'warning' : iconId;
			return {
				id: ch.id,
				name: ch.dangerous ? `${ch.name} ⚠` : ch.name,
				...(description ? { description } : {}),
				...(c.plan === ch.id ? { slashCommand: 'plan' } : {}),
				...(icon && itemIcon ? { icon: icon(itemIcon) } : {}),
			};
		});
		const wanted = previous?.groups.find(g => g.id === c.id)?.selected?.id ?? c.current;
		return {
			id: c.id,
			name: c.name,
			...(c.description || nextTurn ? { description: [c.description, nextTurn ? NEXT_TURN : undefined].filter(Boolean).join(' · ') } : {}),
			items,
			selected: items.find(i => i.id === wanted) ?? items.find(i => i.id === c.current) ?? items[0],
			...(icon && iconId ? { icon: icon(iconId) } : {}),
		};
	});
}

/** The single picker shown while the harness needs a login: it explains, and its command runs the login. */
export function signInGroup(profile: HarnessProfile, icon?: IconFactory): vscode.ChatSessionProviderOptionGroup {
	const item = { id: 'signed-out', name: `Not signed in to ${profile.label}`, description: `Run \`${profile.harness.binary} ${profile.login.args.join(' ')}\` to sign in` };
	return {
		id: SIGN_IN_GROUP,
		name: 'Sign in',
		items: [item],
		selected: item,
		...(icon ? { icon: icon('account') } : {}),
		// Per-harness command ids: core passes option-group commands a context object, not our arguments.
		commands: [
			{ command: `agentChat.login.${profile.id}`, title: `Sign in to ${profile.label}…` },
			{ command: `agentChat.restart.${profile.id}`, title: 'I\'ve signed in: try again' },
		],
	};
}

/** Selected values that differ from what the session has. */
export function changedSelections(groups: readonly vscode.ChatSessionProviderOptionGroup[], controls: readonly ConfigControl[]): { id: string; value: string; previous: string }[] {
	const out: { id: string; value: string; previous: string }[] = [];
	for (const g of groups) {
		const c = controls.find(x => x.id === g.id && x.placement === 'picker');
		if (c && g.selected && g.selected.id !== c.current && c.choices.some(ch => ch.id === g.selected!.id)) {
			out.push({ id: c.id, value: g.selected.id, previous: c.current });
		}
	}
	return out;
}

type Choice = { id: string; name: string; description?: string };

/**
 * The harness's model choices as the picker shows them, and the current one among them.
 * - A "Default (recommended)" choice whose description is the model it stands for (Claude Code: "Opus 5.5") is shown
 *   as that model, "Opus 5.5 (default)": the picker's label is the selected choice's name, and "Default" didn't say
 *   which model a chat would use. The harness also lists that model on its own; it's one row here, with that model's
 *   description (#48), and a chat running on it shows the default row as selected.
 * - Claude Code gives every version of a model the same line ("Best for everyday, complex tasks" on Opus 4.6 to 5):
 *   only the newest version of each family keeps it, the older ones say they are older.
 */
export function modelChoices(choices: readonly Choice[], current?: string): { items: Choice[]; current: string | undefined } {
	const items: Choice[] = [];
	const twins = new Map<string, string>();
	for (const c of choices) {
		const model = c.description?.trim();
		if (!/^default\b/i.test(c.name) || !model || model.split(/\s+/).length > 3 || /^default\b/i.test(model)) {
			items.push({ ...c });
			continue;
		}
		const twin = choices.find(o => o !== c && o.name.trim() === model);
		if (twin) {
			twins.set(twin.id, c.id);
		}
		items.push({ id: c.id, name: `${model} (default)`, description: twin?.description ?? `${c.name}: ${model}` });
	}
	const shown = items.filter(c => !twins.has(c.id));
	const newest = new Map<string, number[]>();
	for (const c of shown) {
		const v = familyVersion(c.name);
		if (v && compareVersions(v.version, newest.get(v.family) ?? []) > 0) {
			newest.set(v.family, v.version);
		}
	}
	for (const c of shown) {
		const v = familyVersion(c.name);
		if (v && compareVersions(v.version, newest.get(v.family)!) < 0) {
			c.description = 'Older version';
		}
	}
	return { items: shown, current: current === undefined ? undefined : twins.get(current) ?? current };
}

/** "Opus 4.6" → Opus, [4, 6]; "Opus 5.5 (default)" → Opus, [5, 5]. */
function familyVersion(name: string): { family: string; version: number[] } | undefined {
	const m = /^(.*?\S)\s+(\d+(?:\.\d+)*)(?:\s+\(default\))?$/.exec(name.trim());
	return m ? { family: m[1]!, version: m[2]!.split('.').map(Number) } : undefined;
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		if (d !== 0) {
			return d;
		}
	}
	return 0;
}
