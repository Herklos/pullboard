/**
 * One coordinator per board, held by one main checkout at a time and passed by takeover [E19].
 *
 * On a linked board every main checkout's coordinator moves reach the relay under that checkout's own root
 * coordinator credential, whose lineage the relay authenticates. The board records the lineage that holds the
 * coordinator: the first coordinator move at this engine takes it, so a board coordinated from one checkout works
 * as before. A coordinator move from any other lineage is refused, naming the holder, until that checkout runs
 * pullboard takeover. An unlinked board's main checkout is already held by one session through its checkout
 * binding, so nothing here applies to it (#347).
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
/** Operations a non-holding main checkout may still send: seat creation and path upkeep stay per machine. */
const UNHELD_OPERATIONS = new Set(['register', 'ensureCoordinator', 'takeCoordinator']);

/**
 * A stored or received holder name, bounded and free of control characters.
 *
 * @param {unknown} label
 * @returns {string}
 */
export function holderLabel(label) {
  const text = typeof label === 'string' ? label.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').trim().slice(0, 80) : '';
  return text || 'another main checkout';
}

/**
 * The name a linked main checkout goes by in a hold: its computer, by the end of the machine id the relay gave it
 * when it was linked, as the device roster shows a computer. It carries no host name or path, since a hold is read
 * by every member of a team board.
 *
 * @param {unknown} machine the link's relay machine id
 * @returns {string}
 */
export function computerLabel(machine) {
  return typeof machine === 'string' && /^[A-Za-z0-9_.-]{1,128}$/u.test(machine) ? `computer ${machine.slice(-8)}` : 'another main checkout';
}

/**
 * Name the sending main checkout on a coordinator move, so a hold and its refusals say which checkout holds it.
 * The name travels sealed inside the move, so only the board's members read it.
 *
 * @param {any} move a prepared engine move
 * @param {unknown} machine the sending link's relay machine id
 * @returns {any} the same move
 */
export function stampCoordinatorHolder(move, machine) {
  if (credentialActor(move) === COORDINATOR) move.holder = computerLabel(machine);
  return move;
}

/**
 * The checkout that holds this board's coordinator, or null before any linked coordinator move at this engine.
 *
 * @param {any} board
 * @returns {{ lineage: string, label: string, at: string } | null}
 */
export function coordinatorHolder(board) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(HOLDER_KEY);
  if (!row) return null;
  try {
    const value = JSON.parse(row.meta_value);
    return typeof value?.lineage === 'string' ? { lineage: value.lineage, label: holderLabel(value.label), at: String(value.at ?? '') } : null;
  } catch { return null; }
}

/** Record a holder in the caller's transaction. */
function saveHolder(board, lineage, label, at) {
  board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value')
    .run(HOLDER_KEY, JSON.stringify({ lineage, label: holderLabel(label), at }));
}

/**
 * Admit one relay-ordered coordinator move from the main checkout with this lineage, or refuse it by name.
 * The first such move takes the hold, so a single coordinating checkout never sees a refusal.
 *
 * @param {any} board
 * @param {{ operation: string, engine: number, holder?: unknown }} move
 * @param {string | null | undefined} lineage the relay-authenticated root coordinator lineage of the sender
 * @param {string} at the relay receipt time
 */
export function requireCoordinatorHold(board, move, lineage, at) {
  if (!lineage || !(move.engine >= COORDINATOR_HOLD_ENGINE) || UNHELD_OPERATIONS.has(move.operation)) return;
  const holder = coordinatorHolder(board);
  if (!holder) { saveHolder(board, lineage, move.holder, at); return; }
  if (holder.lineage === lineage) return;
  throw new Refused('COORDINATOR_HELD',
    `this board's coordinator is held by ${holder.label}, so this main checkout cannot act as coordinator; to coordinate from here, run pullboard takeover in this main checkout`);
}

/**
 * Take this board's coordinator for the main checkout that sent the move, recording who held it before.
 * Only a relay-ordered move from a linked main checkout's own coordinator credential can take it.
 *
 * @param {any} board
 * @param {{ agentId: string, label: string }} options
 * @returns {{ holder: string, previous: string | null }}
 */
export function takeCoordinator(board, { agentId, label }) {
  if (agentId !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator takes over the coordinator; run pullboard takeover in the main checkout');
  const lineage = board.verifierStanding?.lineage;
  if (!lineage) {
    throw new Refused('COORDINATOR_TAKEOVER', 'a linked board passes its coordinator between main checkouts; run pullboard takeover in the main checkout of a board linked with pullboard relay on');
  }
  return atomic(board, () => {
    const previous = coordinatorHolder(board);
    const at = board.clock?.now?.().toISOString?.() ?? new Date().toISOString();
    saveHolder(board, lineage, label, at);
    const holder = holderLabel(label);
    logEvent(board, COORDINATOR, 'coordinator-takeover', null, { holder, previous: previous?.label ?? null, engine: COORDINATOR_HOLD_ENGINE });
    return { holder, previous: previous?.label ?? null };
  });
}
