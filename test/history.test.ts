import test from 'node:test';
import assert from 'node:assert/strict';
import { ResponseHistory } from '../src/history';
import { adaptRequest } from '../src/adapter';

const reasoning = { type: 'reasoning', id: 'rs-test', summary: [], encrypted_content: 'synthetic-encrypted-content' };
const message = (id: string) => ({ type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text: 'synthetic response' }] });
const done = (item: any) => ({ type: 'response.output_item.done', item });

test('SDK stored-item references expand to explicit stateless history including encrypted reasoning', () => {
  const history = new ResponseHistory(); history.selectAccount('account-a');
  history.remember(done(reasoning), 'account-a');
  history.remember({ type: 'response.completed', response: { output: [message('msg-test')] } }, 'account-a');
  const request = { model: 'm', store: true, input: [{ type: 'item_reference', id: 'rs-test' }, { type: 'item_reference', id: 'msg-test' }] };
  const adapted = adaptRequest(request, history.resolve);
  assert.equal(adapted.store, false); assert.deepEqual(adapted.input, [reasoning, message('msg-test')]);
  assert.equal(request.input[0].type, 'item_reference');
  adapted.input[0].encrypted_content = 'changed';
  assert.equal(history.resolve('rs-test').encrypted_content, reasoning.encrypted_content);
});

test('unavailable references fail locally with recovery instructions instead of upstream 404', () => {
  const history = new ResponseHistory(); history.selectAccount('a');
  for (const resolver of [undefined, history.resolve]) assert.throws(() => adaptRequest({ model: 'm', input: [{ type: 'item_reference', id: 'unknown' }] }, resolver), (error: any) => {
    assert.equal(error.status, 409); assert.equal(error.code, 'history_item_unavailable'); assert.match(error.message, /new Assistant chat/); return true;
  });
});

test('history expires, respects item/byte bounds, and clears on account changes and sign-out', () => {
  let now = 0;
  const history = new ResponseHistory(1024, 2, 100, () => now); history.selectAccount('a');
  for (const id of ['one', 'two', 'three']) history.remember(done(message(id)), 'a');
  assert.throws(() => history.resolve('one')); assert.equal(history.resolve('three').id, 'three');
  now = 101; assert.throws(() => history.resolve('three'));
  history.remember(done(message('four')), 'a'); history.selectAccount('b');
  assert.throws(() => history.resolve('four'));
  history.remember(done(message('late-a')), 'a'); assert.throws(() => history.resolve('late-a'));
  history.remember(done(message('b')), 'b'); history.clear(); assert.throws(() => history.resolve('b'));
  history.remember(done(message('late-b')), 'b'); assert.throws(() => history.resolve('late-b'));
  const tiny = new ResponseHistory(1); tiny.selectAccount('a'); tiny.remember(done(reasoning), 'a'); assert.throws(() => tiny.resolve(reasoning.id));
  const bounded = new ResponseHistory(Buffer.byteLength(JSON.stringify(message('one'))) + 1); bounded.selectAccount('a');
  bounded.remember(done(message('one')), 'a'); bounded.remember(done(message('two')), 'a');
  assert.throws(() => bounded.resolve('one')); assert.equal(bounded.resolve('two').id, 'two');
});
