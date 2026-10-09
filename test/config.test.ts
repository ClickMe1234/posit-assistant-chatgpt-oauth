import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupConfig, modelSettings, PROVIDER_NAME, updateOwnedProvider } from '../src/config';

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

test('account model families expose image attachments and plot results, unknown models remain conservative', () => {
  const models = modelSettings(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'unknown-account-model'].map(slug => ({ slug, display_name: slug, visibility: 'list' })));
  for (const model of models.slice(0, -1)) {
    assert.equal(model.supportsImages, true); assert.equal(model.supportsToolResultImages, true);
    assert.deepEqual(model.supportedInputMediaTypes, ['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  }
  assert.equal(models.at(-1)!.supportsImages, false); assert.equal(models.at(-1)!.supportsToolResultImages, false);
});

test('metadata migration backs up old image flags and preserves disabled/unrelated providers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'positron-image-migration-'));
  const path = join(directory, 'providers.json'); const baseUrl = 'http://127.0.0.1:17864/v1';
  const raw = JSON.stringify({ providers: { custom: { [PROVIDER_NAME]: { type: 'openai', baseUrl, enabled: false, models: { custom: [{ id: 'gpt-6.1-sol', supportsImages: false }] } }, Other: { type: 'anthropic', enabled: true } } } });
  try {
    await writeFile(path, raw); const backup = await backupConfig(path, directory);
    await updateOwnedProvider(path, baseUrl, [{ slug: 'gpt-6.1-sol', display_name: 'Sol', visibility: 'list' }], false);
    assert.equal(await readFile(backup, 'utf8'), raw);
    const config = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(config.providers.custom[PROVIDER_NAME].models.custom[0].supportsToolResultImages, true);
    assert.equal(config.providers.custom[PROVIDER_NAME].enabled, false);
    assert.deepEqual(config.providers.custom.Other, { type: 'anthropic', enabled: true });
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
