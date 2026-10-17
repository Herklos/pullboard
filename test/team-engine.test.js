/** Sealed re-reviews bind the original work without changing released receipts [E8,H16,V8]. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { applyEngineMove, appliedSequence, engineReceipt, prepareEngineMove } from '../src/engine.js';
import { VERDICT_REVIEW_ENGINE } from '../src/machine.js';
import { unpackRelease } from './release-archive.js';

const BASE = 'a'.repeat(40);
const COMMIT = 'b'.repeat(40);
const TRUNK = 'c'.repeat(40);
const DIGEST = 'd'.repeat(64);
const AT = '2026-10-16T00:00:00.000Z';

/** Build a submitted, registered board entirely through public engine/store operations. */
function submitted(t) {
  const board = store.openBoard(':memory:', { now: () => new Date(AT) });
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: '/fixture' });
  store.register(board, { lane: 'web', path: '/fixture/web-1' });
  store.register(board, { lane: 'web', path: '/fixture/web-2' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Sealed review fixture' });
  store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 3_600_000, head: BASE,
    freeze: () => ({ text: JSON.stringify({ rows: [], policy: { version: 1, commit: BASE, verify: { policy: 'any', family: 'off' } } }), digest: DIGEST }) });
  store.submit(board, id, { agentId: 'web-1', commit: COMMIT, tree: TRUNK, files: ['web/feature.js'], policyCommit: BASE });
  return board;
}

/** Produce one independent replica through the public board exchange format. */
function replica(t, seed) {
  const board = store.openBoard(':memory:');
  t.after(() => store.closeBoard(board));
  importBoard(board, exportBoard(seed));
  return board;
}

/** The normal verifier's typed arguments, with optional new review metadata. */
function verdict(review) {
  return { agentId: 'web-2', decision: 'ACCEPT', note: 'The verifier checked the original work with the known trunk.',
    head: COMMIT, digest: DIGEST, policy: 'any', familyPolicy: 'off', check: 'green',
    ...(review === undefined ? {} : { review }) };
}

/** A writer-version marker is intentionally newer; all historical semantic rows must still match. */
function withoutWriterMarker(document) {
  const copy = structuredClone(document);
  copy.tables.board_meta = copy.tables.board_meta.filter(row => row.meta_key !== 'relay_engine_version');
  return copy;
}

test('engine 12 acceptance receipts stay exact and sealed re-review needs a newer engine [E8,H16,V8]', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-review-engines-'));
  const archived = join(directory, 'engine12');
  mkdirSync(archived);
  unpackRelease('59a6e2b286ee852add0d68a659f1a1e6b3257c44', archived);
  const oldStore = await import(pathToFileURL(join(archived, 'src/board.js')).href);
  const oldEngine = await import(pathToFileURL(join(archived, 'src/engine.js')).href);
  const oldExchange = await import(pathToFileURL(join(archived, 'src/exchange.js')).href);
  const oldMachine = await import(pathToFileURL(join(archived, 'src/machine.js')).href);
  assert.equal(oldMachine.ENGINE_VERSION, 12, 'this is the actual released executable, not a retagged new engine');
  const seed = submitted(t);
  const one = replica(t, seed);
  const two = replica(t, seed);
  const old = oldStore.openBoard(join(directory, 'old.sqlite'));
  t.after(() => { oldStore.closeBoard(old); rmSync(directory, { recursive: true, force: true }); });
  oldExchange.importBoard(old, exportBoard(seed));
  const accept = oldEngine.prepareEngineMove(old, 'verify', [1, verdict()], { id: 'old-engine12-accept' });
  const repeated = oldEngine.prepareEngineMove(old, 'verify', [1, verdict()], { id: 'old-engine12-repeated-accept' });
  for (const [index, move] of [accept, repeated].entries()) {
    const order = { sequence: index + 1, at: `2026-10-16T00:00:0${index + 1}.000Z` };
    const original = oldEngine.applyEngineMove(old, move, order);
    assert.equal(original.error?.code, index === 0 ? undefined : 'NOT_SUBMITTED');
    for (const board of [one, two]) {
      assert.deepEqual(applyEngineMove(board, move, order), original);
      assert.deepEqual(engineReceipt(board, move.id), oldEngine.engineReceipt(old, move.id));
      assert.deepEqual(withoutWriterMarker(exportBoard(board)), withoutWriterMarker(oldExchange.exportBoard(old)));
    }
  }
  const originalVerdicts = store.verdictsFor(one, 1);
  const reReview = { ...prepareEngineMove(one, 'verify', [1, verdict({ commit: COMMIT, head: COMMIT, trunk: TRUNK, paths: ['web/feature.js'] })], { id: 'sealed-new-review' }), engine: VERDICT_REVIEW_ENGINE };
  assert.equal(reReview.engine, 20, 'the feature replays at its introduction version even after a later writer upgrade');
  const oldBefore = oldExchange.exportBoard(old);
  assert.throws(() => oldEngine.applyEngineMove(old, reReview, { sequence: 3, at: AT }), { code: 'ENGINE_VERSION' });
  assert.deepEqual(oldExchange.exportBoard(old), oldBefore, 'an actual old client refuses the future envelope before changing its prefix');
  const before = exportBoard(one);
  assert.throws(() => applyEngineMove(one, { ...reReview, engine: 12 }, { sequence: 3, at: AT }), { code: 'RELAY_MOVE' });
  assert.deepEqual(exportBoard(one), before, 'new metadata cannot acquire old-engine meaning by changing the tag');
  const order = { sequence: 3, at: '2026-10-16T00:00:03.000Z' };
  assert.deepEqual(applyEngineMove(one, reReview, order), applyEngineMove(two, reReview, order));
  assert.equal(appliedSequence(one), 3);
  assert.equal(store.verdictsFor(one, 1).length, 2);
  assert.deepEqual(store.verdictsFor(one, 1).slice(0, 1), originalVerdicts, 'the old proof remains byte-for-byte unchanged');
  assert.deepEqual(exportBoard(one), exportBoard(two));
});

test('malformed sealed reviews cannot append proof or bind a different submission [E8,H16,V8]', t => {
  const one = submitted(t);
  const two = replica(t, one);
  const valid = { commit: COMMIT, head: COMMIT, trunk: TRUNK, paths: ['web/feature.js'] };
  const invalid = [{ commit: COMMIT, trunk: TRUNK, paths: ['web/feature.js'] }, { ...valid, head: 'not-a-commit' }, null, { ...valid, commit: BASE }, { ...valid, trunk: 'not-a-commit' },
    { ...valid, paths: 'web/feature.js' }, { ...valid, paths: ['web/feature.js', 'web/feature.js'] },
    { ...valid, paths: ['web/z.js', 'web/a.js'] }, { ...valid, paths: ['/web/feature.js'] },
    { ...valid, paths: ['web/../feature.js'] }, { ...valid, paths: ['web//feature.js'] },
    { ...valid, unexpected: true }];
  for (const [index, review] of invalid.entries()) {
    const move = prepareEngineMove(one, 'verify', [1, verdict(review)], { id: `invalid-review-${index}` });
    const order = { sequence: index + 1, at: AT };
    const first = applyEngineMove(one, move, order);
    assert.equal(first.error?.code, 'BAD_VERDICT_REVIEW', JSON.stringify(first));
    assert.deepEqual(first, applyEngineMove(two, move, order));
    assert.deepEqual(store.verdictsFor(one, 1), []);
    assert.equal(store.getItem(one, 1).item_status, 'submitted');
    assert.deepEqual(exportBoard(one), exportBoard(two));
  }
});


test('a landing snapshot binds the checked composition through replay and final receipts [E8,H16,R3]', t => {
  const one = submitted(t);
  const two = replica(t, one);
  const reviewed = { commit: COMMIT, head: TRUNK, trunk: BASE, paths: ['web/feature.js'] };
  /** Capture the same acceptance timestamp in both replicas through their ordered public engine. */
  const acceptAt = (head, sequence) => {
    const move = prepareEngineMove(one, 'verify', [1, { ...verdict({ ...reviewed, head }), head }], { id: `checked-review-${sequence}` });
    const first = applyEngineMove(one, move, { sequence, at: AT });
    assert.equal(first.error, undefined, JSON.stringify(first));
    assert.deepEqual(first, applyEngineMove(two, move, { sequence, at: AT }));
  };
  acceptAt(TRUNK, 1);
  const entry = { id: 1, commit: COMMIT, reviewedCommit: TRUNK, merge: TRUNK };
  const batch = { version: 1, id: 'reviewed-landing', state: 'pushed', base: BASE, tip: TRUNK,
    branch: 'refs/heads/main', root: '/fixture/landing', owner: 'fixture', logPath: '/fixture/landing.log',
    candidates: [entry], items: [entry], revision: 0 };
  const record = prepareEngineMove(one, 'recordLandingBatch', [{ agentId: 'coordinator', batch }], { id: 'checked-landing-snapshot' });
  assert.equal(record.engine, VERDICT_REVIEW_ENGINE);
  const before = exportBoard(one);
  assert.throws(() => applyEngineMove(one, { ...record, engine: 12 }, { sequence: 2, at: AT }), { code: 'RELAY_MOVE' });
  assert.deepEqual(exportBoard(one), before, 'a downgraded checked-head snapshot cannot mutate the prefix');
  assert.deepEqual(applyEngineMove(one, record, { sequence: 2, at: AT }), applyEngineMove(two, record, { sequence: 2, at: AT }));
  acceptAt(COMMIT, 3);
  const finish = prepareEngineMove(one, 'finishLandingBatch', [{ agentId: 'coordinator', id: batch.id, tip: TRUNK }], { id: 'stale-checked-landing' });
  const beforeFinish = exportBoard(one);
  assert.throws(() => applyEngineMove(one, { ...finish, engine: 12 }, { sequence: 4, at: AT }), { code: 'RELAY_MOVE' });
  assert.deepEqual(exportBoard(one), beforeFinish, 'a legacy-tagged finish cannot bypass the checked snapshot binding');
  const refused = applyEngineMove(one, finish, { sequence: 4, at: AT });
  assert.equal(refused.error?.code, 'LAND_ITEM_MOVED', 'a later re-review cannot inherit a prior checked tree gate');
  assert.deepEqual(refused, applyEngineMove(two, finish, { sequence: 4, at: AT }));
  assert.equal(store.getItem(one, 1).item_merged_commit, null);
  assert.equal(store.landingBatches(one)[0].state, 'pushed', 'a refused receipt leaves the exact prior snapshot intact');
  acceptAt(TRUNK, 5);
  const restored = { ...finish, id: 'matching-checked-landing' };
  const landed = applyEngineMove(one, restored, { sequence: 6, at: AT });
  assert.equal(landed.error, undefined, JSON.stringify(landed));
  assert.deepEqual(landed, applyEngineMove(two, restored, { sequence: 6, at: AT }));
  assert.equal(store.getItem(one, 1).item_commit, COMMIT);
  assert.equal(store.getItem(one, 1).item_merged_commit, TRUNK);
  assert.equal(store.landingBatches(one)[0].items[0].reviewedCommit, TRUNK);
  assert.deepEqual(exportBoard(one), exportBoard(two));
});

test('an older landing refusal remains exact after its snapshot acquires checked-head binding [E8,H16,R3]', t => {
  const board = submitted(t);
  store.verify(board, 1, verdict({ commit: COMMIT, head: COMMIT, trunk: BASE, paths: ['web/feature.js'] }));
  const batch = { version: 1, id: 'upgraded-snapshot', state: 'gating', base: BASE, tip: COMMIT,
    branch: 'refs/heads/main', root: '/fixture/landing', owner: 'fixture', logPath: '/fixture/landing.log',
    candidates: [{ id: 1, commit: COMMIT }], items: [{ id: 1, commit: COMMIT }], revision: 0 };
  const legacy = { ...prepareEngineMove(board, 'recordLandingBatch', [{ agentId: 'coordinator', batch }], { id: 'legacy-snapshot' }), engine: 12 };
  assert.equal(applyEngineMove(board, legacy, { sequence: 1, at: AT }).error, undefined);
  const finish = { ...prepareEngineMove(board, 'finishLandingBatch', [{ agentId: 'coordinator', id: batch.id, tip: COMMIT }], { id: 'legacy-not-pushed' }), engine: 12 };
  const original = applyEngineMove(board, finish, { sequence: 2, at: AT });
  assert.equal(original.error?.code, 'LAND_NOT_PUSHED');
  const saved = engineReceipt(board, finish.id);
  const checked = { ...batch, revision: 1, candidates: [{ id: 1, commit: COMMIT, reviewedCommit: TRUNK }], items: [{ id: 1, commit: COMMIT, reviewedCommit: TRUNK }] };
  const update = prepareEngineMove(board, 'recordLandingBatch', [{ agentId: 'coordinator', batch: checked, revision: 1 }], { id: 'checked-snapshot' });
  assert.equal(applyEngineMove(board, update, { sequence: 3, at: AT }).error, undefined);
  assert.deepEqual(applyEngineMove(board, finish, { sequence: 2, at: AT }), original);
  assert.deepEqual(engineReceipt(board, finish.id), saved, 'a new snapshot meaning cannot alter an existing refusal receipt');
  const before = exportBoard(board);
  assert.throws(() => applyEngineMove(board, { ...finish, id: 'new-legacy-attempt' }, { sequence: 4, at: AT }), { code: 'RELAY_MOVE' });
  assert.deepEqual(exportBoard(board), before);
});
