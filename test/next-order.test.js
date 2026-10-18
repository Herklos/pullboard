/** Roadmap position leads next's existing route order only across unfinished milestones [B16]. */
import { submitFixture } from './board-submit-fixture.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { applyEngineMove, applyRelayMove, prepareEngineMove } from '../src/engine.js';
import { ENGINE_VERSION, MILESTONE_RANK_ENGINE } from '../src/machine.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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
  submitFixture(board, id, { agentId: builder, commit: hash, tree: hash });
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

test('next in the main checkout names the lane worktree to join [N2,B26]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.sandbox(), repo = join(box.dir, 'fresh-board');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  const model = box.env.PULLBOARD_MODEL;
  delete box.env.PULLBOARD_MODEL;
  assert.equal(box.run(repo, 'init').code, 0);
  if (model !== undefined) box.env.PULLBOARD_MODEL = model;
  assert.equal(box.run(repo, 'lane', 'add', 'app', '--owns', 'app/').code, 0);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up the fresh board');
  for (const title of ['First app item', 'Second app item']) {
    const added = box.run(repo, 'add', 'app', title, '--route', 'strong',
      '--criterion', 'The app item creates its readiness marker.', '--check', 'test -f app/ready', '--json');
    assert.equal(added.code, 0, `${added.out}\n${added.err}`);
  }
  const json = box.run(repo, 'next', '--json');
  assert.equal(json.code, 1, json.out);
  const refusal = JSON.parse(json.out).error;
  assert.equal(refusal.code, 'NOTHING_FREE', 'the empty coordinator queue keeps its refusal code');
  assert.match(refusal.message, /2 items open in lane app/u);
  assert.equal(refusal.next, 'pullboard worktree app --model "<model name>"');
  assert.doesNotMatch(refusal.message + refusal.next, /wait|keep looking/iu);
  for (const args of [[], ['--wait', '0.01']]) {
    const text = box.run(repo, 'next', ...args);
    assert.equal(text.code, 1);
    assert.match(text.err, /2 items open in lane app/u);
    assert.match(text.err, /pullboard worktree app --model "<model name>"/u);
    assert.doesNotMatch(text.err, /pullboard next --wait|keep looking/iu);
  }
  const opened = box.run(repo, 'worktree', 'app', '--model', 'Newcomer test', '--json');
  assert.equal(opened.code, 0, `${opened.out}\n${opened.err}`);
  const seat = JSON.parse(opened.out);
  const next = box.run(seat.path, 'next', '--build', '--json');
  assert.equal(next.code, 0, `${next.out}\n${next.err}`);
  assert.equal(JSON.parse(next.out).item.item_lane, 'app', 'the suggested command reaches work through the normal claim');
  const idle = helpers.project('true');
  const empty = JSON.parse(idle.run(idle.repo, 'next', '--json').out).error;
  assert.equal(empty.code, 'NOTHING_FREE');
  assert.match(empty.next, /pullboard next --wait 9/u, 'a genuinely idle board retains its ordinary wait');
});

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
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core', priority: [oldest] }).item.item_id, ranked, 'an automatic rework tie-break does not overtake an explicit coordinator rank');
  const replica = store.openBoard(':memory:');
  t.after(() => store.closeBoard(replica));
  importBoard(replica, exportBoard(board));
  assert.equal(store.nextFor(replica, { agentId: builder, lane: 'core' }).item.item_id, ranked, 'a board snapshot retains the explicit rank');
  const ordered = [oldest, middle, ranked].map(id => store.getItem(board, id)).sort(store.buildOrder(board));
  assert.deepEqual(ordered.map(item => item.item_id), [ranked, oldest, middle], 'unranked items retain age order after explicit ranks');
  store.editMilestoneItems(board, 'release', { agentId: 'coordinator', remove: [ranked] });
  store.editMilestoneItems(board, 'release', { agentId: 'coordinator', add: [ranked] });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, oldest, 'removing and readding an item does not retain a ghost rank');
});

test('milestone rank moves replay identically and preserve historical next selection [N2,B13,H16]', (t) => {
  assert.equal(MILESTONE_RANK_ENGINE, 34, 'milestone ranking retains its allocated minimum after later writer upgrades');
  for (const version of new Set([8, 24, 31, 32, 33, MILESTONE_RANK_ENGINE, ENGINE_VERSION])) {
    const source = boardFixture();
    const replica = store.openBoard(':memory:');
    const fixtures = [source, { ...source, board: replica }];
    t.after(() => fixtures.forEach(({ board }) => store.closeBoard(board)));
    for (const { board, builder } of [source]) {
      submitted(board, builder, 'oldest submitted work', 'strong', 1);
      submitted(board, builder, 'newer ranked work', 'strong', 2);
      store.addMilestone(board, { agentId: 'coordinator', name: 'release', items: [1, 2] });
    }
    importBoard(replica, exportBoard(source.board));
    const move = prepareEngineMove(fixtures[0].board, 'orderMilestoneItems', ['release', { agentId: fixtures[0].builder, items: [2, 1] }]);
    assert.equal(move.engine, ENGINE_VERSION, 'the envelope carries the current engine; milestone order starts at34');
    const outcomes = fixtures.map(({ board }) => applyRelayMove(board, move, {
      sequence: 1, at: '2026-10-18T01:00:00Z', kind: 'move', sender: { kind: 'agent', userId: 'fixture', agent: fixtures[0].builder },
    }));
    assert.equal(outcomes[0].error, undefined, JSON.stringify(outcomes[0]));
    assert.deepEqual(outcomes[0], outcomes[1]);
    assert.deepEqual(store.milestones(fixtures[0].board), store.milestones(fixtures[1].board));
    const reserve = prepareEngineMove(fixtures[0].board, 'reserveNextReview', [{ agentId: fixtures[0].reviewer, lane: 'review', leaseMs: HOUR, policy: 'any' }]);
    const results = fixtures.map(({ board }) => applyEngineMove(board, { ...reserve, engine: version }, { sequence: 2, at: '2026-10-18T01:01:00Z' }));
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0].result.item.item_id, version < MILESTONE_RANK_ENGINE ? 1 : 2, `engine${version} preserves its recorded selection`);
    assert.throws(() => applyEngineMove(fixtures[0].board, { ...move, id: 'old-order', engine: MILESTONE_RANK_ENGINE - 1 }, { sequence: 3, at: '2026-10-18T01:02:00Z' }), { code: 'RELAY_MOVE' });
    assert.equal(fixtures[0].board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='relay_applied_sequence'").get().meta_value, '2');
  }
});

test('milestone order refuses invalid membership and unauthenticated ranking [N2,B13,H16]', (t) => {
  const { board, builder } = boardFixture();
  t.after(() => store.closeBoard(board));
  const one = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Listed', route: 'strong' });
  const other = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Elsewhere', route: 'strong' });
  store.addMilestone(board, { agentId: 'coordinator', name: 'release', items: [one] });
  const original = JSON.stringify(store.milestones(board));
  for (const items of [[], [one, one], [other], ['missing#1']]) {
    assert.throws(() => store.orderMilestoneItems(board, 'release', { agentId: builder, items }), { code: 'MILESTONE_ITEMS' });
    assert.equal(JSON.stringify(store.milestones(board)), original);
  }
  for (const agentId of ['person', 'unknown-seat']) {
    assert.throws(() => store.orderMilestoneItems(board, 'release', { agentId, items: [one] }), { code: 'NO_AGENT' });
  }
  const forged = prepareEngineMove(board, 'orderMilestoneItems', ['release', { agentId: 'coordinator', items: [one] }]);
  const refusal = applyRelayMove(board, forged, { sequence: 1, at: '2026-10-18T01:00:00Z', kind: 'move', sender: { kind: 'agent', userId: 'fixture', agent: builder } });
  assert.equal(refusal.error.code, 'RELAY_SENDER_MISMATCH');
  assert.equal(JSON.stringify(store.milestones(board)), original);
});
