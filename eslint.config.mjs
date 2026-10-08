// ESLint for the repo's own TypeScript (packages/*, extensions/*): VS Code's generic rules
// (from vscode/eslint.config.js, same eslint / typescript-eslint versions), as errors. VS Code-only rules
// (its local plugin, the Microsoft header, layering) don't apply here. The core files in fork/src are linted
// with VS Code's own config in the prepared tree: fork/scripts/lint-core.sh.
import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'fork/src/**', '**/src/typings/**'], // typings: vendored upstream proposal .d.ts files
	},
	{
		files: ['**/*.{ts,mts,cts,js,mjs}'],
		languageOptions: { parser: tseslint.parser },
		plugins: { '@stylistic': stylistic, '@typescript-eslint': tseslint.plugin },
		rules: {
			'constructor-super': 'error',
			'curly': 'error',
			'eqeqeq': 'error',
			'prefer-const': ['error', { destructuring: 'all' }],
			'no-buffer-constructor': 'error',
			'no-caller': 'error',
			'no-case-declarations': 'error',
			'no-debugger': 'error',
			'no-duplicate-case': 'error',
			'no-duplicate-imports': 'error',
			'no-eval': 'error',
			'no-async-promise-executor': 'error',
			'no-new-wrappers': 'error',
			'no-sparse-arrays': 'error',
			'no-throw-literal': 'error',
			'no-unsafe-finally': 'error',
			'no-unused-labels': 'error',
			'no-misleading-character-class': 'error',
			'no-restricted-globals': ['error', 'name', 'length', 'event', 'closed', 'external', 'status', 'origin', 'orientation', 'context'],
			'no-var': 'error',
			'@stylistic/semi': 'error',
			'@stylistic/block-spacing': 'error', // VS Code's formatter style for the braces `curly` requires
			'@stylistic/member-delimiter-style': 'error',
			'@typescript-eslint/no-unused-expressions': ['error', { allowTernary: true }],
			'@typescript-eslint/naming-convention': ['error', { selector: 'class', format: ['PascalCase'] }],
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
		},
	},
);
