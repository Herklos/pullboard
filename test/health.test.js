/**
 * pullboard health names every stuck item, why, since when, the next step and who takes it, on a
 * real SQLite board in a real git repo with an injected clock, and never changes either [A6].
 */
import { submitFixture } from './board-submit-fixture.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import * as store from '../src/board.js';
import { main } from '../src/cli.js';
import { boardHealth } from '../src/health.js';
import { JSON_SHAPES } from '../src/json.js';
import { runFixtureChild, runFixtureGit } from './fixture-child.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const freeze = (item) => ({ text: item.item_title, digest: `digest:${item.item_title}` });

/** A private repo, git identity and Pullboard home, so neither git nor the CLI reads this machine. */
function repo(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-health-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  mkdirSync(root);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Health Test', GIT_AUTHOR_EMAIL: 'health@example.com',
    GIT_COMMITTER_NAME: 'Health Test', GIT_COMMITTER_EMAIL: 'health@example.com',
  });
  for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
  Object.assign(process.env, { PULLBOARD_HOME: join(dir, 'home'), PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  delete process.env.PULLBOARD_RELAY_TOKEN;
  /** Run git in the fixture repo, optionally at a fixed commit date. */
  const git = (args, date) => runFixtureGit(args, { cwd: root, env: date ? { ...env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : env });
  git(['init', '-q', '-b', 'main']);
  writeFileSync(join(root, 'pullboard.json'), `${JSON.stringify({ gate: 'true', lanes: { core: { owns: ['src/'] }, docs: { owns: ['docs/'] }, review: { owns: [] } } }, null, 2)}\n`);
  writeFileSync(join(root, 'a.txt'), 'base\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'chore: base'], ago(72 * HOUR));
  return { dir, root, git, file: join(root, '.git', 'pullboard', 'board.sqlite') };
}

/** Commit one file on a new branch from `from`, then return to main; returns the commit. */
function branchCommit(box, branch, from, path, text) {
  box.git(['checkout', '-q', '-b', branch, from]);
  writeFileSync(join(box.root, path), text);
  box.git(['add', path]);
  box.git(['commit', '-q', '-m', `feat: ${branch}`]);
  const commit = box.git(['rev-parse', 'HEAD']);
  box.git(['checkout', '-q', 'main']);
  return commit;
}

/** Open the fixture board with a clock the test turns by hand. */
function boardAt(box) {
  const clock = { at: NOW - 40 * HOUR, now() { return new Date(this.at); } };
  const board = store.openBoard(box.file, clock);
  /** Move the board's clock to a moment before NOW. */
  const at = (ms) => { clock.at = NOW - ms; };
  return { board, at };
}

/** Run the real CLI in this process with the injected clock; returns its exit code and output. */
async function cli(cwd, argv) {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    cwd, clock: { now: () => new Date(NOW) },
    stdout: { isTTY: false, write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
  });
  return { code, stdout, stderr };
}

/** Every board row and the event count, so a read can be proved to change nothing. */
function boardDigest(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = ['item', 'verdict', 'shout', 'event', 'hold', 'agent', 'board_meta'];
    const rows = tables.map((table) => JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()));
    return { events: db.prepare('SELECT COUNT(*) AS n FROM event').get().n, hash: createHash('sha256').update(rows.join('\n')).digest('hex') };
  } finally { db.close(); }
}

/** The checkout's HEAD, index and working tree as git reports them. */
function checkout(box) {
  return { head: box.git(['rev-parse', 'HEAD']), status: box.git(['status', '--porcelain', '--untracked-files=all']),
    index: createHash('sha256').update(readFileSync(join(box.root, '.git', 'index'))).digest('hex') };
}

test('health names each stuck cause with its next step and owner [A6]', async (t) => {
  const box = repo(t);
  const base = box.git(['rev-parse', 'HEAD']);
  box.git(['tag', 'v0.1.0']);
  const conflicting = branchCommit(box, 'core/conflict', base, 'a.txt', 'branch\n');
  const clean = branchCommit(box, 'core/clean', base, 'clean.txt', 'clean\n');
  const cleared = branchCommit(box, 'core/cleared', base, 'other.txt', 'other\n');
  const parent = branchCommit(box, 'core/parent', base, 'parent.txt', 'parent\n');
  const child = branchCommit(box, 'core/child', parent, 'child.txt', 'child\n');
  const landed = branchCommit(box, 'core/landed', base, 'landed.txt', 'landed\n');
  const own = Object.fromEntries(['lapsedReview', 'unreviewed', 'rejected', 'later', 'reopened', 'held'].map((name) => [name, branchCommit(box, `core/${name}`, base, `${name}.txt`, `${name}\n`)]));
  writeFileSync(join(box.root, 'a.txt'), 'main\n');
  box.git(['commit', '-q', '-am', 'feat: main moves on'], ago(48 * HOUR));

  const { board, at } = boardAt(box);
  store.register(board, { lane: 'coordinator', path: box.root });
  const builders = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => store.register(board, { lane: 'core', path: join(box.dir, `core-${n}`) }));
  const reviewer = store.register(board, { lane: 'review', path: join(box.dir, 'review-1') });
  const otherReviewer = store.register(board, { lane: 'review', path: join(box.dir, 'review-2') });
  const add = (title, extra = {}) => store.addItem(board, { by: 'coordinator', lane: 'core', title, ...extra });
  const claim = (id, agentId, leaseMs = 2 * HOUR) => store.claim(board, id, { agentId, lane: 'core', leaseMs, freeze });
  const submit = (id, agentId, commit) => submitFixture(board, id, { agentId, commit, tree: `tree-${id}` });
  const decide = (id, decision, commit, title, by = reviewer) => store.verify(board, id, { agentId: by, decision,
    reason: decision === 'ACCEPT' ? 'CRITERION_MET' : 'TEST_FAILURE', note: 'checked the fixture', head: commit, digest: `digest:${title}`, policy: 'any' });
  /** Build an item through claim and submit, optionally to an accept or a reject. */
  const built = (title, agentId, commit, verdict, extra) => {
    const id = add(title, extra);
    claim(id, agentId);
    submit(id, agentId, commit);
    if (verdict) decide(id, verdict, commit, title);
    return id;
  };

  at(30 * HOUR);
  store.holdLane(board, 'docs', { agentId: 'coordinator', reason: 'docs wait for the release notes' });
  const staleHold = add('Stale hold');
  store.holdItem(board, staleHold, { agentId: 'coordinator', reason: 'waiting for the design' });
  at(3 * HOUR);
  const lapsed = add('Lapsed claim');
  claim(lapsed, builders[0], HOUR);
  const reviewLapsed = add('Lapsed review');
  claim(reviewLapsed, builders[1]);
  submit(reviewLapsed, builders[1], own.lapsedReview);
  at(2.5 * HOUR);
  store.reserveReview(board, reviewLapsed, { agentId: reviewer, leaseMs: HOUR / 2, policy: 'any' });
  at(2 * HOUR);
  const unreviewed = built('Waiting review', builders[2], own.unreviewed);
  const conflict = built('Conflicting accept', builders[3], conflicting, 'ACCEPT');
  const ready = built('Clean accept', builders[4], clean, 'ACCEPT');
  const rejected = built('Rejected rework', builders[5], own.rejected, 'REJECT');
  const later = built('Later rework', builders[6], own.later, 'REJECT');
  const reopened = built('Reopened rework', builders[7], own.reopened);
  store.reopen(board, reopened, { agentId: 'coordinator', note: 'the bar named the wrong file' });
  const stacked = built('Stacked accept', builders[8], child, 'ACCEPT');
  const shipped = built('Landed work', builders[9], landed, 'ACCEPT');
  store.merged(board, shipped, { agentId: 'coordinator', commit: landed });
  const heldAccept = add('Held accept');
  claim(heldAccept, builders[10]);
  store.holdItem(board, heldAccept, { agentId: 'coordinator', reason: 'waiting for the person to pick the wording' });
  submit(heldAccept, builders[10], own.held);
  decide(heldAccept, 'ACCEPT', own.held, 'Held accept', otherReviewer);
  const withdrawn = add('Dropped dependency');
  const orphan = add('Orphaned follow-up', { after: [withdrawn] });
  store.withdraw(board, withdrawn, { agentId: 'coordinator', reason: 'superseded by the new layout' });
  const ask = store.shout(board, { from: builders[2], to: 'coordinator', text: 'Which file owns the wording?', lanes: ['core', 'docs', 'review'], decision: true });
  at(HOUR / 6);
  const parentItem = built('Parent in review', builders[11], parent);
  const conflictHold = built('Conflict hold', builders[0], cleared, 'REJECT');
  store.holdItem(board, conflictHold, { agentId: 'coordinator', reason: 'conflicts with the a.txt batch' });
  store.addMilestone(board, { agentId: 'coordinator', name: '0.1.1', items: [lapsed, rejected, reopened] });
  store.addMilestone(board, { agentId: 'coordinator', name: '0.1.2', items: [later] });
  store.closeBoard(board); // Health opens its own read-only connection.

  const beforeBoard = boardDigest(box.file);
  const beforeCheckout = checkout(box);
  const result = await cli(box.root, ['health', '--json']);
  assert.equal(result.code, 1, `a stuck board exits 1: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(boardDigest(box.file), beforeBoard, 'health changes no board row and appends no event');
  assert.deepEqual(checkout(box), beforeCheckout, 'the merge check never touches the HEAD, index or working tree');
  for (const field of Object.keys(JSON_SHAPES.commands.health.required)) assert.ok(field in report, `health JSON has ${field}`);
  assert.equal(report.asOf, new Date(NOW).toISOString(), 'health reads the injected clock');
  assert.deepEqual(report.thresholds, { stuck: '1h', holds: '1d', release: '1d' });

  const byKey = new Map(report.stuck.map((entry) => [entry.key, entry]));
  /** Assert one finding's cause, since, owner and next step, and that its why names `why`. */
  const expect = (key, { cause, since, role, who, next, why }) => {
    const entry = byKey.get(key) ?? report.waiting.find((waiting) => waiting.key === key);
    assert.ok(entry, `health lists ${key}; found ${[...byKey.keys()].join(', ')}`);
    assert.equal(entry.cause, cause, key);
    assert.equal(entry.since, since, `${key} since`);
    assert.deepEqual(entry.owner, { role, who }, `${key} owner`);
    assert.ok(entry.next.includes(next), `${key} next step: ${entry.next}`);
    for (const part of [why].flat()) assert.ok(entry.why.includes(part), `${key} why names ${part}: ${entry.why}`);
    for (const field of ['subject', 'title', 'ageMinutes', 'command', 'detail']) assert.ok(field in entry, `${key} has ${field}`);
    return entry;
  };
  expect(`CLAIM_LAPSED:item:${lapsed}`, { cause: 'CLAIM_LAPSED', since: ago(2 * HOUR), role: 'builder', who: builders[0], next: `pullboard claim ${lapsed}`, why: builders[0] });
  expect(`REVIEW_LAPSED:item:${reviewLapsed}`, { cause: 'REVIEW_LAPSED', since: ago(2 * HOUR), role: 'reviewer', who: null, next: `pullboard next --verify ${reviewLapsed}`, why: reviewer });
  expect(`NO_REVIEWER:item:${unreviewed}`, { cause: 'NO_REVIEWER', since: ago(2 * HOUR), role: 'coordinator', who: 'coordinator', next: 'reserve a reviewer outside', why: builders[2] });
  const conflictFinding = expect(`UNLANDED_CONFLICT:item:${conflict}`, { cause: 'UNLANDED_CONFLICT', since: ago(2 * HOUR), role: 'builder', who: builders[3], next: 'merge main into its branch', why: ['conflicts with main', 'a.txt'] });
  assert.deepEqual(conflictFinding.detail.files, ['a.txt'], 'the conflict names its files');
  expect(`UNLANDED_READY:item:${ready}`, { cause: 'UNLANDED_READY', since: ago(2 * HOUR), role: 'coordinator', who: 'coordinator', next: 'pullboard land', why: 'merges cleanly onto main' });
  expect(`UNLANDED_HELD:item:${heldAccept}`, { cause: 'UNLANDED_HELD', since: ago(2 * HOUR), role: 'coordinator', who: 'coordinator', next: `pullboard hold ${heldAccept} --off`, why: 'waiting for the person to pick the wording' });
  expect(`UNLANDED_STACKED:item:${stacked}`, { cause: 'UNLANDED_STACKED', since: ago(2 * HOUR), role: 'reviewer', who: null, next: `pullboard next --verify ${parentItem}`, why: `#${parentItem}` });
  expect(`HOLD_STALE:item:${staleHold}`, { cause: 'HOLD_STALE', since: ago(30 * HOUR), role: 'coordinator', who: 'coordinator', next: `pullboard hold ${staleHold} --off`, why: 'waiting for the design' });
  expect('HOLD_STALE:lane:docs', { cause: 'HOLD_STALE', since: ago(30 * HOUR), role: 'coordinator', who: 'coordinator', next: 'pullboard hold docs --off', why: 'docs wait for the release notes' });
  expect(`CONFLICT_HOLD_CLEARS:item:${conflictHold}`, { cause: 'CONFLICT_HOLD_CLEARS', since: ago(HOUR / 6), role: 'coordinator', who: 'coordinator', next: `pullboard hold ${conflictHold} --off`, why: 'now merges cleanly onto main' });
  expect(`REWORK_UNCLAIMED:item:${rejected}`, { cause: 'REWORK_UNCLAIMED', since: ago(2 * HOUR), role: 'builder', who: builders[5], next: `pullboard claim ${rejected}`, why: ['rejected by', 'TEST_FAILURE'] });
  expect(`REWORK_UNCLAIMED:item:${reopened}`, { cause: 'REWORK_UNCLAIMED', since: ago(2 * HOUR), role: 'builder', who: builders[7], next: `pullboard claim ${reopened}`, why: 'reopened by coordinator' });
  expect(`AFTER_WITHDRAWN:item:${orphan}`, { cause: 'AFTER_WITHDRAWN', since: ago(2 * HOUR), role: 'coordinator', who: 'coordinator', next: `pullboard edit ${orphan} --after none`, why: [`#${withdrawn}`, 'superseded by the new layout'] });
  expect(`DECISION_UNANSWERED:shout:${ask}`, { cause: 'DECISION_UNANSWERED', since: ago(2 * HOUR), role: 'coordinator', who: 'coordinator', next: `pullboard answer ${ask}`, why: 'Which file owns the wording?' });
  expect('RELEASE_OVERDUE:release:v0.1.0', { cause: 'RELEASE_OVERDUE', since: ago(72 * HOUR), role: 'coordinator', who: 'coordinator', next: 'publish the release after v0.1.0', why: `#${shipped}` });
  const waiting = report.waiting.find((entry) => entry.key === `REWORK_LATER:item:${later}`);
  assert.ok(waiting, 'rework planned for a later release is listed as waiting');
  assert.ok(!byKey.has(`REWORK_UNCLAIMED:item:${later}`), 'rework in a later release is not stuck');
  assert.equal(waiting.owner.who, builders[6]);
  assert.ok(waiting.why.includes('0.1.2'), 'the waiting line names its release');
  for (const id of [parentItem, conflictHold, shipped]) assert.ok(![...byKey.values()].some((entry) => entry.item === id && !entry.key.startsWith('CONFLICT_HOLD')), `#${id} is moving, not stuck`);

  const patient = boardHealth(box.file, { root: box.root, config: { health: { stuck: '3h', holds: '2d' } }, now: new Date(NOW) });
  assert.deepEqual(patient.thresholds, { stuck: '3h', holds: '2d', release: '1d' }, 'pullboard.json health thresholds replace the defaults');
  assert.ok(!patient.stuck.some((entry) => ['NO_REVIEWER', 'HOLD_STALE', 'REWORK_UNCLAIMED'].includes(entry.cause)), 'longer thresholds clear the younger waits');
  assert.throws(() => boardHealth(box.file, { root: box.root, config: { health: { stuck: 'soon' } }, now: new Date(NOW) }), /BAD_CONFIG|health\.stuck/u);

  const text = await cli(box.root, ['health']);
  assert.equal(text.code, 1);
  const lines = text.stdout.trim().split('\n');
  assert.equal(lines[0], `${report.stuck.length} stuck:`);
  const lapsedLine = lines.find((line) => line.startsWith(`  #${lapsed} `));
  assert.equal(lapsedLine, `  #${lapsed} claim lapsed, since 2026-10-17 10:00 (2h): ${builders[0]}'s lease ran out and nobody is building it. Next, ${builders[0]} (builder): renew it with pullboard claim ${lapsed}.`);
  assert.ok(lines.some((line) => line.startsWith(`  #${conflict} `) && line.includes('a.txt') && line.includes(`${builders[3]} (builder)`)), 'the text names the conflicting files and the builder');
  assert.ok(lines.includes('waiting for a later release:'));
  assert.deepEqual(boardDigest(box.file), beforeBoard, 'text mode changes nothing either');
  assert.deepEqual(checkout(box), beforeCheckout);
});

test('health on a healthy board says nothing is stuck [A6]', async (t) => {
  const box = repo(t);
  const commit = box.git(['rev-parse', 'HEAD']);
  const missing = await cli(box.root, ['health']);
  assert.equal(missing.code, 0, missing.stderr);
  assert.equal(missing.stdout, 'nothing is stuck\n', 'a repo with no board yet has nothing stuck');

  const { board } = boardAt(box);
  store.register(board, { lane: 'coordinator', path: box.root });
  store.closeBoard(board);
  const empty = await cli(box.root, ['health', '--json']);
  assert.equal(empty.code, 0, empty.stderr);
  const emptyReport = JSON.parse(empty.stdout);
  assert.deepEqual([emptyReport.stuck, emptyReport.waiting], [[], []], 'an empty board has nothing stuck');
  assert.equal((await cli(box.root, ['health'])).stdout, 'nothing is stuck\n');

  const moving = boardAt(box);
  t.after(() => store.closeBoard(moving.board));
  const builder = store.register(moving.board, { lane: 'core', path: join(box.dir, 'core-1') });
  const second = store.register(moving.board, { lane: 'core', path: join(box.dir, 'core-2') });
  const reviewer = store.register(moving.board, { lane: 'review', path: join(box.dir, 'review-1') });
  moving.at(30 * HOUR);
  const done = store.addItem(moving.board, { by: 'coordinator', lane: 'core', title: 'Done' });
  store.claim(moving.board, done, { agentId: builder, lane: 'core', leaseMs: 2 * HOUR, freeze });
  submitFixture(moving.board, done, { agentId: builder, commit, tree: 'tree' });
  store.verify(moving.board, done, { agentId: reviewer, decision: 'ACCEPT', reason: 'CRITERION_MET', note: 'ran it', head: commit, digest: 'digest:Done', policy: 'any' });
  store.merged(moving.board, done, { agentId: 'coordinator', commit });
  moving.at(HOUR / 2);
  const building = store.addItem(moving.board, { by: 'coordinator', lane: 'core', title: 'Building' });
  store.claim(moving.board, building, { agentId: builder, lane: 'core', leaseMs: 2 * HOUR, freeze });
  const reviewing = store.addItem(moving.board, { by: 'coordinator', lane: 'core', title: 'Reviewing' });
  store.claim(moving.board, reviewing, { agentId: second, lane: 'core', leaseMs: 2 * HOUR, freeze });
  submitFixture(moving.board, reviewing, { agentId: second, commit, tree: 'tree' });
  store.reserveReview(moving.board, reviewing, { agentId: reviewer, leaseMs: HOUR, policy: 'any' });
  store.addItem(moving.board, { by: 'coordinator', lane: 'core', title: 'Fresh work' });
  const asked = store.shout(moving.board, { from: builder, to: 'coordinator', text: 'Which wording?', lanes: ['core', 'docs', 'review'], decision: true });
  store.answerDecision(moving.board, asked, { agentId: 'coordinator', text: 'the short one', lanes: ['core', 'docs', 'review'] });
  store.holdLane(moving.board, 'docs', { agentId: 'coordinator', reason: 'a short pause' });
  const before = boardDigest(box.file);
  const healthy = await cli(box.root, ['health', '--json']);
  assert.equal(healthy.code, 0, healthy.stdout);
  const report = JSON.parse(healthy.stdout);
  assert.deepEqual(report.stuck, [], `a moving board has nothing stuck: ${report.stuck.map((entry) => entry.key).join(', ')}`);
  assert.equal((await cli(box.root, ['health'])).stdout, 'nothing is stuck\n');
  assert.deepEqual(boardDigest(box.file), before, 'health changes nothing on a healthy board');
});

test('a submitted item with no reviewer goes to the coordinator, not its builder [A6]', async (t) => {
  // A board with no review lane still gets a command the real shout path accepts: it goes to the
  // coordinator, and the builder is never the owner of their own review (#910).
  const box = repo(t);
  writeFileSync(join(box.root, 'pullboard.json'), `${JSON.stringify({ gate: 'true', lanes: { core: { owns: ['src/'] } } }, null, 2)}\n`);
  const commit = box.git(['rev-parse', 'HEAD']);
  const { board, at } = boardAt(box);
  store.register(board, { lane: 'coordinator', path: box.root });
  const builder = store.register(board, { lane: 'core', path: join(box.dir, 'core-1') });
  at(3 * HOUR);
  const waiting = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Waiting review' });
  store.claim(board, waiting, { agentId: builder, lane: 'core', leaseMs: 2 * HOUR, freeze });
  submitFixture(board, waiting, { agentId: builder, commit, tree: 'tree' });
  store.closeBoard(board);

  const result = await cli(box.root, ['health', '--json']);
  assert.equal(result.code, 1, `a submitted item with no reviewer is stuck: ${result.stderr}`);
  const entry = JSON.parse(result.stdout).stuck.find((found) => found.key === `NO_REVIEWER:item:${waiting}`);
  assert.ok(entry, `health lists the unreviewed submission; found ${result.stdout}`);
  assert.notEqual(entry.owner.who, builder, 'the builder is never the owner of their own review');
  assert.deepEqual(entry.owner, { role: 'coordinator', who: 'coordinator' }, 'the coordinator owns the missing reviewer');
  assert.ok(entry.next.includes(`reserve a reviewer outside ${builder}'s controller and session`), `the next step names a reviewer outside the builder: ${entry.next}`);
  assert.ok(!entry.next.includes('pullboard next --verify'), `the next step never sends the builder to verify: ${entry.next}`);
  assert.ok(!entry.command.includes('pullboard next --verify'), `the command never sends the builder to verify: ${entry.command}`);

  // The generated command runs through the real shout path on this board, reaching every agent.
  const argv = entry.command.match(/"[^"]*"|\S+/gu).map((token) => token.replace(/^"|"$/gu, ''));
  assert.equal(argv[0], 'pullboard', entry.command);
  const shouted = await cli(box.root, argv.slice(1));
  assert.equal(shouted.code, 0, `the generated command is accepted: ${shouted.stderr}${shouted.stdout}`);
  const reread = store.openBoard(box.file, { now: () => new Date(NOW) });
  try {
    const sent = store.allShouts(reread).filter((shout) => shout.shout_to === 'all').map((shout) => shout.shout_text);
    assert.ok(sent.some((text) => text.includes(`#${waiting} needs a reviewer outside ${builder}'s controller and session`)), `every agent hears the request: ${sent.join(' | ')}`);
  } finally { store.closeBoard(reread); }
  const text = await cli(box.root, ['health']);
  assert.ok(text.stdout.includes('Next, the coordinator: reserve a reviewer outside'), `the text names the coordinator: ${text.stdout}`);
});

test('item history survives garbage collection mid-read [A6]', () => {
  // A stand-in database whose statement lives only while something references it, as node:sqlite's
  // does on Node 22.13, with garbage collection forced while the history is read (#874).
  const health = pathToFileURL(resolve(import.meta.dirname, '../src/health.js')).href;
  const script = `
    import { DatabaseSync } from 'node:sqlite';
    import { itemHistory } from ${JSON.stringify(health)};
    const real = new DatabaseSync(':memory:');
    real.exec('CREATE TABLE event (event_id INTEGER PRIMARY KEY, event_at TEXT, event_by TEXT, event_kind TEXT, item_id INTEGER, event_detail TEXT)');
    const insert = real.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < 20000; i += 1) insert.run('2026-10-18T00:00:00.000Z', 'agent', i % 3 ? 'claim' : 'submit', i % 50, '{}');
    // Defined outside any scope that holds the statement, so only the code under test can keep it alive.
    const collecting = (rows) => { let read = 0; return { [Symbol.iterator]() { return this; }, next() { read += 1; if (read % 500 === 0) globalThis.gc(); return rows.next(); } }; };
    const db = { prepare: (sql) => { const statement = real.prepare(sql); return { iterate: () => collecting(statement.iterate()) }; } };
    process.stdout.write(String(itemHistory(db).size));
  `;
  const child = runFixtureChild(process.execPath, ['--expose-gc', '--no-warnings', '--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, `reading item history must not lose its statement to garbage collection: ${child.stderr}`);
  assert.equal(child.stdout, '50', 'every item with events has a history entry');
});

/** Commit a pullboard.json whose gate, and optional positive control, the next gate run reads. */
function commitPolicy(box, policy) {
  writeFileSync(join(box.root, 'pullboard.json'), `${JSON.stringify({ gate: 'true', lanes: { core: { owns: ['src/'] }, docs: { owns: ['docs/'] }, review: { owns: [] } }, ...policy }, null, 2)}\n`);
  box.git(['add', 'pullboard.json']);
  box.git(['commit', '-q', '-m', 'chore: gate policy']);
}

/** Health at the real clock, since a gate run records the moment it actually ran. */
async function healthNow(cwd) {
  let stdout = '';
  const code = await main(['health', '--json'], {
    cwd, stdout: { isTTY: false, write: (text) => { stdout += text; } }, stderr: { write: () => {} },
  });
  return { code, report: JSON.parse(stdout) };
}

test('health reports a gate whose positive control fails [C7,D1]', async (t) => {
  const box = repo(t);
  commitPolicy(box, { gate: 'true', positiveControl: 'false' });
  const ran = await cli(box.root, ['gate']);
  assert.equal(ran.code, 0, 'the gate itself is green, so only its known-good case betrays it');
  const { code, report } = await healthNow(box.root);
  assert.equal(code, 1, 'a failing positive control is stuck work, not green');
  const alarm = report.stuck.find((entry) => entry.cause === 'GATE_CONTROL_FAILED');
  assert.ok(alarm, 'health names the gate whose positive control failed');
  assert.equal(alarm.subject, 'gate');
  assert.match(alarm.why, /positive control/u);
  assert.equal(alarm.detail.positiveControl, 'false');
  assert.equal(alarm.detail.runs.at(-1).control, false, 'the finding carries the last run and its control result');
});

test('health reports a gate that refused every run [C7,D1]', async (t) => {
  const box = repo(t);
  commitPolicy(box, { gate: 'false' });
  for (let run = 1; run <= 2; run += 1) assert.equal((await cli(box.root, ['gate'])).code, 1, `run ${run} is refused`);
  assert.equal((await healthNow(box.root)).report.stuck.some((entry) => entry.cause === 'GATE_REFUSED_EVERY_RUN'), false, 'two refusals are not yet an alarm');
  assert.equal((await cli(box.root, ['gate'])).code, 1, 'run 3 is refused');
  const { code, report } = await healthNow(box.root);
  assert.equal(code, 1);
  const alarm = report.stuck.find((entry) => entry.cause === 'GATE_REFUSED_EVERY_RUN');
  assert.ok(alarm, 'health names a gate that refused every run in its window');
  assert.equal(alarm.subject, 'gate');
  assert.deepEqual(alarm.detail.runs.map((run) => run.green), [false, false, false], 'the finding lists the last runs, all refused');
});
