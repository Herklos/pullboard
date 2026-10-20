/** Relay text output stays separate from CLI dispatch and encrypted transport [H15,H17]. */
import { formatSnapshotLimit } from './relay.js';
import { relayStorageLine } from './relay-storage.js';

/** Preserve status's short relay summary, any pending-size finding and the authenticated account quota. */
export function briefLines(state) {
  const lines = [];
  if (state.linked) lines.push(`relay: sequence ${state.sequence}; ${state.behind} pending uploads${state.recovery?.pending ? `; recovery pending for sequence ${state.recovery.skip}; retry ${state.recovery.next}` : ''}`);
  if (state.oversizedSnapshot && !state.refusedCheckpoint) lines.push(formatSnapshotLimit(state.oversizedSnapshot));
  if (state.storage) lines.push(relayStorageLine(state.storage));
  return lines;
}

/** Preserve the named relay-status link and account lines, including recovery and deleted-copy guidance. */
export function detailLines(result, boardName) {
  const lines = [];
  lines.push(result.linked ? `${result.link}\nrelay: ${boardName} (board ${result.board}) is linked for GitHub ${result.login || `account ${result.account}`}; sequence ${result.sequence}; ${result.behind} pending uploads${result.recovery?.pending ? `; recovery pending for sequence ${result.recovery.skip}; retry ${result.recovery.next}` : ''}` : (result.notice || 'relay off; the local board is complete'));
  if (result.storage) lines.push(relayStorageLine(result.storage));
  return lines;
}
