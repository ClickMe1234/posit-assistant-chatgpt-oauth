import test from 'node:test';
import assert from 'node:assert/strict';
import { applyReasoning, reasoningCapabilities } from '../src/reasoning';

const model = (slug: string, metadata = {}) => ({ slug, display_name: slug, visibility: 'list', ...metadata });

test('account thinking metadata overrides family fallbacks and excludes agent-only modes', () => {
  assert.deepEqual(reasoningCapabilities(model('gpt-6.1-sol', {
    supported_reasoning_levels: [{ effort: 'high' }, { effort: 'low' }, { effort: 'high' }, { effort: 'ultra' }, null, {}],
    default_reasoning_level: 'low'
  })), { levels: ['low', 'high'], defaultEffort: 'low' });
  assert.deepEqual(reasoningCapabilities(model('gpt-6.1-sol', { supported_reasoning_levels: [] })), { levels: [], defaultEffort: undefined });
  assert.deepEqual(reasoningCapabilities(model('custom', { supported_reasoning_levels: ['minimal', 'medium'], default_reasoning_level: 'high' })), { levels: ['minimal', 'medium'], defaultEffort: undefined });
});

test('documented family fallbacks are bounded and respect none restrictions', () => {
  for (const slug of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-sol-2026-10-01']) {
    assert.deepEqual(reasoningCapabilities(model(slug)), { levels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' });
  }
  for (const slug of ['gpt-6-sol', 'gpt-6-luna', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    assert.deepEqual(reasoningCapabilities(model(slug)), { levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' });
  }
  for (const slug of ['unknown', 'gpt-6.2-sol', 'gpt-6-astra-pro', 'gpt-5.6-sol-preview']) assert.equal(reasoningCapabilities(model(slug)).levels, undefined);
});

test('selected levels and other reasoning options survive; absent levels use an explicit known default', () => {
  const selected = { reasoning: { effort: 'high', summary: 'detailed', context: 'all_turns' } };
  assert.deepEqual(applyReasoning(selected, model('gpt-6.1-sol')), { reasoningEffort: 'high', reasoningSource: 'assistant' });
  assert.deepEqual(selected.reasoning, { effort: 'high', summary: 'detailed', context: 'all_turns' });
  const automatic = { reasoning: { summary: 'detailed' } };
  assert.deepEqual(applyReasoning(automatic, model('gpt-6.1-sol')), { reasoningEffort: 'medium', reasoningSource: 'model-default' });
  assert.deepEqual(automatic.reasoning, { summary: 'detailed', effort: 'medium' });
  const unknown = {};
  assert.deepEqual(applyReasoning(unknown, model('unknown')), { reasoningSource: 'unspecified' });
  assert.deepEqual(unknown, {});
});

test('none remains an explicit choice, and unsupported or malformed choices fail locally', () => {
  const none = { reasoning: { effort: 'none' } };
  assert.equal(applyReasoning(none, model('gpt-6-luna')).reasoningEffort, 'none');
  assert.equal(none.reasoning.effort, 'none');
  assert.throws(() => applyReasoning(none, model('gpt-6-astra')), /unavailable/);
  assert.throws(() => applyReasoning({ reasoning: { effort: 'high' } }, model('custom', { supported_reasoning_levels: [] })), /unavailable/);
  for (const effort of ['ultra', 'off', '', 100, {}, 'private-input']) assert.throws(() => applyReasoning({ reasoning: { effort } }, model('gpt-6.1-sol')), /Select a thinking level/);
  for (const reasoning of ['high', [], true]) assert.throws(() => applyReasoning({ reasoning }, model('gpt-6.1-sol')), /must be an object/);
});
