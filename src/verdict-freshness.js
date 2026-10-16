/** Acceptance stays append-only; freshness is derived from the known Git trunk [E8,V8]. */
import { spawnSync } from 'node:child_process';
import * as store from './board.js';
import { cleanGitEnvironment, mainCheckout } from './git.js';
import { trunkRef } from './trusted-policy.js';
import { Refused } from './refused.js';

/** Read exact Git objects without inherited selectors, replacements, or filename quoting. */
function readGit(root, args) {
  const result = spawnSync('git', ['--no-replace-objects', ...args], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('Git history is unavailable');
  return result.stdout;
}

/** Read the actual retained trunk tip, rather than a cached checkout HEAD used during review. */
export function verdictTrunk(root) {
  try {
    const ref = mainCheckout(root)?.branch ?? trunkRef(root);
    if (!ref?.startsWith('refs/heads/')) throw new Error('The retained trunk is unavailable');
    return readGit(root, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  } catch {
    throw new Refused('BAD_VERDICT_REVIEW', 'the retained trunk cannot be read; restore its branch and Git objects before reviewing');
  }
}

/** Capture the review's trunk and candidate delta against its submitted coordinator snapshot. */
export function captureVerdictReview(root, board, item, trunk = verdictTrunk(root)) {
  const receipt = store.events(board, { itemId: item.item_id }).findLast(event => {
    if (event.event_kind !== 'submit') return false;
    return JSON.parse(event.event_detail).commit === item.item_commit;
  });
  const submittedMain = receipt ? JSON.parse(receipt.event_detail).policyCommit : null;
  const base = submittedMain ?? item.item_claim_head;
  if (!base) throw new Refused('BAD_VERDICT_REVIEW', 'the submitted base is unavailable; restore its Git objects before reviewing');
  try {
    const ancestor = readGit(root, ['merge-base', base, item.item_commit]).trim();
    const paths = readGit(root, ['diff', '--no-renames', '--name-only', '-z', ancestor, item.item_commit, '--'])
      .split('\0').filter(Boolean).sort();
    return { commit: item.item_commit, trunk, paths };
  } catch {
    throw new Refused('BAD_VERDICT_REVIEW', 'the submitted paths cannot be read; restore the submitted commit and base objects before reviewing');
  }
}

/** Name the concrete stale proof and the required re-review without changing the original verdict. */
export function staleVerdictRefusal(item, state) {
  const changed = state.file && state.commit
    ? `${JSON.stringify(state.file)} changed on main in ${state.commit}`
    : state.reason ?? 'the reviewed Git history is unavailable';
  return new Refused('STALE_VERDICT', `item #${item.item_id}: ${changed}; merge current main into the submitted commit, commit a clean composition, then another agent runs pullboard verify ${item.item_id} accept --note "what was re-reviewed" before landing`);
}

/** Create one read's projector, sharing Git history lookups across its unlanded acceptances. */
export function verdictProjector(root, board, { main } = {}) {
  let tip = main;
  let resolved = main !== undefined;
  const histories = new Map();
  const changes = new Map();
  /** Cache each first-parent range once, including changes whose effects were later reverted. */
  const history = baseline => {
    if (!histories.has(baseline)) {
      readGit(root, ['merge-base', '--is-ancestor', baseline, tip]);
      histories.set(baseline, readGit(root, ['rev-list', '--first-parent', '--reverse', `${baseline}..${tip}`]).trim().split('\n').filter(Boolean));
    }
    return histories.get(baseline);
  };
  /** Compare every commit with its first parent, so a merge's files and a revert both count. */
  const changedFiles = commit => {
    if (!changes.has(commit)) changes.set(commit,
      readGit(root, ['diff', '--no-renames', '--name-only', '-z', `${commit}^1`, commit, '--']).split('\0').filter(Boolean));
    return changes.get(commit);
  };
  /** Return a derived state only for a verified item still waiting to land. */
  const state = item => {
    if (item.item_status !== 'verified' || item.item_merged_commit) return null;
    let review;
    try {
      if (!resolved) {
        resolved = true;
        tip = verdictTrunk(root);
      }
      if (!tip) throw new Error('The known trunk is unavailable');
      // A physical landing is final even before its board merge receipt reaches this replica.
      const landed = spawnSync('git', ['--no-replace-objects', 'merge-base', '--is-ancestor', item.item_commit, tip],
        { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8' });
      if (landed.status === 0) return null;
      if (landed.status !== 1) throw new Error('The submitted commit is unavailable');
      const accepted = store.verdictsFor(board, item.item_id).findLast(verdict =>
        verdict.verdict_decision === 'ACCEPT' && verdict.verdict_commit === item.item_commit);
      review = accepted?.review;
      if (!review) {
        // Legacy receipts did not seal a reviewed trunk. Use a conservative claim-base bound,
        // never invent a capture time or rewrite those immutable receipts.
        const baseline = readGit(root, ['merge-base', item.item_claim_head, tip]).trim();
        review = { trunk: baseline,
          paths: readGit(root, ['diff', '--no-renames', '--name-only', '-z', baseline, item.item_commit, '--']).split('\0').filter(Boolean), legacy: true };
      }
      if (!review.legacy && store.verdictReviewProblem(review, item.item_commit)) throw new Error('The sealed review is invalid');
      const paths = new Set(review.paths);
      for (const commit of history(review.trunk)) {
        const file = changedFiles(commit).find(path => paths.has(path));
        if (file) return { code: 'STALE_VERDICT', file, commit, reviewedTrunk: review.trunk, main: tip,
          ...(review.legacy ? { legacy: true } : {}) };
      }
      return null;
    } catch {
      return { code: 'STALE_VERDICT', file: null, commit: null, reviewedTrunk: review?.trunk ?? null,
        main: tip ?? null, reason: 'the reviewed Git history is unavailable; restore its objects and re-review' };
    }
  };
  /** Decorate a public item read while preserving every stored proof field. */
  const project = item => {
    const freshness = state(item);
    return freshness ? { ...item, item_verdict_state: freshness } : item;
  };
  return { state, project, main: tip ?? null };
}
