// The tact ACP adapter on stdio: `node tact-acp.js` (agent-chat runs it with the editor's own Node).
// Env: TACT_BIN (the tact binary; default `tact` on PATH), plus tact's own (TACT_HOME, TACT_CONFIG, OPENAI_API_KEY…).
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { TactAgent } from './agent.js';

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
const agent: TactAgent = new TactAgent({ tact: process.env.TACT_BIN || 'tact' }, (sessionId, update) => connection.client.notify(acp.methods.client.session.update, { sessionId, update }));

const connection = acp.agent({ name: 'tact-acp' })
	.onRequest(acp.methods.agent.initialize, async () => agent.initialize())
	.onRequest(acp.methods.agent.session.new, async ctx => agent.newSession(ctx.params))
	.onRequest(acp.methods.agent.session.load, async ctx => agent.loadSession(ctx.params))
	.onRequest(acp.methods.agent.session.resume, async ctx => agent.resumeSession(ctx.params))
	.onRequest(acp.methods.agent.session.prompt, async ctx => agent.prompt(ctx.params))
	.onRequest(acp.methods.agent.session.setConfigOption, async ctx => agent.setConfigOption(ctx.params))
	.onRequest(acp.methods.agent.session.close, async ctx => agent.closeSession(ctx.params))
	.onNotification(acp.methods.agent.session.cancel, async ctx => agent.cancel(ctx.params))
	.connect(stream);

const quit = () => {
	agent.dispose();
	process.exit(0);
};
process.on('SIGTERM', quit);
process.on('SIGINT', quit);
process.stdin.on('end', quit);
