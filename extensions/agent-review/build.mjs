// Bundle the extension and the engine into one CommonJS file (built-in extensions ship prebuilt).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  alias: { '@editor/engine': '../../packages/engine/src/index.ts' },
  sourcemap: 'linked',
  minify: false,
  logLevel: 'info',
});
