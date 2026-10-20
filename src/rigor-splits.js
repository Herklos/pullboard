/** Ordinary architectural suggestions retain coordinator and person authority, without red/green proof [D1]. */
import { loadDoctrine } from './doctrine.js';
import { proposeDoctrine } from './doctrine-rulings.js';
import { Refused } from './refused.js';
import { splitAlreadyProposed, splitProposal } from './rigor-conflicts.js';

/** Reserve and write pending review-gated rulings through the existing ordinary doctrine path. */
export async function draftConflictSplits(ctx, report, { read, reserve }) {
  const state = read();
  if (!ctx.info.isMain || !state.coordinator) throw new Refused('COORDINATOR_ONLY', 'only the coordinator proposes standing split rulings; ask your coordinator to run pullboard rigor --draft-splits from the main checkout');
  const splitDrafts = [];
  for (const file of report.hotFiles) {
    const doctrine = loadDoctrine(ctx.info.root, ctx.config);
    if (splitAlreadyProposed([...doctrine.repo.rows, ...state.rows], file)) continue;
    const suggestion = splitProposal(file);
    const values = { source: suggestion.source, gate: 'review' };
    const planned = proposeDoctrine({ ...ctx, doctrine }, values, suggestion.text, { reserved: state.rows.map(row => row.id), write: false });
    const entry = await reserve({ ...planned.row, target: 'doctrine' });
    const written = proposeDoctrine({ ...ctx, doctrine }, values, suggestion.text, { id: entry.id });
    state.rows.push({ ...written.row, target: 'doctrine' });
    splitDrafts.push(written);
  }
  return splitDrafts;
}
