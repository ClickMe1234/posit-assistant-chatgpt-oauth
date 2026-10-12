import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { needsRemoteSignIn } from '../src/hosting';

test('package allows a Node workspace host in Workbench and retains desktop UI preference', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.extensionKind, ['ui', 'workspace']); assert.equal(manifest.main, './dist/extension.cjs');
  for (const command of ['prepareWorkbench', 'authorizeWorkbench', 'importWorkbench']) assert.ok(manifest.contributes.commands.some((entry: any) => entry.command === `chatgptOAuth.${command}`));
});

test('web/server hosts use transfer sign-in; local UI hosts keep local loopback OAuth', () => {
  assert.equal(needsRemoteSignIn(true, undefined, true), true);
  assert.equal(needsRemoteSignIn(true, 'posit-workbench', true), true);
  assert.equal(needsRemoteSignIn(false, 'ssh-remote', true), true);
  assert.equal(needsRemoteSignIn(false, 'ssh-remote', false), false);
  assert.equal(needsRemoteSignIn(false, undefined, false), false);
});
