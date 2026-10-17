/**
 * What `pullboard resume` tells the coordinator seat about its inbox [I1,A9].
 *
 * The blueprint trial found a coordinating agent that never read its inbox in about 17 turns: its
 * resume buried one unread line near the end, and its next step never named the inbox. So the
 * coordinator's resume opens with how many shouts and decisions wait for it and the newest few,
 * and its next step reads them first. Resume only looks: `pullboard inbox` is what marks shouts
 * read, so a session that starts and stops never swallows a message nobody read.
 */
import * as store from './board.js';

/** How many of the newest unread shouts resume names; the rest are a count and a command. */
export const INBOX_NEWEST = 3;

/** The command that reads every waiting shout and marks it read. */
const READ_ALL = 'pullboard inbox';

/**
 * The coordinator's waiting inbox, read without marking anything read: the unread count, the open
 * decisions addressed to it, and the newest unread shouts, oldest of them first. Only shouts to
 * the seat, its lane or all count, never another seat's private shouts (the inbox's own rule).
 *
 * @param {any} board
 * @param {string} agentId
 * @param {{ id: number }[]} openDecisions the open decisions addressed to this seat
 * @returns {{ unread: number, decisions: number, newest: { id: number, from: string, at: string, text: string }[], more: number, read: string }}
 */
export function coordinatorInbox(board, agentId, openDecisions) {
  const unread = store.unreadCount(board, agentId);
  const newest = store.peekShouts(board, agentId, INBOX_NEWEST).map((shout) => ({
    id: shout.shout_id, from: shout.shout_from, at: shout.shout_at, text: shout.shout_text,
  }));
  return { unread, decisions: openDecisions.length, newest, more: Math.max(0, unread - newest.length), read: READ_ALL };
}

/**
 * The text lines for the coordinator's inbox: one count line, then the newest few by name and
 * the command that reads them all. Bounded, so a busy board never floods the session start.
 *
 * @param {ReturnType<typeof coordinatorInbox>} inbox
 * @param {(id: string) => string} name display name for an agent id
 * @param {(at: string) => string} age how long ago a time was
 * @param {(text: string) => string} firstLine
 * @returns {string[]}
 */
export function coordinatorInboxLines(inbox, name, age, firstLine) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const counts = `${plural(inbox.unread, 'unread shout')}, ${plural(inbox.decisions, 'open decision')} for you`;
  if (!inbox.unread && !inbox.decisions) return [`inbox: ${counts}`];
  const lines = [`inbox: ${counts}; read them with ${inbox.read}`];
  for (const shout of [...inbox.newest].reverse()) {
    lines.push(`  newest #${shout.id} from ${name(shout.from)} (${age(shout.at)} ago): ${firstLine(shout.text)}`);
  }
  if (inbox.more) lines.push(`  ${inbox.more} more; read them all with ${inbox.read}`);
  return lines;
}

/**
 * The coordinator's next step with a waiting inbox in front of it, so reading comes first.
 *
 * @param {ReturnType<typeof coordinatorInbox>} inbox
 * @param {string} next the step the board names otherwise
 * @returns {string}
 */
export function inboxFirst(inbox, next) {
  if (!inbox.unread) return next;
  return `read your ${inbox.unread === 1 ? 'unread shout' : `${inbox.unread} unread shouts`} first: ${inbox.read}; then ${next}`;
}
