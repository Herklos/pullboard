/** The roadmap summarizes recorded progress without treating acceptance as landing [N26]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { main } from '../src/cli.js';
import { milestoneRoadmap } from '../src/roadmap.js';
import { submitFixture } from './board-submit-fixture.js';

const HOUR = 3_600_000;

/** A real Git repository and SQLite board with a shared, controlled command clock. */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
  Object.assign(process.env, { HOME: join(dir, 'home'), PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Roadmap fixture', GIT_AUTHOR_EMAIL: 'roadmap@example.invalid',
    GIT_COMMITTER_NAME: 'Roadmap fixture', GIT_COMMITTER_EMAIL: 'roadmap@example.invalid' });
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'SPEC.md'), '# Fixture\n\n## G · Goals\n- G1 [approved, must] Work is tracked. | gate: true\n');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true', verify: 'any',
    lanes: { web: { owns: ['web/'], specs: ['G1'] }, paused: { owns: ['paused/'], specs: ['G1'] } }, shared: [] }));
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'chore: initialize fixture']);
  const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  let instant = Date.parse('2026-10-17T12:00:00Z');
  const clock = { now: () => new Date(instant) };
  const board = store.openBoard(join(repo, '.git', 'pullboard', 'board.sqlite'), clock);
  t.after(() => store.closeBoard(board));
  store.ensureCoordinator(board, repo);
  const builder = store.register(board, { lane: 'web', path: join(dir, 'builder'), model: 'Fixture Model' });
  /** Advance the board clock without editing its stored records. */
  const at = value => { instant = value; };
  /** File work and advance it through ordinary board operations to the requested state. */
  const item = (state, lane = 'web') => {
    const id = store.addItem(board, { by: 'coordinator', lane, title: state + ' work', criterion: 'Tracked work', specIds: ['G1'] });
    if (['waiting', 'held'].includes(state)) {
      if (state === 'held') store.holdItem(board, id, { agentId: 'coordinator', reason: 'Waiting for a judgment' });
      return id;
    }
    store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: HOUR,
      freeze: () => ({ text: 'Tracked work', digest: 'digest:tracked' }) });
    if (state === 'building') return id;
    submitFixture(board, id, { agentId: builder, commit, tree: 'tree' });
    if (state === 'review') return id;
    store.verify(board, id, { agentId: 'coordinator', decision: 'ACCEPT', note: 'checked it',
      head: commit, digest: 'digest:tracked', policy: 'any' });
    if (state === 'landed') store.merged(board, id, { agentId: 'coordinator', commit });
    return id;
  };
  /** Read the public command with the same clock as the board's projections. */
  const run = async (json = true) => {
    let stdout = ''; let stderr = '';
    const code = await main(['roadmap', ...(json ? ['--json'] : [])], { cwd: repo, clock,
      stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } });
    assert.equal(code, 0, stdout + stderr);
    return json ? JSON.parse(stdout) : stdout;
  };
  return { repo, board, clock, commit, at, item, run };
}

test('[N26] each milestone sums its items by state with an estimate', async t => {
  const box = fixture(t);
  const now = box.clock.now().getTime();
  const landings = [];
  for (const hours of [7, 6, 4, 3, 1.5, 1, 0.5]) {
    box.at(now - hours * HOUR);
    landings.push(box.item('landed'));
  }
  box.at(now);
  // Recording an old landing again must not turn it into new progress.
  store.merged(box.board, landings[0], { agentId: 'coordinator', commit: box.commit });
  const landing = box.item('landing');
  const review = box.item('review');
  const building = box.item('building');
  const held = box.item('held');
  const waiting = box.item('waiting');
  const withdrawn = box.item('waiting');
  store.withdraw(box.board, withdrawn, { agentId: 'coordinator', reason: 'No longer planned' });
  const ids = [landings.at(-1), landing, review, building, held, waiting, withdrawn];
  store.addMilestone(box.board, { agentId: 'coordinator', name: 'A', items: ids });
  const ask = store.shout(box.board, { from: 'coordinator', to: store.PERSON, lanes: ['web'], decision: true,
    text: `Choose for #${waiting}, #${waiting}, #${withdrawn}; foreign#${review} and https://example.invalid/#${landing} are outside`,
    evidence: { kind: 'attempt', outcome: 'Needs judgment', item: held, commit: box.commit } });
  const expected = { total: 6, left: 5, landed: 1, landing: 1, review: 1, building: 1, held: 1, waiting: 1,
    needsYou: [held, waiting], pace: { last6h: 5, last2h: 3, last24h: 7 }, estimate: { low: 3.5, high: 6 }, window: '6h', reason: null };
  assert.deepEqual((await box.run()).milestones[0].summary, expected);
  assert.match(await box.run(false), /^  5 left of 6: 1 landed, 1 landing, 1 in review, 1 building, 1 waiting, 1 held; about 3.5 to 6 h at today's pace\.$/m);
  const direct = milestoneRoadmap(box.repo, box.board, { projects: () => [] })[0];
  assert.equal(direct.total, 7, 'legacy milestone membership still includes withdrawn work');
  assert.equal(direct.items.at(-1).status, 'withdrawn');
  assert.equal(direct.done, 1);
  assert.deepEqual(direct.items.map(entry => entry.id), ids, 'existing roadmap fields stay intact');
  assert.equal(['landed', 'landing', 'review', 'building', 'held', 'waiting'].reduce((sum, key) => sum + direct.summary[key], 0), direct.summary.total);
  store.shout(box.board, { from: store.PERSON, to: 'coordinator', lanes: ['web'], answers: ask, text: 'Choose it' });
  assert.deepEqual((await box.run()).milestones[0].summary.needsYou, [], 'answered questions no longer need the person');
  box.at(now + 2 * HOUR);
  const later = (await box.run()).milestones[0].summary;
  assert.equal(later.building, 0, 'an expired claim becomes waiting');
  assert.equal(later.waiting, 2);
  assert.deepEqual(later.pace, { last6h: 4, last2h: 0, last24h: 7 });
  assert.deepEqual(later.estimate, { low: 7.5, high: 7.5 }, 'a zero short window uses the positive six-hour rate');
  box.at(now + 6 * HOUR);
  assert.deepEqual((await box.run()).milestones[0].summary.estimate, { low: 17, high: 17 }, 'sparse recent progress falls back to the full day');
  box.at(now);
  store.addMilestone(box.board, { agentId: 'coordinator', name: 'B', items: [] });
  store.shipMilestone(box.board, 'A', { agentId: 'coordinator', commit: box.commit });
  const shipped = (await box.run()).milestones[0];
  assert.equal(shipped.summary.estimate, null, 'a shipped milestone has no estimate even at a known pace');
  assert.doesNotMatch((await box.run(false)).split('B:')[0], /left of/, 'the shipped milestone has no summary line');
});


test('[N26] roadmap holds and unavailable scoped references partition without leaking names', async t => {
  const box = fixture(t);
  const now = box.clock.now().getTime();
  const building = box.item('building');
  store.holdItem(box.board, building, { agentId: 'coordinator', reason: 'Next stage waits' });
  const paused = box.item('waiting', 'paused');
  store.holdLane(box.board, 'paused', { agentId: 'coordinator', reason: 'Paused lane' });
  store.addMilestone(box.board, { agentId: 'coordinator', name: 'Scoped', items: [building, paused, 'unregistered-private#7'] });
  const scoped = milestoneRoadmap(box.repo, box.board, { projects: () => [], hideOutOfScope: true })[0];
  assert.equal(scoped.summary.building, 1, 'a live builder takes precedence over a hold');
  assert.equal(scoped.summary.held, 1, 'a held lane counts its open work');
  assert.equal(scoped.summary.waiting, 1, 'an unresolved foreign item remains in the total');
  assert.equal(scoped.summary.total, 3);
  assert.equal(scoped.summary.estimate, null);
  assert.doesNotMatch(JSON.stringify(scoped), /unregistered-private/, 'the summary preserves scoped reference redaction');
  box.at(now + 2 * HOUR);
  const expired = milestoneRoadmap(box.repo, box.board, { projects: () => [], hideOutOfScope: true })[0].summary;
  assert.equal(expired.building, 0);
  assert.equal(expired.held, 2, 'the expired builder is held instead of waiting');
  assert.equal(expired.waiting, 1);
});


test('[N26] an estimate with equal bounds prints one number', async t => {
  const box = fixture(t);
  const now = box.clock.now().getTime();
  // Equal six-hour and two-hour rates make the rounded decimal bounds equal.
  for (const hours of [...Array(8).fill(5.75), ...Array(4).fill(1)]) {
    box.at(now - hours * HOUR);
    box.item('landed');
  }
  box.at(now);
  const items = Array.from({ length: 5 }, () => box.item('waiting'));
  store.addMilestone(box.board, { agentId: 'coordinator', name: 'Estimate', items });
  assert.deepEqual((await box.run()).milestones[0].summary.estimate, { low: 2.5, high: 2.5 },
    'JSON retains both equal bounds');
  const equal = await box.run(false);
  assert.match(equal, /; about 2\.5 h at today's pace\./u);
  assert.doesNotMatch(equal, /2\.5 to 2\.5/u);

  // Aging the older landings out of the long window separates the two rates.
  box.at(now + 0.5 * HOUR);
  assert.deepEqual((await box.run()).milestones[0].summary.estimate, { low: 2.5, high: 7.5 },
    'JSON retains both different bounds');
  assert.match(await box.run(false), /; about 2\.5 to 7\.5 h at today's pace\./u);
});


test('[N26] a slow day estimates from the last 24 hours', async t => {
  const box = fixture(t);
  const now = box.clock.now().getTime();
  for (const hours of [2.1, 2.5, 3, 3.5, 4, 4.5, 5, 7, 8, 9, 10, 11]) {
    box.at(now - hours * HOUR);
    box.item('landed');
  }
  box.at(now);
  const items = Array.from({ length: 3 }, () => box.item('waiting'));
  store.addMilestone(box.board, { agentId: 'coordinator', name: 'Slow', items });
  // These are observations of the same real history; no moves are written while changing its query clock.
  box.at(now + 7 * HOUR);
  const slow = (await box.run()).milestones[0].summary;
  assert.deepEqual(slow.estimate, { low: 6, high: 6 }, 'a slow day uses the positive full-day rate');
  assert.equal(slow.window, '24h');
  assert.equal(slow.reason, null);
  assert.deepEqual(slow.pace, { last6h: 0, last2h: 0, last24h: 12 });
  assert.match(await box.run(false), /; about 6 h at the last day's pace\./u);

  box.at(now);
  const recent = (await box.run()).milestones[0].summary;
  assert.deepEqual(recent.estimate, { low: 2.5, high: 2.5 });
  assert.equal(recent.window, '6h');
  assert.deepEqual(recent.pace, { last6h: 7, last2h: 0, last24h: 12 });
  assert.match(await box.run(false), /; about 2\.5 h at today's pace\./u);
  box.at(now + 2.5 * HOUR);
  assert.equal((await box.run()).milestones[0].summary.window, '6h', 'three recent landings still prefer the six-hour rate');
  box.at(now + 3 * HOUR);
  const justSlow = (await box.run()).milestones[0].summary;
  assert.equal(justSlow.pace.last6h, 2);
  assert.equal(justSlow.window, '24h', 'two recent landings use the full-day fallback');

  box.at(now + 20.5 * HOUR);
  const threshold = (await box.run()).milestones[0].summary;
  assert.equal(threshold.pace.last24h, 3, 'the exact24h boundary is outside the window');
  assert.deepEqual(threshold.estimate, { low: 24, high: 24 }, 'three full-day landings are enough');
  assert.equal(threshold.window, '24h');
  box.at(now + 21 * HOUR);
  const sparse = (await box.run()).milestones[0].summary;
  assert.equal(sparse.pace.last24h, 2);
  assert.equal(sparse.estimate, null);
  assert.equal(sparse.window, null);
  assert.equal(sparse.reason, 'few-landings');
  assert.match(await box.run(false), /; too few landings yet to estimate\./u);

  store.addMilestone(box.board, { agentId: 'coordinator', name: 'Next', items: [] });
  store.shipMilestone(box.board, 'Slow', { agentId: 'coordinator', commit: box.commit });
  const shipped = (await box.run()).milestones[0].summary;
  assert.deepEqual({ estimate: shipped.estimate, window: shipped.window, reason: shipped.reason },
    { estimate: null, window: null, reason: null }, 'shipping is not mislabeled as sparse history');
  assert.doesNotMatch((await box.run(false)).split('Next:')[0], /left of|too few landings|about .* h/u);
});
