/**
 * Infra notes: a submit that edits an existing test file, or a file the gate runs, must say why [C7,V4]. An
 * agent once swapped real listeners for in-memory parsers to get past a sandbox, and nobody asked the person.
 * The note and the files it covers are recorded on the submit event, and the reviewer reads them in show.
 */
import { Refused } from './refused.js';
import { tryGit } from './git.js';

/** A test file, by its name or by its folder. */
const TEST_FILE = /^test\/|\.(?:test|spec)\.[cm]?js$/u;
/** A token of a gate command that names a file: a path, or a script with a known extension. */
const GATE_FILE = /\.(?:[cm]?js|sh|json)$|\//u;

/**
 * The gate files a command names, relative to the checkout. A command like "node --test test/a.test.js" names
 * test/a.test.js; a flag or a URL names nothing.
 *
 * @param {string[]} commands the gate commands in force
 * @returns {Set<string>}
 */
function namedByGates(commands) {
  const named = new Set();
  for (const command of commands) {
    for (const token of String(command ?? '').split(/\s+/u)) {
      const word = token.replace(/^["']|["']$/gu, '');
      if (word && !word.startsWith('-') && !word.includes('://') && GATE_FILE.test(word)) named.add(word.replace(/^\.\//u, ''));
    }
  }
  return named;
}

/**
 * The files a submit changes that the claim already had, and that are a test file, the project's pullboard.json,
 * a githook, or a file a gate command names. A new file is not an edit of an existing one.
 *
 * @param {string} root the builder's checkout
 * @param {string} claimHead the commit the item was claimed at
 * @param {string[]} files the files the item changed since the claim
 * @param {string[]} gates the gate commands in force
 * @returns {string[]} the sorted files that need a note
 */
export function existingGuardedEdits(root, claimHead, files, gates) {
  const named = namedByGates(gates);
  const guarded = files.filter((path) => TEST_FILE.test(path) || path === 'pullboard.json' || path.startsWith('.githooks/') || named.has(path));
  return guarded.filter((path) => tryGit(root, ['cat-file', '-e', `${claimHead}:${path}`]).status === 0).sort();
}

/**
 * Decide whether a submit may proceed: refused with INFRA_NOTE_REQUIRED when it edits an existing guarded file and
 * carries no --infra reason, otherwise the note and the files it covers, to record on the submit event.
 *
 * @param {{ root: string, claimHead: string, files: string[], gates: string[], infra: string | undefined }} submit
 * @returns {{ note: string, files: string[] } | null} the infra record, or null when none is needed or given
 * @throws {Refused} INFRA_NOTE_REQUIRED, or USAGE for a malformed --infra value
 */
export function infraNote({ root, claimHead, files, gates, infra }) {
  const edited = existingGuardedEdits(root, claimHead, files, gates);
  if (infra === undefined) {
    if (!edited.length) return null;
    throw new Refused('INFRA_NOTE_REQUIRED', `this change edits existing test or gate file${edited.length > 1 ? 's' : ''} ${edited.join(', ')}; say why with --infra "<why>"`,
      'run pullboard submit <id> --infra "<why>", giving the reason the edit is needed');
  }
  if (typeof infra !== 'string' || !infra.trim() || /[\r\n]/u.test(infra)) throw new Refused('USAGE', '--infra "<why>" is one nonempty line');
  return { note: infra.trim(), files: edited };
}

/**
 * The infra record of an item's latest submit, for the reviewer to read; null when that submit gave none.
 *
 * @param {Array<{ event_kind: string, event_detail: string }>} events the item's events, oldest first
 * @returns {{ note: string, files: string[] } | null}
 */
export function infraNoteOf(events) {
  const latest = events.filter((event) => event.event_kind === 'submit').at(-1);
  return latest ? JSON.parse(latest.event_detail).infra ?? null : null;
}
