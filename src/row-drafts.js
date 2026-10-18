/**
 * Spec rows an agent drafts from a lane worktree (#878). SPEC.md is the coordinator's file, so a lane
 * cannot write it: the draft is recorded on the board instead, where it replays and travels over the
 * relay like any recorded move. Every reader that asks whether a cited id is live counts a board draft
 * as a draft row, so the lane cites the returned id at once and its worktree stays clean. The
 * coordinator's spec apply writes the drafts into SPEC.md, and the person approves them there as before.
 * A draft counts as applied once SPEC.md has its id, so applying needs no second move.
 */
import { atomic, logEvent, PERSON } from './board.js';
import { Refused } from './refused.js';

/** The board's recorded row drafts, oldest first. */
export function rowDrafts(board) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('row_drafts');
  return row ? JSON.parse(row.meta_value) : [];
}

/**
 * Record one drafted spec row on the board. The sender plans the id across SPEC.md, the doctrine file
 * and the board's drafts; the board refuses an id it already holds.
 *
 * @param {any} board
 * @param {{ agentId: string, row: { id: string, text: string, gate: string, tier: string, section: string } }} move
 */
export function draftSpecRow(board, { agentId, row }) {
  if (!agentId || agentId === PERSON) throw new Refused('ROW_DRAFT', 'an agent drafts a row and the person approves it; run pullboard spec draft "<text>" from an agent seat');
  if (!row || !/^[A-Z][A-Z0-9]*\d+$/u.test(String(row.id)) || ['text', 'gate', 'tier', 'section'].some((key) => typeof row[key] !== 'string' || !row[key].trim() || /[\r\n|]/u.test(row[key]))) {
    throw new Refused('ROW_DRAFT', 'a drafted row needs its id and a one-line text, gate, tier and section; run pullboard spec draft "<text>"');
  }
  return atomic(board, () => {
    const current = rowDrafts(board);
    if (current.some((draft) => draft.id === row.id)) throw new Refused('ROW_ID_TAKEN', `${row.id} is already drafted on this board; run pullboard spec draft again for the next free id`);
    logEvent(board, agentId, 'row_draft', null, { row });
    const entry = { id: row.id, text: row.text, gate: row.gate, tier: row.tier, section: row.section, by: agentId, event: board.lastEvent.event_id, at: board.lastEvent.event_at };
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
      .run('row_drafts', JSON.stringify([...current, entry]));
    return entry;
  });
}

/** Board drafts that SPEC.md does not have yet, for spec apply to write. */
export function pendingRowDrafts(spec, drafts) {
  const present = new Set(spec.rows.map((row) => row.id));
  return drafts.filter((draft) => !present.has(draft.id));
}

/** A parsed spec with the board's pending drafts added as draft rows, for readers deciding whether an id is live. */
export function withRowDrafts(spec, drafts) {
  const pending = pendingRowDrafts(spec, drafts ?? []);
  if (!pending.length) return spec;
  return { ...spec, rows: [...spec.rows, ...pending.map((draft) => ({ id: draft.id, status: 'draft', tier: draft.tier, text: draft.text, gate: draft.gate, section: draft.section, line: 0, fields: [] }))] };
}
