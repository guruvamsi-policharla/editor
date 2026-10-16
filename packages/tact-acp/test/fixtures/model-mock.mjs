// A local mock of the model APIs tact calls, for test/real-tact.test.ts: Anthropic Messages (`/v1/messages`) and
// OpenAI Responses (`/v1/responses`), both streamed; the answer is "Hello from mock <model>.". Records each request.
import http from 'node:http';

const sse = (res, events) => {
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	for (const [event, data] of events) {
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	}
	res.end();
};

function messages(model) {
	const text = `Hello from mock ${model}.`;
	return [
		['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
		['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
		['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
		['content_block_stop', { type: 'content_block_stop', index: 0 }],
		['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }],
		['message_stop', { type: 'message_stop' }],
	];
}

function responses(model) {
	const text = `Hello from mock ${model}.`;
	const item = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
	const response = { id: 'resp_1', object: 'response', status: 'completed', model, output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
	return [
		['response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }],
		['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } }],
		['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text }],
		['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
		['response.completed', { type: 'response.completed', response }],
	];
}

/** Starts the mock on a free port: its base URL, the requests seen (`{ path, model }`), and close(). */
export function startModelMock() {
	const requests = [];
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', c => { body += c; });
		req.on('end', () => {
			let json = {};
			try {
				json = JSON.parse(body);
			} catch {
				// not JSON
			}
			requests.push({ path: req.url, model: json.model });
			if (req.url?.endsWith('/messages')) {
				return sse(res, messages(json.model));
			}
			if (req.url?.endsWith('/responses')) {
				return sse(res, responses(json.model));
			}
			res.writeHead(404, { 'content-type': 'application/json' });
			res.end('{"error":"mock: unknown path"}');
		});
	});
	return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() })));
}
