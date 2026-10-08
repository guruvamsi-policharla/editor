// Bundle the extension and the ACP client (with the SDK) into one CommonJS file (built-in extensions ship
// prebuilt), and ship the pinned adapters' lockfiles next to it for the first-use installer. Our own tact
// adapter (packages/tact-acp) is bundled too, as dist/adapters/tact-acp.js, run with the editor's Node.
import { cpSync, rmSync } from 'node:fs';
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
rmSync('dist/adapters', { recursive: true, force: true });
cpSync('../../packages/acp-client/adapters', 'dist/adapters', { recursive: true });
await build({
  entryPoints: ['../../packages/tact-acp/src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: 'dist/adapters/tact-acp.js',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});
