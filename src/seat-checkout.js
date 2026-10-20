/**
 * A seat works in its own checkout (#898). One agent session can hold seats in several checkouts (B13), and a helper
 * can start in a checkout that has no seat at all. These refusals and lines keep each claim with the checkout that
 * will do the work: an unjoined checkout is pointed at its session's seats instead of borrowing one, and an item held
 * by this session's seat elsewhere is named with that seat and its path.
 */
import { agentSessionDigest } from './person.js';
import { localSessionSeats } from './agent-session.js';
import { Refused } from './refused.js';

/** Quote a path the way the CLI's other cd lines do. */
function cdTo(path) {
  return `cd '${path.replaceAll("'", "'\\''")}' &&`;
}

/** This session's seats in other checkouts of the board, by local binding only. */
function sessionSeats(info, agents) {
  const digest = agentSessionDigest();
  return digest ? localSessionSeats(info, { agents, digest }).filter((seat) => seat.agent_path !== info.root) : [];
}

/**
 * The refusal for a write from a checkout with no seat. When this session has seats elsewhere it names them and the
 * command to continue there, so the checkout never claims under another checkout's seat.
 *
 * @param {{ root: string, commonDir: string }} info
 * @param {any[]} agents
 */
export function unjoinedRefusal(info, agents) {
  const seats = sessionSeats(info, agents);
  const join = 'pullboard join <lane> --model "<model name>"';
  if (!seats.length) return new Refused('NOT_JOINED', `this worktree has not joined a lane; run ${join}`);
  const named = seats.map((seat) => `${seat.agent_id} (${seat.agent_lane} lane) in ${seat.agent_path}`).join('; ');
  return new Refused('NOT_JOINED', `this checkout has no seat, and your session's seats work in their own checkouts: ${named}`,
    `continue in that seat: ${cdTo(seats[0].agent_path)} pullboard next; or give this checkout its own seat: ${join}`);
}

/**
 * Refuse a check, submit or release in this checkout for an item one of this session's seats holds in another one.
 *
 * @param {{ root: string, commonDir: string }} info
 * @param {any[]} agents
 * @param {{ item_id: number, item_status: string, item_owner: string|null }} item
 * @param {string} command - The command to repeat in the holder's checkout.
 */
export function refuseHeldElsewhere(info, agents, item, command) {
  if (item.item_status !== 'claimed') return;
  const holder = sessionSeats(info, agents).find((seat) => seat.agent_id === item.item_owner);
  if (!holder) return;
  throw new Refused('NOT_YOURS', `#${item.item_id} is held by ${holder.agent_id} in ${holder.agent_path}, not by this checkout`,
    `${command} it from that seat's checkout: ${cdTo(holder.agent_path)} pullboard ${command} ${item.item_id}`);
}

/** The line that leads next's output when the claim belongs to a seat in another checkout. */
export function seatLeadLine(seat, item, held) {
  return `${seat.agent} (${seat.lane} lane) ${held ? 'holds' : 'now holds'} #${item.item_id} in ${seat.path}; continue there: ${cdTo(seat.path)} pullboard next`;
}
