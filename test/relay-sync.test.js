/** A relay timeout, a busy link lock or an uncertain baseline never fails a local board move [B26,H16,H17]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { relayClientFixture } from './relay-client-fixture.js';

const RELAY = JSON.stringify(new URL('../src/relay.js', import.meta.url).href);

/** Read the saved link without including ciphertext or credentials in an assertion diagnostic. */
function link(box) { return JSON.parse(readFileSync(box.linkFile, 'utf8')); }

/** Run shout moves in one child process with a short transport timeout, reporting codes, notices and local rows. */
function moves(box, texts, options = {}) {
  return box.script(`
    const { relayOperation, localRecords } = await import(${RELAY});
    const lines = [], io = { err: line => lines.push(line), relayTimeoutMs: 300, ...${JSON.stringify(options)} };
    const outcomes = [];
    for (const text of ${JSON.stringify(texts)}) {
      try { await relayOperation(process.cwd(), 'shout', [{ from: 'coordinator', to: 'all', lanes: [], text }], io); outcomes.push('ok'); }
      catch (error) { outcomes.push({ code: error.code, message: error.message }); }
    }
    const local = localRecords(process.cwd(), board => board.db.prepare('SELECT shout_text AS text FROM shout').all().map(row => row.text));
    process.stdout.write(JSON.stringify({ outcomes, lines, local }));
  `);
}

/** Pause the first baseline for size, as the 19 Oct submit failure did, then stop the relay answering. */
async function pausedLink(t) {
  const box = await relayClientFixture(t);
  box.legacySnapshotApi('bad-route');
  box.rejectSnapshots({ status: 400, code: 'BAD_REQUEST', message: 'the body exceeds 14000000 bytes; send a smaller snapshot' });
  await box.link();
  box.rejectSnapshots(null);
  assert.ok(link(box).baselinePause, 'the baseline is paused for size');
  return box;
}

/** Leave a baseline unaccepted and unpaused, the state a timed-out first upload leaves behind. */
async function uncertainLink(t) {
  const box = await pausedLink(t);
  const state = link(box);
  delete state.baselinePause;
  writeFileSync(box.linkFile, JSON.stringify(state) + '\n', { mode: 0o600 });
  return box;
}

/** After the relay answers again, every local move must be inside the one accepted baseline. */
async function assertUploadedLater(box, texts) {
  box.stallApi(false); box.legacySnapshotApi(false);
  const status = await box.cli('status');
  assert.equal(status.code, 0);
  const state = link(box);
  assert.equal(state.baselineAccepted, true, 'the next command uploads the baseline');
  assert.equal(state.baselineStale, undefined);
  const exported = await box.cli('export');
  for (const text of texts) assert.ok(exported.document.tables.shout.some(row => row.shout_text === text), `local move kept: ${text}`);
  assert.equal(box.moveAcks.length, 0, 'the moves went up inside the baseline, not as ordered moves');
}

describe('relay failures never fail a local move', { concurrency: true }, () => {
for (const [name, setup] of [['a paused link', pausedLink], ['a link whose first upload is uncertain', uncertainLink]]) {
  test(`a timing-out relay never fails a move on ${name}, and the move rides the later baseline [B26,H16,H17]`, async t => {
    const box = await setup(t);
    box.stallApi(true);
    const run = await moves(box, ['first move while the relay stalls', 'second move while the relay stalls']);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.document.outcomes, ['ok', 'ok'], 'both moves commit locally');
    assert.deepEqual(run.document.local, ['first move while the relay stalls', 'second move while the relay stalls']);
    assert.equal(run.document.lines.filter(line => /did not answer \(timed out\)/u.test(line)).length, 1, 'the relay failure is reported once');
    await assertUploadedLater(box, run.document.local);
  });

  test(`a busy link lock is waited out with progress, then decided under the lock, on ${name} [B26,H16,H17]`, async t => {
    const box = await setup(t);
    const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
    const lock = box.linkFile + '.lock';
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    writeFileSync(lock + '/pid', String(holder.pid));
    const release = setTimeout(() => { holder.kill(); rmSync(lock, { recursive: true, force: true }); }, 2500);
    t.after(() => { clearTimeout(release); holder.kill(); rmSync(lock, { recursive: true, force: true }); });
    const run = await moves(box, ['move after the lock cleared'], { relayLockProgressMs: 400 });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.document.outcomes, ['ok']);
    assert.ok(run.document.lines.filter(line => /waiting for another worktree/u.test(line)).length >= 2, 'progress lines appear while waiting');
  });
}

test('a lock held past the wait refuses once with RELAY_BUSY and a retry step [B26,H16]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
  const lock = box.linkFile + '.lock';
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  writeFileSync(lock + '/pid', String(holder.pid));
  t.after(() => { holder.kill(); rmSync(lock, { recursive: true, force: true }); });
  const run = await moves(box, ['never sent'], { relayLockWaitMs: 800, relayLockProgressMs: 300 });
  assert.equal(run.document.outcomes[0].code, 'RELAY_BUSY');
  assert.match(run.document.outcomes[0].message, /run the command again/u);
  assert.deepEqual(run.document.local, []);
});

test('on an accepted baseline a stalled relay refuses once with a reason and the retry step, committing nothing [B26,H16]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  assert.equal((await box.cli('status')).code, 0);
  assert.equal(link(box).baselineAccepted, true);
  box.stallApi(true);
  const run = await moves(box, ['must not commit outside the relay order']);
  assert.equal(run.document.outcomes[0].code, 'RELAY_UNAVAILABLE');
  assert.match(run.document.outcomes[0].message, /timed out/u);
  assert.match(run.document.outcomes[0].message, /retry this move when the relay is reachable/u);
  assert.deepEqual(run.document.local, [], 'nothing commits outside the relay order');
});
});
