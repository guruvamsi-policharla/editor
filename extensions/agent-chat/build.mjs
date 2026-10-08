// Bundle the extension and the ACP client (with the SDK) into one CommonJS file (built-in extensions ship prebuilt).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  alias: { '@editor/acp-client': '../../packages/acp-client/src/index.ts' },
  sourcemap: 'linked',
  minify: false,
  logLevel: 'info',
});
