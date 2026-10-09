import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageIndicator, showWelcomeOnce } from '../src/usage';
import type { StateStore } from '../src/oauth';

test('sign-in permission alone never claims Assistant is using the ChatGPT plan', () => {
  const indicator = new UsageIndicator();
  assert.match(indicator.presentation(false, false).text, /sign in/);
  assert.match(indicator.presentation(true, false).text, /consent required/);
  assert.match(indicator.presentation(true, true).text, /ready/);
  assert.doesNotMatch(indicator.presentation(true, true).text, /Using ChatGPT plan/);
});

test('actual Assistant requests show plan use and usage action until the last active request ends', () => {
  const indicator = new UsageIndicator();
  const first = { sequence: 1, source: 'assistant' as const }; const second = { sequence: 2, source: 'assistant' as const };
  indicator.setActive(first, true); indicator.setActive(second, true);
  assert.match(indicator.presentation(true, true).text, /Using ChatGPT plan/);
  assert.equal(indicator.presentation(true, true).command, 'chatgptOAuth.manageUsage');
  indicator.setActive(first, false); assert.match(indicator.presentation(true, true).text, /Using ChatGPT plan/);
  indicator.setActive(second, false); assert.match(indicator.presentation(true, true).text, /ready/);
});

test('verification is distinguished from Assistant use and failures clear usage indication', () => {
  const indicator = new UsageIndicator(); const request = { sequence: 1, source: 'verification' as const };
  indicator.setActive(request, true); assert.match(indicator.presentation(true, true).text, /Verifying/);
  indicator.setActive(request, false); assert.match(indicator.presentation(true, true).text, /ready/);
  indicator.setActive({ sequence: 2, source: 'assistant' }, false); assert.match(indicator.presentation(true, true).text, /ready/);
});

test('first-use confirmation is dismissed once, persists across calls and opens usage on request', async () => {
  const values = new Map<string, any>(); let shown = 0; let opened = 0;
  const state: StateStore = { get: <T>(key: string, fallback: T) => values.get(key) ?? fallback, update: async (key, value) => { values.set(key, value); } };
  const show = async () => { shown++; return 'usage' as const; };
  const open = async () => { opened++; };
  await showWelcomeOnce(state, show, open); await showWelcomeOnce(state, show, open);
  assert.equal(shown, 1); assert.equal(opened, 1); assert.equal(values.get('welcomeShown'), true);
});
