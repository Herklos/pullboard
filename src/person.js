/** Person actions use the view when a terminal is remote or belongs to an agent [B26]. */
import { createHash } from 'node:crypto';
import { COORDINATOR } from './config.js';
import { Refused } from './refused.js';

/** Markers carried by Claude Code and Codex agent subprocesses, rather than user configuration. */
export const AGENT_SHELL_MARKERS = Object.freeze([
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'AI_AGENT',
  'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI', 'CODEX_SHELL',
]);

/** SSH transport markers: any one names a remote shell, and test children acting as the person drop them all. */
export const SSH_SHELL_MARKERS = Object.freeze(['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']);

/**
 * Tell whether this shell arrived over SSH by any of its markers [B26].
 * One list serves the person check and relay on's SSH path, so a marker one honours the other honours too.
 */
export function remoteShell(environment = process.env) {
  return SSH_SHELL_MARKERS.some((name) => Boolean(environment[name]));
}

/** Session identifiers belong beside the shell markers; only their digest reaches the local checkout binding. */
export const AGENT_SESSION_IDS = Object.freeze(['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID']);

/** Distinguish agent sessions, including one stable session for an agent shell with no identifier. */
export function agentSessionDigest(environment = process.env) {
  if (!AGENT_SHELL_MARKERS.some((name) => Boolean(environment[name]))) return null;
  const name = AGENT_SESSION_IDS.find((key) => Boolean(environment[key]));
  const identity = name ? [name, environment[name]] : ['agent-shell-without-session'];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

/** Refuse terminal person actions in an agent shell; only the authenticated view adapter supplies view. */
export function requirePersonChannel(channel = 'terminal', environment = process.env) {
  if (!['terminal', 'view'].includes(channel)) {
    throw new Refused('B26_PERSON_CHANNEL', 'person actions use the terminal or the view; run pullboard view, the person’s channel');
  }
  if (channel === 'terminal' && AGENT_SHELL_MARKERS.some((name) => Boolean(environment[name]))) {
    throw new Refused('B26_PERSON_CHANNEL', 'this terminal belongs to an agent; run pullboard view, the person’s channel, and let the person act there');
  }
  if (channel === 'terminal' && remoteShell(environment)) {
    throw new Refused('B26_PERSON_CHANNEL', 'this is a remote SSH shell, not the person’s terminal; run pullboard view, the person’s channel, and let the person act there');
  }
  return channel;
}

/** Permit only relay-on's SSH device flow for a person; agent terminals stay refused. */
export function requireRelayOnChannel(channel = 'terminal', environment = process.env) {
  if (!['terminal', 'view'].includes(channel)) {
    throw new Refused('B26_PERSON_CHANNEL', 'person actions use the terminal or the view; run pullboard view, the person’s channel');
  }
  if (channel === 'terminal' && AGENT_SHELL_MARKERS.some((name) => Boolean(environment[name]))) {
    throw new Refused('B26_PERSON_CHANNEL', 'this terminal belongs to an agent; run pullboard view, the person’s channel, and let the person act there');
  }
  return channel;
}

/**
 * Whether a shout is the person's own: a relay person request, or the local view acting as the
 * coordinator (N26, B26). The view acting as a named agent, or an agent shell as the coordinator,
 * still speaks as that agent.
 *
 * @param {any} io
 * @param {{ id: string }} me
 * @returns {boolean}
 */
export function personShout(io, me) {
  return io.personRequest?.phase === 'execute' || (io.personChannel === 'view' && me.id === COORDINATOR);
}
