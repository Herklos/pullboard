/**
 * One coordinator per board, held by one main checkout at a time and passed by takeover [E19].
 *
 * On a linked board every main checkout's coordinator moves reach the relay under its own root coordinator
 * credential, and each move names the checkout's relay machine id. The board records which checkout holds the
 * coordinator: the first coordinator move at this engine takes it, so a board coordinated from one checkout works
 * as before, including after another person signs in there. A coordinator move from any other checkout is
 * refused, naming the holder, until that checkout runs pullboard takeover. A move that names no machine id is
 * told apart by its relay-authenticated credential lineage instead. An unlinked board's main checkout is already
 * held by one session through its checkout binding, so nothing here applies to it (#347).
 */
import {
  atomic,
  logEvent,
} from './board.js';
import { COORDINATOR } from './config.js';
import { COORDINATOR_HOLD_ENGINE } from './coordinator-hold-engine.js';
import { Refused } from './refused.js';
import { credentialActor } from './relay-sender.js';

export { COORDINATOR_HOLD_ENGINE };
const HOLDER_KEY = 'coordinator_holder';
const MACHINE = /^[A-Za-z0-9_.-]{1,128}$/u;
/** Operations a non-holding main checkout may still send: seat creation and path upkeep stay per machine. */
const UNHELD_OPERATIONS = new Set(['register', 'ensureCoordinator', 'takeCoordinator']);

/**
 * The name a linked main checkout goes by: its computer, by the end of the machine id the relay gave it when it
 * was linked, as the device roster shows a computer. It carries no host name or path, since every member of a
 * team board reads it.
 *
 * @param {unknown} machine the link's relay machine id
 * @returns {string}
 */
export function computerLabel(machine) {
  return typeof machine === 'string' && MACHINE.test(machine) ? `computer ${machine.slice(-8)}` : 'another main checkout';
}

/** The identity a hold compares: the checkout's machine id when the move names one, else the credential lineage. */
function holdKey(machine, lineage) {
  return typeof machine === 'string' && MACHINE.test(machine) ? `machine:${machine}` : `lineage:${lineage}`;
}

/**
 * Name the sending checkout on a coordinator move, by its relay machine id, so a hold follows the checkout.
 *
 * @param {any} move a prepared engine move
 * @param {unknown} machine the sending link's relay machine id
 * @returns {any} the same move
 */
export function stampCoordinatorHolder(move, machine) {
  if (credentialActor(move) === COORDINATOR && typeof machine === 'string' && MACHINE.test(machine)) move.holder = machine;
  return move;
}

/**
 * The checkout that holds this board's coordinator, or null before any linked coordinator move at this engine.
 *
 * @param {any} board
 * @returns {{ key: string, label: string, at: string } | null}
 */
export function coordinatorHolder(board) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(HOLDER_KEY);
  if (!row) return null;
  try {
    const value = JSON.parse(row.meta_value);
    return typeof value?.key === 'string' ? { key: value.key, label: String(value.label ?? 'another main checkout'), at: String(value.at ?? '') } : null;
  } catch { return null; }
}

/** Record a holder in the caller's transaction and return its name. */
function saveHolder(board, machine, lineage, at) {
  const label = computerLabel(machine);
  board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value')
    .run(HOLDER_KEY, JSON.stringify({ key: holdKey(machine, lineage), label, at }));
  return label;
}

/**
 * Admit one relay-ordered coordinator move from a linked main checkout, or refuse it by name. The first such move
 * takes the hold, so a single coordinating checkout never sees a refusal.
 *
 * @param {any} board
 * @param {{ operation: string, engine: number, holder?: unknown }} move
 * @param {string | null | undefined} lineage the relay-authenticated root coordinator lineage of the sender
 * @param {string} at the relay receipt time
 */
export function requireCoordinatorHold(board, move, lineage, at) {
  if (!lineage || !(move.engine >= COORDINATOR_HOLD_ENGINE) || UNHELD_OPERATIONS.has(move.operation)) return;
  const holder = coordinatorHolder(board);
  if (!holder) { saveHolder(board, move.holder, lineage, at); return; }
  if (holder.key === holdKey(move.holder, lineage)) return;
  throw new Refused('COORDINATOR_HELD',
    `this board's coordinator is held by ${holder.label}, so this main checkout cannot act as coordinator; to coordinate from here, run pullboard takeover in this main checkout`);
}

/**
 * Take this board's coordinator for the linked main checkout that sent the move, recording who held it before.
 * Only a relay-ordered move under a linked main checkout's own coordinator credential can take it.
 *
 * @param {any} board
 * @param {{ agentId: string, machine?: string }} options
 * @returns {{ holder: string, previous: string | null }}
 */
export function takeCoordinator(board, { agentId, machine }) {
  if (agentId !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator takes over the coordinator; run pullboard takeover in the main checkout');
  const lineage = board.verifierStanding?.lineage;
  if (!lineage) {
    throw new Refused('COORDINATOR_TAKEOVER', 'a linked board passes its coordinator between main checkouts; run pullboard takeover in the main checkout of a board linked with pullboard relay on');
  }
  return atomic(board, () => {
    const previous = coordinatorHolder(board);
    const at = board.clock?.now?.().toISOString?.() ?? new Date().toISOString();
    const holder = saveHolder(board, machine, lineage, at);
    logEvent(board, COORDINATOR, 'coordinator-takeover', null, { holder, previous: previous?.label ?? null, engine: COORDINATOR_HOLD_ENGINE });
    return { holder, previous: previous?.label ?? null };
  });
}
