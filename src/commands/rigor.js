/** The pullboard rigor command, in its own module so an item adding another command never edits these lines. */
import * as store from '../board.js';
import {
  COORDINATOR,
} from '../config.js';
import {
  Refused,
} from '../refused.js';
import {
  conflictLines,
  conflictReport,
} from '../rigor-conflicts.js';
import {
  rigorDraftCommand,
} from '../rigor-draft.js';
import {
  draftConflictSplits,
} from '../rigor-splits.js';
import {
  rigorLines,
  rigorReport,
} from '../rigor.js';
import {
  context,
  ordered,
  reserveRow,
  whoAmI,
  withBoard,
} from '../cli.js';

/** Run `pullboard rigor` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  if (values['draft-splits'] && first) throw new Refused('USAGE', 'use pullboard rigor --draft-splits without a proof-bound draft subcommand');
  if (first === 'draft') { const ctx = context(io); return rigorDraftCommand(io, { second, rest, values }, { root: ctx.info.root, config: ctx.config, read: () => withBoard(ctx, (board) => ({ events: store.events(board), actor: whoAmI(ctx, board).id })), reserve: (row) => reserveRow(ctx, row, true), propose: (row, evidence) => withBoard(ctx, async (board) => ordered(ctx, board, 'proposeSentinel', [{ agentId: whoAmI(ctx, board).id, row, evidence }])) }); }
  if (first || second || rest.length) throw new Refused('USAGE', 'pullboard rigor takes no arguments; to draft a rule: pullboard rigor draft <key> "<rule>" --check "<command>" --red <commit> --green <commit>');
  const ctx = context(io);
  const report = withBoard(ctx, (board) => { const history = store.events(board); return { ...rigorReport(history, { person: store.PERSON }), ...conflictReport(history) }; });
  if (values['draft-splits']) report.splitDrafts = await draftConflictSplits(ctx, report, { read: () => withBoard(ctx, (board) => ({ coordinator: whoAmI(ctx, board).id === COORDINATOR, rows: store.rowDrafts(board), decisions: store.rowDecisions(board) })), reserve: row => reserveRow(ctx, row, true) });
  io.result?.(report);
  for (const line of [...rigorLines(report), ...conflictLines(report)]) io.say(line);
  for (const draft of report.splitDrafts ?? []) io.say(`${draft.id}: draft split proposal; person approval required`);
  return 0;
}
