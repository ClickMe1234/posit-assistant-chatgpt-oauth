import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkbenchTransfer, encryptSession, parseTransferJson, validateTransferRequest } from '../src/transfer';
import { DIRECT_SCOPE, type SecretStore, type Session } from '../src/oauth';

const hostId = 'urn:uuid:00000000-0000-4000-8000-000000000001';
const session: Session = { clientId: 'oaiapp_synthetic', subject: 'synthetic-account', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', idToken: 'synthetic-id', scopes: [DIRECT_SCOPE], expiresAt: Date.now() + 3600_000 };
function fixture() {
  const values = new Map<string, string>();
  const store: SecretStore = { get: async key => values.get(key), store: async (key, value) => { values.set(key, value); }, delete: async key => { values.delete(key); } };
  let queue = Promise.resolve();
  const lock = <T>(action: () => Promise<T>) => { const next = queue.then(action); queue = next.then(() => {}, () => {}); return next; };
  return { transfer: new WorkbenchTransfer(store, 'unused', lock), values };
}

test('real RSA-OAEP/AES-GCM transfer contains no plaintext credentials and imports exactly once', async () => {
  const { transfer, values } = fixture(); const request = await transfer.prepare(hostId);
  assert.ok(values.size > 0); assert.equal(request.hostId, hostId); assert.ok(!JSON.stringify(request).includes('PRIVATE KEY'));
  const encrypted = encryptSession(request, session); const serialized = JSON.stringify(encrypted);
  for (const secret of [session.accessToken, session.refreshToken, session.idToken, session.subject]) assert.ok(!serialized.includes(secret));
  let imported: Session | undefined;
  await transfer.consume(encrypted, hostId, async value => { imported = value; });
  assert.deepEqual(imported, session); assert.equal(values.size, 0);
  await assert.rejects(() => transfer.consume(encrypted, hostId, async () => {}), /invalid/);
});

test('changed ciphertext/tag/metadata, wrong host, wrong installation and expired requests are rejected', async () => {
  const { transfer } = fixture(); const request = await transfer.prepare(hostId); const encrypted = encryptSession(request, session);
  const change = (text: string) => (text[0] === 'A' ? 'B' : 'A') + text.slice(1);
  for (const altered of [{ ...encrypted, ciphertext: change(encrypted.ciphertext) }, { ...encrypted, tag: change(encrypted.tag) },
    { ...encrypted, keyId: 'another-key' }, { ...encrypted, expiresAt: encrypted.expiresAt + 1 }, { ...encrypted, iv: 'invalid*' }]) {
    await assert.rejects(() => transfer.consume(altered, hostId, async () => assert.fail('must not import')));
  }
  await assert.rejects(() => transfer.consume(encrypted, hostId.replace(/1$/, '2'), async () => {}));
  const other = fixture(); await other.transfer.prepare(hostId);
  await assert.rejects(() => other.transfer.consume(encrypted, hostId, async () => {}));
  assert.throws(() => validateTransferRequest(request, request.expiresAt + 1));
  assert.throws(() => encryptSession({ ...request, expiresAt: 1 }, session));
  assert.throws(() => parseTransferJson('{invalid'));
  assert.throws(() => parseTransferJson(' '.repeat(256 * 1024 + 1)));
});

test('failed identity import retains the pending key; sign-out deletes it; concurrent replay cannot import twice', async () => {
  const { transfer, values } = fixture(); const encrypted = encryptSession(await transfer.prepare(hostId), session);
  await assert.rejects(() => transfer.consume(encrypted, hostId, async () => { throw new Error('identity mismatch'); }));
  assert.equal(values.size, 1);
  let count = 0;
  const results = await Promise.allSettled([1, 2].map(() => transfer.consume(encrypted, hostId, async () => { count++; })));
  assert.equal(count, 1); assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  await transfer.prepare(hostId); await transfer.clear(); assert.equal(values.size, 0);
  await transfer.prepare(hostId);
  const pending = JSON.parse(values.values().next().value!); pending.request.expiresAt = 1;
  values.set('workbench.pending.v1', JSON.stringify(pending)); await transfer.clearExpired(); assert.equal(values.size, 0);
});
