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
import * as store from './board.js';
import {
  engineReceipt,
  executableArgs,
  prepareEngineMove,
} from './engine.js';
import {
  exportBoard,
  restoreRelaySnapshot,
} from './exchange.js';
import { readBoardKey } from './relay-key.js';
import { transientRelayFailure } from './relay-move-fallback.js';
import {
  actorTransport,
  seatReceipt,
  withSeatName,
} from './relay-seats.js';
import {
  credentialActor,
  operationIntent,
  relayMoveActor,
} from './relay-sender.js';
import {
  seal,
  unseal,
} from './seal.js';
import { Refused } from './refused.js';

/** How many replay refusals the link keeps for pullboard status; older ones stay in the relay's own receipts. */
const KEPT_REFUSALS = 20;

/** Commands that already said their move waits in the outbox, so a command says it once. */
const OUTBOX_NOTICES = new WeakSet();

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

/** Moves whose first argument is an item number; a decision's answer names a shout instead. */
const ITEM_MOVES = new Set(['claim', 'release', 'submit', 'verify', 'reopen', 'refreeze', 'merged', 'withdraw', 'editItem', 'holdItem', 'releaseItemHold', 'escalate', 'appendFact']);

/**
 * Rewrite the item numbers a queued move names through `remap` (first local number to the number it has now), and
 * list any it names whose add was refused at replay.
 * Why: another machine may add an item while this one is offline, so an item added here can get another number from
 * the relay; a later queued move must follow it rather than act on the other machine's item (#922).
 */
export function remapMove(move, remap, lost) {
  const next = structuredClone(move);
  const touched = [];
  const follow = (id) => {
    if (!Number.isSafeInteger(id)) return id;
    if (lost.includes(id)) touched.push(id);
    return Object.hasOwn(remap, id) ? remap[id] : id;
  };
  if (ITEM_MOVES.has(next.operation)) next.args[0] = follow(next.args[0]);
  const options = next.operation === 'addItem' ? next.args[0] : next.operation === 'editItem' ? next.args[1] : null;
  if (options && typeof options === 'object') {
    if (options.parentId !== undefined) options.parentId = follow(options.parentId);
    if (Array.isArray(options.after)) options.after = options.after.map(follow);
  }
  return { move: next, lost: touched };
}

/** Record that the item first added here as `was` is now `is`; true when its number changed. */
function followItem(remap, was, is) {
  if (!Number.isSafeInteger(is) || is === was) { delete remap[was]; return false; }
  remap[was] = is;
  return true;
}

/** Drop the replayed move from the outbox and save what is left. */
async function finishEntry(link, outbox, where, key) {
  outbox.moves.shift();
  if (outbox.moves.length) await writeOutbox(where, key, link.state.board, outbox);
  else removeOutbox(where);
  saveOutboxSummary(link, outbox);
}

/** The queued moves and replay refusals pullboard status shows, when there are any. */
export function outboxFields(state) {
  return { ...(state?.outbox?.moves?.length ? { outbox: structuredClone(state.outbox.moves) } : {}),
    ...(state?.outboxRefusals?.length ? { outboxRefusals: structuredClone(state.outboxRefusals) } : {}),
    ...(state?.outboxRenumbered?.length ? { outboxRenumbered: structuredClone(state.outboxRenumbered) } : {}) };
}

/** Whether this command may queue a move in the ordered outbox: the board's relay.outbox setting, off by default (#922). */
function outboxEnabled(io) {
  try { return io?.relayOutbox?.() === true; } catch { return false; }
}

/**
 * Whether a failure on an accepted link may queue the move instead of refusing it (#922): the relay said nothing
 * definite, and the move needs no relay answer to exist (a registration mints its token there; a person's request
 * is the phone's to send).
 */
export function outboxQueueable(state, error, operation, io) {
  return state.mode === 'ordered' && state.baselineAccepted === true && !state.baselineConflict && !io?.personRequest
    && !['register', 'ensureCoordinator'].includes(operation) && transientRelayFailure(error) && outboxEnabled(io);
}

/** The board's relay-applied sequence, read from an exported image. */
function exportedSequence(native) {
  return Number(native.tables.board_meta.find((row) => row.meta_key === 'relay_applied_sequence')?.meta_value ?? 0);
}

/** Keep the key-free outbox summary on the link, or drop it once the outbox is empty. */
function saveOutboxSummary({ file, state, saveLink }, outbox) {
  if (outbox?.moves.length) state.outbox = { restored: outbox.restored, moves: outbox.moves.map(outboxEntrySummary) };
  else delete state.outbox;
  saveLink(file, state);
}

/**
 * Queue a move the relay could not take on an accepted link, then make it on this machine (#922).
 * The first queued move seals the board as the relay last ordered it; the move is written before it is applied,
 * so a crash between the two leaves it queued and the replay starts from that image anyway. A move this board
 * refuses is refused now and never queued.
 */
export async function queueMove(link, { operation, args, command, move, error, applyLocally }) {
  const { root, file, state, io, localRecords, safePauseCode, safePauseMessage } = link;
  const key = readBoardKey(state.board);
  const where = outboxFile(file);
  const outbox = await readOutbox(where, key, state.board) ?? (() => {
    const base = localRecords(root, (board) => exportBoard(board));
    return { version: 1, base, baseSequence: exportedSequence(base), restored: false, moves: [] };
  })();
  if (!move) {
    const sent = withSeatName(root, operation, args);
    move = localRecords(root, (board) => prepareEngineMove(board, operation, sent));
    move.actor = relayMoveActor(move) ?? credentialActor(move);
  }
  // `after` is the relay sequence this machine had seen: a refusal at replay names the moves ordered since.
  const entry = { move, intent: operationIntent(operation, args), queuedAt: new Date().toISOString(), after: state.sequence,
    ...(command ? { command, commandIntent: operationIntent('cli:' + command.cliOperation, command) } : {}) };
  outbox.moves.push(entry);
  await writeOutbox(where, key, state.board, outbox);
  if (state.pending?.move?.id === move.id) delete state.pending;
  saveOutboxSummary(link, outbox);
  let result;
  try { result = await applyLocally(); }
  catch (refusal) {
    outbox.moves.pop();
    if (outbox.moves.length) await writeOutbox(where, key, state.board, outbox);
    else removeOutbox(where);
    saveOutboxSummary(link, outbox);
    throw refusal;
  }
  if (move.operation === 'addItem' && Number.isSafeInteger(result)) {
    entry.localItem = result;
    await writeOutbox(where, key, state.board, outbox);
  }
  if (!OUTBOX_NOTICES.has(io)) {
    OUTBOX_NOTICES.add(io);
    io.err(`pullboard: [${safePauseCode(error)}] ${error.transportFailure ? `the relay did not answer (${error.transportFailure})` : safePauseMessage(error)}; the move is saved on this machine and waits in the relay outbox (${outbox.moves.length} pending); it goes up in order when the relay answers, and pullboard status lists it`);
  }
  return result;
}

/**
 * Put the queued moves back on top of the board after a replay stopped part way (#922): seal the board as the relay
 * has now ordered it, then apply each remaining move here again, so this machine keeps showing them.
 */
async function rebaseOutbox(link, outbox, key) {
  const { root, file, state, localRecords } = link;
  outbox.base = localRecords(root, (board) => exportBoard(board));
  outbox.baseSequence = exportedSequence(outbox.base);
  outbox.restored = false;
  await writeOutbox(outboxFile(file), key, state.board, outbox);
  saveOutboxSummary(link, outbox);
  const remap = outbox.remap ??= {};
  for (const entry of outbox.moves) {
    const { move } = remapMove(entry.original ?? entry.move, remap, outbox.lost ?? []);
    const result = localRecords(root, (board) => {
      try { return store.atomic(board, () => store[move.operation](board, ...executableArgs(move, board))); }
      catch (error) { if (!(error instanceof Refused)) throw error; return null; }
    });
    // A re-applied add may get another number here; later queued moves name it by its first local number.
    if (Number.isSafeInteger(entry.localItem) && Number.isSafeInteger(result)) followItem(remap, entry.localItem, result);
  }
  await writeOutbox(outboxFile(file), key, state.board, outbox);
}

/**
 * Replay the ordered outbox before this machine applies or sends anything else (#922). The board goes back to the
 * image the relay last ordered, catches up with every other machine's moves, then sends each queued move in order:
 * a move the relay already holds from a lost reply is not sent twice, and a move refused at replay is reported with
 * the moves ordered before it. A relay that fails again part way puts the rest back on top and throws its failure.
 */
export async function flushOutbox(link) {
  const { root, file, state, io, request, catchUp, sendPending, sealedRecord, localRecords, saveLink } = link;
  const where = outboxFile(file);
  if (!state.outbox && !existsSync(where)) return;
  const key = readBoardKey(state.board);
  const outbox = await readOutbox(where, key, state.board);
  if (!outbox?.moves.length) {
    removeOutbox(where);
    saveOutboxSummary(link, null);
    return;
  }
  try {
    if (!outbox.restored) {
      // Probe first: a relay that is still down leaves this machine's board exactly as its person last saw it.
      try { await request(state, '/api/v1/boards/' + state.board + '/events?after=' + outbox.baseSequence, {}, io); }
      catch (error) { if (error.code !== 'SNAPSHOT_REQUIRED') throw error; }
      localRecords(root, (board) => {
        const cursors = board.db.prepare('SELECT agent_id, agent_last_shout_id FROM agent').all();
        restoreRelaySnapshot(board, outbox.base, outbox.baseSequence);
        // Reading shouts is this machine's own progress; the restore keeps the newer read position.
        const keep = board.db.prepare('UPDATE agent SET agent_last_shout_id = ? WHERE agent_id = ? AND (agent_last_shout_id IS NULL OR agent_last_shout_id < ?)');
        for (const row of cursors) if (Number.isSafeInteger(row.agent_last_shout_id)) keep.run(row.agent_last_shout_id, row.agent_id, row.agent_last_shout_id);
      });
      state.sequence = outbox.baseSequence;
      outbox.restored = true;
      await writeOutbox(where, key, state.board, outbox);
      saveOutboxSummary(link, outbox);
    }
    await catchUp(root, file, state, io);
    outbox.remap ??= {};
    outbox.lost ??= [];
    while (outbox.moves.length) {
      const entry = outbox.moves[0];
      const receiptOf = () => localRecords(root, (board) => engineReceipt(board, entry.move.id));
      let receipt = receiptOf();
      let sequence = receipt?.sequence;
      if (!receipt) {
        // Map from the move as it was made, never from an earlier mapped copy, so no number is mapped twice.
        entry.original ??= entry.move;
        const { move, lost } = remapMove(entry.original, outbox.remap, outbox.lost);
        if (lost.length) {
          io.err(`pullboard: ${keepRefusal(state, entry, { code: 'RELAY_OUTBOX_DEPENDS', message: `it acts on #${lost[0]}, which this machine added while the relay was down, and that add was refused` }, [])}`);
          await finishEntry(link, outbox, where, key);
          continue;
        }
        // The renumbered move is saved before it is sent, so a lost reply is matched by these exact contents.
        entry.move = move;
        await writeOutbox(where, key, state.board, outbox);
        await actorTransport(root, file, state, credentialActor(entry.move), io);
        sequence = state.sequence + 1;
        const sealed = await sealedRecord(key, entry.move, state, 'move', sequence);
        const registration = seatReceipt(entry.move, sequence, sealed);
        state.pending = { move: entry.move, intent: entry.intent, ...(entry.command ? { command: entry.command, commandIntent: entry.commandIntent } : {}),
          sequence, sealed, ...(registration ? { registration } : {}) };
        saveLink(file, state);
        let failure;
        try { await sendPending(root, file, state, io); } catch (error) { failure = error; }
        if (failure && !receiptOf()) {
          if (!['RELAY_UNAVAILABLE', 'RELAY_RESPONSE'].includes(failure.code)) throw failure;
          try { await catchUp(root, file, state, io); } catch { throw failure; }
        }
        receipt = receiptOf();
        if (!receipt) throw failure ?? new Refused('RELAY_RESPONSE', 'the relay acknowledged a queued move without its replay receipt; run pullboard status to retry the outbox');
        sequence = receipt.sequence;
      }
      if (state.pending?.move?.id === entry.move.id) delete state.pending;
      if (state.recovered?.move?.id === entry.move.id) delete state.recovered;
      if (receipt.outcome.error) {
        const earlier = localRecords(root, (board) => earlierMoves(board, entry, sequence));
        io.err(`pullboard: ${keepRefusal(state, entry, receipt.outcome.error, earlier)}`);
        if (Number.isSafeInteger(entry.localItem)) outbox.lost.push(entry.localItem);
      } else if (Number.isSafeInteger(entry.localItem) && followItem(outbox.remap, entry.localItem, receipt.outcome.result)) {
        state.outboxRenumbered = [...(state.outboxRenumbered ?? []), { was: entry.localItem, is: receipt.outcome.result }].slice(-KEPT_REFUSALS);
        io.err(`pullboard: the item this machine added as #${entry.localItem} while the relay was down is #${receipt.outcome.result} on the board; its queued moves follow it`);
      }
      await finishEntry(link, outbox, where, key);
    }
  } catch (error) {
    if (outbox.restored && outbox.moves.length) {
      if (state.pending && outbox.moves.some((entry) => entry.move.id === state.pending.move?.id)) delete state.pending;
      await rebaseOutbox(link, outbox, key);
    }
    throw error;
  }
}
