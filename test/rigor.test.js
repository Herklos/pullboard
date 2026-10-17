/** Rigor: a repeated failure cause is noticed from structured fields, never from notes [D1,V1]. */
import { submitFixture } from './board-submit-fixture.js';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { runFixtureChild, runFixtureGit } from './fixture-child.js';
import * as store from '../src/board.js';
import { applyEngineMove, prepareEngineMove } from '../src/engine.js';
import { CAUSE_ENGINE, ENGINE_VERSION } from '../src/machine.js';
import { rigorReport } from '../src/rigor.js';
import { unpackRelease } from './release-archive.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'AI_AGENT', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI', 'CODEX_SHELL', 'SSH_CONNECTION', 'SSH_TTY'];
const DIRS = [];
const HOUR = 3_600_000;
const MERGE = 'c'.repeat(40);

after(() => { for (const dir of DIRS) rmSync(dir, { recursive: true, force: true }); });

/** A freshly initialized repo with a private board, Pullboard home and Git identity, run as the person's terminal. */
function freshBoard() {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-rigor-'));
  DIRS.push(dir);
  // The hooks init installs call pullboard by name, so this checkout's CLI is the one on PATH.
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${BIN.replaceAll("'", "'\\''")}' "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') || key.startsWith('PULLBOARD_') || MARKERS.includes(key)) delete env[key];
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH}`,
    PULLBOARD_HOME: join(dir, 'home'), PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Rigor fixture', GIT_AUTHOR_EMAIL: 'rigor@example.invalid',
    GIT_COMMITTER_NAME: 'Rigor fixture', GIT_COMMITTER_EMAIL: 'rigor@example.invalid',
  });
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const git = (...args) => runFixtureGit(args, { cwd: repo, env });
  const run = (...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd: repo, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  const init = run('init', '--model', 'Rigor coordinator');
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const config = join(repo, 'pullboard.json');
  writeFileSync(config, `${JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), gate: 'true' }, null, 2)}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: set up rigor fixture');
  const file = join(repo, '.git', 'pullboard', 'board.sqlite');
  return { dir, repo, run, git, file, env };
}

/** Run one command with --json and return its document, failing with its output. */
function json(box, ...args) {
  const result = box.run(...args, '--json');
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout);
}

/** Assert a CLI run refused with one code, naming the rule it proves when it did not. */
function refused(result, code, why) {
  const document = JSON.parse(result.stdout || '{}');
  assert.equal(document.error?.code, code, `${why}: ${result.stdout}${result.stderr}`);
}

/**
 * Build board history straight through the board's own moves on the real SQLite file: a builder
 * and a reviewer in one lane, and helpers to submit, reject and land-reopen an item.
 */
function history(file) {
  const board = store.openBoard(file);
  const builder = store.register(board, { lane: 'app', path: '/fixture/app-1', model: 'Builder model' });
  const reviewer = store.register(board, { lane: 'app', path: '/fixture/app-2', model: 'Reviewer model' });
  /** Freeze the item's title, as the real freezer digests its criterion. */
  const freeze = (item) => ({ text: item.item_title, digest: `digest:${item.item_title}` });
  let next = 0;
  /** A fresh 40-character commit id for each submission. */
  const commit = () => (++next).toString(16).padStart(40, '0');
  /** Claim and submit an item at a new commit, returning that commit. */
  const submit = (id) => {
    store.claim(board, id, { agentId: builder, lane: 'app', leaseMs: 2 * HOUR, freeze });
    const sha = commit();
    submitFixture(board, id, { agentId: builder, commit: sha, tree: `tree-${sha}` });
    return sha;
  };
  /** Reject the current submission, naming a cause key or none. */
  const reject = (id, cause, note = 'the named test failed at this commit') => store.verify(board, id, {
    agentId: reviewer, decision: 'REJECT', reason: 'TEST_FAILURE', note, ...(cause === undefined ? {} : { cause }),
    head: store.getItem(board, id).item_commit, digest: `digest:${store.getItem(board, id).item_title}`, policy: 'any',
  });
  /** Accept, then reopen after a red landing whose failing test the note names in the landing format. */
  const landReopen = (id, test) => {
    store.verify(board, id, { agentId: reviewer, decision: 'ACCEPT', note: 'broke the fix; its test failed; restored it',
      head: store.getItem(board, id).item_commit, digest: `digest:${store.getItem(board, id).item_title}`, policy: 'any' });
    return store.reopen(board, id, { agentId: 'coordinator', note: `${test.file}: ${test.name}; merge commit ${MERGE}` });
  };
  /** Add one item in the fixture lane. */
  const add = (title) => store.addItem(board, { by: 'coordinator', lane: 'app', title });
  return { board, add, submit, reject, landReopen, close: () => store.closeBoard(board) };
}

test('a repeated failure cause is noticed [D1,V1]', () => {
  const box = freshBoard();
  const before = json(box, 'rigor');
  assert.deepEqual(before.causes, [], 'an empty board has no repeated cause');

  const catalog = 'test:test/api.test.js::[A1] every catalog command and subcommand has a real CLI exercise';
  const board = history(box.file);
  const [first, second, third, single, conflictA, conflictB] = ['First', 'Second', 'Third', 'Single', 'Conflict A', 'Conflict B'].map(board.add);
  // A repeat: the same failing test sends back two items.
  board.submit(first); board.reject(first, catalog);
  board.submit(second); board.reject(second, catalog);
  // A repeat on one item at two different commits.
  const firstSha = board.submit(third); board.reject(third, 'refusal:UNDECLARED_REFUSAL');
  const secondSha = board.submit(third); board.reject(third, 'refusal:UNDECLARED_REFUSAL');
  // A single: one failure on one item at one commit never lists.
  board.submit(single); board.reject(single, 'row:G1');
  // An uncaused reject: no structured cause and no --cause, so it records no key and is counted.
  const uncausedItem = board.add('Uncaused');
  board.submit(uncausedItem); board.reject(uncausedItem, undefined, `${catalog.slice('test:'.length).replace('::', ': ')} failed`);
  // Merge conflicts on two items never list, however often they recur.
  board.submit(conflictA); board.landReopen(conflictA, { file: 'src/help.js', name: 'conflicts with main 8b8dc50e (0.8.29), merge main and resubmit' });
  board.submit(conflictB); board.landReopen(conflictB, { file: 'src/help.js', name: 'conflicts with main 8b8dc50e (0.8.29), merge main and resubmit' });
  board.close();

  const repeated = json(box, 'rigor');
  assert.deepEqual(repeated.causes.map((cause) => cause.key), [catalog, 'refusal:UNDECLARED_REFUSAL'],
    'the two repeats list, the single and the merge conflicts do not');
  const [test, refusal] = repeated.causes;
  assert.deepEqual(test.items.map((item) => item.id), [first, second], 'a repeat lists both its items');
  assert.equal(test.reads, 'both', 'a failing test reads as work or product, so the person picks');
  assert.equal(test.occurrences, 2);
  assert.deepEqual(refusal.items, [{ id: third, commits: [firstSha, secondSha] }], 'one item at two commits is a repeat');
  assert.equal(refusal.reads, 'work', 'a refusal is about how the work is done');
  assert.ok(!repeated.causes.some((cause) => cause.key === 'row:G1'), 'a single failure does not list');
  assert.ok(!repeated.causes.some((cause) => /conflicts with/u.test(cause.key)), 'a merge conflict never lists');
  assert.equal(repeated.uncaused, 1, 'the uncaused reject is counted, and its note naming the catalog test is never read as a key');
  assert.equal(test.items.length, 2, 'the uncaused reject does not join the catalog cause');

  // A person's never-again lists at once, from one fact and no failure at all.
  const marked = json(box, 'fact', String(single), 'root-cause', 'Every function keeps its JSDoc block', '--cause', 'doctrine:C3', '--never-again', '--as', 'person');
  assert.equal(marked.fact.by, store.PERSON, 'the fact is the person’s');
  assert.equal(marked.fact.neverAgain, true);
  const never = json(box, 'rigor');
  assert.deepEqual(never.causes[0], { key: 'doctrine:C3', reads: 'work', occurrences: 0, neverAgain: true, items: [{ id: single, commits: [] }] },
    'the never-again lists first, at once');
  assert.equal(never.causes.length, 3);

  const text = box.run('rigor');
  assert.equal(text.status, 0, text.stderr);
  const lines = text.stdout.trim().split('\n');
  assert.match(lines[0], /^doctrine:C3 {2}reads as work {2}never again \(the person\) {2}items #\d+$/u);
  assert.equal(lines[1], `${catalog}  reads as both  2 failures  items #${first}, #${second}`);
  assert.equal(lines[2], `refusal:UNDECLARED_REFUSAL  reads as work  2 failures  items #${third} (2 commits)`);
  assert.equal(lines[3], '1 rejects and reopens carry no cause key; name one with --cause <key> (test:<file>::<title>, refusal:<CODE>, row:<id>, doctrine:<id>)',
    'rigor says how many rejects and reopens are uncaused');
  assert.equal(lines.length, 4);
});

test('rigor reads old events by their structured fields only, never by their notes [D1,V1]', () => {
  const box = freshBoard();
  const board = history(box.file);
  const [first, second, third, fourth] = ['First', 'Second', 'Third', 'Fourth'].map(board.add);
  const landing = { file: 'test/machine.test.js', name: 'the declaration matches the refusals board.js and cli.js raise [M1]' };
  // Reopens after a red landing carry their failing tests as structured fields, with no cause key.
  board.submit(first); board.landReopen(first, landing);
  board.submit(second); board.landReopen(second, landing);
  // Rejects recorded without a cause key: their notes name the same test, and are never parsed.
  const note = `${landing.file}: ${landing.name} failed again`;
  board.submit(third); board.reject(third, undefined, note);
  board.submit(fourth); board.reject(fourth, undefined, note);
  board.close();
  const report = json(box, 'rigor');
  assert.deepEqual(report.causes.map((cause) => [cause.key, cause.items.map((item) => item.id)]),
    [[`test:${landing.file}::${landing.name}`, [first, second]]], 'only the structured landing tests count');
  assert.equal(report.uncaused, 2, 'the two causeless rejects are counted as uncaused');
  const text = box.run('rigor');
  assert.match(text.stdout, /^2 rejects and reopens carry no cause key; name one with --cause <key>/mu);
});

test('a cause key is checked, recorded on reject and reopen, and the person alone marks never-again [D1,V1,H16]', () => {
  const box = freshBoard();
  const board = history(box.file);
  const id = board.add('Checked');
  board.submit(id);
  for (const [bad, named] of [['the catalog test failed', '"the catalog test failed"'], ['cause:G1', '"cause:G1"'], ['', 'an empty key']]) {
    assert.throws(() => board.reject(id, bad), (error) => error.code === 'BAD_CAUSE' && error.message.startsWith(`[BAD_CAUSE] ${named} is not a cause key`)
      && ['test:<file>::<title>', 'refusal:<CODE>', 'row:<id>', 'doctrine:<id>'].every((form) => error.message.includes(form)),
    `${named} is refused by name, with the four forms`);
  }
  assert.equal(store.getItem(board.board, id).item_status, 'submitted', 'a refused reject leaves the item submitted');
  board.reject(id, 'row:G1');
  const rejected = store.events(board.board, { itemId: id }).at(-1);
  assert.equal(JSON.parse(rejected.event_detail).cause, 'row:G1', 'the reject records its cause key');

  // A sealed move that carries a cause needs the cause engine; an older envelope cannot carry it.
  const second = board.add('Sealed');
  board.submit(second);
  const move = prepareEngineMove(board.board, 'verify', [second, { agentId: 'app-2', decision: 'REJECT', reason: 'TEST_FAILURE', note: 'red', cause: 'row:G1', head: store.getItem(board.board, second).item_commit, digest: 'digest:Sealed', policy: 'any' }]);
  assert.equal(CAUSE_ENGINE, 30, 'cause moves keep their stable minimum engine');
  assert.equal(move.engine, ENGINE_VERSION, 'new envelopes declare the current engine independently of the feature minimum');
  for (const older of [19, CAUSE_ENGINE - 1]) {
    assert.throws(() => applyEngineMove(board.board, { ...move, engine: older }, { sequence: 1, at: new Date().toISOString() }),
      (error) => error.code === 'RELAY_MOVE', `an engine-${older} move cannot carry a cause key`);
    assert.equal(store.getItem(board.board, second).item_status, 'submitted', `the engine-${older} refusal changes nothing`);
  }
  board.close();

  // The coordinator's reopen records --cause through the CLI.
  const reopenItem = json(box, 'add', 'coordinator', 'Reopen with a cause', '--criterion', 'Reopen records its cause.', '--check', 'true').item;
  // The private person's acceptance permits this intentionally pre-green fixture check.
  json(box, 'check', 'accept', String(reopenItem.item_id));
  json(box, 'claim', String(reopenItem.item_id));
  json(box, 'submit', String(reopenItem.item_id));
  refused(box.run('reopen', String(reopenItem.item_id), '--note', 'wrong bar', '--cause', 'wrong bar', '--json'), 'BAD_CAUSE', 'a reopen refuses a malformed cause');
  json(box, 'reopen', String(reopenItem.item_id), '--note', 'the bar cites the wrong row', '--cause', 'row:G1');
  const reopened = json(box, 'log', String(reopenItem.item_id)).events.at(-1);
  assert.equal(reopened.event_kind, 'reopen');
  assert.equal(JSON.parse(reopened.event_detail).cause, 'row:G1', 'the reopen records its cause key');

  // Only the person marks never-again; the coordinator alone, or without a cause, is refused.
  refused(box.run('fact', String(id), 'root-cause', 'never again', '--cause', 'row:G1', '--never-again', '--json'), 'RIGOR_PERSON_ONLY', 'the coordinator alone cannot mark never-again');
  const agentShell = runFixtureChild(process.execPath, [BIN, 'fact', String(id), 'root-cause', 'never again', '--cause', 'row:G1', '--never-again', '--as', 'person', '--json'],
    { cwd: box.repo, env: { ...box.env, CLAUDECODE: '1' }, encoding: 'utf8' });
  refused(agentShell, 'B26_PERSON_CHANNEL', 'an agent shell cannot act as the person');
  refused(box.run('fact', String(id), 'root-cause', 'never again', '--never-again', '--as', 'person', '--json'), 'BAD_CAUSE', 'a never-again names its cause');
  const logged = json(box, 'log').events.length;
  const report = json(box, 'rigor');
  assert.deepEqual(report.causes.map((cause) => cause.key), ['row:G1'], 'row:G1 on two items repeats');
  assert.equal(report.causes[0].reads, 'product');
  assert.equal(json(box, 'log').events.length, logged, 'rigor is read-only: it records no move');
});

test('reject, reopen and fact moves without a cause replay unchanged from engines 11 and 12 [D1,H16]', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-rigor-replay-'));
  DIRS.push(directory);
  const fixed = { now: () => new Date('2026-10-16T12:00:00.000Z') };
  /** Freeze with the captured verify policy that released verify replay requires. */
  const freeze = (item) => ({
    text: JSON.stringify({ criterion: item.item_title, policy: { version: 1, commit: 'a'.repeat(40), verify: { policy: 'any', family: 'off' } } }),
    digest: `digest:${item.item_title}`,
  });
  const landed = { file: 'test/machine.test.js', name: 'the declaration matches the refusals [M1]' };
  for (const [version, tag] of [[11, 'v0.8.27'], [12, 'v0.8.29']]) {
    const source = join(directory, `client-${version}`);
    mkdirSync(source);
    unpackRelease(tag, source);
    const legacyStore = await import(pathToFileURL(join(source, 'src/board.js')).href);
    const legacyEngine = await import(pathToFileURL(join(source, 'src/engine.js')).href);
    const legacyMachine = await import(pathToFileURL(join(source, 'src/machine.js')).href);
    assert.equal(legacyMachine.ENGINE_VERSION, version, 'the archived executable has the claimed engine');
    const old = legacyStore.openBoard(join(directory, `old-${version}.sqlite`), fixed);
    const current = store.openBoard(join(directory, `current-${version}.sqlite`), fixed);
    t.after(() => { legacyStore.closeBoard(old); store.closeBoard(current); });
    for (const [replica, module] of [[old, legacyStore], [current, store]]) {
      module.register(replica, { lane: 'coordinator', path: '/fixture/main' });
      module.register(replica, { lane: 'app', path: '/fixture/app-1', model: 'Builder model' });
      module.register(replica, { lane: 'app', path: '/fixture/app-2', model: 'Reviewer model' });
    }
    const first = '1'.repeat(40);
    const second = '2'.repeat(40);
    const journal = [
      ['addItem', [{ by: 'coordinator', lane: 'app', title: 'Replayed' }]],
      ['claim', [1, { agentId: 'app-1', lane: 'app', leaseMs: 2 * HOUR, freeze }]],
      ['submit', [1, { agentId: 'app-1', commit: first, tree: 'tree-1' }]],
      ['verify', [1, { agentId: 'app-2', decision: 'REJECT', reason: 'TEST_FAILURE', note: `${landed.file}: ${landed.name}`, head: first, digest: 'digest:Replayed', policy: 'any' }]],
      ['claim', [1, { agentId: 'app-1', lane: 'app', leaseMs: 2 * HOUR, freeze }]],
      ['submit', [1, { agentId: 'app-1', commit: second, tree: 'tree-2' }]],
      ['verify', [1, { agentId: 'app-2', decision: 'ACCEPT', note: 'broke the fix; its test failed; restored it', head: second, digest: 'digest:Replayed', policy: 'any' }]],
      ['reopen', [1, { agentId: 'coordinator', note: `${landed.file}: ${landed.name}; merge commit ${MERGE}` }]],
      ['appendFact', [1, { agentId: 'coordinator', kind: 'root-cause', text: 'the refusal was never declared' }]],
    ];
    journal.forEach(([operation, args], index) => {
      const move = legacyEngine.prepareEngineMove(old, operation, args, { id: `engine-${version}-rigor-${index}` });
      assert.equal(move.engine, version);
      const receipt = { sequence: index + 1, at: `2026-10-16T12:00:0${index}.000Z` };
      const oldOutcome = legacyEngine.applyEngineMove(old, move, receipt);
      assert.equal(oldOutcome.error, undefined, `released engine-${version} ${operation} applies: ${JSON.stringify(oldOutcome)}`);
      assert.deepEqual(applyEngineMove(current, move, receipt), oldOutcome, `engine-${version} ${operation} replays identically`);
    });
    assert.deepEqual(store.events(current), legacyStore.events(old), `engine-${version} reject, reopen and fact events replay with no cause field`);
    assert.ok(store.events(current).every((event) => !Object.hasOwn(JSON.parse(event.event_detail), 'cause')));
    const report = rigorReport(store.events(current), { person: store.PERSON });
    assert.deepEqual(report, { causes: [], uncaused: 1 }, 'the old reject has no key, and one landing failure on one commit is no repeat');
    const caused = prepareEngineMove(current, 'appendFact', [1, { agentId: 'coordinator', kind: 'root-cause', text: 'never again', cause: 'refusal:UNDECLARED', neverAgain: true, asPerson: true, channel: 'terminal' }]);
    assert.throws(() => legacyEngine.applyEngineMove(old, caused, { sequence: journal.length + 1, at: '2026-10-16T12:01:00.000Z' }),
      (error) => error.code === 'ENGINE_VERSION', `the engine-${version} client refuses a cause move before interpreting it`);
  }
});
