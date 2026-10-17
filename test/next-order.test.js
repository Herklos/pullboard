/** Roadmap position leads next's existing route order only across unfinished milestones [B16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { applyEngineMove, prepareEngineMove } from '../src/engine.js';
import { ENGINE_VERSION } from '../src/machine.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const HOUR = 60 * 60 * 1000;
const MID_ITEM_DETAILS = {
  criterion: 'the item can be built and checked from its brief',
  check: 'true',
  brief: 'Files: src/board.js\nTest: verify the candidate follows the release roadmap',
};
/** Build the minimal frozen bar required to submit a fixture item. */
const FREEZE = (item) => ({ text: item.item_title, digest: `digest:${item.item_title}` });

/** Open a real SQLite board and register a coordinator plus strong builder and reviewer agents. */
function boardFixture() {
  const board = store.openBoard(':memory:');
  store.register(board, { lane: 'coordinator', path: '/coordinator' });
  const builder = store.register(board, { lane: 'core', path: '/builder', route: 'strong' });
  const reviewer = store.register(board, { lane: 'review', path: '/reviewer', route: 'strong' });
  return { board, builder, reviewer };
}

/** Add and submit an item through the board's normal claim and submit moves. */
function submitted(board, builder, title, route, number) {
  const id = store.addItem(board, {
    by: 'coordinator', lane: 'core', title, route,
    ...(route === 'mid' ? MID_ITEM_DETAILS : {}),
  });
  store.claim(board, id, { agentId: builder, lane: 'core', leaseMs: HOUR, freeze: FREEZE });
  const hash = String(number).repeat(40);
  store.submit(board, id, { agentId: builder, commit: hash, tree: hash });
  return id;
}

test('a reviewer gets the earliest milestone\'s submissions first [B16]', (t) => {
  const { board, builder, reviewer } = boardFixture();
  t.after(() => store.closeBoard(board));

  const laterStrong = submitted(board, builder, 'later milestone strong', 'strong', 1);
  const earliestMid = submitted(board, builder, 'earliest milestone mid', 'mid', 2);
  const unlistedStrong = submitted(board, builder, 'unlisted strong', 'strong', 3);
  store.addMilestone(board, { agentId: 'coordinator', name: '0.8.4', items: [earliestMid] });
  store.addMilestone(board, { agentId: 'coordinator', name: '0.8.5', items: [laterStrong] });

  const first = store.reserveNextReview(board, { agentId: reviewer, lane: 'review', leaseMs: HOUR, policy: 'any' });
  assert.equal(first.item.item_id, earliestMid, 'roadmap position precedes the stronger later release');

  store.release(board, earliestMid, reviewer, 'preserve the existing review cooldown');
  const second = store.reserveNextReview(board, { agentId: reviewer, lane: 'review', leaseMs: HOUR, policy: 'any' });
  assert.equal(second.item.item_id, laterStrong, 'the existing cooldown still skips the released review');

  const otherReviewer = store.register(board, { lane: 'review', path: '/reviewer-2', route: 'strong' });
  store.reserveReview(board, unlistedStrong, { agentId: otherReviewer, leaseMs: HOUR, policy: 'any' });
  const held = store.nextFor(board, { agentId: otherReviewer, lane: 'review', verify: true });
  assert.equal(held.item.item_id, unlistedStrong, 'a reviewer still resumes its own held review');

  const sameMilestoneStrong = submitted(board, builder, 'same milestone strong', 'strong', 4);
  store.editMilestoneItems(board, '0.8.4', { agentId: 'coordinator', add: [sameMilestoneStrong] });
  const thirdReviewer = store.register(board, { lane: 'review', path: '/reviewer-3', route: 'strong' });
  const newerStrong = submitted(board, builder, 'newer same milestone strong', 'strong', 5);
  store.editMilestoneItems(board, '0.8.4', { agentId: 'coordinator', add: [newerStrong] });
  const sameRelease = store.nextFor(board, { agentId: thirdReviewer, lane: 'review', verify: true });
  assert.equal(sameRelease.item.item_id, sameMilestoneStrong, 'route-tier then oldest order remains within one milestone');
});

test('a builder gets the earliest milestone\'s open items first [B16]', (t) => {
  const { board, builder } = boardFixture();
  t.after(() => store.closeBoard(board));

  const laterStrong = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'later milestone strong', route: 'strong' });
  const earliestMid = store.addItem(board, {
    by: 'coordinator', lane: 'core', title: 'earliest milestone mid', route: 'mid', ...MID_ITEM_DETAILS,
  });
  const unlistedStrong = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'unlisted strong', route: 'strong' });
  store.addMilestone(board, { agentId: 'coordinator', name: '0.8.4', items: [earliestMid] });
  store.addMilestone(board, { agentId: 'coordinator', name: '0.8.5', items: [laterStrong] });

  const first = store.nextFor(board, { agentId: builder, lane: 'core' });
  assert.equal(first.item.item_id, earliestMid, 'roadmap position precedes the stronger later release');

  const sameMilestoneStrong = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'same milestone strong', route: 'strong' });
  store.editMilestoneItems(board, '0.8.4', { agentId: 'coordinator', add: [sameMilestoneStrong] });
  const newerStrong = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'newer same milestone strong', route: 'strong' });
  store.editMilestoneItems(board, '0.8.4', { agentId: 'coordinator', add: [newerStrong] });
  const sameRelease = store.nextFor(board, { agentId: builder, lane: 'core' });
  assert.equal(sameRelease.item.item_id, sameMilestoneStrong, 'route-tier then oldest order remains within one milestone');

  store.claim(board, sameMilestoneStrong, { agentId: builder, lane: 'core', leaseMs: HOUR, freeze: FREEZE });
  const resumed = store.nextFor(board, { agentId: builder, lane: 'core' });
  assert.equal(resumed.item.item_id, sameMilestoneStrong, 'an existing held claim still resumes first');
  assert.notEqual(resumed.item.item_id, unlistedStrong);
});

test('recorded reserve-next moves retain their versioned ordering [B16,H16]', (t) => {
  assert.ok(ENGINE_VERSION >= 8, 'roadmap selection is carried by engine 8 or newer');
  for (const version of [1, 2, 3, 4, 5, 6, 7, ENGINE_VERSION]) {
    const { board, builder, reviewer } = boardFixture();
    t.after(() => store.closeBoard(board));
    const laterStrong = submitted(board, builder, 'later strong', 'strong', 1);
    const earliestMid = submitted(board, builder, 'earliest mid', 'mid', 2);
    store.addMilestone(board, { agentId: 'coordinator', name: 'first', items: [earliestMid] });
    store.addMilestone(board, { agentId: 'coordinator', name: 'later', items: [laterStrong] });
    const move = prepareEngineMove(board, 'reserveNextReview', [{ agentId: reviewer, lane: 'review', leaseMs: HOUR, policy: 'any' }]);
    assert.equal(move.engine, ENGINE_VERSION, 'new moves carry the current engine');
    const outcome = applyEngineMove(board, { ...move, engine: version }, { sequence: 1, at: new Date().toISOString() });
    assert.equal(outcome.error, undefined, JSON.stringify(outcome.error));
    assert.equal(outcome.result.item.item_id, version < 8 ? laterStrong : earliestMid, `engine ${version} retains its recorded selection`);
  }
});

/** Run the public CLI in one private session without letting a peer inherit its identity. */
function crossLaneFixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const session = 'cross-lane-owner-session';
  /** Each command gets its actual invoking session, and the surrounding fixture keeps none. */
  function runAs(identity, cwd, ...args) {
    const previous = { CLAUDECODE: box.env.CLAUDECODE, CLAUDE_CODE_SESSION_ID: box.env.CLAUDE_CODE_SESSION_ID };
    box.env.CLAUDECODE = '1';
    box.env.CLAUDE_CODE_SESSION_ID = identity;
    try { return box.run(cwd, ...args); }
    finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete box.env[name];
        else box.env[name] = value;
      }
    }
  }
  /** Demand real command success before interpreting its versioned result. */
  function json(result) {
    assert.equal(result.code, 0, `${result.out}\n${result.err}`);
    return JSON.parse(result.out);
  }
  /** An existing seat is joined by the actual owner session, rather than a test-only owner flag. */
  function seat(name, lane, identity, route = 'strong') {
    const root = join(box.dir, name);
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', root, 'main');
    return { ...json(runAs(identity, root, 'join', lane, '--route', route, '--model', 'Cross-lane test', '--json')), root };
  }
  /** Add an ordinary routed item through the coordinator CLI with its lane's approved row. */
  function add(lane, title, route = 'strong') {
    return json(box.run(box.repo, 'add', lane, title, '--specs', lane === 'api' ? 'G2' : 'G1', '--route', route,
      ...(route === 'strong' ? [] : ['--criterion', 'The item can be built and checked from its brief.', '--check', 'true',
        '--brief', `Files: ${lane}/page.js\nChange: build the fixture item\nTest: the check proves the fixture`]), '--json')).item.item_id;
  }
  /** Keep the test's queue order explicit without touching a production board. */
  function milestone(name, id) {
    json(box.run(box.repo, 'milestone', 'add', name, '--items', String(id), '--json'));
  }
  /** Read the local checkout binding only; a session digest must never become board metadata. */
  function binding(root) {
    return JSON.parse(readFileSync(join(resolve(root, box.git(root, 'rev-parse', '--git-dir')), 'pullboard-checkout-session.json'), 'utf8'));
  }
  return { ...box, session, runAs, json, seat, add, milestone, binding };
}

test('an agent pulls the top item in any of its lanes [N2,B13]', (t) => {
  const box = crossLaneFixture(t);
  const web = box.json(box.runAs(box.session, box.web, 'join', 'web', '--model', 'Cross-lane test', '--json'));
  const peer = box.seat('peer-api', 'api', 'unrelated-session');
  const peerBinding = box.binding(peer.root);
  const api = box.seat('owned-api', 'api', box.session);
  const later = box.add('web', 'Later web work');
  const first = box.add('api', 'Earlier API release');
  box.milestone('first', first);
  box.milestone('later', later);

  const next = box.json(box.runAs(box.session, box.web, 'next', '--build', '--json'));
  assert.equal(next.item.item_id, first, 'the earlier release in another lane precedes this seat’s later work');
  assert.equal(next.item.item_owner, api.agent, 'the claim belongs to the matching lane seat');
  assert.deepEqual(next.seat, { agent: api.agent, lane: 'api', path: api.root, created: false });
  assert.equal(next.review, false);
  assert.equal(next.held, false);
  assert.deepEqual(box.binding(peer.root), peerBinding, 'another session’s seat is never borrowed or rebound');
  const resumed = box.json(box.runAs(box.session, box.web, 'next', '--build', '--json'));
  assert.equal(resumed.item.item_id, first, 'next resumes the claim in its named seat rather than starting a second item');
  assert.equal(resumed.held, true);
  assert.equal(resumed.seat.agent, api.agent);
  const wrongLane = box.runAs(box.session, api.root, 'claim', String(later), '--json');
  assert.equal(wrongLane.code, 1);
  assert.equal(JSON.parse(wrongLane.out).error.code, 'WRONG_LANE', 'cross-lane routing does not widen a seat’s write authority');
  assert.notEqual(web.agent, api.agent);
});

test('next names the seat to open for a lane the agent lacks [N2,B13]', (t) => {
  const box = crossLaneFixture(t);
  const web = box.seat('owned-mid-web', 'web', box.session, 'mid');
  const peer = box.seat('peer-api', 'api', 'unrelated-session');
  const peerBinding = box.binding(peer.root);
  const tooStrong = box.add('api', 'A strong-only earlier release');
  const first = box.add('api', 'Available mid API work', 'mid');
  const later = box.add('web', 'Later mid web work', 'mid');
  box.milestone('strong-only', tooStrong);
  box.milestone('first-eligible', first);
  box.milestone('later', later);
  const before = box.git(box.repo, 'worktree', 'list', '--porcelain');

  const next = box.json(box.runAs(box.session, web.root, 'next', '--build', '--json'));
  assert.equal(next.item.item_id, first, 'the route still skips stronger work in an earlier milestone');
  assert.equal(next.seat.lane, 'api');
  assert.equal(next.seat.created, true);
  assert.equal(next.item.item_owner, next.seat.agent);
  assert.notEqual(next.seat.agent, peer.agent, 'a peer’s lane seat does not satisfy this session’s missing seat');
  assert.equal(existsSync(next.seat.path), true, 'next actually opens the named seat');
  assert.equal(before.includes(next.seat.path), false);
  assert.equal(box.git(next.seat.path, 'rev-parse', 'HEAD'), box.git(box.repo, 'rev-parse', 'HEAD'), 'the new seat starts on the current trunk');
  const who = box.json(box.runAs(box.session, next.seat.path, 'whoami', '--json'));
  assert.equal(who.id, next.seat.agent);
  assert.equal(who.lane, 'api');
  assert.equal(who.model, 'Cross-lane test');
  assert.equal(box.binding(next.seat.path).digest, createHash('sha256').update(JSON.stringify(['CLAUDE_CODE_SESSION_ID', box.session])).digest('hex'));
  assert.deepEqual(box.binding(peer.root), peerBinding);
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    assert.equal(store.getItem(board, tooStrong).item_status, 'open', 'the new mid seat never claims above its route');
    assert.equal(store.getItem(board, later).item_status, 'open');
  } finally { store.closeBoard(board); }
  assert.equal(readFileSync(join(box.repo, '.git', 'pullboard', 'board.sqlite')).includes(Buffer.from(box.session)), false, 'raw session ids stay out of shared SQLite');
});

test('next follows the rank the coordinator set inside a milestone [N2,B13]', (t) => {
  const box = crossLaneFixture(t);
  box.json(box.runAs(box.session, box.web, 'join', 'web', '--model', 'Rank test', '--json'));
  const api = box.seat('rank-owned-api', 'api', box.session);
  const peer = box.seat('rank-peer-api', 'api', 'rank-peer-session');
  const oldest = box.add('web', 'Oldest unranked strong work');
  const first = box.add('api', 'Ranked mid API work', 'mid');
  const second = box.add('web', 'Second ranked strong work');
  const later = box.add('api', 'Later release work');
  box.json(box.run(box.repo, 'milestone', 'add', 'current', '--items', `${oldest},${first},${second}`, '--json'));
  box.milestone('later', later);
  const ordered = box.runAs(box.session, box.web, 'milestone', 'order', 'current', `${first},${second}`, '--json');
  assert.equal(ordered.code, 0, `an agent can order the milestone through the real CLI\n${ordered.out}\n${ordered.err}`);
  const next = box.json(box.runAs(box.session, box.web, 'next', '--build', '--json'));
  assert.equal(next.item.item_id, first, 'explicit rank precedes route and age across the session’s lanes');
  assert.equal(next.item.item_owner, api.agent);
  box.json(box.runAs(box.session, api.root, 'release', String(first), '--json'));
  box.json(box.runAs('rank-peer-session', peer.root, 'claim', String(first), '--json'));
  const free = box.json(box.runAs(box.session, box.web, 'next', '--build', '--json'));
  assert.equal(free.item.item_id, second, 'an occupied higher rank leaves the next free rank available');
  const resumed = box.json(box.runAs(box.session, box.web, 'next', '--build', '--json'));
  assert.equal(resumed.item.item_id, second, 'the agent resumes its own claim before pulling another rank');
  assert.equal(resumed.held, true);
  const beginner = box.json(box.run(box.repo, 'help', '--json'));
  assert.doesNotMatch(JSON.stringify(beginner.overview ?? beginner), /milestone order|rank the queue/iu, 'newcomer help does not gain scheduling words');
});

test('an unranked item follows the ranked ones [N2,B13]', (t) => {
  const { board, builder } = boardFixture();
  t.after(() => store.closeBoard(board));
  const oldest = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Oldest ordinary item', route: 'strong' });
  const middle = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Middle ordinary item', route: 'strong' });
  const ranked = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Newest ranked item', route: 'strong' });
  store.addMilestone(board, { agentId: 'coordinator', name: 'release', items: [ranked, middle, oldest] });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, oldest, 'a never-ranked board retains its old oldest-first tie-break');
  store.orderMilestoneItems(board, 'release', { agentId: 'coordinator', items: [ranked] });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, ranked);
  const ordered = [oldest, middle, ranked].map(id => store.getItem(board, id)).sort(store.buildOrder(board));
  assert.deepEqual(ordered.map(item => item.item_id), [ranked, oldest, middle], 'unranked items retain age order after explicit ranks');
  store.editMilestoneItems(board, 'release', { agentId: 'coordinator', remove: [ranked] });
  store.editMilestoneItems(board, 'release', { agentId: 'coordinator', add: [ranked] });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, oldest, 'removing and readding an item does not retain a ghost rank');
});
