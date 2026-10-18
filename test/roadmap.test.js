/** Withdrawn work leaves the roadmap, and each milestone lists its work to ship first [N26]. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import * as store from '../src/board.js';
import { submitFixture } from './board-submit-fixture.js';
import { ENGINE_VERSION } from '../src/machine.js';
import { WITHDRAW_MILESTONE_ENGINE } from '../src/milestones.js';
import { prepareEngineMove } from '../src/engine.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const HOUR = 3_600_000;
const TEMP_DIRS = [];

after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

/**
 * A real repo on main with an initialized board, a builder agent, and a helper that files an item
 * in the state the roadmap tells apart: open, accepted (verified only) or landed (verified with a
 * merge commit). Git runs with every GIT_* variable stripped, so a hook's repository never leaks in.
 */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-'));
  TEMP_DIRS.push(dir);
  const repo = join(dir, 'repo');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // The repo's hooks call pullboard by name, so the fixture puts this checkout's CLI on PATH.
  /** Quote a value for the fixture's private shell launcher. */
  const word = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${word(process.execPath)} ${word(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, { HOME: join(dir, 'home'), PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Roadmap fixture', GIT_AUTHOR_EMAIL: 'roadmap@example.invalid',
    GIT_COMMITTER_NAME: 'Roadmap fixture', GIT_COMMITTER_EMAIL: 'roadmap@example.invalid', PATH: `${bin}:${process.env.PATH}` });
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
  /** Run Git inside the fixture repo with its private identity. */
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  /** Run pullboard from the main checkout, where it acts as the coordinator, and require success. */
  const run = (...args) => {
    const result = spawnSync(process.execPath, [BIN, ...args], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    return result.stdout;
  };
  /** Run a command that must succeed and return its JSON document. */
  const json = (...args) => JSON.parse(run(...args, '--json'));
  run('init');
  writeFileSync(join(repo, 'SPEC.md'), '# Fixture\n\n## G · Goals\n- G1 [approved, must] Work is tracked. | gate: true\n');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true', verify: 'any', lanes: { web: { owns: ['web/'], specs: ['G1'] } }, shared: [] }));
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: initialize fixture');
  const board = store.openBoard(join(repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  store.ensureCoordinator(board, repo);
  const builder = store.register(board, { lane: 'web', path: join(dir, 'builder'), model: 'Fixture Model' });
  /** Supply the stable criterion snapshot used by these synthetic board transitions. */
  const freeze = () => ({ text: 'Tracked work', digest: 'digest:tracked' });
  /** File an item and take it to the named state: open, accepted or landed. */
  const item = (title, state) => {
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title, criterion: 'Tracked work', specIds: ['G1'] });
    if (state === 'open') return id;
    const commit = String(id).repeat(40).slice(0, 40);
    store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: HOUR, freeze });
    submitFixture(board, id, { agentId: builder, commit, tree: 'tree' });
    store.verify(board, id, { agentId: 'coordinator', decision: 'ACCEPT', note: 'checked it', head: commit, digest: 'digest:tracked', policy: 'any' });
    if (state === 'landed') store.merged(board, id, { agentId: 'coordinator', commit: git('rev-parse', 'HEAD') });
    return id;
  };
  return { run, json, board, item };
}

test('withdraw leaves every milestone and the roadmap lists work to ship first [N26]', (t) => {
  const { run, json, board, item } = fixture(t);
  const landed = item('Landed page', 'landed');
  const dropped = item('Dropped idea', 'open');
  const first = item('First open page', 'open');
  const accepted = item('Accepted page', 'accepted');
  const second = item('Second open page', 'open');
  const unrelated = item('Unrelated page', 'open');
  run('milestone', 'add', 'Now', '--items', [landed, dropped, first, accepted, second].join(','));
  run('milestone', 'add', 'Later', '--items', [second, dropped].join(','));
  run('milestone', 'add', 'Elsewhere', '--items', String(unrelated));

  // Probe both sealed writers without consuming fixture IDs or changing board state.
  const withdrawMove = prepareEngineMove(board, 'withdraw', [dropped, { agentId: 'coordinator', reason: 'writer version' }], { id: 'withdraw-writer', actor: 'coordinator' });
  const cleanupMove = prepareEngineMove(board, 'editMilestoneItems', ['Now', { agentId: 'coordinator', remove: [dropped] }], { id: 'milestone-writer', actor: 'coordinator' });
  assert.equal(WITHDRAW_MILESTONE_ENGINE, ENGINE_VERSION, 'the feature writer is the current engine');
  assert.equal(withdrawMove.engine, ENGINE_VERSION, 'withdraw writes use the current engine');
  assert.equal(cleanupMove.engine, ENGINE_VERSION, 'milestone cleanup writes use the current engine');

  // Withdraw removes the item from every milestone that lists it and says which, in roadmap order.
  const said = run('withdraw', String(dropped), 'not recurring');
  assert.match(said, new RegExp(`withdrew #${dropped}; removed it from milestone Now, Later`), 'withdraw names each milestone it left');
  const lists = Object.fromEntries(store.milestones(board).map((entry) => [entry.name, entry.items]));
  assert.deepEqual(lists, { Now: [landed, first, accepted, second], Later: [second], Elsewhere: [unrelated] }, 'the item left Now and Later, and Elsewhere is untouched');
  const removals = store.events(board).filter((event) => event.event_kind === 'milestone_items').map((event) => JSON.parse(event.event_detail));
  assert.deepEqual(removals.map(({ name, remove }) => [name, remove]), [['Now', [dropped]], ['Later', [dropped]]], 'each removal is an ordered milestone move, so a replay does the same');
  const quiet = json('withdraw', String(unrelated), 'folded into another item');
  assert.deepEqual(quiet.milestones, ['Elsewhere'], 'the JSON result names the milestones too');
  assert.equal(json('withdraw', String(item('Never planned', 'open')), 'not needed').milestones.length, 0, 'an item no milestone lists leaves none');

  // A board from before this change still names a withdrawn item: the roadmap neither shows nor counts it.
  const stale = item('Stale withdrawn page', 'open');
  run('milestone', 'add', 'Old', '--items', [stale, landed].join(','));
  store.withdraw(board, stale, { agentId: 'coordinator', reason: 'withdrawn before withdraw left milestones' });
  assert.deepEqual(store.milestones(board).find((entry) => entry.name === 'Old').items, [stale, landed], 'the old board still names it');

  const roadmap = Object.fromEntries(json('roadmap').milestones.map((entry) => [entry.name, entry]));
  assert.deepEqual(roadmap.Now.items.map((entry) => [entry.id, entry.state]),
    [[first, 'open'], [second, 'open'], [landed, 'landed'], [accepted, 'accepted']], 'work to ship first, verified after, each in milestone order');
  assert.deepEqual([roadmap.Now.landed, roadmap.Now.done, roadmap.Now.total], [1, 1, 4], 'Now counts 1/4 landed');
  assert.deepEqual(roadmap.Old.items.map((entry) => entry.id), [landed], 'a withdrawn item is never shown');
  assert.deepEqual([roadmap.Old.done, roadmap.Old.total, roadmap.Old.withdrawn], [1, 1, 1], 'nor counted: Old is finished, 1/1, with one withdrawn item set aside');
  assert.deepEqual([roadmap.Elsewhere.total, roadmap.Elsewhere.items], [0, []], 'a milestone whose only item was withdrawn is empty');

  const text = run('roadmap');
  assert.match(text, /^Now: 1\/4 landed\n {2}#3 First open page — open\n {2}#5 Second open page — open\n {2}#1 Landed page — landed\n {2}#4 Accepted page — accepted$/m, 'the text roadmap lists the same order and count');
  assert.match(text, /^Old: 1\/1 landed\n {2}#1 Landed page — landed$/m, 'and leaves the withdrawn item out of the text');
  assert.doesNotMatch(text, /Stale withdrawn page|Dropped idea/, 'no withdrawn item appears anywhere in the text roadmap');
});
