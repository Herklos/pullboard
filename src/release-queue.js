/** Capture one board's release priority before joining the machine resource transaction [C7,V4]. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  boardId,
  openBoardReadOnly,
  roadmap,
} from './board.js';
import { repoInfo } from './git.js';

/**
 * Capture the item's roadmap rank once, without opening or migrating a board for writing.
 * The first unfinished local milestone is current; later milestones follow, then completed earlier
 * milestones, then unplanned work. External references are neither counted nor opened. Board identity joins worktrees and local relay replicas of
 * the same board. A checkout with no board has no release identity and keeps its queue position.
 * Why outside resources.js: remote workers ship only its small trusted runtime, not the board.
 *
 * @param {string} root - The gate caller's checkout.
 * @param {string|number} item - The local item id, or empty for an unplanned run.
 * @returns {{ board: string, rank: number }|undefined}
 */
export function captureReleaseQueue(root, item) {
  let info;
  try { info = repoInfo(root); } catch { return undefined; }
  const file = join(info.commonDir, 'pullboard', 'board.sqlite');
  if (!existsSync(file)) return undefined;
  const db = openBoardReadOnly(file);
  try {
    const board = { db, clock: { now: () => new Date() } };
    return { board: boardId(board), rank: localReleaseRank(roadmap(board), item) };
  } finally { db.close(); }
}

/**
 * Rank local work using the board's own verified-item completion. A repo-qualified reference
 * cannot pin this board to an old milestone: its state belongs to another board and is not read.
 *
 * @param {{ items: { id: number|string, status: string }[] }[]} releases - Public roadmap projection.
 * @param {string|number} item - The local item id.
 * @returns {number} Current, later, completed earlier, then unplanned.
 */
export function localReleaseRank(releases, item) {
  const local = releases.map(release => release.items.filter(entry => typeof entry.id === 'number'));
  const first = local.findIndex(items => items.some(entry => entry.status !== 'verified'));
  const current = first < 0 ? 0 : first;
  const ranks = local.flatMap((items, index) => items.some(entry => String(entry.id) === String(item))
    ? [index >= current ? index - current : releases.length + index] : []);
  return ranks.length ? Math.min(...ranks) : Number.MAX_SAFE_INTEGER;
}
