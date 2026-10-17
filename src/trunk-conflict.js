/**
 * An accepted item that conflicts with the trunk reopens for a main merge [B3,D1].
 *
 * When two accepted items touch the same lines, the second no longer merges onto the trunk. That
 * is not a failed test and not a reject: the work was accepted and only needs main merged into
 * it. `pullboard reopen <id> --conflict "<files>"` records exactly that, naming the conflicting
 * files and the trunk commit they conflict with, and keeps the original accept on record. The
 * builder claims it with its bar unchanged, merges main and resubmits; the re-review checks the
 * frozen check at the new head and nothing else.
 */
import { ENGINE_VERSION } from './machine.js';
import { Refused } from './refused.js';

/** The engine whose reopen may carry a trunk conflict; older engines refuse it before replay. */
export const CONFLICT_ENGINE = 28;

/** The label an item carries from a conflict reopen until its next verdict. */
export const MAIN_MERGE_LABEL = 'needs main merge';

/**
 * True when a sealed move carries this engine's meaning, a trunk conflict on a reopen.
 *
 * @param {string} operation
 * @param {any[]} args
 * @returns {boolean}
 */
export function carriesConflict(operation, args) {
  return operation === 'reopen' && args?.[1]?.conflict !== undefined && args?.[1]?.conflict !== null;
}

/**
 * The file paths named by a `--conflict` value, split on commas and white space, without repeats.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function conflictFiles(text) {
  return [...new Set(String(text ?? '').split(/[\s,]+/u).filter(Boolean))];
}

/**
 * Check the trunk for the conflict the coordinator names, so --conflict cannot stand in for a
 * landing failure note on work that merges cleanly. Every named file must be one Git reports as
 * conflicting; the trunk commit comes from Git, never from the caller.
 *
 * @param {(commit: string) => { ref: string, commit: string, files: string[] | null }} trunkMerge - merges onto the trunk in memory
 * @param {string} commit - the accepted commit
 * @param {string[]} files - the files the coordinator names
 * @returns {{ files: string[], trunk: string }}
 */
export function requireTrunkConflict(trunkMerge, commit, files) {
  if (!files.length) throw new Refused('CONFLICT_FILES', 'name the files that conflict: pullboard reopen <id> --conflict "<file>, <file>"');
  const merge = trunkMerge(commit);
  const branch = merge.ref.replace(/^refs\/heads\//u, '');
  if (!merge.files) throw new Refused('NOT_CONFLICTING', `${commit.slice(0, 12)} merges cleanly onto ${branch} at ${merge.commit.slice(0, 12)}; merge it, or reopen with --note "<test file>: <test name>; merge commit <sha>" after a red landing`);
  const unknown = files.filter((file) => !merge.files.includes(file));
  if (unknown.length) throw new Refused('CONFLICT_FILES', `${unknown.join(', ')} ${unknown.length === 1 ? 'does' : 'do'} not conflict with ${branch} at ${merge.commit.slice(0, 12)}; the conflicting files are ${merge.files.join(', ') || 'unnamed'}`);
  return { files, trunk: merge.commit };
}

/**
 * The conflict a coordinator's `--conflict` names, with the trunk commit Git reports. Anyone else,
 * or an item that is not accepted and unmerged, gets the files alone, so the board's own guards
 * refuse it in their declared order (COORDINATOR_ONLY, NOT_SUBMITTED, ALREADY_MERGED, NOT_ACCEPTED).
 *
 * @param {{ item: any, coordinator: boolean, text: string, trunkMerge: (commit: string) => { ref: string, commit: string, files: string[] | null } }} request
 * @returns {{ files: string[], trunk: string | null }}
 */
export function reopenConflict({ item, coordinator, text, trunkMerge }) {
  const files = conflictFiles(text);
  if (!coordinator || item.item_status !== 'verified' || item.item_merged_commit || !item.item_commit) return { files, trunk: null };
  return requireTrunkConflict(trunkMerge, item.item_commit, files);
}

/**
 * The refusal for a conflict reopen the board cannot record, or null. A conflict reopens only an
 * accepted item, and only under this engine; it names its files and a full trunk commit.
 *
 * @param {any} board
 * @param {any} item
 * @param {unknown} conflict
 * @param {(accept: number) => void} found - receives the id of the accept the reopen sets aside
 * @returns {Refused | null}
 */
export function conflictProblem(board, item, conflict, found) {
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  if (engine < CONFLICT_ENGINE) return new Refused('ENGINE_VERSION', `a reopen for a main merge requires engine ${CONFLICT_ENGINE}; this board uses engine ${engine}; upgrade Pullboard before using --conflict`);
  if (item.item_status !== 'verified') return new Refused('NOT_ACCEPTED', `item #${item.item_id} is ${item.item_status}; --conflict reopens accepted work for a main merge, and a submission reopens with --note "why"`);
  const shape = /** @type {any} */ (conflict);
  const files = Array.isArray(shape?.files) ? shape.files : [];
  if (!files.length || files.some((file) => typeof file !== 'string' || !file.trim() || /[\r\n]/u.test(file)) || new Set(files).size !== files.length
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(shape?.trunk ?? '')) {
    return new Refused('BAD_CONFLICT', 'a trunk conflict names its files and the full trunk commit; run pullboard reopen <id> --conflict "<files>" from the main checkout');
  }
  const accept = board.db.prepare("SELECT event_id FROM event WHERE item_id = ? AND event_kind = 'accept' AND json_extract(event_detail, '$.commit') = ? ORDER BY event_id DESC LIMIT 1").get(item.item_id, item.item_commit);
  if (!accept) return new Refused('NOT_ACCEPTED', `item #${item.item_id} has no accept at ${String(item.item_commit).slice(0, 12)}; --conflict reopens accepted work for a main merge`);
  found(accept.event_id);
  return null;
}

/**
 * The cause key a trunk conflict records: the refusal Pullboard gives work that no longer merges.
 * Rigor (#713) reads cause keys and never counts a merge conflict, so a conflict reopen is never a
 * failing test, nor an uncaused reopen; two branches touching the same lines is no rule to learn.
 */
export const TRUNK_CONFLICT_CAUSE = 'refusal:MERGE_CONFLICT';

/**
 * The event fields a conflict reopen records: the conflict itself and its cause key.
 *
 * @param {{ files: string[], trunk: string }} conflict
 * @returns {{ conflict: { files: string[], trunk: string }, cause: string }}
 */
export function conflictDetail({ files, trunk }) {
  return { conflict: { files, trunk }, cause: TRUNK_CONFLICT_CAUSE };
}

/** The note a conflict reopen records when the coordinator gives none. */
export function conflictNote({ files, trunk }) {
  return `conflicts with the trunk at ${trunk.slice(0, 12)} in ${files.join(', ')}; merge main and resubmit`;
}

/**
 * The trunk conflict an item still carries, or null: the newest reopen, accept or reject on it is
 * a conflict reopen. It names the accept it set aside, so the re-review knows what already passed.
 *
 * @param {any} board
 * @param {number} id
 * @returns {{ files: string[], trunk: string, commit: string, at: string, accept: { by: string, commit: string } | null } | null}
 */
export function mainMergeFor(board, id) {
  const last = board.db.prepare("SELECT event_detail, event_at FROM event WHERE item_id = ? AND event_kind IN ('reopen', 'accept', 'reject') ORDER BY event_id DESC LIMIT 1").get(id);
  const detail = last ? JSON.parse(last.event_detail) : null;
  if (!detail?.conflict) return null;
  const accept = board.db.prepare('SELECT event_by, event_detail FROM event WHERE event_id = ?').get(detail.supersedes);
  return { ...detail.conflict, commit: detail.commit, at: last.event_at,
    accept: accept ? { by: accept.event_by, commit: JSON.parse(accept.event_detail).commit } : null };
}

/**
 * The lines `pullboard show` prints for an item that needs a main merge: what conflicts, then
 * what to do now, for the builder before resubmitting and for the reviewer after.
 *
 * @param {any} item
 * @param {NonNullable<ReturnType<typeof mainMergeFor>>} merge
 * @param {(id: string) => string} [name]
 * @returns {string[]}
 */
export function mainMergeLines(item, merge, name = (id) => id) {
  const accepted = merge.accept ? `accepted by ${name(merge.accept.by)} at ${merge.accept.commit.slice(0, 12)}` : 'accepted';
  const head = `${MAIN_MERGE_LABEL}: ${accepted}; conflicts with the trunk at ${merge.trunk.slice(0, 12)} in ${merge.files.join(', ')}`;
  if (item.item_status === 'submitted') return [head, `re-review: main merge only; run the frozen check at ${item.item_commit.slice(0, 12)}; the accept above stands for the rest`];
  return [head, `next: pullboard claim ${item.item_id} (the bar is unchanged), merge main, resolve ${merge.files.join(', ')}, commit, pullboard submit ${item.item_id}`];
}
