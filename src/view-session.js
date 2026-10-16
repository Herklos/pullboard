/** Private runtime records that let an unattended CLI hand off its live view link. */
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import {
  LOOPBACK,
  lastPort,
} from './serve.js';
import { registryFile } from './projects.js';
import { fetchLocal } from './local-fetch.js';

/** The per-port record keeps the secret out of CLI output and mode 0600 on disk. */
function sessionFile(port) {
  return join(dirname(registryFile()), `view-${port}.json`);
}

/** Read a valid persisted session record, or return null when none is usable. */
function readSession(port) {
  try {
    const record = JSON.parse(readFileSync(sessionFile(port), 'utf8'));
    if (record.port !== port || !Number.isInteger(record.pid) || record.pid < 1
      || typeof record.secret !== 'string' || typeof record.boundAt !== 'string'
      || (record.scopeCommonDir !== undefined && (typeof record.scopeCommonDir !== 'string' || !record.scopeCommonDir))) return null;
    return record;
  } catch {
    return null;
  }
}

/** Atomically store a private session record and update the default port when auto-selected. */
export function rememberView(view, { rememberPort = false } = {}) {
  const file = sessionFile(view.port);
  const temporary = `${file}.${process.pid}.tmp`;
  const pointer = join(dirname(registryFile()), 'view.json');
  const pointerTemporary = `${pointer}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(view)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
    if (rememberPort) {
      writeFileSync(pointerTemporary, `${JSON.stringify({ port: view.port })}\n`, { mode: 0o600 });
      chmodSync(pointerTemporary, 0o600);
      renameSync(pointerTemporary, pointer);
    }
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* Preserve the original failure. */ }
    try { rmSync(pointerTemporary, { force: true }); } catch { /* Preserve the original failure. */ }
    try { rmSync(file, { force: true }); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}

/** Remove the record only when it still belongs to this process and port. */
export function forgetView(port) {
  try {
    if (readSession(port)?.pid === process.pid) rmSync(sessionFile(port), { force: true });
  } catch {
    // A stale record is harmless because reuse also checks the live process and HTTP response.
  }
}

/** Find an authenticated listener only when its saved project scope matches this caller. */
export async function runningView(port = 0, expectedScopeCommonDir = null) {
  const candidatePort = port || lastPort();
  const view = candidatePort ? readSession(candidatePort) : null;
  if (!view || (view.scopeCommonDir ?? null) !== (expectedScopeCommonDir ?? null)) return null;
  try {
    process.kill(view.pid, 0);
    const response = await fetchLocal(`http://${LOOPBACK}:${view.port}/api/v1/boards?k=${encodeURIComponent(view.secret)}`, {
      signal: AbortSignal.timeout(1_000),
      redirect: 'manual',
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const listing = await response.json();
    if (!Array.isArray(listing.boards) || !Array.isArray(listing.warnings)) return null;
    return { url: `http://${LOOPBACK}:${view.port}/?k=${view.secret}`, port: view.port, pid: view.pid, boundAt: view.boundAt };
  } catch {
    return null;
  }
}
