/**
 * What submit and verify read about a submitted commit (N21, V1): the files the item's own commits
 * changed, a refusal when the candidate stacks on another item's unverified commit, a recovered
 * move's durable receipt, and the pinned report a submit prints.
 */
import * as store from './board.js';
import { engineReceipt } from './engine.js';
import {
  git,
  tryGit,
} from './git.js';
import { Refused } from './refused.js';

/**
 * The files an item's own commits changed since its claim (N21). First parents only, so main merged
 * into a lane branch is not counted as the item's work; and nothing another item submitted, such as
 * a verified dependency fast-forwarded in, which merges no commit to skip.
 *
 * @param {string} root
 * @param {number} id
 * @param {string | null} from
 * @param {string} to
 * @returns {string[]}
 */
export function filesSince(root, id, from, to) {
  if (!from) return [];
  const others = [`--exclude=refs/pullboard/items/${id}/*`, '--glob=refs/pullboard/items/*'];
  const result = tryGit(root, ['log', '--first-parent', '--no-merges', '--no-renames', '--format=', '--name-only', to, '--not', from, ...others]);
  return result.status === 0 ? [...new Set(result.stdout.split('\n').filter(Boolean))].sort() : [];
}

/** Refuse a candidate containing another item's unverified submitted commit [V1].
 *
 * Trunk-reachable commits are already landed, including when the candidate is trunk itself.
 * Inspect all remaining reachable commits, including merged topic parents.
 *
 * @param {string} root
 * @param {any} board
 * @param {any} item
 * @param {string} commit
 * @param {{ ref: string, commit: string } | null} trunk
 * @returns {void}
 */
export function refuseUnverifiedStack(root, board, item, commit, trunk) {
  const trunkRange = trunk?.commit
    ? tryGit(root, ['rev-list', `${trunk.commit}..${commit}`])
    : { status: 1, stdout: '' };
  if (trunkRange.status !== 0) {
    throw new Refused('NO_POLICY', 'the current trunk range cannot be read; restore Git history and retry the submit or verification');
  }
  const commits = new Set(trunkRange.stdout.split('\n').filter(Boolean));
  const stacked = store.unverifiedSubmissions(board)
    .find((other) => other.item_id !== item.item_id && commits.has(other.item_commit));
  if (stacked) {
    throw new Refused(
      'STACKED_ON_UNVERIFIED',
      `#${item.item_id} includes unverified item #${stacked.item_id} at ${stacked.item_commit}; wait for #${stacked.item_id} to be accepted or rebuild without its commits before continuing`,
    );
  }
}

/** Return the durable outcome only when a recovered move exactly matches its original receipt. */
export function recordedRecovery(board, move) {
  const receipt = engineReceipt(board, move.id);
  return receipt?.move === JSON.stringify(move) ? receipt : null;
}

/** Report and pin the original submitted commit, including a recovered acknowledged outcome. */
export function reportSubmission(ctx, id, commit, gate, doctrine = []) {
  const { root } = ctx.info;
  const pin = `refs/pullboard/items/${id}/${commit.slice(0, 12)}`;
  git(root, ['update-ref', pin, commit]);
  ctx.io.result?.({ id, commit, pin, gate, ...(doctrine.length ? { doctrine } : {}) });
  ctx.io.say(`submitted #${id} at ${commit.slice(0, 12)}; ${gate.report}`);
  ctx.io.say(`pinned as ${pin}, so this work can't be lost; keep your worktree until it is merged`);
  ctx.io.say(`next: another agent checks out ${commit.slice(0, 12)} and runs: pullboard verify ${id} accept|reject`);
  return 0;
}
