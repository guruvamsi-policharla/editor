import { describe, expect, it } from 'vitest';
import { mentions, promptBlocks } from '../src/prompt.js';

const files = new Set(['/w/paper/main.tex', '/w/notes.txt', '/w/my dir/a.tex']);
const exists = (p: string) => files.has(p);

describe('prompt blocks', () => {
	it('sends the text as typed plus a resource_link per referenced file', () => {
		const blocks = promptBlocks({ prompt: 'tighten @paper/main.tex:L42-58 please', references: [{ path: '/w/notes.txt' }], root: '/w', exists });
		expect(blocks).toEqual([
			{ type: 'text', text: 'tighten @paper/main.tex:L42-58 please' },
			{ type: 'resource_link', uri: 'file:///w/notes.txt', name: 'notes.txt' },
			{ type: 'resource_link', uri: 'file:///w/paper/main.tex', name: 'paper/main.tex:L42-58', description: 'Lines 42–58' },
		]);
	});

	it('a slash command goes first; duplicates and unknown files are dropped', () => {
		const blocks = promptBlocks({ prompt: 'focus @notes.txt and @notes.txt and @missing.txt', command: 'compact', references: [], root: '/w', exists });
		expect(blocks[0]).toEqual({ type: 'text', text: '/compact focus @notes.txt and @notes.txt and @missing.txt' });
		expect(blocks.slice(1).map(b => (b.type === 'resource_link' ? b.name : ''))).toEqual(['notes.txt']);
	});

	it('Cmd/Ctrl+L pills: the text keeps them in place; their links follow the text\'s order, before attached files', () => {
		const prompt = 'In this part @paper/main.tex:L7-8 fold in this argument @paper/main.tex:L13 please';
		const blocks = promptBlocks({
			prompt,
			references: [
				{ path: '/w/notes.txt' },
				{ path: '/w/paper/main.tex', startLine: 13, endLine: 13, at: prompt.indexOf('@paper/main.tex:L13') },
				{ path: '/w/paper/main.tex', startLine: 7, endLine: 8, at: prompt.indexOf('@paper/main.tex:L7-8') },
			],
			root: '/w',
			exists,
		});
		expect(blocks[0]).toEqual({ type: 'text', text: prompt });
		expect(blocks.slice(1).map(b => (b.type === 'resource_link' ? b.name : ''))).toEqual(['paper/main.tex:L7-8', 'paper/main.tex:L13', 'notes.txt']);
	});

	it('mentions: one line, escaped spaces, absolute paths; e-mail addresses are not mentions', () => {
		expect(mentions('@notes.txt:L3 and @my\\ dir/a.tex, @/w/paper/main.tex', '/w', exists)).toEqual([
			{ path: '/w/notes.txt', startLine: 3, endLine: 3 },
			{ path: '/w/my dir/a.tex' },
			{ path: '/w/paper/main.tex' },
		]);
		expect(mentions('mail guru@notes.txt', '/w', exists)).toEqual([]);
	});
});
