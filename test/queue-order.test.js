/** Local release completion and deterministic ordering boundaries [C7,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localReleaseRank } from '../src/release-queue.js';
import { orderedWaiters } from '../src/queue-order.js';

test('release priority uses only local verified work, leaving external references alone [C7,V4]', () => {
  const releases = [
    { items: [{ id: 'elsewhere#1', status: 'unavailable' }, { id: 1, status: 'verified' }] },
    { items: [{ id: 2, status: 'claimed' }] },
    { items: [{ id: 3, status: 'open' }] },
  ];
  assert.deepEqual([1, 2, 3, 4].sort((a, b) => localReleaseRank(releases, a) - localReleaseRank(releases, b)), [2, 3, 1, 4],
    'an unknown external reference cannot make completed local work outrank the current release');
  const localOnly = releases.map(release => ({ items: release.items.filter(entry => typeof entry.id === 'number') }));
  assert.deepEqual([1, 2, 3, 4].map(id => localReleaseRank(releases, id)), [1, 2, 3, 4].map(id => localReleaseRank(localOnly, id)));
});

test('release ordering preserves opportunity positions and already aged arrivals [C7,V4]', () => {
  const now = Date.UTC(2026, 9, 17, 2);
  const order = { reviewsFirst: false, currentReleaseFirst: true, ageMs: 60_000 };
  /** Build one otherwise-tied waiter with a captured board rank and controlled age. */
  const row = (ticket, board, rank, waited = 0) => ({ ticket, board_key: board, release_rank: rank, release_aware: 1, since: new Date(now - waited).toISOString() });
  const line = [row(1, 'A', 2), row(2, 'B', 0), row(3, 'A', 0)];
  const ordered = orderedWaiters(line, now, order);
  assert.deepEqual(ordered.map(entry => entry.ticket), [3, 2, 1]);
  assert.deepEqual(ordered.map(entry => entry.queue_ticket ?? entry.ticket), [1, 2, 3]);
  const remaining = ordered.filter(entry => entry.ticket !== 3);
  assert.deepEqual(orderedWaiters(remaining, now, order).map(entry => entry.ticket), [2, 1], 'consumed opportunities cannot be reused');
  assert.deepEqual(orderedWaiters([row(1, 'A', 2, 61_000), row(2, 'A', 0)], now, order).map(entry => entry.ticket), [1, 2],
    'release-only admission also protects an aged unplanned run');
});
