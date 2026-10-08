// A minimal ACP agent over stdio for unit tests. On a prompt it misbehaves on purpose: it calls
// fs/read_text_file (which the client never advertised), then asks for permission, then ends the turn.
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
let clientCapabilities;

const connection = acp.agent({ name: 'fake-agent' })
	.onRequest(acp.methods.agent.initialize, async ctx => {
		clientCapabilities = ctx.params.clientCapabilities;
		return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
	})
	.onRequest(acp.methods.agent.session.new, async () => ({
		sessionId: 's1',
		configOptions: [{ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'a', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] }],
	}))
	.onRequest(acp.methods.agent.session.prompt, async () => {
		const client = connection.client;
		let fsError;
		try {
			await client.request('fs/read_text_file', { sessionId: 's1', path: '/etc/hostname' });
		} catch (e) {
			fsError = e.code;
		}
		const permission = await client.request(acp.methods.client.session.requestPermission, {
			sessionId: 's1',
			toolCall: { toolCallId: 't1', title: 'Run `true`', kind: 'execute' },
			options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }, { optionId: 'no', name: 'No', kind: 'reject_once' }],
		});
		await client.notify(acp.methods.client.session.update, {
			sessionId: 's1',
			update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ fsError, clientCapabilities, permission }) } },
		});
		return { stopReason: 'end_turn' };
	})
	.connect(stream);
