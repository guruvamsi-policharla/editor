// Config controls (from @editor/acp-client) ↔ the chat input's option pickers. Type-only vscode import, so
// it's unit-tested without VS Code.
import type * as vscode from 'vscode';
import type { ConfigControl, HarnessProfile } from '@editor/acp-client';

/** A ThemeIcon-shaped value (the class isn't available in unit tests). */
export type IconFactory = (id: string) => vscode.ThemeIcon;

const NEXT_TURN = 'Applies from your next message';

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
		const items: vscode.ChatSessionProviderOptionItem[] = c.choices.map(ch => ({
			id: ch.id,
			name: ch.dangerous ? `${ch.name} ⚠` : ch.name,
			...(ch.description || nextTurn ? { description: [ch.description, nextTurn ? NEXT_TURN : undefined].filter(Boolean).join(' · ') } : {}),
			...(c.plan === ch.id ? { slashCommand: 'plan' } : {}),
		}));
		const wanted = previous?.groups.find(g => g.id === c.id)?.selected?.id ?? c.current;
		const iconId = c.category ? CATEGORY_ICON[c.category] : undefined;
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
		commands: [
			{ command: 'agentChat.login', title: `Sign in to ${profile.label}…`, arguments: [profile.id] },
			{ command: 'agentChat.restart', title: 'I\'ve signed in: try again', arguments: [profile.id] },
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
