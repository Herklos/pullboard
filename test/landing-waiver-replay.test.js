/** Preserve released person-waiver receipts on independent current replicas [B3,R3,H16]. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { applyEngineMove, engineReceipt } from '../src/engine.js';
import { unpackRelease } from './release-archive.js';

/** Ignore only the current writer marker, never semantic history or ordered receipts. */
function withoutWriterMarker(document) {
  const copy = structuredClone(document);
  copy.tables.board_meta = copy.tables.board_meta.filter(row => row.meta_key !== 'relay_engine_version');
  return copy;
}

test('an actual engine12 person waiver keeps its exact receipt and history on both replicas [B3,R3,H16]', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-old-waiver-'));
  const archived = join(directory, 'engine12');
  const replicas = [];
  let oldStore;
  let old;
  t.after(() => {
    for (const board of replicas) store.closeBoard(board);
    if (old) oldStore.closeBoard(old);
    rmSync(directory, { recursive: true, force: true });
  });
  mkdirSync(archived);
  unpackRelease('59a6e2b286ee852add0d68a659f1a1e6b3257c44', archived);
  oldStore = await import(pathToFileURL(join(archived, 'src/board.js')).href);
  const oldEngine = await import(pathToFileURL(join(archived, 'src/engine.js')).href);
  const oldExchange = await import(pathToFileURL(join(archived, 'src/exchange.js')).href);
  const oldMachine = await import(pathToFileURL(join(archived, 'src/machine.js')).href);
  assert.equal(oldMachine.ENGINE_VERSION, 12, 'use the actual released executable, not a retagged current writer');
  old = oldStore.openBoard(join(directory, 'old.sqlite'));
  oldStore.ensureCoordinator(old, '/fixture');
  const seed = oldExchange.exportBoard(old);
  for (let index = 0; index < 2; index++) {
    const board = store.openBoard(':memory:');
    replicas.push(board);
    importBoard(board, seed);
  }
  const move = oldEngine.prepareEngineMove(old, 'recordLandingWaiver', [{
    agentId: 'person', channel: 'terminal', id: 'legacy-waiver', test: 'test/flaky.test.js',
    until: '2099-01-01T00:00:00.000Z', reason: 'Synthetic private replay proof',
  }], { id: 'old-person-waiver' });
  const order = { sequence: 1, at: '2026-10-17T20:00:00.000Z' };
  const original = oldEngine.applyEngineMove(old, move, order);
  assert.equal(original.error, undefined);
  assert.equal(Object.hasOwn(original.result, 'kind'), false, 'the released receipt did not store a match kind');
  const current = replicas.map(board => applyEngineMove(board, move, order));
  assert.deepEqual(current[0], current[1], 'current replicas agree');
  assert.deepEqual(exportBoard(replicas[0]), exportBoard(replicas[1]), 'current ordered prefixes agree');
  assert.deepEqual(current[0], original, 'the old move retains its released receipt shape');
  for (const board of replicas) {
    assert.deepEqual(engineReceipt(board, move.id), oldEngine.engineReceipt(old, move.id));
    assert.deepEqual(withoutWriterMarker(exportBoard(board)), withoutWriterMarker(oldExchange.exportBoard(old)));
    const before = exportBoard(board);
    assert.equal(store.landingWaiverFor(board, { file: 'test/flaky.test.js', name: 'unrelated behavior' }).kind, 'file');
    assert.equal(store.landingWaiverFor(board, { file: 'test/unrelated.test.js', name: 'test/flaky.test.js' }), null,
      'a file waiver cannot cover a test merely named like its file');
    assert.deepEqual(exportBoard(board), before, 'derived waiver classification never writes history');
    assert.deepEqual(applyEngineMove(board, move, order), original, 'retrying the old move preserves its released receipt');
  }
});
