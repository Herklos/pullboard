/**
 * Which agent session built an item (#921). A seat name is not a session: one session can hold the coordinator's
 * checkout and a review worktree at once, and then "never verify your own work" holds only by name. Claims and submits
 * record the session's digest beside the board, in this repository's own Git directory, never on the shared board or
 * the relay, and a verdict from a session that built or submitted the item is refused.
 */
import { appendFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { agentSessionDigest } from './person.js';
import { Refused } from './refused.js';

/** The local ledger of item moves by session digest, shared by every worktree of this repository. */
function ledgerFile(info) {
  return join(info.commonDir, 'pullboard', 'item-sessions.jsonl');
}

/** Record that this session claimed or submitted an item. A ledger that cannot be written never fails the move. */
export function recordItemSession(info, item, move, digest = agentSessionDigest()) {
  if (!digest || !Number.isInteger(Number(item))) return;
  try {
    mkdirSync(join(info.commonDir, 'pullboard'), { recursive: true, mode: 0o700 });
    appendFileSync(ledgerFile(info), JSON.stringify({ item: Number(item), move, digest, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  } catch { /* The binding scan below still covers a session that holds the builder's checkout. */ }
}

/** The digests recorded for one item's claims and submits. */
function ledgerDigests(info, item) {
  const file = ledgerFile(info);
  if (!existsSync(file)) return new Set();
  return new Set(readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    try {
      const row = JSON.parse(line);
      return row.item === item && typeof row.digest === 'string' ? [row.digest] : [];
    } catch { return []; }
  }));
}

/** The seats this session's digest is bound to now, in the main checkout and every worktree. */
function boundSeats(info, digest) {
  const files = [join(info.commonDir, 'pullboard-checkout-session.json')];
  const worktrees = join(info.commonDir, 'worktrees');
  if (existsSync(worktrees)) {
    for (const entry of readdirSync(worktrees, { withFileTypes: true })) {
      if (entry.isDirectory()) files.push(join(worktrees, entry.name, 'pullboard-checkout-session.json'));
    }
  }
  const seats = new Set();
  for (const file of files) {
    try {
      const binding = JSON.parse(readFileSync(file, 'utf8'));
      if (binding.digest === digest && typeof binding.agent === 'string') seats.add(binding.agent);
    } catch { /* A missing or damaged peer binding names no seat. */ }
  }
  return seats;
}

/**
 * Refuse a verdict from the agent session that built or submitted the item: its digest is on the item's ledger, or it
 * is bound right now to the seat that built it. A shell with no agent session (the person's terminal) is never refused.
 *
 * @param {{ commonDir: string }} info
 * @param {{ item_id: number, item_built_by?: string|null, item_owner?: string|null }} item
 */
export function refuseSelfSession(info, item, digest = agentSessionDigest()) {
  if (!digest) return;
  const builders = [item.item_built_by, item.item_owner].filter(Boolean);
  const seats = boundSeats(info, digest);
  if (!ledgerDigests(info, item.item_id).has(digest) && !builders.some((builder) => seats.has(builder))) return;
  throw new Refused('SELF_SESSION_VERIFY', `this agent session built or submitted #${item.item_id}, so its verdict would be its own work under another seat's name`,
    'ask another agent session to verify it: pullboard next --verify from that session\'s own worktree');
}
