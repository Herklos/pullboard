/**
 * A CI or cloud session's board, from its environment alone [E18]. A session that cannot pair holds an agent token
 * (PULLBOARD_RELAY_TOKEN) and the board key (PULLBOARD_RELAY_KEY), and optionally the relay address
 * (PULLBOARD_RELAY_URL). On its first command in a clone with no relay link, the relay names the token's board and
 * agent; the session reads that board's sealed snapshot with the key and then works as that agent. The link it saves
 * holds neither the token nor the key, so nothing secret lands on disk, and its scope is the token's one board.
 */
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { repoInfo } from './git.js';
import { Refused } from './refused.js';
import {
  DEFAULT_RELAY,
  localRecords,
  relayOrigin,
  request,
  restoreCheckpoint,
  saveLink,
} from './relay.js';
import { readBoardKey } from './relay-key.js';
import { appliedSequence } from './engine.js';
import { importBoard } from './exchange.js';

const TOKEN = /^pa_[A-Za-z0-9_-]{43}$/u;

/**
 * Link this clone to the board its environment names, once, when the environment holds both an agent token and a
 * board key and the clone has no link yet. Returns whether it linked.
 *
 * @param {string} root
 * @param {string} file - the clone's relay.json
 * @param {{ err?: (line: string) => void }} io
 * @returns {Promise<boolean>}
 */
export async function environmentLink(root, file, io) {
  const token = process.env.PULLBOARD_RELAY_TOKEN;
  if (token === undefined || process.env.PULLBOARD_RELAY_KEY === undefined || existsSync(file)) return false;
  if (!TOKEN.test(token)) throw new Refused('AUTH_REQUIRED', 'set PULLBOARD_RELAY_TOKEN to one agent token for this board, never in command arguments');
  const url = relayOrigin(process.env.PULLBOARD_RELAY_URL || DEFAULT_RELAY);
  const probe = { version: 1, board: '0'.repeat(32), url, token, sequence: 0, cursor: 0 };
  // A board token sees exactly its own board; the session then names the agent it acts as.
  const { boards } = await request(probe, '/auth/boards', {}, io);
  if (!Array.isArray(boards) || boards.length !== 1) throw new Refused('RELAY_ACTOR', 'PULLBOARD_RELAY_TOKEN must be one agent token, scoped to one board');
  const { session } = await request(probe, '/auth/session?board=' + boards[0].id, {}, io);
  if (session?.kind !== 'board' || !/^[0-9a-f]{32}$/u.test(session.board ?? '') || typeof session.agent !== 'string') {
    throw new Refused('RELAY_ACTOR', 'PULLBOARD_RELAY_TOKEN must be one agent token, scoped to one board');
  }
  const state = { version: 1, mode: 'ordered', board: session.board, url, token: null, personReauth: true, environment: { agent: session.agent },
    sequence: 0, cursor: 0, baselineAccepted: true };
  // The clone has no board of its own yet: the relay's snapshot becomes it, as a pairing would bring it.
  await restoreCheckpoint(root, state, io, readBoardKey(state.board), (board, native) => importBoard(board, native));
  state.sequence = localRecords(root, appliedSequence);
  state.cursor = localRecords(root, (board) => board.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id);
  saveLink(file, state);
  io.err?.(`pullboard: this session works on board ${state.board.slice(0, 8)} as ${session.agent}, from its environment; no key file or token is stored`);
  return true;
}

/**
 * The agent an environment session works as, when this clone's link came from its environment and the token is still
 * there, or null. Reading the link file directly keeps this a pure read with no relay contact.
 *
 * @param {string} root
 * @param {{ db: any }} board
 * @returns {object | null} the agent row
 */
export function environmentAgent(root, board) {
  if (process.env.PULLBOARD_RELAY_TOKEN === undefined) return null;
  let state;
  try { state = JSON.parse(readFileSync(join(repoInfo(root).commonDir, 'pullboard', 'relay.json'), 'utf8')); } catch { return null; }
  const agent = state?.environment?.agent;
  return typeof agent === 'string' ? board.db.prepare('SELECT * FROM agent WHERE agent_id = ?').get(agent) ?? null : null;
}
