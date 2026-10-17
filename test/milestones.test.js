/** The roadmap counts what landed on main, and shipping a milestone carries the rest forward [N26]. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import * as store from '../src/board.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const HOUR = 3_600_000;
const TEMP_DIRS = [];

after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

/**
 * A real repo on main with an initialized board and a builder agent, and items in each state
 * the roadmap tells apart: landed (verified with a merge commit), accepted (verified only) and open.
 * Git runs with every GIT_* variable stripped, so a hook's repository never leaks into the fixture.
 */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-milestones-'));
  TEMP_DIRS.push(dir);
  const repo = join(dir, 'repo');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // The repo's hooks call pullboard by name, so the fixture puts this checkout's CLI on PATH.
  const word = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${word(process.execPath)} ${word(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, { HOME: join(dir, 'home'), PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Milestone fixture', GIT_AUTHOR_EMAIL: 'milestones@example.invalid',
    GIT_COMMITTER_NAME: 'Milestone fixture', GIT_COMMITTER_EMAIL: 'milestones@example.invalid', PATH: `${bin}:${process.env.PATH}` });
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
  /** Run Git inside the fixture repo with its private identity. */
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  /** Run pullboard from the main checkout, where it acts as the coordinator. */
  const run = (...args) => {
    const result = spawnSync(process.execPath, [BIN, ...args], { cwd: repo, env, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  /** Run a command that must succeed and return its JSON document. */
  const json = (...args) => {
    const result = run(...args, '--json');
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const initialized = run('init');
  assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr);
  writeFileSync(join(repo, 'SPEC.md'), '# Fixture\n\n## G · Goals\n- G1 [approved, must] Work is tracked. | gate: true\n');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true', verify: 'any', lanes: { web: { owns: ['web/'], specs: ['G1'] } }, shared: [] }));
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: initialize fixture');
  const board = store.openBoard(join(repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  store.ensureCoordinator(board, repo);
  const builder = store.register(board, { lane: 'web', path: join(dir, 'builder'), model: 'Fixture Model' });
  const freeze = () => ({ text: 'Tracked work', digest: 'digest:tracked' });
  /** File an item and take it to the named state: open, accepted or landed. */
  const item = (title, state) => {
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title, criterion: 'Tracked work', specIds: ['G1'] });
    if (state === 'open') return id;
    const commit = String(id).repeat(40).slice(0, 40);
    store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: HOUR, freeze });
    store.submit(board, id, { agentId: builder, commit, tree: 'tree' });
    store.verify(board, id, { agentId: 'coordinator', decision: 'ACCEPT', note: 'checked it', head: commit, digest: 'digest:tracked', policy: 'any' });
    if (state === 'landed') store.merged(board, id, { agentId: 'coordinator', commit: git('rev-parse', 'HEAD') });
    return id;
  };
  return { repo, git, run, json, board, builder, item };
}

/** The milestone named `name` in a roadmap document. */
function milestone(document, name) {
  return document.milestones.find((entry) => entry.name === name);
}

/** The milestone moves recorded on an item's thread. */
function moves(box, id) {
  return box.json('show', String(id)).thread.filter((entry) => entry.kind === 'milestone_moved');
}

test('[N26] a milestone ships what landed and moves the rest', async (t) => {
  const box = fixture(t);
  const landed = box.item('Landed work', 'landed');
  const accepted = box.item('Accepted work', 'accepted');
  const open = box.item('Open work', 'open');
  const later = box.item('Later work', 'open');
  box.json('milestone', 'add', 'A', '--items', `${landed},${accepted},${open}`);
  box.json('milestone', 'add', 'B', '--items', String(later));

  // The target: set on A and shown in the roadmap and its JSON; a passed one is marked.
  const edited = box.json('milestone', 'edit', 'A', '--target', '2026-01-02T03:04Z');
  assert.equal(edited.milestone.target, '2026-01-02T03:04:00.000Z', 'the edit stores the target');
  const before = box.json('roadmap');
  assert.equal(milestone(before, 'A').target, '2026-01-02T03:04:00.000Z', 'the roadmap JSON shows the target');
  assert.equal(milestone(before, 'A').pastTarget, true, 'an unshipped milestone past its target is marked');
  assert.equal(milestone(before, 'B').pastTarget, false, 'a milestone with no target is never past it');

  // Landed counting: only the merged item counts; each item shows landed, accepted or its status.
  assert.equal(milestone(before, 'A').landed, 1, 'only the item merged onto main counts as landed');
  assert.equal(milestone(before, 'A').done, 1, 'done means landed, so accepted work is not done');
  assert.equal(milestone(before, 'A').total, 3);
  assert.deepEqual(milestone(before, 'A').items.map(({ id, state }) => [id, state]),
    [[landed, 'landed'], [accepted, 'accepted'], [open, 'open']], 'each item shows its roadmap state');
  const text = box.run('roadmap');
  assert.equal(text.status, 0, text.stdout + text.stderr);
  assert.match(text.stdout, /^A: 1\/3 landed · target 2026-01-02T03:04:00\.000Z, past target$/m, 'the text shows N/M landed, the target and past target');
  assert.match(text.stdout, /^ {2}#\d+ Landed work — landed$/m);
  assert.match(text.stdout, /^ {2}#\d+ Accepted work — accepted$/m);
  assert.match(text.stdout, /^ {2}#\d+ Open work — open$/m);

  // Shipping is the coordinator's move, not a builder's.
  assert.throws(() => store.shipMilestone(box.board, 'A', { agentId: box.builder, commit: box.git('rev-parse', 'main') }),
    (error) => error.code === 'COORDINATOR_ONLY');

  // Ship: A records main's commit, and the two unlanded items move into B.
  const main = box.git('rev-parse', 'main');
  const shipped = box.json('milestone', 'ship', 'A');
  assert.equal(shipped.milestone.shipped.commit, main, "the milestone is shipped at main's commit");
  assert.equal(shipped.into, 'B', 'the next milestone is the one after it');
  assert.deepEqual(shipped.moved, [accepted, open]);
  const after = box.json('roadmap');
  assert.equal(milestone(after, 'A').shipped.commit, main, "the roadmap shows main's commit on the shipped milestone");
  assert.deepEqual(milestone(after, 'A').items.map(({ id }) => id), [landed], 'only the landed item stays in the shipped milestone');
  assert.equal(milestone(after, 'A').pastTarget, false, 'a shipped milestone is no longer past its target');
  assert.deepEqual(milestone(after, 'B').items.map(({ id }) => id), [later, accepted, open], 'the unlanded items are now in B');

  // The threads: each moved item records the move; the landed one records none.
  for (const id of [accepted, open]) {
    const recorded = moves(box, id);
    assert.equal(recorded.length, 1, `#${id}'s thread records its move`);
    assert.equal(recorded[0].detail.from, 'A');
    assert.equal(recorded[0].detail.to, 'B');
    assert.equal(recorded[0].detail.commit, main);
  }
  assert.deepEqual(moves(box, landed), [], 'a landed item does not move');

  // The refusal: a shipped milestone takes no new items.
  const refused = box.run('milestone', 'items', 'A', '--add', String(later), '--json');
  assert.notEqual(refused.status, 0, refused.stdout + refused.stderr);
  assert.equal(JSON.parse(refused.stdout).error.code, 'MILESTONE_SHIPPED', 'adding to a shipped milestone is refused');
  assert.deepEqual(milestone(box.json('roadmap'), 'A').items.map(({ id }) => id), [landed], 'the refusal changes nothing');

  // A target means one instant on every replica: the move carries UTC, and a bare local time
  // in an ordered envelope is refused alike in every zone instead of read in each one's own.
  const { prepareEngineMove, applyEngineMove } = await import('../src/engine.js');
  const { exportBoard, importBoard } = await import('../src/exchange.js');
  store.addMilestone(box.board, { agentId: 'coordinator', name: 'Z' });
  const snapshot = exportBoard(box.board);
  const prepared = prepareEngineMove(box.board, 'editMilestone', ['Z', { agentId: 'coordinator', target: '2026-10-20T18:00' }], { id: 'zone-target', actor: 'coordinator' });
  assert.match(prepared.args[1].target, /Z$/u, 'the prepared move carries the instant in UTC');
  const bare = { ...prepared, id: 'bare-target', args: ['Z', { agentId: 'coordinator', target: '2026-10-20T18:00' }] };
  const zone = process.env.TZ;
  const replicas = [];
  try {
    for (const name of ['UTC', 'America/Chicago']) {
      const dir = mkdtempSync(join(tmpdir(), 'pullboard-target-zone-'));
      TEMP_DIRS.push(dir);
      const replica = store.openBoard(join(dir, 'board.sqlite'));
      t.after(() => store.closeBoard(replica));
      importBoard(replica, snapshot);
      process.env.TZ = name;
      const refused = applyEngineMove(replica, bare, { sequence: 1, at: '2026-10-17T04:00:00.000Z' });
      assert.equal(refused.error?.code, 'MILESTONE_TARGET', `a bare local time is refused in ${name}: ${JSON.stringify(refused)}`);
      const applied = applyEngineMove(replica, prepared, { sequence: 2, at: '2026-10-17T04:00:01.000Z' });
      assert.equal(applied.error, undefined, JSON.stringify(applied));
      replicas.push(store.milestones(replica).find((row) => row.name === 'Z').target);
    }
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
  assert.equal(replicas[0], replicas[1], `every replica stores the same target: ${JSON.stringify(replicas)}`);
});

test('[N26] milestone ship --next names where the unlanded items go', (t) => {
  const box = fixture(t);
  const open = box.item('Open work', 'open');
  box.json('milestone', 'add', 'A', '--items', String(open));
  box.json('milestone', 'add', 'B');
  box.json('milestone', 'add', 'C');
  const shipped = box.json('milestone', 'ship', 'A', '--next', 'C');
  assert.equal(shipped.into, 'C', '--next overrides the milestone after it');
  const document = box.json('roadmap');
  assert.deepEqual(milestone(document, 'B').items, [], 'the milestone after it gets nothing');
  assert.deepEqual(milestone(document, 'C').items.map(({ id }) => id), [open], 'the --next milestone gets the unlanded item');
  assert.equal(moves(box, open)[0].detail.to, 'C', 'the thread names the --next milestone');
});
