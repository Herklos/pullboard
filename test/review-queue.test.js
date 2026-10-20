/** A review offer accounts for backlog, live reservations and reviewer eligibility [Q1,V15]. */
import { submitFixture } from './board-submit-fixture.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from './e2e-helpers.js';

const HOUR = 60 * 60 * 1000;
const REVIEW_LEASE = 1_000;

/** Create an in-memory board with deterministic agent routes, families and a controllable clock. */
function fixture(t) {
  let milliseconds = Date.parse('2026-10-08T12:00:00.000Z');
  const clock = {
    now: () => new Date(milliseconds),
    advance: (duration) => { milliseconds += duration; },
  };
  const board = store.openBoard(':memory:', clock);
  t.after(() => store.closeBoard(board));
  const agents = {
    coordinator: store.register(board, { lane: 'coordinator', path: '/fixture/main' }),
    alphaBuilder: store.register(board, { lane: 'web', path: '/fixture/web-alpha', route: 'strong', family: 'Alpha' }),
    betaBuilder: store.register(board, { lane: 'web', path: '/fixture/web-beta', route: 'strong', family: 'Beta' }),
    lightBuilder: store.register(board, { lane: 'web', path: '/fixture/web-light', route: 'light', family: 'Gamma' }),
    alphaReviewer: store.register(board, { lane: 'review', path: '/fixture/review-alpha', route: 'strong', family: 'Alpha' }),
    betaReviewer: store.register(board, { lane: 'review', path: '/fixture/review-beta', route: 'strong', family: 'Beta' }),
    lightReviewer: store.register(board, { lane: 'review', path: '/fixture/review-light', route: 'light', family: 'Gamma' }),
  };
  return { board, clock, agents };
}

/** Freeze the fixture title and digest, as a CLI claim callback does for a submitted item. */
function freeze(item) {
  const text = JSON.stringify({ title: item.item_title });
  return { text, digest: createHash('sha256').update(text).digest('hex') };
}

/** Create and claim a submitted item with deterministic Git pins and a real board event history. */
function submitted(board, { builder, lane = 'web', route = 'strong', title }) {
  const id = store.addItem(board, { by: 'coordinator', lane, title, route, criterion: `Complete ${title}.` });
  store.claim(board, id, { agentId: builder, lane, leaseMs: HOUR, freeze });
  const commit = createHash('sha1').update(`commit:${title}`).digest('hex');
  const tree = createHash('sha1').update(`tree:${title}`).digest('hex');
  submitFixture(board, id, { agentId: builder, commit, tree });
  return id;
}

/** Make one live review reservation through the same store operation used by the CLI. */
function reserve(board, item, agentId, leaseMs = REVIEW_LEASE) {
  return store.reserveReview(board, item, { agentId, leaseMs, policy: 'any' });
}

test('[Q1,V15] an empty queue is zeroed and exactly three waiting items produce an offer over build work', (t) => {
  const { board, agents } = fixture(t);
  assert.deepEqual(store.reviewQueue(board), {
    pending: 0, reviewing: 0, reserved: 0, oldestSubmittedAt: null, ageMs: 0,
  });

  const open = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Available build' });
  const ids = [
    submitted(board, { builder: agents.alphaBuilder, title: 'Waiting one' }),
    submitted(board, { builder: agents.betaBuilder, title: 'Waiting two' }),
    submitted(board, { builder: agents.alphaBuilder, title: 'Waiting three' }),
  ];
  const offer = store.reviewOffer(board, { agentId: agents.betaReviewer, lane: 'review', policy: 'any', ratio: 3 });
  assert.ok(offer, 'the queue meets the three-to-one threshold even while build work is open');
  assert.ok(ids.includes(offer.item.item_id));
  assert.deepEqual(offer.queue, store.reviewQueue(board));
  assert.equal(offer.queue.pending, 3);
  assert.equal(offer.queue.reviewing, 0);
  assert.equal(offer.ratio, 3);
  assert.equal(store.getItem(board, open).item_status, 'open', 'offering review does not claim or close build work');
});

test('[Q1,V15] a short queue and a reviewer who built every submitted item receive no offer', (t) => {
  const { board, agents } = fixture(t);
  submitted(board, { builder: agents.alphaBuilder, title: 'First waiting item' });
  submitted(board, { builder: agents.betaBuilder, title: 'Second waiting item' });
  assert.equal(store.reviewOffer(board, { agentId: agents.alphaReviewer, lane: 'review', policy: 'any', ratio: 3 }), null,
    'two pending reviews are below ratio three with no active reviewers');

  const own = fixture(t);
  const onlyMine = submitted(own.board, { builder: own.agents.betaReviewer, lane: 'review', title: 'Reviewer own item' });
  const ownOffer = store.reviewOffer(own.board, { agentId: own.agents.betaReviewer, lane: 'review', policy: 'any', ratio: 1 });
  assert.equal(ownOffer, null, 'meeting the threshold cannot make a reviewer review its own submission');
  assert.equal(store.getItem(own.board, onlyMine).item_built_by, own.agents.betaReviewer);
});

test('[Q1,V15] live reservations count distinct agents; renewal leaves submitted age anchored to submit events', (t) => {
  const { board, clock, agents } = fixture(t);
  const first = submitted(board, { builder: agents.alphaBuilder, title: 'Oldest item' });
  const firstSubmittedAt = store.events(board, { itemId: first }).filter((event) => event.event_kind === 'submit').at(-1).event_at;
  clock.advance(10_000);
  const second = submitted(board, { builder: agents.betaBuilder, title: 'Second item' });
  clock.advance(10_000);
  const third = submitted(board, { builder: agents.alphaBuilder, title: 'Third item' });

  reserve(board, first, agents.alphaReviewer);
  reserve(board, second, agents.alphaReviewer);
  clock.advance(250);
  reserve(board, first, agents.alphaReviewer);
  reserve(board, third, agents.alphaReviewer);
  let queue = store.reviewQueue(board);
  assert.deepEqual([queue.pending, queue.reviewing, queue.reserved], [3, 1, 3]);
  assert.equal(queue.oldestSubmittedAt, firstSubmittedAt);
  assert.equal(queue.ageMs, clock.now().getTime() - Date.parse(firstSubmittedAt), 'renewing a reservation never resets submit age');

  clock.advance(REVIEW_LEASE + 1);
  queue = store.reviewQueue(board);
  assert.deepEqual([queue.pending, queue.reviewing, queue.reserved], [3, 0, 0], 'expired reviewers and item holds leave the live queue counts');
  assert.equal(queue.oldestSubmittedAt, firstSubmittedAt);
  assert.equal(queue.ageMs, clock.now().getTime() - Date.parse(firstSubmittedAt));

  reserve(board, second, agents.betaReviewer);
  queue = store.reviewQueue(board);
  assert.deepEqual([queue.reviewing, queue.reserved], [1, 1], 'a new live reservation counts its distinct reviewer and held item');
  assert.equal(queue.oldestSubmittedAt, firstSubmittedAt, 'the new reservation still does not reset submit age');
});

test('[Q1,V15,O2,B13] policy, family and route rules still decide which reviewer can take an offer', (t) => {
  const { board, agents } = fixture(t);
  submitted(board, { builder: agents.alphaBuilder, title: 'Strong Alpha item', route: 'strong' });

  assert.equal(store.reviewOffer(board, {
    agentId: agents.betaReviewer, lane: 'review', policy: 'coordinator', ratio: 1,
  }), null, 'coordinator policy excludes lane reviewers');
  const coordinatorOffer = store.reviewOffer(board, {
    agentId: agents.coordinator, lane: 'coordinator', policy: 'coordinator', ratio: 1,
  });
  assert.ok(coordinatorOffer, 'the coordinator can take its policy-required review');

  assert.equal(store.reviewOffer(board, {
    agentId: agents.alphaReviewer, lane: 'review', policy: 'any', familyPolicy: 'require', ratio: 1,
  }), null, 'family=require excludes the builder family');
  const otherFamily = store.reviewOffer(board, {
    agentId: agents.betaReviewer, lane: 'review', policy: 'any', familyPolicy: 'require', ratio: 1,
  });
  assert.ok(otherFamily, 'a different declared family can review');

  assert.equal(store.reviewOffer(board, {
    agentId: agents.lightReviewer, lane: 'review', policy: 'any', ratio: 1,
  }), null, 'a light reviewer cannot take a strong item');
});

/**
 * A real board where web-1 submits #1, then main changes the same file (#807). A second seat in the api lane
 * reviews, so the builder never verifies its own work. Returns the box and helpers.
 */
function staleHeadFixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  /** Demand real command success and its versioned result. */
  const json = (result) => { assert.equal(result.code, 0, result.out + result.err); return JSON.parse(result.out); };
  /** Add, claim, build and submit one web item from a web seat's worktree. */
  const build = (title, path, text, seat = box.web) => {
    const id = json(box.run(box.repo, 'add', 'web', title, '--criterion', `${path} exists`, '--json')).item.item_id;
    json(box.run(seat, 'claim', String(id), '--json'));
    mkdirSync(join(seat, 'web'), { recursive: true });
    writeFileSync(join(seat, path), text);
    box.git(seat, 'add', path);
    box.git(seat, 'commit', '-q', '-m', `feat(web): ${title.toLowerCase()} [G1]`);
    json(box.run(seat, 'submit', String(id), '--json'));
    return id;
  };
  const conflicted = build('Show the list', 'web/list.html', '<ul>from the branch</ul>\n');
  // The trunk moves: the same file lands on main with other lines.
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/list.html'), '<ol>from main</ol>\n');
  box.git(box.repo, 'add', 'web/list.html');
  box.git(box.repo, 'commit', '-q', '-m', 'feat(web): main lands its own list [G1]');
  const reviewer = join(box.dir, 'api-1');
  box.git(box.repo, 'worktree', 'add', '-q', reviewer, '-b', 'api/review');
  json(box.run(reviewer, 'join', 'api', '--json'));
  return { box, json, build, conflicted, reviewer };
}

test('a submitted head that no longer merges is returned to its builder [C7,V4]', (t) => {
  const { box, json, conflicted, reviewer } = staleHeadFixture(t);
  assert.equal(json(box.run(box.repo, 'show', String(conflicted), '--json')).item_status, 'submitted', 'the head waits for review before the trunk check');
  const next = box.run(reviewer, 'next', '--verify', '--json');
  assert.match(next.err, new RegExp(`returned #${conflicted} to its builder unreviewed: it no longer merges onto the trunk \\(web/list\\.html\\)`, 'u'), next.out + next.err);
  const item = json(box.run(box.repo, 'show', String(conflicted), '--json'));
  assert.equal(item.item_status, 'open', 'the head that no longer merges goes back, unreviewed');
  assert.equal(item.item_review_by, null, 'no reviewer holds it');
  assert.equal(item.item_verdict, null, 'returning it is not a reject');
  const reopen = item.thread.findLast((entry) => entry.type === 'move' && entry.kind === 'reopen');
  assert.ok(reopen, 'the return is a recorded reopen');
  const inbox = box.run(box.web, 'inbox').out;
  assert.match(inbox, new RegExp(`#${conflicted} went back to you unreviewed: .* no longer merges onto the trunk at [0-9a-f]{12} \\(web/list\\.html\\)\\. Claim it, merge main, resolve that file and submit again: pullboard claim ${conflicted}`, 'u'),
    'the builder is told the conflicting file and the one step back');
  json(box.run(box.web, 'claim', String(conflicted), '--json'));
});

test('next --verify skips a head that does not merge [C7,V4]', (t) => {
  const { box, json, build, conflicted, reviewer } = staleHeadFixture(t);
  // A second web seat on a fresh branch from main builds work that merges cleanly.
  const second = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', second, '-b', 'web/two', 'main');
  json(box.run(second, 'join', 'web', '--json'));
  const clean = build('Show the footer', 'web/footer.html', '<footer>clean</footer>\n', second);
  const next = json(box.run(reviewer, 'next', '--verify', '--json'));
  assert.equal(next.item.item_id, clean, 'the reviewer gets the head that merges, though the conflicting one is older');
  assert.equal(json(box.run(box.repo, 'show', String(conflicted), '--json')).item_status, 'open');
  assert.equal(json(box.run(box.repo, 'show', String(clean), '--json')).item_review_by !== null, true, 'the clean head is reserved for review');
});
