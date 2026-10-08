import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Settings the chat changes from VS Code's defaults (package.json `configurationDefaults`).
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const defaults: Record<string, unknown> = pkg.contributes.configurationDefaults;

describe('setting defaults', () => {
	it('sending a message saves nothing: the user\'s unsaved edits stay theirs (an agent write under them is a conflict to merge, #18)', () => {
		expect(defaults['chat.saveBeforeSend']).toBe(false);
	});

	it('the editor\'s selection isn\'t attached by itself: a new chat starts clean, and Cmd/Ctrl+L is the way to reference lines', () => {
		expect(defaults['chat.implicitContext.enabled']).toEqual({ panel: 'never' });
	});
});
