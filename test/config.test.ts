import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupConfig, PROVIDER_NAME, updateOwnedProvider } from '../src/config';

test('provider backup is exact and model configuration preserves unrelated providers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'positron-plan-config-'));
  const path = join(directory, 'providers.json'); const baseUrl = 'http://127.0.0.1:17864/v1';
  const unrelated = { baseUrl: 'https://example.invalid/v1', headers: { 'x-tenant': 'other' } };
  const raw = JSON.stringify({ version: 1, providers: { openai: unrelated, custom: { [PROVIDER_NAME]: { type: 'openai', baseUrl }, 'Other gateway': { type: 'anthropic', enabled: false } } } }, null, 4);
  try {
    await writeFile(path, raw);
    const backup = await backupConfig(path, directory); assert.equal(await readFile(backup, 'utf8'), raw);
    await updateOwnedProvider(path, baseUrl, [{ slug: 'account-model', display_name: 'Account model', visibility: 'list', context_window: 65536 }]);
    const updated = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(updated.providers.openai, unrelated); assert.deepEqual(updated.providers.custom['Other gateway'], { type: 'anthropic', enabled: false });
    assert.equal(updated.providers.custom[PROVIDER_NAME].protocol, 'openai-responses');
    assert.equal(updated.providers.custom[PROVIDER_NAME].models.custom[0].id, 'account-model');
    assert.equal(updated.providers.custom[PROVIDER_NAME].models.custom[0].maxContextLength, 65536);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('an endpoint/type conflict or invalid configuration is preserved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'positron-plan-config-'));
  const path = join(directory, 'providers.json');
  try {
    const raw = JSON.stringify({ providers: { custom: { [PROVIDER_NAME]: { type: 'anthropic', baseUrl: 'https://other.invalid' } } } });
    await writeFile(path, raw);
    await assert.rejects(() => updateOwnedProvider(path, 'http://127.0.0.1:1/v1', []), /changed/);
    assert.equal(await readFile(path, 'utf8'), raw);
    await writeFile(path, '{invalid');
    await assert.rejects(() => backupConfig(path, directory), /preserved/); assert.equal(await readFile(path, 'utf8'), '{invalid');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
