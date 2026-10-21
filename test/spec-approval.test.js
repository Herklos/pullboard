/** Hand-written approval is visible without becoming a person's decision [S1,B26,P6]. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';
import { configFromSource } from '../src/config.js';
import * as store from '../src/board.js';
import { SPEC_APPROVAL_ENGINE } from '../src/spec-approval-engine.js';
import { submitFixture } from './board-submit-fixture.js';

/** Run the private project's real CLI and require its structured successful response. */
function document(box, root, ...args) {
  const result = box.run(root, ...args, '--json');
  assert.equal(result.code, 0, `${result.out}\n${result.err}`);
  return JSON.parse(result.out);
}

test('a row approved without a person move reads as agent-approved until the person confirms it [S1,B26,P6]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  // This normal fixture's setup commit writes approved rows, without any person row decision.
  const box = helpers.project('true');
  const sourceCommit = box.git(box.repo, 'rev-parse', 'HEAD');
  const initial = document(box, box.repo, 'status');
  const unconfirmed = (initial.needs ?? []).find(need => need.kind === 'agent-approved' && need.id === 'G1');
  assert.ok(unconfirmed, 'an approved row with no person decision must appear in Needs you as agent-approved');
  assert.equal(unconfirmed.commit, sourceCommit, 'the flag names the commit containing the unconfirmed row');
  assert.ok(unconfirmed.agent, 'the available author attribution is shown, never inferred to be human approval');
  assert.match(unconfirmed.text, /agent-approved/u);

  const added = document(box, box.repo, 'add', 'web', 'Work on the unconfirmed requirement',
    '--specs', 'G1', '--criterion', 'The fixture page exists.');
  const id = added.item.item_id;
  assert.equal(box.run(box.web, 'claim', String(id)).code, 0, 'the default flag does not block work');
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/page.js'), 'export const page = true;\n');
  box.git(box.web, 'add', 'web/page.js');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): add the fixture page [G1]');
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  document(box, box.web, 'submit', String(id));
  const review = join(box.dir, 'independent-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, commit);
  document(box, review, 'join', 'api');
  const verified = box.run(review, 'verify', String(id), 'accept', '--note', 'The real fixture gate passed on the submitted commit.');
  assert.equal(verified.code, 0, `${verified.out}\n${verified.err}`);
  assert.match(verified.out, /verified against agent-approved G1/u);
  const exported = document(box, box.repo, 'export');
  const acceptance = exported.tables.event.findLast(event => event.item_id === id && event.event_kind === 'accept');
  assert.ok(acceptance, 'the normal independent verification produced a receipt');
  assert.match(acceptance.event_detail, /verified against agent-approved G1/u);
  const ledger = box.run(box.repo, 'ledger');
  assert.equal(ledger.code, 0, ledger.err);
  assert.match(ledger.out, /verified against agent-approved G1/u);

  // Only this isolated fixture simulates a marked agent and a separate ordinary person terminal.
  const agent = runFixtureChild(process.execPath, [helpers.BIN, 'spec', 'approve', 'G1', '--json'], {
    cwd: box.web, env: { ...box.env, CLAUDECODE: '1' }, encoding: 'utf8',
  });
  assert.equal(agent.status, 1);
  assert.equal(JSON.parse(agent.stdout).error.code, 'B26_PERSON_CHANNEL', 'an agent cannot confirm its own approval');
  document(box, box.repo, 'spec', 'approve', 'G1');
  const confirmed = document(box, box.repo, 'status');
  assert.equal((confirmed.needs ?? []).some(need => need.kind === 'agent-approved' && need.id === 'G1'), false,
    'one person decision confirms the exact row without a separate apply step');
  const after = box.run(box.repo, 'ledger');
  assert.equal(after.code, 0, after.err);
  assert.doesNotMatch(after.out, /verified against agent-approved G1/u, 'the current ledger reflects the confirmation');
  const kept = document(box, box.repo, 'export').tables.event.find(event => event.event_id === acceptance.event_id);
  assert.equal(kept.event_detail, acceptance.event_detail, 'confirmation never rewrites the historical verification receipt');
});

test('agent approval settings preserve the filename form and reject ambiguous choices [S1,P6]', () => {
  assert.equal(configFromSource('{}').specAgentApproval, 'flag');
  assert.equal(configFromSource('{"spec":"requirements.md"}').spec, 'requirements.md');
  for (const agentApproval of ['flag', 'allow', 'refuse']) {
    const config = configFromSource(JSON.stringify({ spec: { file: 'requirements.md', agentApproval } }));
    assert.equal(config.spec, 'requirements.md');
    assert.equal(config.specAgentApproval, agentApproval);
  }
  for (const spec of [null, [], { file: 'SPEC.md', agentApproval: null }, { file: 'SPEC.md', agentApproval: 'trust' },
    { file: 'SPEC.md', agentApproval: 'flag', agent: 'person' }]) {
    assert.throws(() => configFromSource(JSON.stringify({ spec })), error => error.code === 'BAD_CONFIG');
  }
});

test('allow suppresses approval calls and explicit refuse protects a new claim [S1,B26,P6]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  for (const mode of ['allow', 'refuse']) {
    const box = helpers.project('true');
    const file = join(box.repo, 'pullboard.json');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...config, spec: { file: 'SPEC.md', agentApproval: mode } }, null, 2) + '\n');
    box.git(box.repo, 'add', 'pullboard.json');
    box.git(box.repo, 'commit', '-q', '-m', 'chore(config): choose approval policy');
    box.git(box.web, 'merge', '-q', '--ff-only', 'main');
    const initial = document(box, box.repo, 'status');
    assert.equal(initial.needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'), mode !== 'allow');
    const id = document(box, box.repo, 'add', 'web', 'Policy-controlled fixture', '--specs', 'G1', '--criterion', 'A real fixture.').item.item_id;
    const claimed = box.run(box.web, 'claim', String(id), '--json');
    if (mode === 'allow') assert.equal(claimed.code, 0, `${claimed.out}\n${claimed.err}`);
    else {
      assert.equal(claimed.code, 1);
      assert.equal(JSON.parse(claimed.out).error.code, 'AGENT_APPROVAL_REQUIRED');
      document(box, box.repo, 'spec', 'approve', 'G1');
      assert.equal(box.run(box.web, 'claim', String(id)).code, 0, 'the exact person decision unblocks an explicit refuse policy');
    }
  }
});

test('confirmation follows the exact row and an unsigned ledger cannot impersonate it [S1,S19,P6]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const before = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const line = before.split('\n').find(text => text.startsWith('- G1 '));
  mkdirSync(join(box.repo, '.pullboard'), { recursive: true });
  writeFileSync(join(box.repo, '.pullboard/signoffs.jsonl'), JSON.stringify({ version: 1, type: 'row-decision', kind: 'spec',
    file: 'SPEC.md', id: 'G1', decision: 'approve', by: 'person', source: line, replacement: line, text: 'The page renders.' }) + '\n');
  assert.ok(document(box, box.repo, 'status').needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'),
    'a hand-written unsigned receipt is not person approval');
  document(box, box.repo, 'spec', 'approve', 'G1');
  assert.equal(document(box, box.repo, 'status').needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'), false);
  writeFileSync(join(box.repo, 'SPEC.md'), before.replace('The page renders.', 'The changed page renders.'));
  const changed = document(box, box.repo, 'status').needs.find(need => need.kind === 'agent-approved' && need.id === 'G1');
  assert.ok(changed, 'an approval of earlier wording cannot confirm a changed row');
  assert.equal(changed.commit, null, 'uncommitted wording never borrows a committed row attribution');
  document(box, box.repo, 'spec', 'approve', 'G1');
  assert.equal(document(box, box.repo, 'status').needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'), false);
});

test('the actual API reports approval calls and accepts one person confirmation [A9,S1,P6]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const view = await helpers.startView(box, box.repo);
  t.after(view.stop);
  const before = (await view.state(box.repo)).project;
  assert.ok(before.needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'));
  assert.equal(before.spec.find(row => row.id === 'G1').agentApproval.attribution, 'Git author, seat unknown');
  const confirmed = await view.act(box.repo, { verb: 'spec-approve', args: { ids: 'G1' } });
  assert.equal(confirmed.status, 200);
  const after = (await view.state(box.repo)).project;
  assert.equal(after.needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'), false);
  assert.equal(after.spec.find(row => row.id === 'G1').agentApproval, null);
});

test('a clone recognizes an exact signed approval without borrowing another board history [S19,S20,P6]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const key = join(box.dir, 'private-fixture-signing-key');
  const made = runFixtureChild('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { env: box.env, encoding: 'utf8' });
  assert.equal(made.status, 0, made.failure ?? made.stderr);
  box.git(box.repo, 'config', 'user.signingkey', key);
  document(box, box.repo, 'spec', 'signers', 'add', '--key', key + '.pub', '--by', 'fixture-person');
  const approved = document(box, box.repo, 'spec', 'approve', 'G1', '--by', 'fixture-person');
  assert.ok(approved.decisions[0].signature, 'the fixture person produced an actual SSH signature');
  document(box, box.repo, 'spec', 'apply');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore(spec): preserve the signed approval');
  const clone = join(box.dir, 'signed-clone');
  box.git(box.repo, 'clone', '-q', box.repo, clone);
  document(box, clone, 'init');
  assert.equal(document(box, clone, 'status').needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'), false,
    'a separate local board verifies the committed signed receipt');
  const view = await helpers.startView(box, clone);
  t.after(view.stop);
  const before = (await view.state(clone)).project;
  assert.equal(before.spec.find(row => row.id === 'G1').agentApproval, null);
  const head = box.git(clone, 'rev-parse', 'HEAD');
  const events = document(box, clone, 'export').tables.event;
  const receiptFile = join(clone, '.pullboard/signoffs.jsonl');
  const receipt = readFileSync(receiptFile, 'utf8');
  rmSync(receiptFile);
  const removed = (await view.state(clone)).project;
  assert.ok(removed.needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'),
    'removing only the proof file invalidates a cached confirmation');
  writeFileSync(receiptFile, receipt);
  assert.equal((await view.state(clone)).project.spec.find(row => row.id === 'G1').agentApproval, null,
    'restoring the exact verified proof confirms the row again');
  const records = receipt.trimEnd().split('\n').map(line => JSON.parse(line));
  const decision = records.find(record => record.type === 'row-decision' && record.id === 'G1');
  assert.ok(decision);
  decision.signature = 'invalid SSH signature';
  writeFileSync(receiptFile, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const invalid = (await view.state(clone)).project;
  assert.ok(invalid.needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'));
  assert.equal(invalid.specApprovalEvidenceErrors[0].code, 'BAD_SIGNATURE');
  writeFileSync(receiptFile, receipt);
  assert.equal((await view.state(clone)).project.spec.find(row => row.id === 'G1').agentApproval, null);
  assert.equal(box.git(clone, 'rev-parse', 'HEAD'), head, 'proof changes made no Git move');
  assert.deepEqual(document(box, clone, 'export').tables.event, events, 'proof reads made no board event');
  const source = readFileSync(join(clone, 'SPEC.md'), 'utf8');
  writeFileSync(join(clone, 'SPEC.md'), source.replace('gate: web test', 'gate: web stricter-test'));
  assert.ok(document(box, clone, 'status').needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'),
    'a signed approval does not authorize different gate bytes');
});

test('approval projection leaves a board with no Spec readable [I10,S1,P6]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const id = document(box, box.repo, 'add', 'web', 'An item needs no spec rows').item.item_id;
  rmSync(join(box.repo, 'SPEC.md'));
  assert.equal(document(box, box.repo, 'status').needs.some(need => need.kind === 'agent-approved'), false);
  assert.equal(document(box, box.repo, 'show', String(id)).agentApproved.length, 0);
  assert.deepEqual(document(box, box.repo, 'ledger').items, []);
  const view = await helpers.startView(box, box.repo);
  t.after(view.stop);
  const state = (await view.state(box.repo)).project;
  assert.deepEqual(state.spec, []);
  assert.equal(state.needs.some(need => need.kind === 'agent-approved'), false);
});

test('only new-engine acceptance receipts retain the verification note [H16,S1,P6]', t => {
  const payloads = [];
  const note = 'Fixture verification note; verified against agent-approved G1';
  for (const version of [SPEC_APPROVAL_ENGINE - 1, SPEC_APPROVAL_ENGINE]) {
    const board = store.openBoard(':memory:');
    t.after(() => store.closeBoard(board));
    const builder = store.register(board, { lane: 'web', path: '/fixture-builder', model: 'Fixture builder' });
    const reviewer = store.register(board, { lane: 'review', path: '/fixture-reviewer', model: 'Fixture reviewer' });
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Versioned receipt' });
    const frozen = { text: JSON.stringify({ rows: [], policy: { version: 1, commit: 'a'.repeat(40), verify: { policy: 'any', family: 'off' } } }), digest: 'f'.repeat(64) };
    store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000, head: 'a'.repeat(40), freeze: () => frozen });
    submitFixture(board, id, { agentId: builder, commit: 'b'.repeat(40), tree: 'c'.repeat(40) });
    board.executionEngineVersion = version;
    store.verify(board, id, { agentId: reviewer, decision: 'ACCEPT', note, head: 'b'.repeat(40), digest: frozen.digest,
      policy: 'any', check: 'green', review: { commit: 'b'.repeat(40), head: 'b'.repeat(40), trunk: 'a'.repeat(40), paths: [] } });
    const detail = JSON.parse(store.events(board, { itemId: id }).find(event => event.event_kind === 'accept').event_detail);
    assert.equal(detail.note, version >= SPEC_APPROVAL_ENGINE ? note : undefined);
    const { note: recorded, ...historical } = detail;
    payloads.push(historical);
  }
  assert.deepEqual(payloads[0], payloads[1], 'every existing receipt field retains its earlier replay meaning');
});


test('malformed approval evidence stays unconfirmed without blocking default flag work [S1,B26,P6]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  document(box, box.repo, 'spec', 'approve', 'G1');
  assert.equal(document(box, box.repo, 'status').needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'), false);
  mkdirSync(join(box.repo, '.pullboard'), { recursive: true });
  document(box, box.repo, 'spec', 'decline', 'G2', '--reason', 'Not a governing requirement');
  writeFileSync(join(box.repo, '.pullboard/signoffs.jsonl'), '{not valid JSON\n');
  const status = document(box, box.repo, 'status');
  assert.ok(status.needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'), 'bad proof does not confirm even a board-held decision');
  assert.ok(status.specApprovalEvidenceErrors.some(error => error.code === 'BAD_SIGNOFFS'));
  assert.equal(document(box, box.repo, 'status').needs.some(need => need.kind === 'agent-approved' && need.id === 'G2'), false,
    'one person decline removes the outstanding approval call');
  const id = document(box, box.repo, 'add', 'web', 'Default flag remains usable', '--specs', 'G1', '--criterion', 'A real fixture.').item.item_id;
  // The malformed ledger is in the coordinator checkout; the builder independently sees an unconfirmed row.
  assert.equal(box.run(box.web, 'claim', String(id)).code, 0);
});
