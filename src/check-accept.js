/**
 * A check that already passes on main proves nothing, so a board that asks for it holds the item
 * until the person accepts that exact check [V2,V4,B26].
 */
import { createHash } from 'node:crypto';
import { PERSON, atomic, itemById, logEvent } from './board.js';
import { Refused } from './refused.js';

/** The engine that first replays a person's check acceptance; older engines refuse the move unread [H16]. */
export const CHECK_ACCEPT_ENGINE = 24;

/** The setting value that turns today's warning into a hold. */
export const PROVES_NOTHING_HOLD = 'hold';

/**
 * Digest one check's exact text. An acceptance names this digest, so it binds to the words the
 * person read and cannot carry over to a different check.
 *
 * @param {string} command
 * @returns {string}
 */
export function checkDigest(command) {
  return createHash('sha256').update(String(command)).digest('hex');
}

/**
 * Record the person's acceptance of an item's current check, as an ordered board move.
 * Only the person, from the terminal or the view, may make it; the digest must match the check
 * the item carries now, so an acceptance prepared for one check cannot land on another.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, channel: string, digest: string }} who
 * @returns {{ id: number, digest: string, check: string }}
 */
export function acceptCheck(board, id, { agentId, channel, digest }) {
  if (agentId !== PERSON) throw new Refused('CHECK_ACCEPT_PERSON_ONLY', 'only the person accepts a check that already passes on main; ask the coordinator to bring it to the person');
  if (!['terminal', 'view'].includes(channel)) throw new Refused('B26_PERSON_CHANNEL', 'a check acceptance uses the person’s terminal or view; run pullboard view');
  return atomic(board, () => {
    const item = itemById(board, id);
    if (!item.item_check) throw new Refused('NO_CHECK', `#${id} has no check command to accept; its proof is the project gate`);
    if (typeof digest !== 'string' || digest !== checkDigest(item.item_check)) {
      throw new Refused('CHECK_ACCEPT_STALE', `#${id}'s check changed since this acceptance was prepared; read the current check with pullboard show ${id} and accept it again`);
    }
    logEvent(board, PERSON, 'check_accept', id, { digest, channel });
    return { id, digest, check: item.item_check };
  });
}

/**
 * The person's live acceptance of the item's current check, or null.
 * It counts only when its digest names the current check text and no later edit set a
 * different check, so changing the check (even back to an old one) needs a new acceptance.
 *
 * @param {any} board
 * @param {any} item
 * @returns {{ event: number, digest: string } | null}
 */
export function checkAcceptance(board, item) {
  if (!item?.item_check) return null;
  const digest = checkDigest(item.item_check);
  const rows = board.db.prepare("SELECT event_id, event_by, event_kind, event_detail FROM event WHERE item_id = ? AND event_kind IN ('check_accept', 'edit') ORDER BY event_id").all(item.item_id);
  let accepted = null;
  for (const row of rows) {
    const detail = JSON.parse(row.event_detail);
    if (row.event_kind === 'check_accept' && row.event_by === PERSON && detail.digest === digest) accepted = { event: row.event_id, digest };
    else if (row.event_kind === 'edit' && Object.hasOwn(detail, 'check') && detail.check !== item.item_check) accepted = null;
  }
  return accepted;
}

/**
 * Refuse a claim or submit whose check already passes on main, when the board's
 * checks.provesNothing setting is "hold" and the person has not accepted that check.
 * With no setting the green baseline stays a warning, as on boards made before the setting.
 *
 * @param {() => any} mainConfig - reads accepted main's config, so a worktree's uncommitted edit cannot
 *   lift the hold; called only for a green, unaccepted check, so other claims never read main for it
 * @param {any} board
 * @param {any} item - as getItem returns it, with item_check_baseline
 */
export function refuseProvesNothing(mainConfig, board, item) {
  const base = item?.item_check_baseline;
  if (base?.result !== 'green' || base.command !== item.item_check || checkAcceptance(board, item)) return;
  if (mainConfig()?.checks?.provesNothing !== PROVES_NOTHING_HOLD) return;
  throw new Refused('CRITERION_PROVES_NOTHING',
    `#${item.item_id} is held: its check already passes on main ${String(base.main).slice(0, 12)}, so it proves nothing: ${base.command}`,
    `the coordinator sets a check that fails before the work (pullboard edit ${item.item_id} --check "<command>"), or the person accepts this one: pullboard check accept ${item.item_id}`);
}
