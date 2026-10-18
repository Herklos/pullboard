/**
 * Rigor's second step: a repeated cause becomes a draft row with its proof [D1,D3,S1]. A work cause
 * becomes a Doctrine row whose check holds a count of 0; a product cause becomes a spec row gated
 * by its failing test; a cause that reads as both drafts one of each, and the person picks. The
 * proof is the check run on real commits: red on the bad one, green on the fix. Nothing here
 * approves or applies a row.
 */
import { Refused } from './refused.js';
import {
  causeProblem,
  rigorReport,
} from './rigor.js';
import { draftRow } from './spec-draft.js';
import { proveCauseCheck } from './rigor-proof.js';
import { rigorSource } from './rigor-source.js';

/**
 * Draft the rows for a repeated cause, after proving its check. Refused when the key is malformed,
 * has not repeated (pullboard rigor does not list it), the rule text is not one line, or the proof
 * does not hold. Returns the drafts with their evidence and proof.
 *
 * @param {{ root: string, config: any, events: any[], person: string }} board
 * @param {{ key: string, text: string, check?: string, red?: string, green?: string, section?: string }} request
 * @returns {Promise<{ key: string, reads: string, evidence: { items: { id: number, commits: string[] }[], occurrences: number, neverAgain: boolean }, proof: object, drafts: object[] }>}
 */
export async function rigorDraft({ root, config, events, person, agent }, { key, text, check, red, green, section }) {
  const malformed = causeProblem(key ?? '');
  if (malformed) throw malformed;
  const cause = rigorReport(events, { person }).causes.find((entry) => entry.key === key);
  if (!cause) throw new Refused('RIGOR_UNNOTICED', `${key} has not repeated, so there is nothing to draft yet; pullboard rigor lists the causes that can become rules`);
  if (!text?.trim() || /[\r\n|]/u.test(text)) throw new Refused('USAGE', 'give the rule as one nonempty line without a field separator: pullboard rigor draft <key> "<rule>" --check "<command>" --red <commit> --green <commit>');
  if (cause.reads !== 'work' && / \| /u.test(check ?? '')) throw new Refused('USAGE', 'a spec row gate cannot hold " | "; put the pipeline in a script and name the script in --check');
  const proof = await proveCauseCheck(root, cause, { check, red, green }, { agent });
  const items = cause.items.map((item) => `#${item.id}`).join(', ');
  const why = `Why: rigor ${key.replaceAll('|', '/')} ${cause.neverAgain ? 'was marked never again by the person' : `failed on ${items}`}; red at ${proof.red.commit}, green at ${proof.green.commit}.`;
  const rowText = `${text.trim()} ${why}`;
  const source = rigorSource(cause, proof);
  const drafts = [];
  if (cause.reads !== 'product') drafts.push(draftRow(root, config, { target: 'doctrine', text: rowText, gate: `check ${proof.countCheck}`, fields: ['count: 0', `source: ${source}`], section }));
  if (cause.reads !== 'work') drafts.push(draftRow(root, config, { target: 'spec', text: rowText, gate: proof.check, fields: [`source: ${source}`], section }));
  return { key, reads: cause.reads, evidence: { items: cause.items, occurrences: cause.occurrences, neverAgain: cause.neverAgain },
    proof: { check: proof.check, red: proof.red, green: proof.green }, drafts };
}
