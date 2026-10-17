/**
 * The names a saved blueprint must never carry (S1): who works on this board and this machine's
 * name, read from the board, Git, the sign-offs and the spec.
 */
import { hostname } from 'node:os';
import { displayAgentName } from './agent-names.js';
import * as store from './board.js';
import { tryGit } from './git.js';
import { readSignoffs } from './spec.js';

/**
 * Every private name a saved blueprint must never carry: each agent's id, display name, model
 * and family, the person's Git name and email, everyone who signed off or signs rows, and this
 * machine's host name, whole, plus the parts of each (a first name, an email's user) to match
 * only as written. Missing sources add nothing; they never stop the save [S1].
 */
export function privateNames(root, board, spec) {
  const names = new Set();
  const parts = new Set();
  const add = (value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    // "unknown" is the label for an undeclared model, not anyone's name.
    if (!text || text === 'unknown') return;
    names.add(text);
    for (const part of text.split(/[\s@.<>()]+/u)) if (part.length >= 3 && part !== 'unknown' && part !== text) parts.add(part);
  };
  for (const agent of store.listAgents(board)) {
    add(agent.agent_id); add(agent.agent_model); add(agent.agent_family); add(displayAgentName(agent)); add(displayAgentName(agent, 'prefix'));
  }
  for (const key of ['user.name', 'user.email']) add(tryGit(root, ['config', '--get', key]).stdout);
  for (const ident of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const found = /^(.*?)\s*<([^>]*)>/u.exec(tryGit(root, ['var', ident]).stdout ?? '');
    if (found) { add(found[1]); add(found[2]); }
  }
  try { for (const record of readSignoffs(root)) add(record.by); } catch { /* An unreadable sign-off file adds no names. */ }
  for (const row of spec.rows) for (const signer of row.signers ?? []) add(signer);
  add(hostname());
  add(hostname().split('.')[0]);
  return { names: [...names], parts: [...parts] };
}
