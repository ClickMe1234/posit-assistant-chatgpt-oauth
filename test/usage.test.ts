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

test('thinking display follows admitted requests, preserves the last Assistant level and clears on sign-out', () => {
  const indicator = new UsageIndicator();
  const high = { sequence: 1, source: 'assistant' as const, model: 'Sol', reasoningEffort: 'high' as const, reasoningSource: 'assistant' as const };
  const low = { sequence: 2, source: 'assistant' as const, model: 'Luna', reasoningEffort: 'low' as const, reasoningSource: 'model-default' as const };
  indicator.setActive(high, true);
  assert.match(indicator.presentation(true, true).text, /Thinking: High/);
  assert.match(indicator.presentation(true, true).tooltip, /Sol: High/);
  indicator.setActive(low, true);
  assert.match(indicator.presentation(true, true).text, /High, Low/);
  assert.match(indicator.presentation(true, true).tooltip, /Luna: Low \(model default\)/);
  indicator.setActive(high, false);
  assert.match(indicator.presentation(true, true).text, /Thinking: Low/);
  indicator.setActive(low, false);
  assert.match(indicator.presentation(true, true).text, /ready.*Last thinking: Low/);
  // Rejected requests and standalone verification must not replace the last
  // admitted Assistant level, even when their receipt finishes later.
  indicator.setActive({ ...high, sequence: 3 }, false);
  const verification = { sequence: 4, source: 'verification' as const, reasoningEffort: 'max' as const };
  indicator.setActive(verification, true);
  assert.match(indicator.presentation(true, true).text, /Verifying.*Thinking: Max/);
  indicator.setActive(verification, false);
  assert.match(indicator.presentation(true, true).text, /Last thinking: Low/);
  assert.doesNotMatch(indicator.presentation(false, false).text, /Last thinking/);
  assert.doesNotMatch(indicator.presentation(true, true).text, /Last thinking/);
});

test('an unreported model default is identified honestly and none is visible', () => {
  const indicator = new UsageIndicator(); const request = { sequence: 1, source: 'assistant' as const };
  indicator.setActive(request, true);
  assert.match(indicator.presentation(true, true).text, /Thinking: Model default \(not reported\)/);
  indicator.setActive(request, false);
  indicator.setActive({ sequence: 2, source: 'assistant', reasoningEffort: 'none' }, true);
  assert.match(indicator.presentation(true, true).text, /Thinking: None/);
});

test('first-use confirmation is dismissed once, persists across calls and opens usage on request', async () => {
  const values = new Map<string, any>(); let shown = 0; let opened = 0;
  const state: StateStore = { get: <T>(key: string, fallback: T) => values.get(key) ?? fallback, update: async (key, value) => { values.set(key, value); } };
  const show = async () => { shown++; return 'usage' as const; };
  const open = async () => { opened++; };
  await showWelcomeOnce(state, show, open); await showWelcomeOnce(state, show, open);
  assert.equal(shown, 1); assert.equal(opened, 1); assert.equal(values.get('welcomeShown'), true);
});
