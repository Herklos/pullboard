/** Real CLI scenario for a review, submit or check that keeps its item lease while queued [C7,V4]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import * as store from '../src/board.js';
import { runFixtureChild } from './fixture-child.js';

const CLOCKED_CLI = `
import { readFileSync } from 'node:fs';
import { main } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../src/cli.js')).href)};
/** The private test alone controls the board clock; resource liveness still uses real OS time. */
const clock = { now: () => new Date(Number(readFileSync(process.env.PULLBOARD_FIXTURE_CLOCK, 'utf8'))) };
process.exitCode = await main(process.argv.slice(1), {
  cwd: process.cwd(), clock, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
});
`;

/** Run the real CLI with a private file-backed board clock and the fixture's ordinary identity. */
function clockedCli(box, cwd, ...args) {
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', CLOCKED_CLI, ...args],
    { cwd, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.failure ?? result.stderr}`);
  return args.includes('--json') ? JSON.parse(result.stdout) : result.stdout;
}

/** Track a waiting real CLI process in the same cleanup registry as the resource workers. */
function leaseCommand({ helpers, children }, box, cwd, ...args) {
  const child = helpers.launch(box, cwd, process.execPath, ['--input-type=module', '-e', CLOCKED_CLI, ...args]);
  child.lines = createInterface({ input: child.stdout });
  child.exitResult = null;
  child.finished = child.closed.then((result) => {
    child.exitResult = result;
    children.delete(child);
    return result;
  });
  children.add(child);
  return child;
}

/** Create genuine submitted/claimed items and independent reviewers before advancing any clock. */
function itemLeaseFixture(t, helpers) {
  const box = helpers.project('true');
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, lease: '1m', reviewLease: '1m' }));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure queue lease fixture');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  box.first = box.repo;
  box.home = box.env.PULLBOARD_MACHINE_HOME;
  box.clockFile = join(box.dir, 'board-clock');
  writeFileSync(box.clockFile, String(Date.now()));
  box.env.PULLBOARD_FIXTURE_CLOCK = box.clockFile;
  box.clock = { now: () => new Date(Number(readFileSync(box.clockFile, 'utf8'))) };
  box.advance = (ms) => writeFileSync(box.clockFile, String(box.clock.now().getTime() + ms));
  box.board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), box.clock);
  t.after(() => store.closeBoard(box.board));
  box.gates = [];
  box.ids = [];
  box.reviewCommits = [];
  for (const number of [1, 2, 3, 4]) {
    const folder = join(box.dir, `item-gate-${number}`);
    mkdirSync(folder);
    const gate = helpers.holdingGate({ dir: folder });
    const added = clockedCli(box, box.repo, 'add', 'web', `Queued lease ${number}`, '--specs', 'G1',
      '--criterion', 'The queued command retains only its own live item lease.', '--check', gate.command, '--json');
    const id = added.item.item_id;
    box.ids.push(id); box.gates.push(gate);
    if (number < 4) {
      // Each item has independent ancestry: a pending review cannot be another submit's base.
      box.git(box.web, 'switch', '-q', '--detach', 'main');
      clockedCli(box, box.web, 'claim', String(id), '--json');
      mkdirSync(join(box.web, 'web'), { recursive: true });
      writeFileSync(join(box.web, 'web', `queued-${number}.txt`), 'fixture\n');
      box.git(box.web, 'add', 'web');
      box.git(box.web, 'commit', '-q', '-m', 'feat(web): queue lease fixture [G1]');
      if (number < 3) {
        clockedCli(box, box.web, 'submit', String(id), '--json');
        box.reviewCommits.push(box.git(box.web, 'rev-parse', 'HEAD'));
      }
    }
  }
  box.reviewers = [];
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  for (const number of [1, 2]) {
    const root = join(box.dir, `queue-review-${number}`);
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', root, box.reviewCommits[number - 1]);
    clockedCli(box, root, 'join', 'api', '--json');
    box.reviewers.push(root);
  }
  box.checker = join(box.dir, 'queue-build-check');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', box.checker, commit);
  clockedCli(box, box.checker, 'join', 'web', '--json');
  clockedCli(box, box.checker, 'claim', String(box.ids[3]), '--json');
  clockedCli(box, box.repo, 'settings', 'gateSlots', '2', '--json');
  return box;
}

/**
 * Run the queued-lease scenario against the resource suite's private pool helpers.
 *
 * Why a module: test/resources.test.js is over the 1500-line cap, so its long CLI scenarios
 * live beside it, as the release-first proof does, while the named test stays in that file.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ helpers: any, children: Set<any>, fixture: Function, poolWorker: Function, privateList: Function, privateTake: Function, acquired: Function, release: Function, waitUntil: Function }} deps
 */
export async function queuedLeaseProof(t, deps) {
  const { fixture, poolWorker, privateList, privateTake, acquired, release, waitUntil } = deps;
  const box = itemLeaseFixture(t, deps.helpers);
  const [reviewId, deadId, buildId, checkId] = box.ids;
  const [reviewGate, deadGate, buildGate, checkGate] = box.gates;
  const [reviewer, deadReviewer] = box.reviewers;
  // Readers project expired claims as open with no lease. Observe the retained raw deadline
  // here so admission's normal expiry remains distinguishable from an unwanted renewal.
  const item = (id) => store.itemById(box.board, id);
  const end = (id, kind) => item(id)[kind === 'review' ? 'item_review_until' : 'item_lease_until'];
  const waiting = (id) => privateList(box).find((resource) => resource.name === 'gate')?.line.find((entry) => entry.item === String(id));
  let holder;
  const commands = [];
  try {
    clockedCli(box, reviewer, 'next', '--verify', String(reviewId), '--json');
    const originalReviewEnd = end(reviewId, 'review');
    const originalBuildEnd = end(buildId, 'check');
    const originalCheckEnd = end(checkId, 'check');
    holder = poolWorker(box, { agent: 'lease-test-holder', browser: true });
    await acquired(holder);
    writeFileSync(reviewGate.mode, 'hold'); writeFileSync(buildGate.mode, 'hold'); writeFileSync(checkGate.mode, 'hold');
    const review = leaseCommand(deps, box, reviewer, 'verify', String(reviewId), 'accept',
      '--note', 'Private fixture: waited behind held capacity and ran the frozen check.', '--json');
    commands.push(review);
    await waitUntil(() => waiting(reviewId)?.leaseUntil, 'the real verify waiter and its item lease end');
    const build = leaseCommand(deps, box, box.web, 'submit', String(buildId), '--json');
    commands.push(build);
    await waitUntil(() => waiting(buildId)?.leaseUntil, 'the real submit waiter and its item lease end');
    const check = leaseCommand(deps, box, box.checker, 'check', String(checkId), '--yes', '--json');
    commands.push(check);
    await waitUntil(() => waiting(checkId)?.leaseUntil, 'the independent owned check and its item lease end');
    const listed = clockedCli(box, box.repo, 'resources', '--json').resources.find((resource) => resource.name === 'gate');
    for (const [id, kind] of [[reviewId, 'review'], [buildId, 'submit'], [checkId, 'check']]) {
      const entry = listed.line.find((row) => row.item === String(id));
      assert.equal(entry.kind, kind);
      assert.equal(entry.leaseUntil, end(id, kind), 'resources reports this exact board item lease, not the pool heartbeat');
    }
    assert.match(clockedCli(box, box.repo, 'resources'), /lease until \d{4}-\d{2}-\d{2}T/u);

    box.advance(30_000);
    await waitUntil(() => end(reviewId, 'review') > originalReviewEnd && end(buildId, 'check') > originalBuildEnd
      && end(checkId, 'check') > originalCheckEnd, 'all live queued commands renew before their original expiry');
    const previousReviewEnd = end(reviewId, 'review');
    const previousBuildEnd = end(buildId, 'check');
    const previousCheckEnd = end(checkId, 'check');
    box.advance(31_000);
    await waitUntil(() => end(reviewId, 'review') > previousReviewEnd && end(buildId, 'check') > previousBuildEnd
      && end(checkId, 'check') > previousCheckEnd, 'all leases remain held past their original deadlines');
    assert.ok(box.clock.now().toISOString() > originalReviewEnd);
    assert.ok(end(reviewId, 'review') > box.clock.now().toISOString());
    assert.ok(end(buildId, 'check') > box.clock.now().toISOString());
    assert.ok(end(checkId, 'check') > box.clock.now().toISOString());

    await release(holder); holder = null;
    await waitUntil(() => existsSync(reviewGate.events), 'the admitted verification starts its actual frozen check');
    const runningReviewEnd = end(reviewId, 'review');
    for (const advance of [30_000, 31_000, 1_000]) {
      const beforeBuildEnd = end(buildId, 'check');
      const beforeCheckEnd = end(checkId, 'check');
      box.advance(advance);
      if (advance >= 30_000) await waitUntil(() => end(buildId, 'check') > beforeBuildEnd
        && end(checkId, 'check') > beforeCheckEnd, 'both build waiters renew while the admitted review runs');
    }
    assert.equal(end(reviewId, 'review'), runningReviewEnd, 'admission ends review item renewals');
    assert.ok(runningReviewEnd < box.clock.now().toISOString(), 'the running review resumes ordinary lease expiry');
    assert.ok(waiting(buildId) && waiting(checkId), 'submit and check remain queued behind the review');
    writeFileSync(reviewGate.release, 'release');
    assert.equal((await review.finished).code, 0, `${review.stdoutText}\n${review.stderrText}`);
    await waitUntil(() => existsSync(buildGate.events), 'the admitted real submit starts its frozen check');
    const runningBuildEnd = end(buildId, 'check');
    for (const advance of [30_000, 31_000, 1_000]) {
      const beforeCheckEnd = end(checkId, 'check');
      box.advance(advance);
      if (advance >= 30_000) await waitUntil(() => end(checkId, 'check') > beforeCheckEnd,
        'the standalone check keeps renewing while submit runs');
    }
    clockedCli(box, box.repo, 'resources', '--json');
    assert.equal(end(buildId, 'check'), runningBuildEnd, 'admission ends build item renewals');
    assert.ok(runningBuildEnd < box.clock.now().toISOString(), 'the running build resumes ordinary lease expiry');
    writeFileSync(buildGate.release, 'release');
    assert.equal((await build.finished).code, 0, `${build.stdoutText}\n${build.stderrText}`);
    assert.equal(item(buildId).item_status, 'submitted', 'the actual queued submit completes its ordinary board move');
    await waitUntil(() => existsSync(checkGate.events), 'the independent owned check starts');
    const runningCheckEnd = end(checkId, 'check');
    box.advance(Date.parse(runningCheckEnd) - box.clock.now().getTime() + 1);
    clockedCli(box, box.repo, 'resources', '--json');
    assert.equal(end(checkId, 'check'), runningCheckEnd, 'admission ends standalone check renewals');
    assert.ok(runningCheckEnd < box.clock.now().toISOString(), 'the standalone check resumes normal expiry');
    writeFileSync(checkGate.release, 'release');
    assert.equal((await check.finished).code, 0, `${check.stdoutText}\n${check.stderrText}`);

    clockedCli(box, deadReviewer, 'next', '--verify', String(deadId), '--json');
    holder = poolWorker(box, { agent: 'dead-waiter-holder', browser: true });
    await acquired(holder);
    const dead = leaseCommand(deps, box, deadReviewer, 'verify', String(deadId), 'accept',
      '--note', 'Private fixture: the queued waiter must not start before its holder releases.', '--json');
    commands.push(dead);
    await waitUntil(() => waiting(deadId)?.leaseUntil, 'the doomed real reviewer is queued with its item lease');
    const beforeDeadEnd = end(deadId, 'review');
    box.advance(30_000);
    await waitUntil(() => end(deadId, 'review') > beforeDeadEnd, 'the reviewer renews while alive');
    assert.equal(existsSync(deadGate.events), false, 'the killed waiter never started its frozen check');
    dead.kill('SIGKILL');
    assert.equal((await dead.finished).signal, 'SIGKILL');
    await waitUntil(() => !waiting(deadId), 'the real dead waiter is pruned');
    const lastDeadEnd = end(deadId, 'review');
    box.advance(Date.parse(lastDeadEnd) - box.clock.now().getTime() + 1);
    assert.equal(end(deadId, 'review'), lastDeadEnd, 'a dead process cannot continue renewing');
    clockedCli(box, reviewer, 'next', '--verify', String(deadId), '--json');
    assert.equal(item(deadId).item_review_by, store.agentAt(box.board, reviewer).agent_id,
      'another actual reviewer can reserve after the dead waiter lease lapses');

    await t.test('asynchronous renewal finishes outside the queue transaction before admission', async () => {
      const callbackBox = fixture();
      const callbackHolder = await privateTake(callbackBox, { name: 'awaited-renewal', capacity: 1 });
      let enter;
      let finish;
      const entered = new Promise((resolve) => { enter = resolve; });
      const barrier = new Promise((resolve) => { finish = resolve; });
      const refused = new Error('fixture item lease was lost while waiting');
      let completed = false;
      const queued = privateTake(callbackBox, { name: 'awaited-renewal', capacity: 1, onWait: async () => {
        const connection = new DatabaseSync(join(callbackBox.home, 'resources.sqlite'));
        try { connection.exec('BEGIN IMMEDIATE'); connection.exec('ROLLBACK'); }
        finally { connection.close(); }
        enter();
        await barrier;
        completed = true;
        throw refused;
      } }).then((lease) => ({ lease }), (error) => ({ error }));
      await entered;
      callbackHolder.release();
      finish();
      const result = await queued;
      try {
        assert.equal(completed, true);
        assert.equal(result.error, refused, 'a failed awaited renewal refuses admission instead of running stale work');
        const pool = privateList(callbackBox).find((entry) => entry.name === 'awaited-renewal');
        assert.deepEqual(pool.line, [], 'failed renewal removes its waiter');
        assert.deepEqual(pool.holders, [], 'failed renewal never leaves a held resource');
      } finally { result.lease?.release(); }
    });
  } finally {
    for (const gate of box.gates) writeFileSync(gate.release, 'release');
    if (holder && !holder.exitResult) await release(holder);
    // Released gates let each CLI reap its own check workers and private clone before the
    // shared fixture directory is removed. Killing a parent here would strand those workers.
    await Promise.all(commands.map((child) => child.finished));
    for (const child of commands) child.lines.close();
  }
}
