import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { OAuthBridge } from '../src/bridge';
import { OAuthManager } from '../src/oauth';
import { encodeEvent, events } from '../src/sse';
import { upstreamError } from '../src/errors';

async function freePort(): Promise<number> {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
function fakeAuth() { return { active: async () => ({ clientId: 'oaiapp_mock' }), accessToken: async () => 'mock-oauth-token' } as unknown as OAuthManager; }
function completed(output: any[] = []) { return { type: 'response.completed', response: { id: 'resp-mock', object: 'response', status: 'completed', output } }; }
function sse(items: any[]) { return new Response(items.map(encodeEvent).join(''), { headers: { 'content-type': 'text/event-stream' } }); }

test('real loopback HTTP server requires local credential and rejects browser origins/Host attacks', async () => {
  const key = randomBytes(32).toString('base64url');
  const bridge = new OAuthBridge(fakeAuth(), key, await freePort(), (async () => Response.json({ models: [{ slug: 'model-from-account', display_name: 'Account Model', visibility: 'list' }] })) as typeof fetch);
  await bridge.start();
  try {
    assert.equal((await fetch(`${bridge.baseUrl}/models`)).status, 401);
    assert.equal((await fetch(`${bridge.baseUrl}/models`, { headers: { Authorization: `Bearer ${key}`, Origin: 'https://attacker.invalid' } })).status, 401);
    const hostAttack = await new Promise<number>(resolve => { const request = httpRequest(`${bridge.baseUrl}/models`, { headers: { Authorization: `Bearer ${key}`, Host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode!); }); request.end(); });
    assert.equal(hostAttack, 401);
    const valid = await fetch(`${bridge.baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(valid.status, 200); assert.deepEqual((await valid.json() as any).data.map((model: any) => model.id), ['model-from-account']);
    const wrongProtocol = await fetch(`${bridge.baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}` } });
    assert.equal(wrongProtocol.status, 404); assert.match((await wrongProtocol.json() as any).error.message, /Responses/);
  } finally { await bridge.stop(); }
});
test('mocked upstream complete file-tool cycle preserves emitted calls and returned local results over HTTP', async () => {
  const key = 'mock-local-credential'; const requests: any[] = [];
  const toolCall = { type: 'function_call', namespace: 'positron', id: 'fc-read', call_id: 'call-read', name: 'read_file', arguments: '{"path":"fixture.txt"}' };
  const upstream = (async (url: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer mock-oauth-token');
    if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'account-model', display_name: 'Account model', visibility: 'list' }, { slug: 'hidden', display_name: 'Hidden', visibility: 'hidden' }] });
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const request = JSON.parse(init.body as string); requests.push(request);
    if (requests.length === 1) return sse([
      { type: 'response.output_item.added', output_index: 0, item: { ...toolCall, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc-read', delta: toolCall.arguments },
      { type: 'response.output_item.done', output_index: 0, item: toolCall }, completed([toolCall])
    ]);
    return sse([{ type: 'response.output_text.delta', output_index: 0, delta: 'The file contains a marker.' }, completed([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The file contains a marker.' }] }])]);
  }) as typeof fetch;
  const bridge = new OAuthBridge(fakeAuth(), key, await freePort(), upstream); await bridge.start();
  try {
    const input = [{ role: 'user', content: 'Read fixture.txt' }];
    const tools = [{ type: 'function', name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
    const send = async (body: any) => {
      const response = await fetch(`${bridge.baseUrl}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 200); const result: any[] = []; for await (const event of events(response.body!)) result.push(event); return result;
    };
    const first = await send({ model: 'account-model', input, tools, max_output_tokens: 100 });
    const returned = first.find(event => event.type === 'response.output_item.done').item;
    assert.equal(returned.namespace, undefined); assert.equal(returned.call_id, 'call-read');
    const second = await send({ model: 'account-model', tools, input: [...input, returned, { type: 'function_call_output', call_id: returned.call_id, output: 'marker=prototype-fixture' }] });
    assert.ok(second.some(event => event.type === 'response.output_text.delta'));
    assert.equal(requests[1].input[1].namespace, 'positron'); assert.equal(requests[1].input[2].call_id, 'call-read'); assert.equal(requests[1].input[2].output, 'marker=prototype-fixture');
    assert.equal(requests[0].max_output_tokens, undefined); assert.equal(requests[0].stream, true); assert.equal(requests[0].store, false);
    assert.equal(bridge.receipts[0].toolCalls, 1); assert.equal(bridge.receipts[1].functionOutputs, 1); assert.equal(bridge.receipts[1].completed, true);
  } finally { await bridge.stop(); }
});
test('usage limits retain code, status, request ID and retry hint without logging tokens', async () => {
  const bridge = new OAuthBridge(fakeAuth(), 'local', await freePort(), (async (url: string) => url.endsWith('/models') ? Response.json({ models: [{ slug: 'm', display_name: 'M', visibility: 'list' }] }) : Response.json({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'raw diagnostic ignored' } }, { status: 429, headers: { 'x-request-id': 'request-test', 'retry-after': '60' } })) as typeof fetch);
  await assert.rejects(async () => { for await (const _ of bridge.stream({ model: 'm', input: [] }, new AbortController().signal)) {} }, (error: any) => { assert.equal(error.status, 429); assert.equal(error.code, 'subscription_sharing_usage_limit_exceeded'); assert.equal(error.requestId, 'request-test'); assert.equal(error.retryAfter, '60'); return true; });
  assert.equal(bridge.receipts[0].completed, false);
});
test('HTTP cancellation propagates upstream and does not report completion', async () => {
  let aborted = false;
  const bridge = new OAuthBridge(fakeAuth(), 'local', await freePort(), (async (url: string, init: RequestInit) => {
    if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'm', display_name: 'M', visibility: 'list' }] });
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from(encodeEvent({ type: 'response.output_text.delta', delta: 'first' })));
      init.signal!.addEventListener('abort', () => { aborted = true; controller.error(new DOMException('Cancelled', 'AbortError')); });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch);
  await bridge.start();
  try {
    const controller = new AbortController();
    const response = await fetch(`${bridge.baseUrl}/responses`, { method: 'POST', headers: { Authorization: 'Bearer local', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'm', input: [] }), signal: controller.signal });
    const reader = response.body!.getReader(); await reader.read(); controller.abort(); await reader.cancel().catch(() => {});
    for (let n = 0; n < 30 && !aborted; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(aborted, true); assert.equal(bridge.receipts[0].cancelled, true); assert.equal(bridge.receipts[0].completed, false);
  } finally { await bridge.stop(); }
});
test('early EOF cannot pass as a completed subscription stream', async () => {
  const bridge = new OAuthBridge(fakeAuth(), 'local', await freePort(), (async (url: string) => url.endsWith('/models') ? Response.json({ models: [{ slug: 'm', display_name: 'M', visibility: 'list' }] }) : sse([{ type: 'response.output_text.delta', delta: 'partial' }])) as typeof fetch);
  await assert.rejects(async () => { for await (const _ of bridge.stream({ model: 'm', input: [] }, new AbortController().signal)) {} }, /without response.completed/);
});
test('OAuth standard error strings and direct-admission detail bodies have safe diagnostics', async () => {
  const refresh = await upstreamError(Response.json({ error: 'invalid_grant', error_description: 'untrusted' }, { status: 400 }));
  assert.equal(refresh.code, 'invalid_grant'); assert.match(refresh.message, /expired/);
  const admission = await upstreamError(Response.json({ detail: 'region-specific diagnostic' }, { status: 403 }));
  assert.equal(admission.status, 403); assert.equal(admission.code, 'upstream_http_403'); assert.match(admission.message, /region/);
  assert.equal(admission.bodyShape, 'detail-string');
});

test('404 recovery is actionable and diagnostic parameter fields cannot echo arbitrary content', async () => {
  const response = await upstreamError(Response.json({ error: { message: 'untrusted server text', param: 'input[4].content' } }, { status: 404 }));
  assert.equal(response.param, 'input[4].content'); assert.match(response.message, /new Assistant chat/); assert.match(response.message, /Output/);
  const reflected = await upstreamError(Response.json({ error: { param: 'Bearer mock-token / private input' } }, { status: 400 }));
  assert.equal(reflected.param, undefined); assert.ok(!reflected.message.includes('mock-token'));
});

test('request activity follows admitted streams and clears on completion, failure and cancellation', async () => {
  for (const outcome of ['complete', 'failure', 'cancel'] as const) {
    const activity: boolean[] = []; const controller = new AbortController();
    const bridge = new OAuthBridge(fakeAuth(), 'local', await freePort(), (async (url: string, init: RequestInit) => {
      if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'm', display_name: 'M', visibility: 'list' }] });
      if (outcome === 'failure') return Response.json({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }, { status: 429 });
      if (outcome === 'complete') return sse([completed()]);
      return new Response(new ReadableStream({ start(stream) {
        stream.enqueue(Buffer.from(encodeEvent({ type: 'response.output_text.delta', delta: 'first' })));
        init.signal!.addEventListener('abort', () => stream.error(new DOMException('Cancelled', 'AbortError')));
      } }));
    }) as typeof fetch, () => {}, (_, active) => activity.push(active));
    const run = async () => { for await (const _ of bridge.stream({ model: 'm', input: [] }, controller.signal, 'assistant')) if (outcome === 'cancel') controller.abort(); };
    if (outcome === 'complete') await run(); else await assert.rejects(run);
    assert.deepEqual(activity, outcome === 'failure' ? [false] : [true, false]);
    assert.equal(bridge.receipts[0].source, 'assistant');
  }
});

test('mocked plot cycle streams tool arguments, replays SDK references and forwards the image on follow-up turns', async () => {
  const requests: any[] = [];
  const reasoning = { type: 'reasoning', id: 'rs-plot', summary: [], encrypted_content: 'synthetic-reasoning' };
  const call = { type: 'function_call', id: 'fc-plot', namespace: 'positron', call_id: 'call-plot', name: 'getPlot', arguments: '{"id":"plot-1"}' };
  const answer = { type: 'message', id: 'msg-plot', role: 'assistant', content: [{ type: 'output_text', text: 'The plot contains a red line.' }] };
  const image = { type: 'input_image', image_url: 'data:image/png;base64,c3ludGhldGlj', detail: 'auto' };
  const upstream = (async (url: string, init: RequestInit) => {
    if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'gpt-6.1-sol', display_name: 'Sol', visibility: 'list' }] });
    const request = JSON.parse(init.body as string); requests.push(request);
    // Reproduce the storage mismatch: OpenAI cannot look up unstored item IDs.
    if (request.input.some((item: any) => item.type === 'item_reference')) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
    assert.equal(request.store, false); assert.equal(request.stream, true);
    if (requests.length === 1) return sse([
      { type: 'response.output_item.done', output_index: 0, item: reasoning },
      { type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, item_id: call.id, delta: '{"id":' },
      { type: 'response.function_call_arguments.delta', output_index: 1, item_id: call.id, delta: '"plot-1"}' },
      { type: 'response.output_item.done', output_index: 1, item: call }, completed([reasoning, call])
    ]);
    return sse([{ type: 'response.output_text.delta', output_index: 0, delta: answer.content[0].text }, { type: 'response.output_item.done', output_index: 0, item: answer }, completed([answer])]);
  }) as typeof fetch;
  const bridge = new OAuthBridge(fakeAuth(), 'local', await freePort(), upstream); await bridge.start();
  try {
    const input: any[] = [{ role: 'user', content: 'View my current plot.' }];
    const tools = [{ type: 'function', name: 'getPlot', parameters: { type: 'object' } }];
    const send = async () => {
      const response = await fetch(`${bridge.baseUrl}/responses`, { method: 'POST', headers: { Authorization: 'Bearer local', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-6.1-sol', store: true, input, tools }) });
      assert.equal(response.status, 200); const received: any[] = []; for await (const event of events(response.body!)) received.push(event); return received;
    };
    const first = await send();
    assert.equal(first.filter(event => event.type.endsWith('arguments.delta')).map(event => event.delta).join(''), call.arguments);
    const localCall = first.find(event => event.item?.type === 'function_call' && event.type.endsWith('.done')).item;
    assert.equal(localCall.namespace, undefined);
    input.push({ type: 'item_reference', id: reasoning.id }, localCall, { type: 'function_call_output', call_id: call.call_id, output: [{ type: 'input_text', text: 'Current plot' }, image] });
    const second = await send(); assert.ok(second.some(event => event.type === 'response.output_text.delta'));
    assert.deepEqual(requests[1].input[1], reasoning); assert.equal(requests[1].input[2].namespace, 'positron');
    assert.deepEqual(requests[1].input[3].output[1], image);
    input.push({ type: 'item_reference', id: answer.id }, { role: 'user', content: 'What colour was the line?' });
    await send(); assert.deepEqual(requests[2].input[4], answer);
    assert.equal(bridge.receipts[1].inputImages, 1); assert.equal(bridge.receipts[1].resolvedReferences, 1);
    assert.equal(bridge.receipts[2].resolvedReferences, 2); assert.equal(bridge.receipts[2].completed, true);
    const diagnostics = JSON.stringify(bridge.receipts); assert.ok(!diagnostics.includes(image.image_url)); assert.ok(!diagnostics.includes(reasoning.encrypted_content));
    bridge.cancelAll();
    const missing = await fetch(`${bridge.baseUrl}/responses`, { method: 'POST', headers: { Authorization: 'Bearer local', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-6.1-sol', input }) });
    assert.equal(missing.status, 409); assert.equal((await missing.json() as any).error.code, 'history_item_unavailable');
    assert.equal(requests.length, 3);
  } finally { await bridge.stop(); }
});
