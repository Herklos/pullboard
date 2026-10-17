/** Read the existing shared board projection with current unapplied person decisions [N26,A9]. */
import { join } from 'node:path';
import * as store from './board.js';
import { repoInfo } from './git.js';
import { projectRowDecisions } from './row-decisions.js';
import { pendingFit, projectFit } from './blueprint-fit.js';
import { projectState } from './serve.js';

/** Borrow an existing connection or open a read-only one; retain exact row-decision matching. */
export function personNeedsState(root, { board: providedBoard = null } = {}) {
  const info = repoInfo(root);
  const board = providedBoard ?? { db: store.openBoardReadOnly(join(info.commonDir, 'pullboard', 'board.sqlite')) };
  try {
    return projectFit(pendingFit(info.commonDir), projectRowDecisions(store.rowDecisions(board), projectState(root, { board })));
  } finally {
    if (!providedBoard) store.closeBoard(board);
  }
}
