import { readFile, mkdir, writeFile, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AccountModel } from './bridge';
import { BridgeError } from './errors';

export const PROVIDER_NAME = 'ChatGPT OAuth (local)';
export async function readConfig(path: string): Promise<{ raw: string; value: any }> {
  try {
    const raw = await readFile(path, 'utf8');
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid root');
    return { raw, value };
  } catch (error: any) {
    if (error.code === 'ENOENT') return { raw: '', value: { $schema: 'https://assistant.posit.co/schemas/providers.schema.json', version: 1, providers: {} } };
    throw new BridgeError(400, 'invalid_provider_config', 'Existing providers.json could not be read as JSON. It was preserved.');
  }
}
export async function backupConfig(path: string, storageDirectory: string): Promise<string> {
  const { raw } = await readConfig(path);
  const directory = join(storageDirectory, 'provider-backups'); await mkdir(directory, { recursive: true });
  const backup = join(directory, `providers-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  await writeFile(backup, raw || '{}\n', { mode: 0o600, flag: 'wx' });
  return backup;
}
export function modelSettings(models: AccountModel[]) {
  return models.map(model => {
    const context = Number.isSafeInteger(model.context_window) && model.context_window! >= 8192 ? model.context_window! : 32768;
    // Match the image-capable account families recognized by Assistant 1.7.0.
    // Unknown models stay text-only; discovery is not a vision entitlement check.
    const images = /^gpt-6(?:[.-]|$)/.test(model.slug) || /^gpt-5\.6(?:-(?:sol|terra|luna)(?:-\d{4}-\d{2}-\d{2})?)?$/.test(model.slug);
    return { id: model.slug, name: model.display_name, protocol: 'openai-responses', maxContextLength: context,
      maxInputTokens: Math.max(4096, context - 8192), maxOutputTokens: 8192,
      supportsTools: true, supportsImages: images, supportsToolResultImages: images,
      supportedInputMediaTypes: images ? ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] : [], supportsWebSearch: false };
  });
}
export async function updateOwnedProvider(path: string, baseUrl: string, models: AccountModel[], enable = true): Promise<void> {
  // Positron/ai-config uses proper-lockfile's directory lock at this exact path.
  // Share that lock so updates merge with the latest user/Assistant configuration.
  const lockPath = `${path}.lock`; const deadline = Date.now() + 15_000;
  while (true) {
    try { await mkdir(lockPath); break; }
    catch (error: any) { if (error.code !== 'EEXIST') throw error; if (Date.now() >= deadline) throw new BridgeError(409, 'config_busy', 'Another process is editing providers.json. Retry shortly.'); await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  try { await updateLocked(path, baseUrl, models, enable); }
  finally { await rmdir(lockPath); }
}

async function updateLocked(path: string, baseUrl: string, models: AccountModel[], enable: boolean): Promise<void> {
  const { raw, value } = await readConfig(path);
  const entry = value.providers?.custom?.[PROVIDER_NAME];
  if (!entry || entry.type !== 'openai' || entry.baseUrl !== baseUrl) throw new BridgeError(409, 'provider_changed', 'The local provider entry changed. Reconnect it before updating models.');
  entry.protocol = 'openai-responses';
  entry.models = { discovery: 'off', custom: modelSettings(models) };
  if (enable) entry.enabled = true;
  // Verify no other writer changed providers.json while preparing the update.
  const current = await readFile(path, 'utf8');
  if (current !== raw) throw new BridgeError(409, 'config_changed', 'providers.json changed during the update. Retry the connection.');
  const temporary = join(dirname(path), `.chatgpt-plan-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    // Recheck after writing the temporary file as well.
    if (await readFile(path, 'utf8') !== raw) throw new BridgeError(409, 'config_changed', 'providers.json changed during the update. Retry the connection.');
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}
