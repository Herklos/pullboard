/** Real Git, SQLite and ordered-engine coverage for coordinator criterion reopen [V2,V6,H16]. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import * as store from '../src/board.js';
import { appliedSequence, applyRelayMove, engineReceipt, prepareEngineMove } from '../src/engine.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { ENGINE_VERSION } from '../src/machine.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { unpackRelease } from './release-archive.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { project, commitFile } = e2e;

/** Open the real board SQLite file created by the CLI fixture and close it with the test. */
function openFixtureBoard(t, box) {
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  return board;
}

/** Create two isolated SQLite replicas from the submitted fixture's real board snapshot. */
function replicaPair(t, box) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-reopen-relay-'));
  const source = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  const snapshot = exportBoard(source);
  store.closeBoard(source);
  const copies = ['one', 'two'].map((name) => {
    const replica = store.openBoard(join(directory, `${name}.sqlite`));
    importBoard(replica, snapshot);
    return replica;
  });
  t.after(() => {
    for (const replica of copies) store.closeBoard(replica);
    rmSync(directory, { recursive: true, force: true });
  });
  return copies;
}

/** Add, claim and submit a real item through its joined Git worktree. */
function submitFixture(box) {
  const added = box.run(box.repo, 'add', 'web', 'Corrected criterion', '--specs', 'G1', '--criterion', 'The page renders.');
  assert.equal(added.code, 0, added.err);
  const claimed = box.run(box.web, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.err);
  const commit = commitFile(box, box.web, 'web/page.html', '<h1>Page</h1>', 'feat(web): page [G1]');
  assert.equal(commit.status, 0, commit.stderr);
  const submitted = box.run(box.web, 'submit', '1');
  assert.equal(submitted.code, 0, submitted.err);
  return { commit: box.git(box.web, 'rev-parse', 'HEAD'), tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}') };
}

/** Reserve the real submission from a separate joined reviewer checkout. */
function reserveFixtureReview(box) {
  const reviewPath = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', reviewPath, '-b', 'review/one');
  const joined = box.run(reviewPath, 'join', 'api');
  assert.equal(joined.code, 0, joined.err);
  const reserved = box.run(reviewPath, 'next', '--verify', '1');
  assert.equal(reserved.code, 0, reserved.err);
  return reviewPath;
}

/** Configure a real private main, joined builder, failing landing test and bare origin. */
function landingProject() {
  const box = project('node --test web/landing.test.js');
  // The private landing runs a real nested Node test runner, not the parent's test worker.
  delete box.env.NODE_TEST_CONTEXT;
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web', 'feature.js'), 'export const status = "PASS";\n');
  writeFileSync(join(box.repo, 'web', 'landing.test.js'), [
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    "import { test } from 'node:test';",
    "test('keeps the landed behavior', () => assert.match(readFileSync(new URL('./feature.js', import.meta.url), 'utf8'), /export const status/u));",
    '',
  ].join('\n'));
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.affectedTests = 'node --test';
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'web/landing.test.js', 'web/feature.js', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'test(web): add landing behavior check');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const remote = join(box.dir, 'origin.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  return { ...box, remote };
}

/** Add a real trunk regression after review, so only combining it with the candidate turns red. */
function requireLandingBehavior(box) {
  const file = join(box.repo, 'web', 'landing.test.js');
  const previous = readFileSync(file, 'utf8');
  writeFileSync(file, previous.replace('assert.match', 'assert.doesNotMatch').replace('/export const status/u', '/RED/u'));
  box.git(box.repo, 'add', 'web/landing.test.js');
  box.git(box.repo, 'commit', '-q', '-m', 'test(web): check behavior during integration [G1]');
  box.git(box.repo, 'push', '-q', 'origin', 'main');
}

/** Add and submit an item using its real joined Git worktree and frozen syntax check. */
function submitLandingFixture(box, number, contents, cwd = box.web) {
  if (cwd !== box.web) {
    box.git(box.repo, 'worktree', 'add', '-q', '-b', `web/landing-${number}`, cwd, 'main');
    assert.match(box.run(cwd, 'join', 'web').out, /joined as web-/u);
  }
  const added = box.run(box.repo, 'add', 'web', `Landing fixture ${number}`, '--specs', 'G1', '--criterion', `landing fixture ${number} remains valid`,
    '--check', 'node --check web/feature.js', '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal(box.run(cwd, 'claim', String(id)).code, 0);
  const committed = commitFile(box, cwd, 'web/feature.js', contents, `feat(web): submit landing fixture ${number} [G1]`);
  assert.equal(committed.status, 0, committed.stderr);
  const commit = box.git(cwd, 'rev-parse', 'HEAD');
  const submitted = box.run(cwd, 'submit', String(id));
  assert.equal(submitted.code, 0, submitted.err);
  return { id, cwd, commit };
}

/** Accept an item at its actual submitted commit, then restore the coordinator's main checkout. */
function acceptLandingFixture(box, item) {
  box.git(box.repo, 'switch', '-q', '--detach', item.commit);
  try {
    const result = box.run(box.repo, 'verify', String(item.id), 'accept', '--as', 'coordinator', '--note', 'private landing fixture passed its frozen check');
    assert.equal(result.code, 0, result.err);
  } finally { box.git(box.repo, 'switch', '-q', 'main'); }
}

/** Read a complete public item projection through a short-lived board connection. */
function readItem(box, id) {
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try { return { ...store.getItem(board, id), thread: store.itemThread(board, id), verdicts: store.verdictsFor(board, id) }; }
  finally { store.closeBoard(board); }
}

/** Accepted engine-9 source before verified-item reopening; the 0.8.8 tag is not yet published. */
const engine9Source = '314ef28751c44c96186b337cc4ace0fd8bf33d42';

/** Assert both older sealed engines preserve their submitted-only verified-item refusal. */
async function assertLegacyVerifiedReopen(t, box, item, note) {
  for (const [version, reference] of [[8, 'v0.8.6'], [9, engine9Source]]) {
    const directory = mkdtempSync(join(tmpdir(), `pullboard-engine-${version}-verified-reopen-`));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const source = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
    const snapshot = exportBoard(source);
    store.closeBoard(source);
    const move = { version: 1, engine: version, id: `legacy-verified-reopen-${version}`, operation: 'reopen',
      args: [item.id, { agentId: 'coordinator', note }], actor: 'coordinator' };
    const receipt = { sequence: 1, at: '2026-10-11T12:00:00.000Z', kind: 'move',
      sender: { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' } };

    const currentReceiver = store.openBoard(join(directory, 'current.sqlite'));
    t.after(() => store.closeBoard(currentReceiver));
    importBoard(currentReceiver, snapshot);
    const before = store.getItem(currentReceiver, item.id);
    const currentResult = applyRelayMove(currentReceiver, move, receipt);
    assert.equal(currentResult.error?.code, 'NOT_SUBMITTED');
    assert.deepEqual(store.getItem(currentReceiver, item.id), before, `engine-${version} replay leaves the verified item row unchanged`);
    assert.equal(currentResult.error?.message, `item #${item.id} is verified, not submitted`, `the current engine preserves engine-${version} refusal ordering and message`);

    const oldDirectory = join(directory, 'old-client');
    mkdirSync(oldDirectory);
    unpackRelease(reference, oldDirectory);
    const legacyEngine = await import(pathToFileURL(join(oldDirectory, 'src/engine.js')).href);
    const legacyStore = await import(pathToFileURL(join(oldDirectory, 'src/board.js')).href);
    const legacyExchange = await import(pathToFileURL(join(oldDirectory, 'src/exchange.js')).href);
    const legacyReceiver = legacyStore.openBoard(join(directory, 'legacy.sqlite'));
    t.after(() => legacyStore.closeBoard(legacyReceiver));
    legacyExchange.importBoard(legacyReceiver, snapshot);
    assert.equal((await import(pathToFileURL(join(oldDirectory, 'src/machine.js')).href)).ENGINE_VERSION, version);
    const legacyBefore = legacyStore.getItem(legacyReceiver, item.id);
    const legacyResult = legacyEngine.applyRelayMove(legacyReceiver, move, receipt);
    assert.equal(legacyResult.error?.code, 'NOT_SUBMITTED');
    assert.deepEqual(currentResult.error, legacyResult.error, `engine-${version} preserves the older refusal envelope`);
    assert.deepEqual(store.events(currentReceiver), legacyStore.events(legacyReceiver), `engine-${version} preserves the older refusal event history`);
    assert.deepEqual(legacyStore.getItem(legacyReceiver, item.id), legacyBefore, `the engine-${version} client keeps its submitted-only rule`);

    const nextMove = prepareEngineMove(currentReceiver, 'reopen', [item.id, { agentId: 'coordinator', note }],
      { id: `engine10-verified-reopen-after-${version}`, actor: 'coordinator' });
    assert.equal(nextMove.engine, 10);
    const beforeFuture = legacyExchange.exportBoard(legacyReceiver);
    assert.throws(() => legacyEngine.applyRelayMove(legacyReceiver, nextMove, { ...receipt, sequence: 2 }),
      (error) => error.code === 'ENGINE_VERSION');
    assert.deepEqual(legacyExchange.exportBoard(legacyReceiver), beforeFuture, `engine ${version} refuses before applying the engine-10 return`);
    const nextResult = applyRelayMove(currentReceiver, nextMove, { ...receipt, sequence: 2 });
    assert.equal(nextResult.error, undefined, JSON.stringify(nextResult));
    assert.equal(store.getItem(currentReceiver, item.id).item_status, 'open');
    assert.equal(nextResult.result.landingFailure.mergeCommit, note.match(/merge commit ([a-f0-9]{40})/u)[1]);
  }
}

test('the coordinator reopens a submitted item without a verdict [V2,V6,O8]', (t) => {
  const box = project();
  const submitted = submitFixture(box);
  reserveFixtureReview(box);

  const wrongCaller = box.run(box.web, 'reopen', '1', '--note', 'criterion wording needs correction', '--json');
  assert.equal(wrongCaller.code, 1);
  assert.equal(JSON.parse(wrongCaller.out).error.code, 'COORDINATOR_ONLY');
  const missingNote = box.run(box.repo, 'reopen', '1', '--note', ' ', '--json');
  assert.equal(missingNote.code, 1);
  assert.equal(JSON.parse(missingNote.out).error.code, 'NOTE_REQUIRED');

  assert.notEqual(box.git(box.repo, 'rev-parse', 'HEAD'), submitted.commit, 'the coordinator stays at its own head');
  const reopened = box.run(box.repo, 'reopen', '1', '--note', 'correct the frozen criterion, not the work', '--json');
  assert.equal(reopened.code, 0, reopened.err);
  const result = JSON.parse(reopened.out);
  assert.equal(result.version, 1);
  assert.equal(result.id, 1);
  assert.equal(result.commit, submitted.commit);
  const alreadyOpen = box.run(box.repo, 'reopen', '1', '--note', 'try twice', '--json');
  assert.equal(alreadyOpen.code, 1);
  assert.equal(JSON.parse(alreadyOpen.out).error.code, 'NOT_SUBMITTED');

  const board = openFixtureBoard(t, box);
  const item = store.getItem(board, 1);
  assert.equal(item.item_status, 'open');
  assert.equal(item.item_commit, submitted.commit, 'the builder’s submitted commit remains on record');
  assert.equal(item.item_built_by, 'web-1');
  assert.equal(item.item_verdict, null, 'reopen records no verifier judgment');
  assert.equal(item.item_verified_by, null);
  assert.equal(item.item_review_by, null, 'the old review reservation is cleared without a release/cooldown');
  assert.deepEqual(store.stats(board), {
    items: { open: 1, claimed: 0, submitted: 0, verified: 0, withdrawn: 0 }, accepted: 0, rejected: 0,
  });
  const last = store.events(board).at(-1);
  assert.equal(last.event_kind, 'reopen');
  assert.equal(last.event_by, 'coordinator');
  assert.deepEqual(JSON.parse(last.event_detail), {
    commit: submitted.commit, note: 'correct the frozen criterion, not the work', judgment: null, model: 'unknown',
  });
  assert.equal(store.events(board).some((event) => event.event_kind === 'release' && JSON.parse(event.event_detail).review), false);

  const edited = box.run(box.repo, 'edit', '1', '--criterion', 'The page renders a heading.');
  assert.equal(edited.code, 0, edited.err);
  assert.equal(store.getItem(board, 1).item_criterion, 'The page renders a heading.');
});

test('a red landing gate returns a verified item to its builder [B3,V4]', async (t) => {
  const box = landingProject();
  const item = submitLandingFixture(box, 1, 'export const status = "RED";\n');
  acceptLandingFixture(box, item);
  const initial = readItem(box, item.id);
  const originalAccept = initial.thread.find((event) => event.type === 'move' && event.kind === 'accept');
  assert.ok(originalAccept, 'the item begins with an actual accept event');
  requireLandingBehavior(box);

  const nonCoordinator = box.run(item.cwd, 'reopen', String(item.id), '--note', 'coordinator only', '--json');
  assert.equal(JSON.parse(nonCoordinator.out).error.code, 'COORDINATOR_ONLY');

  const landing = box.run(box.repo, 'land', '--max', '1', '--json');
  assert.equal(landing.code, 0, landing.err);
  const landingResult = JSON.parse(landing.out);
  assert.deepEqual(landingResult.culprits.map((culprit) => culprit.id), [item.id], JSON.stringify(landingResult));
  assert.equal(landingResult.culprits[0].mergeCommit, landingResult.batch.tip);
  assert.equal(landingResult.culprits[0].tests[0].file, 'web/landing.test.js');
  const returned = readItem(box, item.id);
  assert.equal(returned.item_status, 'open', 'land reopens its named culprit automatically');
  const automaticReopen = returned.thread.find((event) => event.type === 'move' && event.kind === 'reopen');
  assert.ok(automaticReopen);
  assert.equal(automaticReopen.detail.supersedes, originalAccept.eventId);
  assert.equal(automaticReopen.detail.landingFailure.mergeCommit, landingResult.batch.tip);
  assert.deepEqual(automaticReopen.detail.landingFailure.tests, landingResult.culprits[0].tests);
  assert.ok(returned.thread.some((event) => event.type === 'move' && event.eventId === originalAccept.eventId && event.kind === 'accept'),
    'the original accept remains in append-only item history');
  assert.deepEqual(returned.thread.find((event) => event.eventId === originalAccept.eventId), originalAccept,
    'returning the item does not rewrite its earlier accept event');
  assert.deepEqual(returned.verdicts, initial.verdicts, 'the prior verdict receipt stays byte-for-byte unchanged');
  const landingNote = automaticReopen.detail.note;

  const firstClaim = box.run(item.cwd, 'claim', String(item.id));
  assert.equal(firstClaim.code, 0, firstClaim.err);
  assert.equal(box.tryGit(item.cwd, 'merge-base', '--is-ancestor', item.commit, 'HEAD').status, 0,
    'the builder reclaims on top of the accepted commit');
  const firstFix = commitFile(box, item.cwd, 'web/feature.js', 'export const status = "PASS";\n', 'fix(web): restore landing behavior [G1]');
  assert.equal(firstFix.status, 0, firstFix.stderr);
  item.commit = box.git(item.cwd, 'rev-parse', 'HEAD');
  const firstSubmit = box.run(item.cwd, 'submit', String(item.id));
  assert.equal(firstSubmit.code, 0, firstSubmit.err);
  const awaitingFreshAccept = readItem(box, item.id);
  assert.equal(awaitingFreshAccept.item_status, 'submitted');
  assert.equal(awaitingFreshAccept.item_verified_by, null, 'the older accept does not verify the resubmission');
  const firstDryLand = box.run(box.repo, 'land', '--dry-run', '--json');
  assert.equal(firstDryLand.code, 0, firstDryLand.err);
  assert.ok(!JSON.parse(firstDryLand.out).items.includes(item.id), 'the earlier accept cannot make the resubmission eligible to land');
  acceptLandingFixture(box, item);
  const firstResubmission = readItem(box, item.id);
  const firstFreshAccept = firstResubmission.thread.filter((event) => event.type === 'move' && event.kind === 'accept').at(-1);
  assert.notEqual(firstFreshAccept.detail.commit, originalAccept.detail.commit);

  await assertLegacyVerifiedReopen(t, box, item, landingNote);
  const manualBox = landingProject();
  const manualItem = submitLandingFixture(manualBox, 1, 'export const status = "PASS_MANUAL";\n');
  acceptLandingFixture(manualBox, manualItem);
  const manualBoard = store.openBoard(join(manualBox.repo, '.git', 'pullboard', 'board.sqlite'));
  try { assert.deepEqual(store.landingBatches(manualBoard), [], 'hand-run landing evidence starts with no recorded batch'); }
  finally { store.closeBoard(manualBoard); }
  const manualAccept = readItem(manualBox, manualItem.id).thread.find((event) => event.type === 'move' && event.kind === 'accept');
  const noNamedTest = manualBox.run(manualBox.repo, 'reopen', String(manualItem.id), '--note', `merge commit ${'d'.repeat(40)}`, '--json');
  assert.equal(noNamedTest.code, 1);
  assert.equal(JSON.parse(noNamedTest.out).error.code, 'LANDING_FAILURE_REQUIRED');
  const manualNote = `web/landing.test.js: keeps the landed behavior; merge commit ${'d'.repeat(40)}`;
  const manual = manualBox.run(manualBox.repo, 'reopen', String(manualItem.id), '--note', manualNote, '--json');
  assert.equal(manual.code, 0, manual.err);
  const manuallyReturned = readItem(manualBox, manualItem.id);
  assert.equal(manuallyReturned.item_status, 'open');
  const manualEvent = manuallyReturned.thread.filter((event) => event.type === 'move' && event.kind === 'reopen').at(-1);
  assert.equal(manualEvent.detail.supersedes, manualAccept.eventId);
  assert.deepEqual(manualEvent.detail.landingFailure, {
    batch: null,
    tests: [{ file: 'web/landing.test.js', name: 'keeps the landed behavior' }],
    mergeCommit: 'd'.repeat(40),
  });
  assert.ok(manuallyReturned.thread.some((event) => event.eventId === manualAccept.eventId && event.kind === 'accept'),
    'the prior manual accept remains immutable in history');

  const nextManualNote = `web/landing.test.js: keeps the landed behavior; merge commit ${'e'.repeat(40)}`;
  const returnedAgain = box.run(box.repo, 'reopen', String(item.id), '--note', nextManualNote, '--json');
  assert.equal(returnedAgain.code, 0, returnedAgain.err);
  const returnedAgainItem = readItem(box, item.id);
  const returnedAgainEvent = returnedAgainItem.thread.filter((event) => event.type === 'move' && event.kind === 'reopen').at(-1);
  assert.equal(returnedAgainEvent.detail.supersedes, firstFreshAccept.eventId);
  assert.equal(returnedAgainEvent.detail.landingFailure.batch, null);

  const secondClaim = box.run(item.cwd, 'claim', String(item.id));
  assert.equal(secondClaim.code, 0, secondClaim.err);
  const secondFix = commitFile(box, item.cwd, 'web/feature.js', 'export const status = "PASS_AGAIN";\n', 'fix(web): finish landing rework [G1]');
  assert.equal(secondFix.status, 0, secondFix.stderr);
  item.commit = box.git(item.cwd, 'rev-parse', 'HEAD');
  const secondSubmit = box.run(item.cwd, 'submit', String(item.id));
  assert.equal(secondSubmit.code, 0, secondSubmit.err);
  const secondAwaitingAccept = readItem(box, item.id);
  assert.equal(secondAwaitingAccept.item_status, 'submitted');
  assert.equal(secondAwaitingAccept.item_verified_by, null, 'the prior accepts do not verify the second resubmission');
  const secondDryLand = box.run(box.repo, 'land', '--dry-run', '--json');
  assert.equal(secondDryLand.code, 0, secondDryLand.err);
  assert.ok(!JSON.parse(secondDryLand.out).items.includes(item.id), 'the earlier accepts cannot make the second resubmission eligible to land');
  acceptLandingFixture(box, item);
  const readyToLand = readItem(box, item.id);
  assert.equal(readyToLand.thread.filter((event) => event.type === 'move' && event.kind === 'accept').length, 3,
    'the resubmitted work has a fresh accept');
  assert.equal(JSON.parse(box.run(item.cwd, 'reopen', String(item.id), '--note', landingNote, '--json').out).error.code, 'COORDINATOR_ONLY');

  const greenLanding = box.run(box.repo, 'land', '--max', '1', '--json');
  assert.equal(greenLanding.code, 0, greenLanding.err);
  assert.deepEqual(JSON.parse(greenLanding.out).landed, [item.id]);
  const merged = readItem(box, item.id);
  assert.equal(merged.item_status, 'verified');
  assert.ok(merged.item_merged_commit);
  const mergedReopen = box.run(box.repo, 'reopen', String(item.id), '--note', landingNote, '--json');
  assert.equal(mergedReopen.code, 1);
  assert.equal(JSON.parse(mergedReopen.out).error.code, 'ALREADY_MERGED');
});

test('a reopened item resubmits at a new head after a criterion edit [V2,V6,H16]', async (t) => {
  const box = project();
  const submitted = submitFixture(box);
  const reviewPath = reserveFixtureReview(box);
  const copies = replicaPair(t, box);
  assert.ok(ENGINE_VERSION >= 8, 'engine 8 introduces ordered reopen semantics');
  assert.ok(ENGINE_VERSION >= 10, 'engine 10 adds verified-item landing reopens');
  const move = prepareEngineMove(copies[0], 'reopen', [1, {
    agentId: 'coordinator', note: 'replay the no-verdict return',
  }], { id: 'reopen-engine-roundtrip', actor: 'coordinator' });
  assert.equal(move.engine, ENGINE_VERSION, "new moves use the current engine while legacy receipts retain their recorded engine");
  const oldReceiver = store.openBoard(join(box.dir, 'old-engine.sqlite'));
  t.after(() => store.closeBoard(oldReceiver));
  importBoard(oldReceiver, exportBoard(copies[0]));
  const beforeOldReceiver = exportBoard(oldReceiver);
  const oldDirectory = mkdtempSync(join(tmpdir(), 'pullboard-engine-7-reopen-'));
  t.after(() => rmSync(oldDirectory, { recursive: true, force: true }));
  unpackRelease('v0.8.4', oldDirectory);
  const oldEngine = await import(pathToFileURL(join(oldDirectory, 'src/engine.js')).href);
  const oldMachine = await import(pathToFileURL(join(oldDirectory, 'src/machine.js')).href);
  assert.equal(oldMachine.ENGINE_VERSION, 7, 'retain coverage for the actual released engine-7 client');
  const sender = { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' };
  assert.throws(() => oldEngine.applyRelayMove(oldReceiver, move, {
    sequence: 1, at: '2026-10-10T12:00:00.000Z', kind: 'move', sender,
  }), (error) => error.code === 'ENGINE_VERSION');
  assert.deepEqual(exportBoard(oldReceiver), beforeOldReceiver, 'the actual engine-7 client refuses the future move before changing rows or replay state');
  assert.equal(appliedSequence(oldReceiver), 0);

  assert.throws(() => applyRelayMove(oldReceiver, { ...move, engine: 7 }, {
    sequence: 1, at: '2026-10-10T12:00:00.000Z', kind: 'move', sender,
  }), (error) => error.code === 'RELAY_MOVE');
  assert.deepEqual(exportBoard(oldReceiver), beforeOldReceiver, 'the current receiver rejects an impossible pre-introduction tag without mutation');

  for (const [version, reference] of [[8, 'v0.8.6'], [9, engine9Source]]) {
    const legacyDirectory = mkdtempSync(join(tmpdir(), `pullboard-engine-${version}-reopen-`));
    t.after(() => rmSync(legacyDirectory, { recursive: true, force: true }));
    unpackRelease(reference, legacyDirectory);
    const legacyEngine = await import(pathToFileURL(join(legacyDirectory, 'src/engine.js')).href);
    const legacyStore = await import(pathToFileURL(join(legacyDirectory, 'src/board.js')).href);
    const legacyExchange = await import(pathToFileURL(join(legacyDirectory, 'src/exchange.js')).href);
    const legacyMachine = await import(pathToFileURL(join(legacyDirectory, 'src/machine.js')).href);
    assert.equal(legacyMachine.ENGINE_VERSION, version, `exercise the actual engine-${version} source`);
    const legacyReceiver = legacyStore.openBoard(join(box.dir, `engine-${version}-reopen.sqlite`));
    t.after(() => legacyStore.closeBoard(legacyReceiver));
    const submittedSnapshot = exportBoard(copies[0]);
    legacyExchange.importBoard(legacyReceiver, submittedSnapshot);
    assert.throws(() => legacyEngine.applyRelayMove(legacyReceiver, move, {
      sequence: 1, at: '2026-10-10T12:00:00.000Z', kind: 'move', sender,
    }), (error) => error.code === 'ENGINE_VERSION');
    const legacyMove = { ...move, id: `legacy-engine${version}-reopen`, engine: version };
    const legacyResult = legacyEngine.applyRelayMove(legacyReceiver, legacyMove, {
      sequence: 1, at: '2026-10-10T12:00:00.000Z', kind: 'move', sender,
    });
    assert.equal(legacyResult.error, undefined, JSON.stringify(legacyResult));
    assert.deepEqual(legacyResult.result, { id: 1, commit: submitted.commit });
    const currentLegacyReceiver = store.openBoard(join(box.dir, `current-engine-${version}-reopen.sqlite`));
    t.after(() => store.closeBoard(currentLegacyReceiver));
    importBoard(currentLegacyReceiver, submittedSnapshot);
    const currentLegacyResult = applyRelayMove(currentLegacyReceiver, legacyMove, {
      sequence: 1, at: '2026-10-10T12:00:00.000Z', kind: 'move', sender,
    });
    assert.equal(currentLegacyResult.error, undefined, JSON.stringify(currentLegacyResult));
    assert.deepEqual(currentLegacyResult.result, legacyResult.result);
    assert.deepEqual(store.getItem(currentLegacyReceiver, 1), legacyStore.getItem(legacyReceiver, 1),
      `the current engine replays a submitted engine-${version} reopen as its older client did`);
  }

  const first = applyRelayMove(copies[0], move, { sequence: 1, at: '2026-10-10T12:00:00.000Z', kind: 'move', sender });
  const second = applyRelayMove(copies[1], move, { sequence: 1, at: '2026-10-10T12:00:00.000Z', kind: 'move', sender });
  assert.deepEqual(first, second);
  assert.deepEqual(first.result, { id: 1, commit: submitted.commit });
  for (const replica of copies) {
    assert.equal(store.getItem(replica, 1).item_status, 'open');
    assert.equal(store.getItem(replica, 1).item_commit, submitted.commit);
    assert.equal(store.events(replica).at(-1).event_kind, 'reopen');
    assert.equal(JSON.parse(store.events(replica).at(-1).event_detail).judgment, null);
    assert.equal(appliedSequence(replica), 1);
    assert.equal(engineReceipt(replica, move.id).sequence, 1);
    const forged = { ...move, id: 'forged-reopen' };
    const refusal = applyRelayMove(replica, forged, {
      sequence: 2, at: '2026-10-10T12:00:01.000Z', kind: 'move',
      sender: { kind: 'agent', userId: 'fixture-user', agent: 'web-1' },
    });
    assert.equal(refusal.error.code, 'RELAY_SENDER_MISMATCH');
    const refusedEvent = store.events(replica, { itemId: 1 }).at(-1);
    assert.equal(refusedEvent.event_kind, 'relay_refused', 'a forged reopen is visible in the item history');
    assert.equal(refusedEvent.item_id, 1);
    assert.equal(refusedEvent.event_by, 'web-1');
    assert.equal(appliedSequence(replica), 2);
  }

  const reopened = box.run(box.repo, 'reopen', '1', '--note', 'correct the frozen criterion');
  assert.equal(reopened.code, 0, reopened.err);
  const edited = box.run(box.repo, 'edit', '1', '--criterion', 'The page renders a heading.');
  assert.equal(edited.code, 0, edited.err);

  const claimed = box.run(box.web, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.err);
  const sameHead = box.run(box.web, 'submit', '1', '--json');
  assert.equal(sameHead.code, 1);
  assert.equal(JSON.parse(sameHead.out).error.code, 'HEAD_NOT_NEW');
  const treeBefore = box.git(box.web, 'rev-parse', 'HEAD^{tree}');
  box.git(box.web, 'commit', '--allow-empty', '-m', 'chore(web): resend corrected criterion at a new head [G1]');
  const newHead = box.git(box.web, 'rev-parse', 'HEAD');
  assert.notEqual(newHead, submitted.commit);
  assert.equal(box.git(box.web, 'rev-parse', 'HEAD^{tree}'), treeBefore, 'an empty commit keeps the measured tree unchanged');
  const resubmission = box.run(box.web, 'submit', '1', '--json');
  assert.equal(resubmission.code, 0, resubmission.err);
  assert.equal(JSON.parse(resubmission.out).commit, newHead);
  const board = openFixtureBoard(t, box);
  assert.equal(store.getItem(board, 1).item_commit, newHead);
  const freshReview = box.run(reviewPath, 'next', '--verify', '1');
  assert.equal(freshReview.code, 0, `reopen starts no reviewer cooldown: ${freshReview.err}`);
});
