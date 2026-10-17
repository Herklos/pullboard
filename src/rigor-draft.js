/**
 * Rigor's second step: a repeated cause becomes a draft row with its proof [D1,D3,S1]. A work cause
 * becomes a Doctrine row whose check holds a count of 0; a product cause becomes a spec row gated
 * by its failing test; a cause that reads as both drafts one of each, and the person picks. The
 * proof is the check run on real commits: red on the bad one, green on the fix. Nothing here
 * approves or applies a row.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanGitEnvironment, resolveCommit, tryGit } from './git.js';
import { Refused } from './refused.js';
import { causeProblem, rigorReport } from './rigor.js';
import { draftRow } from './spec-draft.js';

// budget: one proof run of a check at one commit; a check slower than this cannot gate a row.
const CHECK_TIMEOUT_MS = 10 * 60_000;

/** The refusal for a draft without a proof, naming what is missing and the full command shape. */
function unproven(why, key) {
  return new Refused('RIGOR_UNPROVEN', `${why}; a draft needs its proof: pullboard rigor draft "${key}" "<rule>" --check "<command>" --red <commit where it fails> --green <commit where it passes>`);
}

/**
 * Run a check in a throwaway detached worktree at one commit and report its exit status and the
 * problem lines it printed (one nonblank stdout line per problem).
 *
 * @param {string} root
 * @param {string} commit
 * @param {string} check
 * @returns {{ commit: string, exit: number | null, problems: number, timedOut: boolean }}
 */
export function runCheckAt(root, commit, check) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-rigor-proof-'));
  const tree = join(dir, 'tree');
  const added = tryGit(root, ['worktree', 'add', '--detach', '--quiet', tree, commit]);
  try {
    if (added.status !== 0) throw new Refused('RIGOR_UNPROVEN', `cannot check out ${commit.slice(0, 12)} to prove the check: ${added.stderr || 'git worktree add failed'}; fetch the commit and retry`);
    const run = spawnSync('sh', ['-c', check], { cwd: tree, env: cleanGitEnvironment(), encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    const problems = String(run.stdout ?? '').split(/\r?\n/u).filter((line) => line.trim()).length;
    return { commit, exit: run.status, problems, timedOut: Boolean(run.error) };
  } finally {
    if (added.status === 0) tryGit(root, ['worktree', 'remove', '--force', tree]);
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Prove a check red on the bad commit and green on the fix. A work check counts problems: it exits
 * 0 or 1 and prints at least one problem line at red and none at green. A product check is a test:
 * it exits nonzero at red and 0 at green. A cause that reads as both needs both.
 *
 * @param {string} root
 * @param {{ key: string, reads: string, check?: string, red?: string, green?: string }} request
 * @returns {{ check: string, red: object, green: object }}
 */
export function proveCheck(root, { key, reads, check, red, green }) {
  if (!check?.trim()) throw unproven('no --check names the command that proves it', key);
  if (!red || !green) throw unproven(`no ${!red ? '--red' : '--green'} names the commit where the check ${!red ? 'fails' : 'passes'}`, key);
  const commits = [red, green].map((ref) => {
    const commit = resolveCommit(root, ref);
    if (!commit) throw unproven(`${ref} is not a commit in this repository`, key);
    return commit;
  });
  const [atRed, atGreen] = commits.map((commit) => runCheckAt(root, commit, check));
  for (const run of [atRed, atGreen]) if (run.timedOut) throw unproven(`the check did not finish at ${run.commit.slice(0, 12)}`, key);
  const work = reads !== 'product';
  const product = reads !== 'work';
  const counted = (run) => run.exit === 0 || run.exit === 1;
  if (work && (!counted(atRed) || !counted(atGreen))) throw unproven(`a work check exits 0 or 1 and prints one line per problem; it exited ${atRed.exit} at red and ${atGreen.exit} at green`, key);
  if (work && (atRed.problems < 1 || atGreen.problems > 0)) throw unproven(`the check printed ${atRed.problems} problems at red ${atRed.commit.slice(0, 12)} and ${atGreen.problems} at green ${atGreen.commit.slice(0, 12)}; red needs at least 1 and green none`, key);
  if (product && (atRed.exit === 0 || atGreen.exit !== 0)) throw unproven(`the test exited ${atRed.exit} at red ${atRed.commit.slice(0, 12)} and ${atGreen.exit} at green ${atGreen.commit.slice(0, 12)}; red needs a failure and green a pass`, key);
  return { check: check.trim(), red: atRed, green: atGreen };
}

/**
 * Draft the rows for a repeated cause, after proving its check. Refused when the key is malformed,
 * has not repeated (pullboard rigor does not list it), the rule text is not one line, or the proof
 * does not hold. Returns the drafts with their evidence and proof.
 *
 * @param {{ root: string, config: any, events: any[], person: string }} board
 * @param {{ key: string, text: string, check?: string, red?: string, green?: string, section?: string }} request
 * @returns {{ key: string, reads: string, evidence: { items: { id: number, commits: string[] }[], occurrences: number, neverAgain: boolean }, proof: object, drafts: object[] }}
 */
export function rigorDraft({ root, config, events, person }, { key, text, check, red, green, section }) {
  const malformed = causeProblem(key ?? '');
  if (malformed) throw malformed;
  const cause = rigorReport(events, { person }).causes.find((entry) => entry.key === key);
  if (!cause) throw new Refused('RIGOR_UNNOTICED', `${key} has not repeated, so there is nothing to draft yet; pullboard rigor lists the causes that can become rules`);
  if (!text?.trim() || /[\r\n|]/u.test(text)) throw new Refused('USAGE', 'give the rule as one nonempty line without a field separator: pullboard rigor draft <key> "<rule>" --check "<command>" --red <commit> --green <commit>');
  if (cause.reads !== 'work' && / \| /u.test(check ?? '')) throw new Refused('USAGE', 'a spec row gate cannot hold " | "; put the pipeline in a script and name the script in --check');
  const proof = proveCheck(root, { key, reads: cause.reads, check, red, green });
  const items = cause.items.map((item) => `#${item.id}`).join(', ');
  const why = `Why: rigor ${key.replaceAll('|', '/')} ${cause.neverAgain ? 'was marked never again by the person' : `failed on ${items}`}; red at ${proof.red.commit.slice(0, 12)}, green at ${proof.green.commit.slice(0, 12)}.`;
  const rowText = `${text.trim()} ${why}`;
  const drafts = [];
  if (cause.reads !== 'product') drafts.push(draftRow(root, config, { target: 'doctrine', text: rowText, gate: `check ${proof.check}`, fields: ['count: 0'], section }));
  if (cause.reads !== 'work') drafts.push(draftRow(root, config, { target: 'spec', text: rowText, gate: proof.check, section }));
  return { key, reads: cause.reads, evidence: { items: cause.items, occurrences: cause.occurrences, neverAgain: cause.neverAgain },
    proof: { check: proof.check, red: proof.red, green: proof.green }, drafts };
}
