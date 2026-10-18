/** Board-state fixtures supply the receipt required by modern submits [C7,V4]. */
import { submit } from '../src/board.js';

/** Record a synthetic board move without claiming that this fixture ran a gate. */
export function submitFixture(board, id, options) {
  return submit(board, id, {
    submissionProof: { version: 1, files: [], full: false, deferred: true,
      reason: 'synthetic board-state fixture; no gate execution' },
    ...options,
  });
}
