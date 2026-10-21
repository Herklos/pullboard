/**
 * The ordered outbox (#922): board moves made on an accepted relay link while the relay is unavailable, sealed on
 * this machine with the board as the relay last ordered it, until they replay in relay order.
 */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import {
  gunzipSync,
  gzipSync,
} from 'node:zlib';
import {
  seal,
  unseal,
} from './seal.js';
import { Refused } from './refused.js';

/** How many replay refusals the link keeps for pullboard status; older ones stay in the relay's own receipts. */
const KEPT_REFUSALS = 20;

/** The sealed outbox beside a link file. */
export function outboxFile(linkFile) {
  return join(dirname(linkFile), 'relay-outbox.sealed');
}

/** Whether a link holds moves the relay has not ordered yet, while the local board still shows them applied. */
export function outboxAhead(state) {
  return Boolean(state?.outbox?.moves?.length) && state.outbox.restored !== true;
}

/**
 * Read and open the sealed outbox, or null when there is none.
 * Why: the board image and the queued moves are as private as the relay's own sealed records, so they stay sealed at rest.
 */
export async function readOutbox(file, key, boardId) {
  if (!existsSync(file)) return null;
  const plain = await unseal(key, readFileSync(file), { boardId, kind: 'outbox', sequence: 0 });
  const document = JSON.parse(gunzipSync(plain).toString('utf8'));
  if (document?.version !== 1 || !Array.isArray(document.moves) || !document.base || !Number.isSafeInteger(document.baseSequence)) {
    throw new Refused('RELAY_OUTBOX', 'the relay outbox on this machine is unreadable; keep it, and ask for help before relinking this board');
  }
  return document;
}

/** Seal and atomically replace the outbox, readable only by this user. */
export async function writeOutbox(file, key, boardId, document) {
  const sealed = await seal(key, gzipSync(Buffer.from(JSON.stringify(document))), { boardId, kind: 'outbox', sequence: 0 });
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, Buffer.from(sealed), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

/** Remove the outbox once every move in it has been ordered. */
export function removeOutbox(file) {
  rmSync(file, { force: true });
}

/** The item a move acts on, when its first argument names one. */
function moveItem(move) {
  return Number.isSafeInteger(move?.args?.[0]) ? move.args[0] : null;
}

/** Name a move for people: its operation, its item and who made it. */
export function describeMove(move) {
  const item = moveItem(move);
  return `${move.operation}${item === null ? '' : ` #${item}`}${move.actor ? ` by ${move.actor}` : ''}`;
}

/** The key-free line pullboard status keeps for one queued move. */
export function outboxEntrySummary(entry) {
  return { id: entry.move.id, operation: entry.move.operation, item: moveItem(entry.move), actor: entry.move.actor ?? null, queuedAt: entry.queuedAt };
}

/**
 * The moves the relay ordered after a queued move was made and before it replayed, on the same item when any are,
 * so a refusal at replay names what came first.
 * Why: a refused replay that named only itself would leave the person to guess which other machine's move won.
 */
export function earlierMoves(board, entry, sequence) {
  const rows = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key LIKE 'relay_receipt_%'").all();
  const between = [];
  for (const { meta_value: value } of rows) {
    let receipt;
    try { receipt = JSON.parse(value); } catch { continue; }
    if (!(receipt.sequence > entry.after && receipt.sequence < sequence)) continue;
    let move;
    try { move = JSON.parse(receipt.move); } catch { continue; }
    if (move.id === entry.move.id) continue;
    between.push({ sequence: receipt.sequence, move });
  }
  const item = moveItem(entry.move);
  const same = item === null ? [] : between.filter(({ move }) => moveItem(move) === item);
  return (same.length ? same : between).sort((a, b) => a.sequence - b.sequence).slice(-3)
    .map(({ sequence: at, move }) => ({ sequence: at, move: describeMove(move) }));
}

/** Keep one replay refusal on the link for pullboard status, newest last, and return its line. */
export function keepRefusal(state, entry, refusal, earlier) {
  const kept = { move: describeMove(entry.move), queuedAt: entry.queuedAt, code: refusal.code, message: refusal.message, earlier };
  state.outboxRefusals = [...(state.outboxRefusals ?? []), kept].slice(-KEPT_REFUSALS);
  return refusalLine(kept);
}

/** Say what a refused replay was and which ordered moves came first. */
export function refusalLine(kept) {
  const first = kept.earlier.length
    ? `; moves the relay ordered first: ${kept.earlier.map(({ sequence, move }) => `sequence ${sequence} ${move}`).join(', ')}`
    : '; no other move reached the relay first';
  return `[RELAY_OUTBOX_REFUSED] the queued move ${kept.move} (made ${kept.queuedAt}) was refused when it replayed: [${kept.code}] ${kept.message}${first}`;
}
