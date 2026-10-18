/** A checkout belongs to one local agent session; bindings never enter the shared board [B3,B7]. */
import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import { takeResource } from './resources.js';
import { Refused } from './refused.js';

/** Keep each worktree's binding in its own Git directory rather than the shared common directory. */
export function checkoutSessionFile(info) {
  return join(info.gitDir, 'pullboard-checkout-session.json');
}

/** Read only a digest and local agent identity; damaged bindings need an explicit takeover. */
function readBinding(file, takeover) {
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value.version !== 1 || typeof value.agent !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest) || !Number.isFinite(Date.parse(value.at))) throw new Error('invalid binding');
    return value;
  } catch {
    if (takeover) return null;
    throw new Refused('CHECKOUT_SESSION', 'this checkout’s local session binding is unreadable; run pullboard takeover from the same agent’s new session');
  }
}

/** Check whether this already-bound checkout belongs to the invoking agent session. */
export function localSessionMatches(info, { agent, digest }) {
  const current = readBinding(checkoutSessionFile(info), false);
  return current !== null && current.agent === agent && current.digest === digest;
}

/** Serialize local binding changes, record an explicit takeover, and replace complete JSON atomically. */
export async function bindLocalSession(info, { agent, digest, takeover = false, recordTakeover, keepLease = false }) {
  const file = checkoutSessionFile(info);
  const name = 'checkout-session:' + createHash('sha256').update(info.gitDir).digest('hex');
  const lease = await takeResource({ name, capacity: 1, scope: 'repo', root: info.root, agent });
  let retained = false;
  /** Atomically replace the complete local record, keeping identifiers out of durable state. */
  function persist(identity) {
    const pending = file + '.' + process.pid + '.tmp';
    writeFileSync(pending, JSON.stringify({ version: 1, agent: identity, digest, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    renameSync(pending, file);
  }
  try {
    const previous = readBinding(file, takeover);
    if (!takeover && previous && previous.digest !== digest) {
      throw new Refused('NOT_YOUR_CHECKOUT', `this checkout belongs to ${previous.agent} in another agent session`,
        'create a separate checkout with git worktree add --detach .claude/worktrees/<new-name> HEAD, using an unused folder; then cd there and run pullboard join <lane> --model "<model name>". If you are the same agent in a new session, run pullboard takeover instead');
    }
    if (takeover) await recordTakeover();
    if (!previous || takeover || previous.agent !== agent) persist(agent);
    if (keepLease) {
      retained = true;
      return { release: lease.release, updateAgent: persist };
    }
  } finally { if (!retained) lease.release(); }
}

/** Find this session's registered seats from local Git bindings, never from shared board credentials. */
export function localSessionSeats(info, { agents, digest }) {
  const directory = join(info.commonDir, 'worktrees');
  if (!existsSync(directory)) return [];
  const registered = new Map(agents.map((agent) => [agent.agent_id, agent]));
  const seats = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const gitDir = join(directory, entry.name);
    try {
      const binding = readBinding(join(gitDir, 'pullboard-checkout-session.json'), false);
      if (!binding || binding.digest !== digest) continue;
      const agent = registered.get(binding.agent);
      if (!agent || agent.agent_lane === 'coordinator') continue;
      const gitFile = readFileSync(join(gitDir, 'gitdir'), 'utf8').trim();
      const root = realpathSync(dirname(gitFile));
      if (root !== agent.agent_path) continue;
      const pointer = readFileSync(gitFile, 'utf8').trim();
      if (!pointer.startsWith('gitdir: ') || resolve(root, pointer.slice(8)) !== resolve(gitDir)) continue;
      seats.push(agent);
    } catch (error) {
      // Gone or damaged peers are not authority to borrow a checkout. The invoking seat was
      // already checked by bindCheckoutSession, so its own damaged binding still refuses.
      if (!['ENOENT', 'ENOTDIR'].includes(error.code) && !(error instanceof Refused)) throw error;
    }
  }
  return seats;
}
