/** Submission receipts distinguish actual selection from later landing escapes [C7,V4]. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as store from '../src/board.js';
import { applyEngineMove, applyRelayMove, prepareEngineMove } from '../src/engine.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { SUBMISSION_PROOF_ENGINE, landingFileTimes } from '../src/submit-invariants.js';
import { landingFailures } from '../src/land.js';
import { createE2eHelpers } from './e2e-helpers.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Read a fixture's real board through its public interface. */
function onBoard(box, action) {
  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try { return action(board); } finally { store.closeBoard(board); }
}

/** Run the real fixture CLI, preserving a refusal as an assertion failure. */
function json(box, root, ...args) {
  const result = box.run(root, ...args, '--json');
  assert.equal(result.code, 0, result.err + result.out);
  return JSON.parse(result.out);
}

/** Record synthetic landing history through the public operation, never direct database writes. */
function landing(box, id, submit, commit, files, diagnostics = [], green = false) {
  return onBoard(box, board => store.recordLandingBatch(board, {
    agentId: 'coordinator', batch: {
      version: 1, id, base: submit.policyCommit, tip: commit, root: join(box.dir, id),
      branch: 'refs/heads/main', owner: 'fixture', state: 'blocked', logPath: join(box.dir, id + '.log'),
      items: [{ id: submit.id, commit: submit.commit }],
      gateResults: [{ commit, tree: 'e'.repeat(40), isGreen: green,
        submissions: [{ id: submit.id, commit: submit.commit }],
        failures: green ? [] : files.map(file => ({ file: file.path, name: file.path + ' contract' })),
        fileTimes: files, logPath: join(box.dir, id + '.log') }],
      invariantEvidence: { version: 1, gates: [{ commit, isGreen: green,
        submissions: [{ id: submit.id, commit: submit.commit }],
        failures: green ? [] : files.map(file => file.path), fileTimes: files }], diagnostics },
    },
  }));
}

test('a landing escape is proposed as a submit invariant [C7,V4]', async () => {
  const box = e2e.project('node --test web/page.test.js');
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.submitGate = 'landing';
  config.affectedTests = 'node --test';
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/page.js'), 'export const page = 1;\n');
  writeFileSync(join(box.repo, 'web/page.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { page } from './page.js';\ntest('page contract', () => assert.ok(page));\n");
  writeFileSync(join(box.repo, 'web/other.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('unrelated contract', () => assert.ok(true));\n");
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure private selection');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const made = json(box, box.repo, 'add', 'web', 'change the page', '--specs', 'G1',
    '--criterion', 'The page remains present.', '--check', 'node --test web/page.test.js', '--wait');
  const id = made.item.item_id;
  json(box, box.web, 'claim', String(id));
  assert.equal(e2e.commitFile(box, box.web, 'web/page.js', 'export const page = 2;\n',
    'feat(web): update page [G1]').status, 0);
  json(box, box.web, 'submit', String(id));
  const event = onBoard(box, board => store.events(board, { itemId: id }).findLast(row => row.event_kind === 'submit'));
  const submit = { id, ...JSON.parse(event.event_detail) };
  assert.ok(submit.submissionProof, 'the actual submit event retains the selected files instead of relying on its human note');
  assert.equal(submit.submissionProof.full, false);
  assert.deepEqual(submit.submissionProof.files, ['web/page.test.js']);
  assert.equal(submit.submissionProof.reason, '');
  assert.equal(submit.submissionProof.deferred, true);
  assert.equal(submit.submissionProof.version, 1);

  const first = 'a'.repeat(40);
  const second = 'b'.repeat(40);
  const third = 'c'.repeat(40);
  landing(box, 'earlier-green', submit, first, [], [], true);
  landing(box, 'first-escape', submit, first, [
    { path: 'test/repeated.test.js', durationMs: 4000 },
    { path: 'test/once.test.js', durationMs: 1000 },
    { path: 'test/slow.test.js', durationMs: 70000 },
    { path: 'web/page.test.js', durationMs: 12 },
    { path: 'test/recovered.test.js', durationMs: 50 },
    { path: 'test/other-commit.test.js', durationMs: 75 },
    { path: 'test/unknown.test.js', durationMs: null },
  ], [
    { test: 'test/recovered.test.js', isGreen: true, commit: first, wallMs: 52 },
    { test: 'test/other-commit.test.js', isGreen: true, commit: second, wallMs: 76 },
  ]);
  landing(box, 'second-escape', submit, second, [
    { path: 'test/repeated.test.js', durationMs: 4500 },
    { path: 'test/slow.test.js', durationMs: 80000 },
  ]);
  // A second receipt of the same merge is evidence custody, not another escaped merge.
  landing(box, 'duplicate-receipt', submit, second, [{ path: 'test/repeated.test.js', durationMs: 4500 }]);
  const recoveredCommit = 'f'.repeat(40);
  landing(box, 'full-recovery-red', submit, recoveredCommit, [{ path: 'test/full-recovered.test.js', durationMs: 25 }]);
  landing(box, 'later-full-green', submit, recoveredCommit, [], [], true);
  onBoard(box, board => {
    const previous = store.landingBatches(board).find(batch => batch.id === 'first-escape');
    const eventCount = store.events(board).length;
    assert.throws(() => store.recordLandingBatch(board, { agentId: 'coordinator', revision: previous.revision,
      batch: { ...previous, invariantEvidence: { ...previous.invariantEvidence, gates: [] } } }), { code: 'LAND_EVIDENCE' });
    assert.equal(store.events(board).length, eventCount, 'a prior receipt cannot be removed or rewritten');
  });
  const untouchedConfig = readFileSync(configPath, 'utf8');
  const proposals = json(box, box.repo, 'status').submitInvariantProposals;
  assert.equal(proposals[0].file, 'test/repeated.test.js', 'a repeated escape below budget is first');
  const byFile = new Map(proposals.map(proposal => [proposal.file, proposal]));
  assert.equal(byFile.get('test/repeated.test.js').escapes, 2);
  assert.equal(byFile.get('test/repeated.test.js').runtimeMs, 4500);
  assert.equal(byFile.get('test/repeated.test.js').budgetMs, 60000);
  assert.equal(byFile.get('test/repeated.test.js').withinBudget, true);
  assert.equal(byFile.get('test/slow.test.js').withinBudget, false);
  assert.equal(byFile.get('test/unknown.test.js').runtimeMs, null, 'unmeasured is not zero');
  assert.equal(byFile.get('test/unknown.test.js').withinBudget, null);
  assert.ok(byFile.has('test/other-commit.test.js'), 'green on a different commit cannot erase the escape');
  assert.ok(byFile.has('test/once.test.js'), 'an earlier green at the same commit does not erase a later failure');
  assert.equal(byFile.has('test/full-recovered.test.js'), false, 'a later full green at the exact commit suppresses the escape');
  assert.equal(byFile.has('test/recovered.test.js'), false, 'whole-file green at the exact merge suppresses it');
  assert.equal(byFile.has('web/page.test.js'), false, 'a selected file did not escape selection');
  const human = box.run(box.repo, 'status');
  assert.equal(human.code, 0, human.err);
  assert.match(human.out, /submit invariant/u);
  assert.match(human.out, /test\/repeated\.test\.js/u);
  assert.match(human.out, /60\s*s/u);
  assert.match(human.out, /unmeasured/u);
  assert.equal(readFileSync(configPath, 'utf8'), untouchedConfig, 'status never auto-edits configuration');

  // Historical submits with no selection remain unknown, even if their human note mentions a fallback.
  onBoard(box, board => {
    const legacy = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'legacy submit' });
    store.claim(board, legacy, { agentId: 'web-1', lane: 'web', leaseMs: 3600000,
      freeze: () => ({ text: '{"rows":[]}', digest: 'f'.repeat(64) }) });
    store.submit(board, legacy, { agentId: 'web-1', commit: 'd'.repeat(40), tree: 'e'.repeat(40), note: 'full suite deferred to the landing gate' });
    submit.legacy = legacy;
  });
  landing(box, 'legacy-unknown', { id: submit.legacy, commit: 'd'.repeat(40), policyCommit: submit.policyCommit }, third,
    [{ path: 'test/legacy.test.js', durationMs: 1 }]);
  assert.equal(json(box, box.repo, 'status').submitInvariantProposals.some(row => row.file === 'test/legacy.test.js'), false);

  const fallbackItem = json(box, box.repo, 'add', 'web', 'change a non-module input', '--specs', 'G1',
    '--criterion', 'Non-module selection is recorded.', '--check', 'node --test web/page.test.js', '--wait').item.item_id;
  const fallbackTree = join(box.dir, 'web-fallback');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'web/fallback', fallbackTree, 'main');
  json(box, fallbackTree, 'join', 'web');
  json(box, fallbackTree, 'claim', String(fallbackItem));
  assert.equal(e2e.commitFile(box, fallbackTree, 'web/style.css', 'body { color: red; }\n', 'feat(web): change non-module input [G1]').status, 0);
  json(box, fallbackTree, 'submit', String(fallbackItem));
  const fallback = onBoard(box, board => store.events(board, { itemId: fallbackItem }).findLast(row => row.event_kind === 'submit'));
  const fallbackProof = JSON.parse(fallback.event_detail).submissionProof;
  assert.equal(fallbackProof.full, true);
  assert.equal(fallbackProof.deferred, true);
  assert.deepEqual(fallbackProof.files, [], 'a deferred full fallback did not run its possible selection');
  assert.match(fallbackProof.reason, /style\.css/u, 'the actual full-fallback reason remains durable');

  delete config.submitGate;
  writeFileSync(configPath, JSON.stringify(config));
  assert.deepEqual(json(box, box.repo, 'status').submitInvariantProposals, [], 'feature is off outside landing submit policy');
});

test('submission selection replays on two replicas and legacy history remains unknown [C7,V4,H16]', t => {
  const box = e2e.sandbox();
  const source = store.openBoard(join(box.dir, 'source.sqlite'));
  const copies = [];
  t.after(() => { for (const board of [source, ...copies]) store.closeBoard(board); });
  store.register(source, { lane: 'coordinator', path: '/fixture/main' });
  store.register(source, { lane: 'web', path: '/fixture/web' });
  const id = store.addItem(source, { by: 'coordinator', lane: 'web', title: 'selection replica' });
  store.claim(source, id, { agentId: 'web-1', lane: 'web', leaseMs: 3600000,
    freeze: () => ({ text: '{"rows":[]}', digest: 'f'.repeat(64) }) });
  const document = exportBoard(source);
  for (let index = 0; index < 4; index += 1) {
    const board = store.openBoard(join(box.dir, `replica-${index}.sqlite`));
    importBoard(board, document); copies.push(board);
  }
  const options = { agentId: 'web-1', commit: 'a'.repeat(40), tree: 'b'.repeat(40),
    submissionProof: { version: 1, files: ['test/a.test.js'], full: false, deferred: true, reason: '' } };
  const move = prepareEngineMove(source, 'submit', [id, options], { id: 'selection-replay', actor: 'web-1' });
  const receipt = { sequence: 1, at: '2026-10-17T00:00:00.000Z', kind: 'move',
    sender: { kind: 'agent', userId: 'fixture', agent: 'web-1' } };
  const first = applyRelayMove(copies[0], move, receipt);
  assert.equal(first.error, undefined);
  assert.deepEqual(applyRelayMove(copies[1], move, receipt), first);
  assert.deepEqual(store.events(copies[0]), store.events(copies[1]));
  assert.throws(() => applyEngineMove(copies[2], { ...move, engine: SUBMISSION_PROOF_ENGINE - 1 }, receipt), { code: 'RELAY_MOVE' });
  assert.equal(store.getItem(copies[2], id).item_status, 'claimed');
  const invalid = structuredClone(move);
  invalid.id = 'selection-invalid-path';
  invalid.args[1].submissionProof.files = ['../outside.test.js'];
  assert.equal(applyRelayMove(copies[2], invalid, receipt).error?.code, 'SUBMISSION_PROOF');
  assert.equal(store.getItem(copies[2], id).item_status, 'claimed', 'invalid coverage cannot submit the item');
  const legacy = structuredClone(move);
  legacy.engine = 12;
  delete legacy.args[1].submissionProof;
  const old = applyRelayMove(copies[3], legacy, receipt);
  assert.equal(old.error, undefined);
  const last = store.events(copies[3]).findLast(event => event.event_kind === 'submit');
  assert.equal(Object.hasOwn(JSON.parse(last.event_detail), 'submissionProof'), false);
  assert.deepEqual(landingFileTimes('/fixture', { files: [], tests: [{ file: 'test/a.test.js', durationMs: 8 }] }), [],
    'case-body duration is not a measured file duration');
  assert.deepEqual(landingFileTimes('/fixture', { files: [{ path: '/fixture/test/a.test.js', durationMs: 8 }, { path: '/elsewhere/private.js', durationMs: 1 }] }),
    [{ path: 'test/a.test.js', durationMs: 8 }], 'reported file timings are relative and cannot escape the project');
  const cancelled = "not ok 1 - cancelled child\n  location: /fixture/test/cancelled.test.js:1:1\n  failureType: 'cancelledByParent'\nnot ok 2 - actual failure\n  location: /fixture/test/failed.test.js:1:1\n  failureType: 'testCodeFailure'\nnot ok 3 - test/wrapper.test.js\n  failureType: 'subtestsFailed'\n";
  assert.equal(landingFailures(cancelled, '/fixture').length, 3, 'the existing landing parser behavior stays available');
  assert.deepEqual(landingFailures(cancelled, '/fixture', { excludeCancelled: true }), [{ file: 'test/failed.test.js', name: 'actual failure' }],
    'cancellation fallout and aggregate wrappers do not become independent escaped-file suggestions');
});
