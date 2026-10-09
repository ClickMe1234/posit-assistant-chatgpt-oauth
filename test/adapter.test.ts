import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptRequest, adaptEvent, TOOL_NAMESPACE } from '../src/adapter';
import { events, encodeEvent } from '../src/sse';

test('subscription adaptation removes unsupported parameters, supplies history and wraps local tools', () => {
  const request = { model: 'account-model', input: [{ type: 'message', role: 'system', content: 'Instructions' }, { role: 'user', content: 'Read a file' }, { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"README.md"}' }, { type: 'function_call_output', call_id: 'call-1', output: 'file contents' }], tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' }, defer_loading: true }], max_output_tokens: 200, temperature: 1, metadata: { ignored: true }, store: true, stream: false };
  const output = adaptRequest(request);
  assert.equal(output.store, false); assert.equal(output.stream, true);
  assert.equal(output.input[0].role, 'developer'); assert.equal(output.input[2].namespace, TOOL_NAMESPACE);
  assert.equal(output.input[3].call_id, 'call-1'); assert.equal(output.input[3].output, 'file contents');
  assert.deepEqual(output.tools[0].tools[0].allowed_callers, ['direct']); assert.equal(output.tools[0].tools[0].defer_loading, undefined);
  assert.equal(output.max_output_tokens, undefined); assert.equal(output.temperature, undefined); assert.equal(output.metadata, undefined);
  assert.ok(output.include.includes('reasoning.encrypted_content'));
  assert.equal(request.input[0].role, 'system'); assert.equal(request.tools[0].defer_loading, true);
});
test('rejects server-side continuation and hosted/unsupported tools', () => {
  const base = { model: 'm', input: [] };
  assert.throws(() => adaptRequest({ ...base, previous_response_id: 'resp-old' }), /history/i);
  for (const type of ['tool_search', 'mcp', 'image_generation', 'file_search', 'programmatic_tool_calling']) {
    assert.throws(() => adaptRequest({ ...base, tools: [{ type }] }), /unsupported/i);
  }
  assert.throws(() => adaptRequest({ model: 'm', input: 'string' }), /array/);
});
test('preserves encrypted reasoning and function output IDs across multiple turns', () => {
  const input = [{ type: 'reasoning', id: 'reasoning-1', encrypted_content: 'encrypted' }, { type: 'function_call', call_id: 'call-1', name: 'edit_file', arguments: '{}' }, { type: 'function_call_output', call_id: 'call-1', output: '{"changed":true}' }, { role: 'user', content: 'What changed?' }];
  const output = adaptRequest({ model: 'm', input });
  assert.equal(output.input[0].encrypted_content, 'encrypted'); assert.deepEqual(output.input[2], input[2]); assert.equal(output.input[3].content, 'What changed?');
});
test('streamed tool call adaptation preserves delta ordering, call IDs and completion', async () => {
  const raw = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', namespace: TOOL_NAMESPACE, id: 'fc-1', call_id: 'call-1', name: 'read_file', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc-1', output_index: 0, delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc-1', output_index: 0, delta: '"café.txt"}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', namespace: TOOL_NAMESPACE, id: 'fc-1', call_id: 'call-1', name: 'read_file', arguments: '{"path":"café.txt"}' } },
    { type: 'response.completed', response: { id: 'resp-1', status: 'completed', output: [{ type: 'function_call', namespace: TOOL_NAMESPACE, call_id: 'call-1', name: 'read_file', arguments: '{"path":"café.txt"}' }] } }
  ];
  const wire = Buffer.from(': heartbeat\r\n\r\n' + raw.map(encodeEvent).join('').replace(/\n/g, '\r\n'));
  // Byte-at-a-time splits UTF-8 characters and CRLF delimiters.
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of wire) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const received: any[] = [];
  for await (const event of events(body)) received.push(adaptEvent(event));
  assert.equal(received.length, raw.length);
  assert.equal(received[0].item.namespace, undefined); assert.equal(received[0].item.call_id, 'call-1');
  assert.equal(received.filter(event => event.type.endsWith('arguments.delta')).map(event => event.delta).join(''), '{"path":"café.txt"}');
  assert.equal(received[4].response.output[0].namespace, undefined);
  assert.equal(raw[0].item?.namespace, TOOL_NAMESPACE);
});
test('malformed SSE is an error rather than silent success', async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from('data: {invalid}\n\n')); controller.close(); } });
  await assert.rejects(async () => { for await (const _ of events(body)) { /* consume */ } }, /malformed/);
});
