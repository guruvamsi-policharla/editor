/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Cmd+L (Ctrl+L on Linux) in a LaTeX file runs "Send Selection to Agent" when LaTeX Workshop is installed. Its
// default keybindings use Cmd+L / Ctrl+L as the first key of a dozen chords in LaTeX files, and an installed
// extension's keybindings rank above a built-in extension's: with ours in agent-review's package.json, Cmd+L only
// started a chord ("(⌘L) was pressed. Waiting for second key of chord..."). Resolved for macOS and Linux the way the
// workbench does: default keybindings sorted by weight, the user's keybindings.json after them.

import assert from 'assert';
import { KeybindingParser } from '../../../../../base/common/keybindingParser.js';
import { decodeKeybinding, Keybinding } from '../../../../../base/common/keybindings.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ContextKeyExpr, ContextKeyExpression, ContextKeyValue, IContext } from '../../../../../platform/contextkey/common/contextkey.js';
import { KeybindingResolver, ResultKind } from '../../../../../platform/keybinding/common/keybindingResolver.js';
import { IKeybindingRule, KeybindingsRegistry, KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ResolvedKeybindingItem } from '../../../../../platform/keybinding/common/resolvedKeybindingItem.js';
import { USLayoutResolvedKeybinding } from '../../../../../platform/keybinding/common/usLayoutResolvedKeybinding.js';
import { AGENT_CHAT_CMD_L } from '../../browser/agentChat.contribution.js';

const SEND = 'agentReview.sendSelectionToAgent';
const LATEX = 'editorLangId =~ /^latex$|^context$|^latex-expl3$|^doctex$|^rsweave$|^jlweave$|^pweave$/';

/** LaTeX Workshop 10.20.0's package.json (a few of its Cmd/Ctrl+L chords, verbatim, in their order). */
const LATEX_WORKSHOP = [
	{ key: 'ctrl+l alt+b', mac: 'cmd+l alt+b', command: 'latex-workshop.build', when: `${LATEX} && config.latex-workshop.bind.altKeymap.enabled && !virtualWorkspace` },
	{ key: 'ctrl+l ctrl+enter', mac: 'cmd+l cmd+enter', command: 'latex-workshop.shortcut.item', when: `editorTextFocus && !editorReadonly && ${LATEX}` },
	{ key: 'ctrl+l ctrl+b', mac: 'cmd+l cmd+b', command: 'latex-workshop.shortcut.textbf', when: `editorTextFocus && !editorReadonly && ${LATEX}` },
	{ key: 'ctrl+l ctrl+l', mac: 'cmd+l cmd+l', command: 'expandLineSelection', when: `textInputFocus && ${LATEX}` },
	{ key: 'ctrl+l ctrl+w', mac: 'cmd+l cmd+w', command: 'latex-workshop.surround', when: `editorTextFocus && !editorReadonly && editorHasSelection && ${LATEX}` },
];

/** Core's other Cmd/Ctrl+L bindings an editor can see. */
const CORE: IKeybindingRule[] = [
	{ id: 'expandLineSelection', weight: KeybindingWeight.EditorCore, when: ContextKeyExpr.has('textInputFocus'), primary: KeyMod.CtrlCmd | KeyCode.KeyL },
	{ id: 'workbench.action.chat.newChat', weight: KeybindingWeight.WorkbenchContrib + 1, when: ContextKeyExpr.has('inChat'), primary: KeyMod.CtrlCmd | KeyCode.KeyN, secondary: [KeyMod.CtrlCmd | KeyCode.KeyL], mac: { primary: KeyMod.CtrlCmd | KeyCode.KeyN, secondary: [KeyMod.WinCtrl | KeyCode.KeyL] } },
];

interface Binding { keybinding: Keybinding; command: string; when: ContextKeyExpression | undefined; weight: number }

function fromRule(rule: IKeybindingRule, os: OperatingSystem): Binding[] {
	// As KeybindingsRegistry binds a rule to the platform.
	const kb = (os === OperatingSystem.Macintosh ? rule.mac : rule.linux) ?? rule;
	return [kb.primary, ...(kb.secondary ?? [])].filter((k): k is number => !!k)
		.map(k => ({ keybinding: decodeKeybinding(k, os)!, command: rule.id, when: rule.when ?? undefined, weight: rule.weight }));
}

function fromExtension(bindings: typeof LATEX_WORKSHOP, os: OperatingSystem, builtin: boolean): Binding[] {
	// As the workbench reads an extension's `contributes.keybindings`: the platform's key, weight by position.
	return bindings.map((b, i) => ({
		keybinding: KeybindingParser.parseKeybinding(os === OperatingSystem.Macintosh ? b.mac : b.key)!,
		command: b.command,
		when: ContextKeyExpr.deserialize(b.when),
		weight: (builtin ? KeybindingWeight.BuiltinExtension : KeybindingWeight.ExternalExtension) + i + 1,
	}));
}

function item(b: Binding, os: OperatingSystem, isDefault: boolean): ResolvedKeybindingItem {
	return new ResolvedKeybindingItem(USLayoutResolvedKeybinding.resolveKeybinding(b.keybinding, os)[0], b.command, null, b.when, isDefault, null, false);
}

function resolve(os: OperatingSystem, ours: Binding[], context: Record<string, ContextKeyValue>, user: Binding[] = []) {
	const defaults = [...fromExtension(LATEX_WORKSHOP, os, false), ...CORE.flatMap(r => fromRule(r, os)), ...ours]
		.sort((a, b) => a.weight - b.weight);
	const resolver = new KeybindingResolver(defaults.map(b => item(b, os, true)), user.map(b => item(b, os, false)), () => { });
	const cmdL = USLayoutResolvedKeybinding.getDispatchStr(decodeKeybinding(KeyMod.CtrlCmd | KeyCode.KeyL, os)!.chords[0])!;
	const ctx: IContext = { getValue: <T extends ContextKeyValue>(key: string) => context[key] as T | undefined };
	return resolver.resolve(ctx, [], cmdL);
}

const inTexEditor = { editorFocus: true, editorTextFocus: true, textInputFocus: true, editorLangId: 'latex', editorReadonly: false };

suite('AgentChat: Cmd/Ctrl+L keybinding', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('is registered for Cmd+L on macOS and Ctrl+L on Linux, in a text editor, above every extension\'s defaults', () => {
		const registered = KeybindingsRegistry.getDefaultKeybindings().filter(k => k.command === SEND);
		assert.strictEqual(registered.length, 1);
		assert.ok(registered[0].weight1 > KeybindingWeight.ExternalExtension + 10_000);
		assert.strictEqual(AGENT_CHAT_CMD_L.when?.serialize(), 'editorTextFocus');
		assert.deepStrictEqual(fromRule(AGENT_CHAT_CMD_L, OperatingSystem.Macintosh).map(b => USLayoutResolvedKeybinding.resolveKeybinding(b.keybinding, OperatingSystem.Macintosh)[0].getUserSettingsLabel()), ['cmd+l']);
		assert.deepStrictEqual(fromRule(AGENT_CHAT_CMD_L, OperatingSystem.Linux).map(b => USLayoutResolvedKeybinding.resolveKeybinding(b.keybinding, OperatingSystem.Linux)[0].getUserSettingsLabel()), ['ctrl+l']);
	});

	for (const [name, os] of [['macOS', OperatingSystem.Macintosh], ['Linux', OperatingSystem.Linux]] as const) {
		test(`${name}: runs Send Selection to Agent in a LaTeX file with LaTeX Workshop's chords installed, with and without a selection`, () => {
			const ours = fromRule(AGENT_CHAT_CMD_L, os);
			for (const editorHasSelection of [true, false]) {
				const r = resolve(os, ours, { ...inTexEditor, editorHasSelection });
				assert.strictEqual(r.kind, ResultKind.KbFound, `selection: ${editorHasSelection}`);
				assert.strictEqual(r.kind === ResultKind.KbFound && r.commandId, SEND);
			}
			const r = resolve(os, ours, { ...inTexEditor, editorLangId: 'markdown', editorHasSelection: true });
			assert.strictEqual(r.kind === ResultKind.KbFound && r.commandId, SEND);
		});

		test(`${name}: the same binding from a built-in extension's package.json only started a chord (the bug)`, () => {
			const asBuiltinExtension = fromExtension([{ key: 'ctrl+l', mac: 'cmd+l', command: SEND, when: 'editorTextFocus' }], os, true);
			assert.strictEqual(resolve(os, asBuiltinExtension, { ...inTexEditor, editorHasSelection: true }).kind, ResultKind.MoreChordsNeeded);
		});

		test(`${name}: not in a text editor's focus, Cmd/Ctrl+L keeps its other meanings; keybindings.json still wins`, () => {
			const ours = fromRule(AGENT_CHAT_CMD_L, os);
			const r = resolve(os, ours, { textInputFocus: true });
			assert.strictEqual(r.kind === ResultKind.KbFound && r.commandId, 'expandLineSelection');
			const user = fromRule({ id: 'my.command', weight: 0, when: undefined, primary: KeyMod.CtrlCmd | KeyCode.KeyL }, os);
			const u = resolve(os, ours, { ...inTexEditor, editorHasSelection: true }, user);
			assert.strictEqual(u.kind === ResultKind.KbFound && u.commandId, 'my.command');
		});
	}
});
