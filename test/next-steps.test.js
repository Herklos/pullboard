/** Every seat routes person decisions through the coordinator [B26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refusalDocument } from '../src/json.js';
import { NEXT_STEPS } from '../src/next-steps.js';
import { agentsBlock } from '../src/templates.js';

test('agents are never told to ask the person [B26]', () => {
  const route = 'ask the coordinator to bring it to the person: pullboard shout coordinator "<what is needed>" --decision';
  for (const code of Object.keys(NEXT_STEPS)) {
    const refusal = { code, message: 'This operation was refused.' };
    const original = refusalDocument(refusal).error.next;
    const builder = refusalDocument(refusal, { caller: 'seat' }).error.next;
    assert.doesNotMatch(builder, /\bask the person\b/iu, `${code} never directs a seat to the person`);
    if (/\bask the person\b/iu.test(original)) assert.equal(builder, route, `${code} names the coordinator decision route`);
    else assert.equal(builder, original, `${code} keeps unrelated guidance`);
    assert.equal(refusalDocument(refusal, { caller: 'coordinator' }).error.next, original, `${code} keeps coordinator guidance`);
    assert.equal(refusalDocument(refusal, { caller: 'person' }).error.next, original, `${code} keeps person guidance`);
  }
  for (const text of ['ask the person to approve G1', 'Ask the person for a waiver', 'ask the person to preview this change']) {
    const explicit = { code: 'B26_PERSON_APPROVAL', message: 'An approval is required.', next: text };
    assert.equal(refusalDocument(explicit, { caller: 'seat' }).error.next, route, 'contextual next steps use the same route');
    assert.equal(refusalDocument(explicit, { caller: 'coordinator' }).error.next, text, 'contextual coordinator wording is unchanged');
    const footer = { code: explicit.code, message: `An approval is required.\nnext: ${text}` };
    assert.equal(refusalDocument(footer, { caller: 'seat' }).error.next, route, 'a remote next footer cannot direct a seat to the person');
    assert.equal(refusalDocument(footer, { caller: 'person' }).error.next, text, 'a person retains the original footer');
  }
  const block = agentsBlock();
  const talk = block.slice(block.indexOf('**Talk.**'), block.indexOf('**Small models.**') === -1 ? block.indexOf('**Never.**') : block.indexOf('**Small models.**'));
  assert.match(talk, /only the coordinator/iu);
  assert.match(talk, /main checkout/iu);
  assert.match(talk, /pullboard shout coordinator/iu);
  assert.match(talk, /--decision/u);
  assert.match(talk, /never asks? the person in (?:its|their) own session/iu);
  for (const need of ['decision', 'approval', 'waiver', 'preview', 'phone check']) assert.ok(talk.includes(need), `Talk routes a ${need}`);
});
