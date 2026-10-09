import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { createHash } from 'node:crypto';
import { OAuthManager, makePending, authorizeUrl, consumeCallback, validateIdentity, verifyIdToken, ISSUER, DIRECT_SCOPE, type SecretStore, type StateStore } from '../src/oauth';

function fixture(responder: (url: string, init?: RequestInit) => Promise<Response> = async () => new Response('{}')) {
  const secrets = new Map<string, string>(); const state = new Map<string, any>();
  const secretStore: SecretStore = { get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); }, delete: async key => { secrets.delete(key); } };
  const stateStore: StateStore = { get: <T>(key: string, fallback: T) => state.get(key) ?? fallback, update: async (key, value) => { state.set(key, value); } };
  let queue = Promise.resolve();
  const lock = <T>(action: () => Promise<T>): Promise<T> => { const result = queue.then(action, action); queue = result.then(() => {}, () => {}); return result; };
  const manager = new OAuthManager(secretStore, stateStore, 'unused', { fetch: responder as typeof fetch, verify: async token => JSON.parse(token), lock });
  return { manager, secrets, state };
}
function tokenResponse(nonce: string, subject = 'subject-1', scopes = DIRECT_SCOPE, expires = 3600) {
  return { access_token: 'mock-access', refresh_token: 'mock-refresh', id_token: JSON.stringify({ sub: subject, nonce, email: 'test@example.invalid' }), token_type: 'Bearer', expires_in: expires, scope: scopes };
}
async function authenticate(manager: OAuthManager, nonce: string) {
  const pending = makePending('http://127.0.0.1:12345/auth/callback'); pending.nonce = nonce;
  return manager.exchange(pending, new URL(`${pending.redirectUri}?code=mock-code&state=${pending.state}&client_id=oaiapp_mock`));
}
test('fresh PKCE, nonce, stable opaque host and exact registration parameters', async () => {
  const { manager } = fixture(); const host = await manager.hostId();
  assert.equal(await manager.hostId(), host); assert.match(host, /^urn:uuid:/);
  const a = makePending('http://127.0.0.1:12345/auth/callback'); const b = makePending(a.redirectUri);
  assert.notEqual(a.state, b.state); assert.notEqual(a.nonce, b.nonce); assert.notEqual(a.verifier, b.verifier);
  const url = new URL(authorizeUrl(a, host));
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('redirect_uri'), a.redirectUri);
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(a.verifier).digest('base64url'));
  const returning = new URL(authorizeUrl(makePending(a.redirectUri, { clientId: 'oaiapp_saved', subject: 'subject-1' }), host, 'mock-id'));
  assert.equal(returning.searchParams.get('client_id'), 'oaiapp_saved'); assert.equal(returning.searchParams.has('agent_name_hint'), false);
});
test('callback rejects state mismatch, duplicate state, replay, expired attempt and changed issued client', () => {
  const pending = makePending('http://127.0.0.1:1/auth/callback', { clientId: 'oaiapp_saved', subject: 's' });
  assert.throws(() => consumeCallback(new URL(`${pending.redirectUri}?state=wrong&code=c`), pending), /state/);
  assert.equal(pending.consumed, false);
  assert.throws(() => consumeCallback(new URL(`${pending.redirectUri}?state=${pending.state}&state=${pending.state}&code=c`), pending), /Duplicate/);
  assert.throws(() => consumeCallback(new URL(`${pending.redirectUri}?state=${pending.state}&client_id=oaiapp_other&code=c`), pending), /registration/);
  const valid = makePending(pending.redirectUri);
  const callback = new URL(`${valid.redirectUri}?state=${valid.state}&client_id=oaiapp_new&code=c`);
  assert.equal(consumeCallback(callback, valid).clientId, 'oaiapp_new'); assert.throws(() => consumeCallback(callback, valid), /already/);
  const expired = makePending(pending.redirectUri); expired.expiresAt = 1;
  assert.throws(() => consumeCallback(new URL(`${expired.redirectUri}?state=${expired.state}`), expired), /expired/);
});
test('declined consent consumes state without exchanging a code', () => {
  const pending = makePending('http://127.0.0.1:1/auth/callback');
  assert.throws(() => consumeCallback(new URL(`${pending.redirectUri}?state=${pending.state}&error=access_denied`), pending), /declined/);
  assert.equal(pending.consumed, true);
});
test('real JWT verification rejects wrong issuer, audience, expiry and signature; nonce/account checked separately', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const sign = (issuer = ISSUER, audience = 'oaiapp_mock', exp = '1h') => new SignJWT({ nonce: 'n' }).setProtectedHeader({ alg: 'RS256' }).setIssuer(issuer).setAudience(audience).setSubject('s').setIssuedAt().setExpirationTime(exp).sign(privateKey);
  const valid = await sign(); const identity = await verifyIdToken(valid, 'oaiapp_mock', publicKey);
  validateIdentity(identity, { nonce: 'n', subject: 's' });
  await assert.rejects(() => verifyIdToken(valid, 'wrong-client', publicKey));
  await assert.rejects(async () => verifyIdToken(await sign('https://other.invalid'), 'oaiapp_mock', publicKey));
  await assert.rejects(async () => verifyIdToken(await sign(ISSUER, 'oaiapp_mock', '-1h'), 'oaiapp_mock', publicKey));
  await assert.rejects(() => verifyIdToken(valid, 'oaiapp_mock', other.publicKey));
  assert.throws(() => validateIdentity(identity, { nonce: 'wrong' }), /nonce/);
  assert.throws(() => validateIdentity(identity, { nonce: 'n', subject: 'another' }), /different account/);
});
test('exchange uses the issued client and exact redirect URI and refuses mismatched account without overwriting', async () => {
  const nonce = 'n'; let form: URLSearchParams;
  const { manager } = fixture(async (_, init) => { form = init!.body as URLSearchParams; return Response.json(tokenResponse(nonce)); });
  await authenticate(manager, nonce);
  assert.equal(form!.get('client_id'), 'oaiapp_mock'); assert.equal(form!.get('redirect_uri'), 'http://127.0.0.1:12345/auth/callback');
  const pending = makePending('http://127.0.0.1:12345/auth/callback', { clientId: 'oaiapp_mock', subject: 'another' }); pending.nonce = nonce;
  await assert.rejects(() => manager.exchange(pending, new URL(`${pending.redirectUri}?state=${pending.state}&code=c`)), /different account/);
  assert.equal((await manager.active())?.subject, 'subject-1');
});
test('scope-less identity sign-in cannot perform subscription inference', async () => {
  const { manager } = fixture(async () => Response.json(tokenResponse('n', 's', 'openid email')));
  await authenticate(manager, 'n'); assert.ok(await manager.active());
  await assert.rejects(() => manager.accessToken(), /permission/);
});
test('concurrent refreshes serialize, rotate atomically, retain absent scope and use issued registration', async () => {
  let refreshes = 0;
  const { manager } = fixture(async (_, init) => {
    const form = init!.body as URLSearchParams;
    if (form.get('grant_type') === 'authorization_code') return Response.json(tokenResponse('n', 's', DIRECT_SCOPE, 1));
    refreshes++; assert.equal(form.get('client_id'), 'oaiapp_mock'); assert.equal(form.has('scope'), false);
    assert.equal(form.get('refresh_token'), 'mock-refresh');
    await new Promise(resolve => setTimeout(resolve, 20));
    return Response.json({ access_token: 'mock-access-rotated', refresh_token: 'mock-refresh-rotated', token_type: 'Bearer', expires_in: 3600 });
  });
  await authenticate(manager, 'n');
  assert.deepEqual(await Promise.all([manager.accessToken(), manager.accessToken(), manager.accessToken()]), ['mock-access-rotated', 'mock-access-rotated', 'mock-access-rotated']);
  assert.equal(refreshes, 1); assert.equal((await manager.active())?.refreshToken, 'mock-refresh-rotated');
  assert.equal(await manager.accessToken(true, 'mock-access'), 'mock-access-rotated'); assert.equal(refreshes, 1);
});
test('invalid_grant clears unusable tokens and retains account mapping', async () => {
  const { manager, secrets } = fixture(async (_, init) => (init!.body as URLSearchParams).get('grant_type') === 'authorization_code' ? Response.json(tokenResponse('n', 's', DIRECT_SCOPE, 1)) : Response.json({ error: { code: 'invalid_grant' } }, { status: 400 }));
  await authenticate(manager, 'n'); await assert.rejects(() => manager.accessToken(), /expired/);
  assert.equal(secrets.size, 0); assert.equal(manager.registrations().length, 1);
});
test('sign-out revokes refresh session and clears credentials while retaining stable host and registration', async () => {
  let revoked = false;
  const { manager, secrets } = fixture(async (url, init) => {
    if (url.endsWith('openid-configuration')) return Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks`, revocation_endpoint: `${ISSUER}/revoke` });
    if (url.endsWith('/revoke')) { const form = init!.body as URLSearchParams; assert.equal(form.get('token_type_hint'), 'refresh_token'); assert.equal(form.get('client_id'), 'oaiapp_mock'); revoked = true; return new Response('', { status: 200 }); }
    return Response.json(tokenResponse('n'));
  });
  const host = await manager.hostId(); await authenticate(manager, 'n');
  assert.equal(await manager.signOut(true), true); assert.equal(revoked, true); assert.equal(secrets.size, 0);
  assert.equal(manager.registrations().length, 1); assert.equal(await manager.hostId(), host);
});
test('sign-out stops a pending exchange from restoring credentials', async () => {
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const { manager } = fixture(async () => { await blocked; return Response.json(tokenResponse('n')); });
  const exchange = authenticate(manager, 'n'); await manager.signOut(true); finish();
  await assert.rejects(() => exchange, /changed/); assert.equal(await manager.active(), undefined);
});

test('expired authorization code retries once with its issued client, fresh PKCE/state/nonce and no dynamic registration', async () => {
  let grants = 0; let nonce = ''; const attempts: URL[] = [];
  const { manager } = fixture(async (_, init) => {
    const form = init!.body as URLSearchParams; assert.equal(form.get('client_id'), 'oaiapp_retry');
    if (++grants === 1) return Response.json({ error: 'invalid_grant' }, { status: 400 });
    return Response.json(tokenResponse(nonce));
  });
  const session = await manager.signIn(async address => {
    const url = new URL(address); attempts.push(url); nonce = url.searchParams.get('nonce')!;
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({ state: url.searchParams.get('state')!, code: 'mock-code', ...(attempts.length === 1 ? { client_id: 'oaiapp_retry' } : {}) }).toString();
    const response = await fetch(callback); assert.equal(response.status, attempts.length === 1 ? 400 : 200);
    return true;
  });
  assert.equal(session.clientId, 'oaiapp_retry'); assert.equal(attempts.length, 2);
  assert.equal(attempts[0].searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(attempts[1].searchParams.get('client_id'), 'oaiapp_retry');
  assert.equal(attempts[1].searchParams.has('agent_name_hint'), false);
  for (const key of ['state', 'nonce', 'code_challenge']) assert.notEqual(attempts[0].searchParams.get(key), attempts[1].searchParams.get(key));
  assert.equal(attempts[0].searchParams.get('ext_agent_host_id'), attempts[1].searchParams.get('ext_agent_host_id'));
});

test('cancelled browser sign-in closes its listener and stores no credentials', async () => {
  const { manager, secrets } = fixture(); const controller = new AbortController(); let callback = '';
  await assert.rejects(() => manager.signIn(async address => {
    callback = new URL(address).searchParams.get('redirect_uri')!;
    controller.abort(); return true;
  }, undefined, controller.signal), /cancelled/);
  assert.equal(secrets.size, 0); await assert.rejects(() => fetch(callback));
});
