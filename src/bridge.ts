import { createServer, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { OAuthManager, RESOURCE } from './oauth';
import { adaptEvent, adaptRequest } from './adapter';
import { BridgeError, safeError, upstreamError } from './errors';
import { encodeEvent, events } from './sse';

export interface AccountModel { slug: string; display_name: string; visibility: string; context_window?: number; [key: string]: any; }
export interface RequestReceipt { sequence: number; source: 'assistant' | 'verification'; model: string; inputItems: number; userMessages: number; functionOutputs: number; tools: number; toolCalls: number; textDeltas: number; completed: boolean; cancelled: boolean; errorCode?: string; upstreamStatus?: number; upstreamContentType?: string; requestId?: string; }

export class OAuthBridge {
  private server?: Server;
  private requests = new Set<AbortController>();
  private catalog?: { clientId: string; at: number; models: AccountModel[] };
  private catalogPending?: Promise<AccountModel[]>;
  readonly receipts: RequestReceipt[] = [];
  private sequence = 0;
  constructor(private auth: OAuthManager, private credential: string, readonly port: number, private fetcher: typeof fetch = fetch, private report: (receipt: RequestReceipt) => void = () => {}, private activity: (receipt: RequestReceipt, active: boolean) => void = () => {}) {}
  get baseUrl() { return `http://127.0.0.1:${this.port}/v1`; }
  async models(signal?: AbortSignal, force = false): Promise<AccountModel[]> {
    const session = await this.auth.active();
    if (!session) throw new BridgeError(401, 'sign_in_required', 'Continue with ChatGPT first.');
    if (!force && this.catalog?.clientId === session.clientId && Date.now() - this.catalog.at < 60_000) return this.catalog.models;
    // Coalesce model discovery only when no per-request cancellation is involved.
    if (!signal && this.catalogPending) return this.catalogPending;
    const load = async () => {
      const response = await this.authorizedFetch(`${RESOURCE}/models`, { signal: signal ?? AbortSignal.timeout(30_000) });
      if (!response.ok) throw await upstreamError(response);
      const body = await response.json() as any;
      if (!Array.isArray(body.models)) throw new BridgeError(502, 'invalid_catalog', 'The subscription model endpoint did not return an account catalog.');
      const models = body.models.filter((model: any) => model.visibility === 'list' && typeof model.slug === 'string' && typeof model.display_name === 'string');
      if (!models.length) throw new BridgeError(403, 'no_models', 'No visible models are available to the selected account.');
      if ((await this.auth.active())?.clientId !== session.clientId) throw new BridgeError(409, 'account_changed', 'The active account changed during model discovery.');
      this.catalog = { clientId: session.clientId, at: Date.now(), models };
      return models;
    };
    if (signal) return load();
    this.catalogPending = load().finally(() => { this.catalogPending = undefined; });
    return this.catalogPending;
  }
  private async authorizedFetch(url: string, init: RequestInit): Promise<Response> {
    const accessToken = await this.auth.accessToken();
    const send = (token: string) => this.fetcher(url, { ...init, redirect: 'error', headers: { 'Content-Type': 'application/json', Accept: url.endsWith('/responses') ? 'text/event-stream' : 'application/json', Authorization: `Bearer ${token}` } });
    let response = await send(accessToken);
    if (response.status === 401) {
      await response.body?.cancel();
      const renewed = await this.auth.accessToken(true, accessToken);
      response = await send(renewed);
    }
    return response;
  }
  async *stream(request: any, signal: AbortSignal, source: RequestReceipt['source'] = 'verification'): AsyncGenerator<any> {
    const adapted = adaptRequest(request);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    this.requests.add(controller);
    const receipt: RequestReceipt = { sequence: ++this.sequence, source, model: adapted.model, inputItems: adapted.input.length, userMessages: adapted.input.filter((item: any) => item.role === 'user').length, functionOutputs: adapted.input.filter((item: any) => item.type === 'function_call_output').length, tools: adapted.tools?.flatMap((tool: any) => tool.tools ?? [tool]).length ?? 0, toolCalls: 0, textDeltas: 0, completed: false, cancelled: false };
    this.receipts.push(receipt);
    if (this.receipts.length > 1000) this.receipts.shift();
    try {
      controller.signal.throwIfAborted();
      const catalog = await this.models(controller.signal);
      if (!catalog.some(model => model.slug === adapted.model)) throw new BridgeError(400, 'model_unavailable', 'Select a model discovered for the current ChatGPT account.');
      const response = await this.authorizedFetch(`${RESOURCE}/responses`, { method: 'POST', body: JSON.stringify(adapted), signal: controller.signal });
      receipt.upstreamStatus = response.status;
      receipt.upstreamContentType = response.headers.get('content-type') ?? '(absent)';
      receipt.requestId = response.headers.get('x-request-id') ?? response.headers.get('openai-request-id') ?? undefined;
      if (!response.ok) throw await upstreamError(response);
      if (!response.body) throw new BridgeError(502, 'stream_required', 'The subscription endpoint did not provide a response body.');
      this.activity(receipt, true);
      // The framing and a completed terminal event establish stream validity.
      // Some gateways omit or mislabel Content-Type; never infer success from it.
      let terminal = false;
      for await (const raw of events(response.body, controller.signal)) {
        const event = adaptEvent(raw);
        if (event.type === 'response.output_text.delta') receipt.textDeltas++;
        if (event.type === 'response.output_item.done' && ['function_call', 'custom_tool_call'].includes(event.item?.type)) receipt.toolCalls++;
        if (event.type === 'response.failed' || event.type === 'error') {
          const error = await upstreamError(new Response(JSON.stringify({ error: event.response?.error ?? event.error ?? event }), { status: 400 }));
          throw error;
        }
        if (event.type === 'response.incomplete') throw new BridgeError(502, 'response_incomplete', 'OpenAI ended the response before completion.');
        if (event.type === 'response.completed') {
          if (event.response?.status !== 'completed') throw new BridgeError(502, 'response_incomplete', 'OpenAI did not report a completed response.');
          terminal = true; receipt.completed = true;
        }
        yield event;
        if (terminal) break;
      }
      if (!terminal) throw new BridgeError(502, 'truncated_stream', 'The stream closed without response.completed.');
    } catch (error) { receipt.cancelled = controller.signal.aborted; receipt.errorCode = safeError(error).code; throw error; }
    finally { this.requests.delete(controller); signal.removeEventListener('abort', abort); this.activity(receipt, false); this.report({ ...receipt }); }
  }
  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const expectedHost = `127.0.0.1:${this.port}`;
      const expected = Buffer.from(`Bearer ${this.credential}`); const received = Buffer.from(req.headers.authorization ?? '');
      if (req.headers.host !== expectedHost || req.headers.origin || received.length !== expected.length || !timingSafeEqual(received, expected)) {
        this.jsonError(res, new BridgeError(401, 'local_auth_required', 'A valid local bridge credential is required.')); return;
      }
      const controller = new AbortController();
      res.once('close', () => { if (!res.writableFinished) controller.abort(); });
      req.once('aborted', () => controller.abort());
      try {
        if (req.method === 'GET' && req.url === '/v1/models') {
          const models = await this.models(controller.signal);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ object: 'list', data: models.map(model => ({ id: model.slug, object: 'model', created: 0, owned_by: 'chatgpt-plan' })) })); return;
        }
        if (req.method !== 'POST' || req.url !== '/v1/responses') throw new BridgeError(404, 'unsupported_protocol', 'This bridge speaks Responses at /v1/responses. Configure an OpenAI provider, not the default OpenAI-compatible Chat Completions provider.');
        if (!req.headers['content-type']?.startsWith('application/json')) throw new BridgeError(415, 'json_required', 'Expected application/json.');
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 16 * 1024 * 1024) throw new BridgeError(413, 'request_too_large', 'Request exceeds 16 MiB.'); chunks.push(chunk); }
        let body: any; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new BridgeError(400, 'invalid_json', 'Invalid request JSON.'); }
        const stream = this.stream(body, controller.signal, 'assistant');
        // Do not send HTTP 200 before model/auth/admission failures have been checked.
        const first = await stream.next();
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const write = async (event: any) => {
          if (res.destroyed) throw new DOMException('Cancelled', 'AbortError');
          if (!res.write(encodeEvent(event))) await new Promise<void>((resolve, reject) => {
            const cleanup = () => { res.off('drain', drained); res.off('close', closed); };
            const drained = () => { cleanup(); resolve(); };
            const closed = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
            res.once('drain', drained); res.once('close', closed);
          });
        };
        try { if (!first.done) await write(first.value); for await (const event of stream) await write(event); res.end(); }
        finally { await stream.return(undefined); }
      } catch (error) {
        const safe = safeError(error);
        if (res.headersSent && !res.destroyed) { res.end(encodeEvent({ type: 'error', code: safe.code, message: safe.message, param: safe.param ?? null })); }
        else if (!res.destroyed) this.jsonError(res, safe);
      }
    });
    this.server.maxConnections = 32; this.server.requestTimeout = 120_000; this.server.headersTimeout = 15_000;
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(this.port, '127.0.0.1', resolve); });
  }
  private jsonError(res: ServerResponse, error: BridgeError) {
    if (error.requestId) res.setHeader('x-request-id', error.requestId);
    if (error.retryAfter) res.setHeader('retry-after', error.retryAfter);
    res.writeHead(error.status < 400 || error.status > 599 ? 500 : error.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'bridge_error', code: error.code, message: error.message, param: error.param ?? null }, ...(error.bodyShape ? { upstream: { bodyShape: error.bodyShape } } : {}) }));
  }
  cancelAll() { for (const controller of this.requests) controller.abort(); this.catalog = undefined; this.catalogPending = undefined; }
  async stop() { this.cancelAll(); const server = this.server; this.server = undefined; if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } }
}
