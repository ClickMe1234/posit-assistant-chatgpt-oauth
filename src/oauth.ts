import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { BridgeError, upstreamError } from './errors';

export const ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
export const SCOPES = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
export const AGENT_NAME = 'Posit Assistant ChatGPT OAuth';

export interface SecretStore { get(key: string): PromiseLike<string | undefined>; store(key: string, value: string): PromiseLike<void>; delete(key: string): PromiseLike<void>; }
export interface StateStore { get<T>(key: string, fallback: T): T; update(key: string, value: any): PromiseLike<void>; }
export interface Registration { clientId: string; subject: string; email?: string; }
export interface Session extends Registration { accessToken: string; refreshToken: string; idToken: string; expiresAt: number; scopes: string[]; }
export interface Pending { state: string; nonce: string; verifier: string; redirectUri: string; expiresAt: number; clientId?: string; subject?: string; consumed: boolean; }
interface Vault { active?: string; sessions: Record<string, Session>; }
const VAULT_KEY = 'oauth.sessions.v1';

export async function verifyIdToken(token: string, clientId: string, key: CryptoKey | Uint8Array | JWTVerifyGetKey): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, key as JWTVerifyGetKey, { issuer: ISSUER, audience: clientId, requiredClaims: ['sub', 'exp', 'iat'], algorithms: ['RS256'], clockTolerance: 5 });
  return payload;
}

type PendingRegistration = Pick<Registration, 'clientId'> & Partial<Pick<Registration, 'subject'>>;
export function makePending(redirectUri: string, registration?: PendingRegistration): Pending {
  return { state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'), verifier: randomBytes(64).toString('base64url'), redirectUri, expiresAt: Date.now() + 10 * 60_000, clientId: registration?.clientId, subject: registration?.subject, consumed: false };
}

export function authorizeUrl(pending: Pending, hostId: string, idTokenHint?: string, requestConsent = false): string {
  const url = new URL(`${ISSUER}/api/accounts/authorize`);
  const params: Record<string, string> = {
    client_id: pending.clientId ?? 'dynamic_agent_client', ext_agent_host_id: hostId,
    response_type: 'code', redirect_uri: pending.redirectUri, scope: SCOPES, resource: RESOURCE,
    state: pending.state, nonce: pending.nonce, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(pending.verifier).digest('base64url')
  };
  if (!pending.clientId) params.agent_name_hint = AGENT_NAME;
  if (idTokenHint && pending.clientId) params.id_token_hint = idTokenHint;
  if (requestConsent) params.prompt = 'consent';
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

export function consumeCallback(url: URL, pending: Pending): { code: string; clientId: string } {
  if (pending.consumed || Date.now() >= pending.expiresAt) throw new BridgeError(400, 'expired_authorization', 'This sign-in attempt expired or was already completed.');
  for (const field of ['code', 'state', 'client_id', 'error']) if (url.searchParams.getAll(field).length > 1) throw new BridgeError(400, 'invalid_callback', 'Duplicate OAuth callback parameter.');
  const state = url.searchParams.get('state') ?? '';
  const received = Buffer.from(state); const expected = Buffer.from(pending.state);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new BridgeError(400, 'state_mismatch', 'Sign-in state did not match.');
  pending.consumed = true;
  if (url.searchParams.has('error')) throw new BridgeError(400, 'authorization_denied', 'ChatGPT sign-in or consent was declined.');
  const clientId = url.searchParams.get('client_id') ?? pending.clientId;
  if (!clientId || clientId === 'dynamic_agent_client') throw new BridgeError(400, 'incomplete_registration', 'OpenAI did not issue a client registration.');
  if (pending.clientId && clientId !== pending.clientId) throw new BridgeError(400, 'client_mismatch', 'The callback changed the selected account registration.');
  const code = url.searchParams.get('code');
  if (!code) throw new BridgeError(400, 'missing_code', 'The callback did not contain an authorization code.');
  return { code, clientId };
}

export function validateIdentity(payload: JWTPayload, pending: Pick<Pending, 'nonce' | 'subject'>): void {
  if (payload.nonce !== pending.nonce) throw new BridgeError(400, 'nonce_mismatch', 'The validated ID token nonce did not match.');
  if (typeof payload.sub !== 'string' || !payload.sub) throw new BridgeError(400, 'missing_subject', 'The validated ID token has no account identity.');
  if (pending.subject && payload.sub !== pending.subject) throw new BridgeError(400, 'account_mismatch', 'Sign-in returned a different account. The previous account was preserved.');
}

export function tokenSession(tokens: any, registration: Registration, old?: Session): Session {
  if (typeof tokens.access_token !== 'string' || !tokens.access_token || tokens.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0)
    throw new BridgeError(502, 'invalid_token_response', 'OpenAI returned an incomplete OAuth token set.');
  const refreshToken = tokens.refresh_token ?? old?.refreshToken;
  const idToken = tokens.id_token ?? old?.idToken;
  if (typeof refreshToken !== 'string' || typeof idToken !== 'string') throw new BridgeError(502, 'invalid_token_response', 'OpenAI did not provide the required renewable session.');
  return { ...registration, accessToken: tokens.access_token, refreshToken, idToken,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    scopes: typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : old?.scopes ?? [] };
}

// Also serializes rotating refresh tokens across Positron windows. The file holds
// only a PID/timestamp, never credentials; a stale crash lock can be reclaimed.
export async function withFileLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'oauth-session.lock');
  const deadline = Date.now() + 35_000;
  let lock: Awaited<ReturnType<typeof open>>;
  while (true) {
    try { lock = await open(path, 'wx', 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() })); break; }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - (await stat(path)).mtimeMs > 120_000) await unlink(path); } catch { /* a lock may have just been released */ }
      if (Date.now() > deadline) throw new BridgeError(503, 'session_busy', 'Another Positron window is updating this account. Try again shortly.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  try { return await action(); } finally { await lock.close(); await unlink(path).catch(() => {}); }
}

export interface OAuthDependencies {
  fetch?: typeof fetch;
  verify?: (token: string, clientId: string) => Promise<JWTPayload>;
  lock?: <T>(action: () => Promise<T>) => Promise<T>;
}

export class OAuthManager {
  private fetcher: typeof fetch;
  private verifier: (token: string, clientId: string) => Promise<JWTPayload>;
  private lock: <T>(action: () => Promise<T>) => Promise<T>;
  private cancelSignIn?: () => void;
  private signingIn = false;
  private epoch = 0;
  private metadataPromise?: Promise<any>;
  private keyResolver?: JWTVerifyGetKey;
  constructor(private secrets: SecretStore, private state: StateStore, storageDirectory: string, dependencies: OAuthDependencies = {}) {
    this.fetcher = dependencies.fetch ?? fetch;
    this.lock = dependencies.lock ?? (action => withFileLock(storageDirectory, action));
    this.verifier = dependencies.verify ?? (async (token, clientId) => {
      const metadata = await this.metadata();
      this.keyResolver ??= createRemoteJWKSet(new URL(metadata.jwks_uri));
      return verifyIdToken(token, clientId, this.keyResolver);
    });
  }
  private async readVault(): Promise<Vault> { return JSON.parse(await this.secrets.get(VAULT_KEY) ?? '{"sessions":{}}'); }
  private async saveVault(vault: Vault) { if (!Object.keys(vault.sessions).length) await this.secrets.delete(VAULT_KEY); else await this.secrets.store(VAULT_KEY, JSON.stringify(vault)); }
  registrations(): Registration[] { return this.state.get<Registration[]>('registrations', []); }
  async active(): Promise<Session | undefined> { const vault = await this.readVault(); return vault.active ? vault.sessions[vault.active] : undefined; }
  async hostId(): Promise<string> {
    return this.lock(async () => {
      let id = this.state.get<string>('hostId', '');
      if (!id) { id = `urn:uuid:${randomUUID()}`; await this.state.update('hostId', id); }
      return id;
    });
  }
  async select(clientId: string): Promise<void> {
    this.epoch++;
    await this.lock(async () => { const vault = await this.readVault(); if (!vault.sessions[clientId]) throw new BridgeError(401, 'sign_in_required', 'Continue with ChatGPT to renew this saved account.'); vault.active = clientId; await this.saveVault(vault); });
  }
  private async network(url: string, init?: RequestInit): Promise<Response> {
    try { return await this.fetcher(url, { ...init, redirect: 'error', signal: init?.signal ?? AbortSignal.timeout(25_000) }); }
    catch (error: any) { if (error.name === 'AbortError') throw error; throw new BridgeError(503, 'auth_network', 'OpenAI authentication could not be reached. Try again.'); }
  }
  private async metadata(): Promise<any> {
    this.metadataPromise ??= (async () => {
      const response = await this.network(`${ISSUER}/.well-known/openid-configuration`);
      if (!response.ok) throw await upstreamError(response);
      const metadata = await response.json() as any;
      if (metadata.issuer !== ISSUER) throw new BridgeError(502, 'invalid_issuer', 'OpenAI discovery returned an unexpected issuer.');
      for (const key of ['jwks_uri', 'revocation_endpoint']) { const url = new URL(metadata[key]); if (url.origin !== ISSUER) throw new BridgeError(502, 'invalid_discovery', 'OpenAI discovery returned an unexpected endpoint.'); }
      return metadata;
    })().catch(error => { this.metadataPromise = undefined; throw error; });
    return this.metadataPromise;
  }
  private async grant(params: Record<string, string>): Promise<any> {
    const response = await this.network(`${ISSUER}/api/accounts/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
    if (!response.ok) throw await upstreamError(response);
    return response.json();
  }
  async exchange(pending: Pending, callback: URL, epoch = this.epoch): Promise<Session> {
    const { code, clientId } = consumeCallback(callback, pending);
    // Retain the issued ID within this attempt even if its code has expired.
    pending.clientId = clientId;
    const tokens = await this.grant({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: pending.verifier, redirect_uri: pending.redirectUri, resource: RESOURCE });
    let payload: JWTPayload;
    try { payload = await this.verifier(tokens.id_token, clientId); } catch { throw new BridgeError(400, 'invalid_id_token', 'The ID token failed signature, issuer, audience or expiry validation.'); }
    validateIdentity(payload, pending);
    const known = this.registrations().find(item => item.clientId === clientId);
    if (known && known.subject !== payload.sub) throw new BridgeError(400, 'account_mismatch', 'Sign-in returned a different identity for a saved registration.');
    const registration = { clientId, subject: payload.sub!, email: typeof payload.email === 'string' ? payload.email : undefined };
    const session = tokenSession(tokens, registration);
    await this.lock(async () => {
      if (epoch !== this.epoch) throw new BridgeError(409, 'sign_in_cancelled', 'Account state changed during sign-in.');
      const vault = await this.readVault(); vault.sessions[clientId] = session; vault.active = clientId;
      const registrations = this.registrations().filter(item => item.clientId !== clientId);
      await this.state.update('registrations', [...registrations, registration]);
      await this.saveVault(vault);
    });
    return session;
  }
  async signIn(openBrowser: (url: string) => PromiseLike<boolean>, registration?: Registration, signal?: AbortSignal): Promise<Session> {
    if (this.signingIn) throw new BridgeError(409, 'sign_in_pending', 'A browser sign-in is already pending.');
    this.signingIn = true;
    try {
      const hostId = await this.hostId();
      const old = registration ? (await this.readVault()).sessions[registration.clientId] : undefined;
      let selected: PendingRegistration | undefined = registration;
      for (let attempt = 0; attempt < 2; attempt++) {
        const recovery: { pending?: Pending } = {};
        try { return await this.signInAttempt(openBrowser, hostId, selected, signal, old, recovery); }
        catch (error) {
          if (!(error instanceof BridgeError) || error.code !== 'invalid_grant' || attempt || !recovery.pending?.clientId || signal?.aborted) throw error;
          selected = { clientId: recovery.pending.clientId, subject: selected?.subject };
        }
      }
      throw new BridgeError(401, 'invalid_grant', 'Continue with ChatGPT again.');
    } finally { this.signingIn = false; }
  }
  private async signInAttempt(openBrowser: (url: string) => PromiseLike<boolean>, hostId: string, registration: PendingRegistration | undefined, signal: AbortSignal | undefined, old: Session | undefined, recovery: { pending?: Pending }): Promise<Session> {
    const epoch = this.epoch;
    let server: Server;
    let pending: Pending;
    let resolveResult!: (value: Session) => void;
    let rejectResult!: (reason: any) => void;
    const result = new Promise<Session>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    // Mark the promise handled while the system browser is being opened.
    void result.catch(() => {});
    server = createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'");
      if (req.method !== 'GET' || !req.url?.startsWith('/auth/callback?') || req.headers.host !== new URL(pending.redirectUri).host) { res.writeHead(404); res.end('Not found'); return; }
      try {
        const session = await this.exchange(pending, new URL(req.url, pending.redirectUri), epoch);
        res.end('ChatGPT sign-in completed. Return to Positron.'); resolveResult(session);
      } catch (error) {
        res.writeHead(400); res.end('Sign-in could not be completed. Return to Positron for the error.');
        if (pending.consumed) rejectResult(error);
      }
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No OAuth listener');
    pending = makePending(`http://127.0.0.1:${address.port}/auth/callback`, registration);
    recovery.pending = pending;
    const cancel = () => { this.epoch++; rejectResult(new BridgeError(499, 'cancelled', 'Sign-in cancelled.')); };
    this.cancelSignIn = cancel;
    const timeout = setTimeout(() => { this.epoch++; rejectResult(new BridgeError(408, 'sign_in_timeout', 'Browser sign-in timed out. Continue with ChatGPT again.')); }, 10 * 60_000);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      signal?.throwIfAborted();
      if (!await openBrowser(authorizeUrl(pending, hostId, old?.idToken, Boolean(old && !old.scopes.includes(DIRECT_SCOPE))))) throw new BridgeError(502, 'browser_failed', 'The system browser could not be opened.');
      return await result;
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); this.cancelSignIn = undefined; server.close(); server.closeAllConnections(); }
  }
  async accessToken(forceRenewal = false, rejectedToken?: string): Promise<string> {
    return this.lock(async () => {
      const vault = await this.readVault(); const session = vault.active ? vault.sessions[vault.active] : undefined;
      if (!session) throw new BridgeError(401, 'sign_in_required', 'Continue with ChatGPT in Positron first.');
      if (!session.scopes.includes(DIRECT_SCOPE)) throw new BridgeError(403, 'plan_permission_missing', 'Sign-in succeeded, but permission to use the ChatGPT plan is disabled. Continue with ChatGPT to enable it.');
      if (forceRenewal && rejectedToken && session.accessToken !== rejectedToken && session.expiresAt > Date.now() + 60_000) return session.accessToken;
      if (!forceRenewal && session.expiresAt > Date.now() + 60_000) return session.accessToken;
      let tokens: any;
      try { tokens = await this.grant({ grant_type: 'refresh_token', client_id: session.clientId, refresh_token: session.refreshToken, resource: RESOURCE }); }
      catch (error) {
        if (error instanceof BridgeError && ['invalid_grant', 'invalid_token'].includes(error.code)) { delete vault.sessions[session.clientId]; delete vault.active; await this.saveVault(vault); }
        throw error;
      }
      const renewed = tokenSession(tokens, session, session);
      if (tokens.id_token) {
        let payload: JWTPayload;
        try { payload = await this.verifier(tokens.id_token, session.clientId); } catch { throw new BridgeError(401, 'invalid_id_token', 'The renewed ID token failed validation.'); }
        if (payload.sub !== session.subject) throw new BridgeError(401, 'account_mismatch', 'Token renewal changed account identity.');
      }
      vault.sessions[session.clientId] = renewed; await this.saveVault(vault);
      if (!renewed.scopes.includes(DIRECT_SCOPE)) throw new BridgeError(403, 'plan_permission_missing', 'ChatGPT plan permission is no longer granted.');
      return renewed.accessToken;
    });
  }
  async signOut(all = false): Promise<boolean> {
    this.epoch++; this.cancelSignIn?.();
    return this.lock(async () => {
      const vault = await this.readVault(); let confirmed = true;
      const ids = all ? Object.keys(vault.sessions) : vault.active ? [vault.active] : [];
      for (const id of ids) {
        const session = vault.sessions[id];
        try {
          const metadata = await this.metadata(); let response: Response | undefined;
          for (let attempt = 0; attempt < 3; attempt++) {
            try { response = await this.network(metadata.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: session.refreshToken, token_type_hint: 'refresh_token', client_id: session.clientId }) }); if (response.status < 500) break; } catch { /* bounded retry */ }
            await new Promise(resolve => setTimeout(resolve, 200 * 2 ** attempt));
          }
          if (response?.status !== 200) confirmed = false;
        } catch { confirmed = false; }
        delete vault.sessions[id];
      }
      if (all || ids.includes(vault.active ?? '')) delete vault.active;
      await this.saveVault(vault);
      return confirmed;
    });
  }
  dispose() { this.epoch++; this.cancelSignIn?.(); }
}
