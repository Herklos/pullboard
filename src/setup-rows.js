/**
 * What setup asks about spec rows (#848): a row the person has already decided waits for the
 * coordinator's spec apply, never for the person again, and each open row gets the command that
 * decides it, approve for a draft and answer for a pending question.
 */
import { decisionProjection } from './row-decisions.js';
import { rowDecisionContext } from './row-decision-state.js';

/** Include stale decisions even when the current file row was already marked approved. */
export function setupDecisionRows(root, config, records, rows) {
  const context = rowDecisionContext(root, config);
  return rows.map(row => decisionProjection(records, row, 'spec', context))
    .filter(row => row.status === 'draft' || row.status === 'pending' || row.staleDecision);
}

/**
 * The setup step once every open row has a person decision that spec apply has not written yet.
 *
 * @param {string[]} rowIds The decided rows waiting for apply.
 * @param {boolean} seat Whether an agent seat, not the coordinator, is reading it.
 * @returns {{waitingOn: string, rowIds: string[], question: string, command: string, afterAnswer: string, agentNext: string}}
 */
export function applyStep(rowIds, seat) {
  const names = rowIds.join(', ');
  return { waitingOn: 'coordinator-apply', rowIds,
    question: seat ? `The person approved ${names}; the coordinator applies them.` : `The person approved ${names}; apply them: pullboard spec apply.`, command: 'pullboard spec apply',
    afterAnswer: 'spec apply writes the person’s decisions into SPEC.md; then commit SPEC.md so every worktree reads them.',
    agentNext: seat ? `ask the coordinator to apply ${names}: pullboard shout coordinator "the person approved ${names}; please run pullboard spec apply"` : 'pullboard spec apply, then commit SPEC.md' };
}

/**
 * The person's command for the rows still open, and the verb that names it: approve for drafts,
 * answer for pending questions, decide for a mix.
 *
 * @param {{id: string, status: string}[]} rows The open rows with no person decision.
 * @returns {{personCommand: string, verb: string, seatQuestion: string, seatNext: string}}
 */
export function personAsk(rows) {
  const questions = rows.filter(row => row.status === 'pending').map(row => row.id);
  const drafts = rows.filter(row => row.status !== 'pending').map(row => row.id);
  const personCommand = [drafts.length ? `pullboard spec approve ${drafts.join(',')}` : '', ...questions.map(id => `pullboard spec answer ${id} "<choice>"`)].filter(Boolean).join('; ');
  const verb = !questions.length ? 'approve' : drafts.length ? 'decide' : 'answer';
  const names = rows.map(row => row.id).join(', ');
  const request = verb === 'approve' ? `bring approval of ${names} to the person` : `ask the person to ${verb} ${names}`;
  return { personCommand, verb,
    seatQuestion: `Waiting for the coordinator to ${request}.`,
    seatNext: `ask the coordinator to ${request}: pullboard shout coordinator "${verb} ${names}" --decision; meanwhile pullboard spec show ${rows[0].id}` };
}
