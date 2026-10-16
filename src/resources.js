/** Machine and repository queues persist leases; waiters are admitted by class (landing, review, submit, other), aging up over time, then in arrival order [Q1,Q2,Q3]. */
import { mkdirSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { repoInfo } from './git.js';
import { machineHome, withMachineHomeWrite } from './machine-home.js';
import { Refused } from './refused.js';

const LEASE_MS = 20_000;
const HEARTBEAT_MS = 3_000;
const POLL_MS = 40;
const PROCESS_IDENTITY_CACHE_MS = 3_000;
const processIdentities = new Map();

/** Mark child commands whose parent already owns a machine gate slot. */
export const GATE_SLOT_HELD_ENV = 'PULLBOARD_GATE_SLOT_HELD';
export const GATE_SLOT_POOL_ENV = 'PULLBOARD_GATE_SLOT_POOL';
export const GATE_SLOT_TOKEN_ENV = 'PULLBOARD_GATE_SLOT_TOKEN';
export const BROWSER_SLOT_HELD_ENV = 'PULLBOARD_BROWSER_SLOT_HELD';

/** Reserve a distinct resource row for each configured remote host. */
function runnerResourceName(host) { return `runner:${host}`; }

/** Build child markers that identify the exact machine queue lease and its browser capacity. */
export function gateSlotEnvironment(lease) {
  if (lease?.runner) throw new Refused('REMOTE_GATE_SLOT_NOT_INHERITABLE', 'remote runner leases cannot be inherited through local gate markers');
  if (!lease || lease.name !== 'gate' || lease.scope !== 'machine' || typeof lease.pool !== 'string' || typeof lease.token !== 'string') {
    throw new Refused('GATE_SLOT_LEASE_REQUIRED', 'pass the live machine gate lease when starting a child test process');
  }
  return {
    [GATE_SLOT_HELD_ENV]: '1',
    [GATE_SLOT_POOL_ENV]: lease.pool,
    [GATE_SLOT_TOKEN_ENV]: lease.token,
    [BROWSER_SLOT_HELD_ENV]: lease.browser ? '1' : '',
  };
}

/** Resolve the local database for the requested scope. */
function databaseFile(scope, root) {
  if (scope === 'board') throw new Refused('BOARD_SCOPE_UNAVAILABLE', 'board-scoped resources need the relay; run pullboard relay on');
  if (scope === 'machine') return machineResourceFile();
  if (scope === 'repo') return join(repoInfo(root).commonDir, 'pullboard', 'resources.sqlite');
  throw new Refused('BAD_RESOURCE_SCOPE', `unknown resource scope "${scope}"; use machine or repo`);
}

/** Resolve the database path for the machine-wide resource pool. */
function machineResourceFile() {
  return join(machineHome(), 'resources.sqlite');
}

/** Canonicalize an absolute resource path without creating a missing foreign pool. */
function canonicalResourceFile(file) {
  let candidate = resolve(file);
  const missing = [];
  while (true) {
    try {
      return resolve(realpathSync(candidate), ...missing);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missing.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

/** Open and initialize the small durable queue database. */
function open(file, machine = false) {
  return machine ? withMachineHomeWrite(machineHome(), () => openQueue(file)) : openQueue(file);
}

/** Initialize a queue, leaving machine-storage error translation to its caller. */
function openQueue(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 10000');
  let transaction = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transaction = true;
    db.exec(`CREATE TABLE IF NOT EXISTS resource (name TEXT PRIMARY KEY, capacity INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS holder (token TEXT PRIMARY KEY, name TEXT NOT NULL, pid INTEGER NOT NULL, started TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL, repo TEXT NOT NULL, since TEXT NOT NULL, heartbeat INTEGER NOT NULL, landing INTEGER NOT NULL DEFAULT 0, item_check INTEGER NOT NULL DEFAULT 0, browser INTEGER NOT NULL DEFAULT 0, item TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', runner TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS holder_name ON holder(name);
      CREATE TABLE IF NOT EXISTS waiter (ticket INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pid INTEGER NOT NULL, started TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL, repo TEXT NOT NULL, since TEXT NOT NULL, heartbeat INTEGER NOT NULL, landing INTEGER NOT NULL DEFAULT 0, item_check INTEGER NOT NULL DEFAULT 0, browser INTEGER NOT NULL DEFAULT 0, item TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', remote INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS runner_unavailable (host TEXT PRIMARY KEY, since TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS waiter_name_ticket ON waiter(name, ticket);`);
    for (const table of ['holder', 'waiter']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name);
      if (!columns.includes('started')) db.exec(`ALTER TABLE ${table} ADD COLUMN started TEXT NOT NULL DEFAULT ''`);
      if (!columns.includes('landing')) db.exec(`ALTER TABLE ${table} ADD COLUMN landing INTEGER NOT NULL DEFAULT 0`);
      if (!columns.includes('item_check')) db.exec(`ALTER TABLE ${table} ADD COLUMN item_check INTEGER NOT NULL DEFAULT 0`);
      if (!columns.includes('diagnostic')) db.exec(`ALTER TABLE ${table} ADD COLUMN diagnostic INTEGER NOT NULL DEFAULT 0`);
      if (!columns.includes('browser')) db.exec(`ALTER TABLE ${table} ADD COLUMN browser INTEGER NOT NULL DEFAULT 0`);
      if (!columns.includes('item')) db.exec(`ALTER TABLE ${table} ADD COLUMN item TEXT NOT NULL DEFAULT ''`);
      if (!columns.includes('kind')) db.exec(`ALTER TABLE ${table} ADD COLUMN kind TEXT NOT NULL DEFAULT ''`);
      if (table === 'holder' && !columns.includes('runner')) db.exec("ALTER TABLE holder ADD COLUMN runner TEXT NOT NULL DEFAULT ''");
      if (table === 'waiter' && !columns.includes('remote')) db.exec('ALTER TABLE waiter ADD COLUMN remote INTEGER NOT NULL DEFAULT 0');
    }
    // Marks a waiter whose process admits by class; an older pullboard leaves it 0.
    if (!db.prepare('PRAGMA table_info(waiter)').all().some(({ name }) => name === 'classed')) {
      db.exec('ALTER TABLE waiter ADD COLUMN classed INTEGER NOT NULL DEFAULT 0');
    }
    // Older runner-aware builds stored remote leases as ordinary gate holders. Move them
    // into their host namespace so old readers of name='gate' continue to see local use only.
    db.exec(`INSERT INTO resource(name, capacity)
      SELECT 'runner:' || runner, MAX(1, COUNT(*)) FROM holder
      WHERE name = 'gate' AND runner <> '' GROUP BY runner
      ON CONFLICT(name) DO NOTHING;
      UPDATE holder SET name = 'runner:' || runner WHERE name = 'gate' AND runner <> '';`);
    db.exec('COMMIT');
    transaction = false;
  } catch (error) {
    if (transaction) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve the migration error. */ }
    }
    db.close();
    throw error;
  }
  return db;
}

/** Check whether the operating system still recognizes this process ID. */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** Read a stable OS process identity; an unreadable identity is unknown, not proof of death. */
function processIdentity(pid) {
  const cached = processIdentities.get(pid);
  if (cached && Date.now() - cached.checkedAt < PROCESS_IDENTITY_CACHE_MS) return cached.identity;
  let identity = null;
  try {
    const output = execFileSync('/bin/ps', ['-o', 'lstart=', '-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const fields = output.split(/\s+/u);
    const state = fields.pop();
    if (fields.length) identity = { started: fields.join(' '), zombie: state?.startsWith('Z') ?? false };
  } catch { /* A live PID remains authoritative when the OS identity utility is unavailable. */ }
  processIdentities.set(pid, { identity, checkedAt: Date.now() });
  if (processIdentities.size > 1024) {
    for (const [cachedPid, entry] of processIdentities) {
      if (Date.now() - entry.checkedAt >= PROCESS_IDENTITY_CACHE_MS) processIdentities.delete(cachedPid);
    }
  }
  return identity;
}

/** Read the start identity to store with a lease when the OS can provide it. */
function processStarted(pid) {
  return processIdentity(pid)?.started ?? '';
}

/** Confirm that a live PID still belongs to the process recorded in the lease. */
function sameProcess(pid, started) {
  if (!alive(pid)) return false;
  const identity = processIdentity(pid);
  if (!identity) return true;
  if (identity.zombie) return false;
  return !started || identity.started === started;
}

/** Return the Git root for display when the resource caller is inside a repository. */
function repoRoot(root) {
  try { return repoInfo(root).root; } catch { return ''; }
}

/** Run a short serialized database update and discard dead or expired leases. */
function update(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const cutoff = Date.now() - LEASE_MS;
    for (const row of db.prepare('SELECT token, pid, started, heartbeat FROM holder').all()) {
      if (!alive(row.pid) || (row.heartbeat < cutoff && !sameProcess(row.pid, row.started))) {
        db.prepare('DELETE FROM holder WHERE token = ?').run(row.token);
      }
    }
    for (const row of db.prepare('SELECT token, pid, started, heartbeat FROM waiter').all()) {
      if (!alive(row.pid) || (row.heartbeat < cutoff && !sameProcess(row.pid, row.started))) {
        db.prepare('DELETE FROM waiter WHERE token = ?').run(row.token);
      }
    }
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Admission classes, most urgent first. */
export const QUEUE_CLASSES = ['landing', 'review', 'submit', 'other'];
/** A waiter moves up one class for every this long it has waited, so no class starves. */
export const QUEUE_AGE_MS = 30 * 60_000;

/**
 * A waiter's admission class: its declared class from the run it names, and the class it holds now
 * after aging up one class per QUEUE_AGE_MS waited. Landings come first, then reviews (they unblock
 * landing), then submits and item checks, then focused, diagnostic and every other run.
 *
 * @param {{ landing?: number|boolean, itemCheck?: number|boolean, diagnostic?: number|boolean, kind?: string, since?: string }} entry
 * @param {number} [now] - The clock reading to age against; injectable so tests need not wait.
 * @returns {{ base: number, effective: number, name: string, declared: string }}
 */
export function queueClass(entry, now = Date.now()) {
  const kind = entry.kind ?? '';
  const base = entry.landing === true || entry.landing === 1 ? 0
    : kind === 'review' ? 1
      : !(entry.diagnostic === true || entry.diagnostic === 1) && (entry.itemCheck === true || entry.itemCheck === 1 || kind === 'submit' || kind === 'check') ? 2
        : 3;
  const waited = Math.max(0, now - (Date.parse(entry.since ?? '') || now));
  const effective = Math.max(0, base - Math.floor(waited / QUEUE_AGE_MS));
  return { base, effective, name: QUEUE_CLASSES[effective], declared: QUEUE_CLASSES[base] };
}

/**
 * Whether a line admits by class: only while every waiter in it was queued by a process that
 * admits by class (see admissionRank for why).
 *
 * @param {Array<{ classed?: number }>} waiters - The whole line for one resource.
 * @returns {boolean}
 */
function classOrderInEffect(waiters) {
  return waiters.every((waiter) => waiter.classed === 1);
}

/**
 * The admission rank every process in this queue agrees on. Class order (with aging) applies only
 * while every waiter was queued by a process that admits by class. Why: an older pullboard admits
 * landings first and then by ticket, and two processes ranking the same line differently each
 * wait for the other while a slot stays empty. With any older waiter queued, everyone falls back
 * to that older order, so mixed versions on one machine never deadlock.
 *
 * @param {Array<{ classed?: number }>} waiters - The whole line for one resource.
 * @param {number} now
 * @returns {(waiter: object) => number}
 */
function admissionRank(waiters, now) {
  return classOrderInEffect(waiters) ? (waiter) => queueClass(waiter, now).effective : (waiter) => (waiter.landing === 1 ? 0 : 1);
}

/** Current holders and the waiting line in admission order, each waiter naming its class. */
function snapshot(db, name, now = Date.now()) {
  /** Preserve older public entries while naming diagnostics as a distinct queue class. */
  const project = ({ diagnostic, browser, remote, runner, item, kind, ...entry }) => ({ ...entry, landing: entry.landing === 1,
    itemCheck: entry.itemCheck === 1 && diagnostic !== 1, ...(diagnostic === 1 ? { diagnostic: true } : {}),
    ...(browser === 1 ? { browser: true } : {}), ...(remote === 1 ? { remote: true } : {}),
    ...(runner ? { runner } : {}), ...(item ? { item } : {}), ...(kind ? { kind } : {}) });
  // Browser is an additional capability on a gate lease, not a second partially held row.
  const where = name === 'browser' ? 'name = ? AND browser = 1' : 'name = ?';
  const sourceName = name === 'browser' ? 'gate' : name;
  const runnerHost = name.startsWith('runner:') ? name.slice('runner:'.length) : '';
  const holderWhere = runnerHost ? 'name = ?' : where;
  const holderValues = [sourceName];
  const holders = db.prepare(`SELECT agent, repo, since, landing, item_check AS itemCheck, diagnostic, browser, runner, item, kind FROM holder WHERE ${holderWhere} ORDER BY since, token`).all(...holderValues).map(project);
  const queued = db.prepare('SELECT classed FROM waiter WHERE name = ?').all(sourceName);
  const rank = admissionRank(queued, now);
  const line = db.prepare(`SELECT ticket, agent, repo, since, landing, item_check AS itemCheck, diagnostic, browser, remote, item, kind, classed FROM waiter WHERE ${where}`).all(sourceName)
    .sort((left, right) => rank(left) - rank(right) || left.ticket - right.ticket)
    .map(({ ticket, classed, ...entry }) => {
      const current = queueClass(entry, now);
      return { ...project(entry), queueClass: current.name, ...(current.effective < current.base ? { agedFrom: current.declared } : {}) };
    });
  // An older pullboard in the line means everyone admits in arrival order until it leaves.
  return { holders, line, ...(queued.some((waiter) => waiter.classed !== 1) ? { order: 'arrival' } : {}) };
}

/** Count reported or admissible queue position separately so blocked work cannot distort the visible line. */
function waiterPosition(db, name, ticket, { eligibleOnly = false, now = Date.now() } = {}) {
  const queueName = name === 'browser' ? 'gate' : name;
  const waiters = db.prepare('SELECT ticket, pid, agent, repo, since, landing, item_check AS itemCheck, diagnostic, browser, kind, classed FROM waiter WHERE name = ? ORDER BY ticket').all(queueName);
  const holders = db.prepare('SELECT pid, agent, repo FROM holder WHERE name = ?').all(queueName);
  const browserCapacity = db.prepare("SELECT capacity FROM resource WHERE name = 'browser'").get()?.capacity ?? 1;
  const browserBusy = db.prepare("SELECT COUNT(*) AS count FROM holder WHERE name = 'gate' AND browser = 1").get().count >= browserCapacity;
  /** A live process owns its leases even if it changes descriptive agent or repository labels. */
  const holdsSlot = (waiter) => holders.some((holder) => holder.pid === waiter.pid);
  /** Leave a waiting independent landing a slot before a holder takes another lease. */
  const blockedByLanding = (waiter) => holdsSlot(waiter)
    && waiters.some((other) => other.landing === 1 && other.pid !== waiter.pid);
  /** Map queue entries to the admission rank every process in this line agrees on. */
  const rank = admissionRank(waiters, now);
  const line = name === 'browser' ? waiters.filter((waiter) => waiter.browser === 1) : waiters;
  const considered = line.filter((waiter) => !blockedByLanding(waiter)
    // Browser availability affects admission only; reported positions retain every browser waiter.
    && (!eligibleOnly || name === 'browser' || waiter.browser !== 1 || !browserBusy));
  const current = line.find((waiter) => waiter.ticket === ticket);
  if (!current) return eligibleOnly ? Number.MAX_SAFE_INTEGER : line.length + 1;
  const currentIndex = considered.findIndex((waiter) => waiter.ticket === ticket);
  if (currentIndex < 0) return eligibleOnly ? Number.MAX_SAFE_INTEGER : Math.max(2, considered.length + 1);
  const currentRank = rank(current);
  return considered.filter((waiter) => rank(waiter) < currentRank || (rank(waiter) === currentRank && waiter.ticket <= ticket)).length;
}

/** Validate the configured remote executors before using them in a queue transaction. */
function validatedRunners(value) {
  if (!Array.isArray(value)) throw new Refused('BAD_RUNNER_POOL', 'runnerProvider must return an array of runner settings');
  const seen = new Set();
  return value.map((runner) => {
    if (!runner || typeof runner.host !== 'string' || !runner.host.trim() || runner.host.trim() !== runner.host
      || !Number.isSafeInteger(runner.slots) || runner.slots < 1
      || !Number.isSafeInteger(runner.browser) || runner.browser < 0 || runner.browser > runner.slots
      || seen.has(runner.host)) {
      throw new Refused('BAD_RUNNER_POOL', 'runners require unique nonempty hosts, positive slots, and browser capacity from zero through slots');
    }
    seen.add(runner.host);
    return { host: runner.host, slots: runner.slots, browser: runner.browser,
      ...(typeof runner.node === 'string' ? { node: runner.node } : {}),
      ...(typeof runner.root === 'string' ? { root: runner.root } : {}) };
  });
}

/**
 * Find the earliest compatible free executor while allowing CPU waiters past browser-only blocks.
 * Local and remote slots are offered in one admission order: the class rank that snapshot and
 * waiterPosition report (landing, review, submit, other, aging up), FIFO by ticket within a class,
 * or landing-first arrival order while an older pullboard waits in the line. Why one order: a
 * second order for runners would let a focused run take a remote slot ahead of a review that
 * could also run there.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} ticket - The waiter asking for admission.
 * @param {number} capacity - Local gate slots.
 * @param {Array<{host:string,slots:number,browser:number}>} runners - Validated remote executors.
 * @param {number} [now] - The clock reading to age against.
 * @returns {{host:string,slots:number,browser:number}|null}
 */
function gateAdmission(db, ticket, capacity, runners, now = Date.now()) {
  const queued = db.prepare("SELECT ticket, pid, since, landing, item_check AS itemCheck, diagnostic, browser, remote, kind, classed FROM waiter WHERE name = 'gate'").all();
  const rank = admissionRank(queued, now);
  const waiters = queued.sort((left, right) => rank(left) - rank(right) || left.ticket - right.ticket);
  const holders = db.prepare("SELECT pid, landing, browser FROM holder WHERE name = 'gate'").all();
  const localUsed = holders.length;
  const localBrowsers = holders.filter(holder => holder.browser === 1).length;
  const browserCapacity = db.prepare("SELECT capacity FROM resource WHERE name = 'browser'").get()?.capacity ?? 1;
  const usage = new Map(runners.map(runner => {
    // The reserved namespace is authoritative even for an older generic holder that
    // predates the name guard and has no runner column value.
    const remoteHolders = db.prepare('SELECT browser FROM holder WHERE name = ?').all(runnerResourceName(runner.host));
    return [runner.host, {
      slots: remoteHolders.length,
      browsers: remoteHolders.filter(holder => holder.browser === 1).length,
    }];
  }));
  const unavailable = new Set(db.prepare('SELECT host FROM runner_unavailable').all().map(row => row.host));
  /** Keep an already holding process from taking another slot ahead of a different landing. */
  const blockedByLanding = waiter => holders.some(holder => holder.pid === waiter.pid)
    && waiters.some(other => other.landing === 1 && other.pid !== waiter.pid);
  /** Find a currently free compatible slot without reserving it for later queue entries. */
  function available(waiter) {
    if (blockedByLanding(waiter)) return null;
    if (localUsed < capacity && (waiter.browser !== 1 || localBrowsers < browserCapacity)) {
      return { host: '', slots: capacity, browser: waiter.browser === 1 ? 1 : 0 };
    }
    if (waiter.remote === 1) {
      for (const runner of runners) {
        if (unavailable.has(runner.host) || (waiter.browser === 1 && runner.browser < 1)) continue;
        const used = usage.get(runner.host);
        if (used.slots >= runner.slots || (waiter.browser === 1 && used.browsers >= runner.browser)) continue;
        return runner;
      }
    }
    return null;
  }
  for (const runner of runners) {
    const resourceName = runnerResourceName(runner.host);
    const row = db.prepare('SELECT capacity FROM resource WHERE name = ?').get(resourceName);
    const held = usage.get(runner.host).slots;
    if (!row) db.prepare('INSERT INTO resource(name, capacity) VALUES (?, ?)').run(resourceName, runner.slots);
    else if (row.capacity !== runner.slots) {
      if (held > runner.slots) throw new Refused('RUNNER_CAPACITY_MISMATCH', `runner ${runner.host} has ${held} active slot(s), more than configured capacity ${runner.slots}`);
      db.prepare('UPDATE resource SET capacity = ? WHERE name = ?').run(runner.slots, resourceName);
    }
  }
  for (const waiter of waiters) {
    const executor = available(waiter);
    if (executor) return waiter.ticket === ticket ? executor : null;
  }
  return null;
}

/** List configured runners with active slot usage from the same local admission database. */
export function runnerResourceStatus(runners) {
  const configured = validatedRunners(runners);
  const db = open(machineResourceFile());
  try {
    return update(db, () => configured.map(runner => {
      const holders = db.prepare('SELECT agent, repo, since, browser, item, kind, runner FROM holder WHERE name = ? ORDER BY since, token')
        .all(runnerResourceName(runner.host));
      const unavailable = db.prepare('SELECT since, detail FROM runner_unavailable WHERE host = ?').get(runner.host);
      return { ...runner, inUse: holders.length, browserInUse: holders.filter(holder => holder.browser === 1).length,
        unavailable: Boolean(unavailable), ...(unavailable ? { unavailableSince: unavailable.since, unavailableReason: unavailable.detail } : {}), holders };
    }));
  } finally { db.close(); }
}

/** Serialize runner-setting changes against active remote leases and clear that host's quarantine. */
export function updateRunnerSettings(host, persist) {
  if (typeof host !== 'string' || !host.trim() || host.trim() !== host || typeof persist !== 'function') {
    throw new Refused('BAD_RUNNER_SETTINGS', 'a runner host and settings persistence callback are required');
  }
  const db = open(machineResourceFile());
  try {
    return update(db, () => {
      const resourceName = runnerResourceName(host);
      const held = db.prepare('SELECT COUNT(*) AS count FROM holder WHERE name = ?').get(resourceName).count;
      if (held) throw new Refused('RUNNER_BUSY', `runner ${host} has ${held} active slot(s); wait for them to finish before changing its settings`);
      const result = persist();
      if (Number.isSafeInteger(result?.slots) && result.slots > 0) {
        db.prepare('INSERT INTO resource(name, capacity) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET capacity = excluded.capacity')
          .run(resourceName, result.slots);
      }
      db.prepare('DELETE FROM runner_unavailable WHERE host = ?').run(host);
      return result;
    });
  } finally { db.close(); }
}

/** Pause briefly between durable queue checks. */
function pause(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }

/**
 * Join the queue in its admission class (landing, review, submit, other), aging up over time; FIFO by ticket within a class.
 *
 * @param {{ name: string, capacity: number, capacityProvider?: () => number, browserCapacityProvider?: () => number, scope?: 'machine'|'repo'|'board', root?: string, agent?: string, repo?: string, landing?: boolean, itemCheck?: boolean, diagnostic?: boolean, browser?: boolean, remote?: boolean, runnerProvider?: () => Array<{host:string,slots:number,browser:number}>, item?: string, kind?: string, onWait?: (state: object) => void, allowIdleCapacityUpdate?: boolean, _resume?: object }} options - Resource identity, queue class and optional remote executor pool.
 * @returns {Promise<{ name: string, scope: string, token: string, pool: string, browser: boolean, runner?: {host:string,slots:number,browser:number}, waitMs: number, release: () => void, renew: () => void, requeueRunner?: () => Promise<object> }>}
 */
export async function takeResource(options) {
  const { name, capacity, scope = 'machine', root = process.cwd(), allowIdleCapacityUpdate = false } = options;
  if (typeof name !== 'string' || !name.trim() || name.trim() !== name) throw new Refused('BAD_RESOURCE_NAME', 'resource name must be nonempty trimmed text');
  if (name.startsWith('runner:')) throw new Refused('RESERVED_RUNNER_RESOURCE', 'runner resource rows are managed by the machine gate; request name "gate"');
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Refused('BAD_RESOURCE_CAPACITY', 'resource capacity must be a positive integer');
  const landing = options.landing === true;
  const itemCheck = options.itemCheck === true;
  const diagnostic = options.diagnostic === true;
  const browser = options.browser === true;
  const remote = options.remote === true;
  // This synchronous provider is used inside the admission transaction; callers must
  // limit it to a bounded local configuration read, never Git, process inspection or network work.
  const runnerProvider = options.runnerProvider;
  const item = options.item ?? '';
  const kind = options.kind ?? '';
  if (browser && name !== 'gate') throw new Refused('BAD_BROWSER_RESOURCE', 'browser capacity can only be acquired together with the machine gate; request name "gate" with browser: true');
  if ((remote || runnerProvider !== undefined) && name !== 'gate') throw new Refused('BAD_REMOTE_RESOURCE', 'remote executors can only be acquired together with the machine gate');
  if (runnerProvider !== undefined && typeof runnerProvider !== 'function') throw new Refused('BAD_RUNNER_POOL', 'runnerProvider must be a function returning configured runners');
  if (name === 'browser' && !browser) throw new Refused('BAD_BROWSER_RESOURCE', 'browser capacity is acquired only as part of a gate lease; request name "gate" with browser: true');
  if (typeof item !== 'string' || typeof kind !== 'string') throw new Refused('BAD_RESOURCE_METADATA', 'resource item and kind metadata must be text');
  if (landing && itemCheck) throw new Refused('BAD_RESOURCE_PRIORITY', 'a gate slot cannot be both a landing and an item check');
  if (diagnostic && (landing || itemCheck)) throw new Refused('BAD_RESOURCE_PRIORITY', 'a diagnostic slot cannot also be a landing or an item check');
  const file = databaseFile(scope, root);
  const db = open(file, scope === 'machine');
  let pool;
  try { pool = canonicalResourceFile(file); }
  catch (error) { db.close(); throw error; }
  const resume = options._resume;
  const token = resume?.token ?? randomUUID();
  const requestedAt = resume?.requestedAt ?? Date.now();
  let priorWaitMs = resume?.priorWaitMs ?? 0;
  let waitStartedAt = resume?.waitStartedAt ?? Date.now();
  const pid = process.pid;
  const agent = options.agent ?? process.env.PULLBOARD_AGENT ?? `pid-${pid}`;
  const started = processStarted(pid);
  const repo = options.repo ?? repoRoot(root);
  let queuedAt = resume?.queuedAt ?? new Date().toISOString();
  try {
    let initialTicket = resume?.ticket;
    update(db, () => {
      const currentCapacity = options.capacityProvider?.() ?? capacity;
      if (!Number.isSafeInteger(currentCapacity) || currentCapacity < 1) throw new Refused('BAD_RESOURCE_CAPACITY', 'resource capacity must be a positive integer');
      const row = db.prepare('SELECT capacity FROM resource WHERE name = ?').get(name);
      if (row && row.capacity !== currentCapacity) {
        const state = snapshot(db, name);
        const activeHolders = name === 'gate' ? state.holders.filter(holder => !holder.runner).length : state.holders.length;
        if (!allowIdleCapacityUpdate || activeHolders || state.line.length) {
          throw new Refused('RESOURCE_CAPACITY_MISMATCH', `resource "${name}" already has capacity ${row.capacity}`);
        }
        db.prepare('UPDATE resource SET capacity = ? WHERE name = ?').run(currentCapacity, name);
      }
      db.prepare('INSERT INTO resource(name, capacity) VALUES (?, ?) ON CONFLICT(name) DO NOTHING').run(name, currentCapacity);
      if (name === 'gate' && scope === 'machine' && browser) {
        const browserCapacity = options.browserCapacityProvider?.() ?? 1;
        if (!Number.isSafeInteger(browserCapacity) || browserCapacity < 1 || browserCapacity > currentCapacity) {
          throw new Refused('BAD_BROWSER_SLOTS', `browser capacity must be a positive integer no greater than gate capacity (${currentCapacity}); run pullboard settings browserSlots <n>`);
        }
        const browserResource = db.prepare("SELECT capacity FROM resource WHERE name = 'browser'").get();
        if (browserResource && browserResource.capacity !== browserCapacity) {
          const state = snapshot(db, 'browser');
          if (!allowIdleCapacityUpdate || state.holders.length || state.line.length) {
            throw new Refused('RESOURCE_CAPACITY_MISMATCH', `resource "browser" already has capacity ${browserResource.capacity}`);
          }
          db.prepare("UPDATE resource SET capacity = ? WHERE name = 'browser'").run(browserCapacity);
        }
        db.prepare("INSERT INTO resource(name, capacity) VALUES ('browser', ?) ON CONFLICT(name) DO NOTHING").run(browserCapacity);
      }
      if (!resume) {
        // Remote eligibility is metadata on this same ticket; the kind and flags decide the
        // admission class, and the ticket keeps arrival order within it.
        const inserted = db.prepare('INSERT INTO waiter(token, name, pid, started, agent, repo, since, heartbeat, landing, item_check, diagnostic, browser, item, kind, remote, classed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)').run(token, name, pid, started, agent, repo, queuedAt, Date.now(), Number(landing), Number(itemCheck || diagnostic), Number(diagnostic), Number(browser), item, kind, Number(remote));
        initialTicket = Number(inserted.lastInsertRowid);
      }
    });
    while (true) {
      const acquired = update(db, () => {
        // The machine-settings provider performs a bounded local JSON read. Read it
        // after taking the same SQLite write lock used by updateRunnerSettings so an
        // older pre-lock snapshot cannot overwrite a newer configured capacity.
        const runners = runnerProvider ? validatedRunners(runnerProvider()) : [];
        const waiter = db.prepare('SELECT ticket FROM waiter WHERE token = ?').get(token);
        if (!waiter) {
          if (resume && initialTicket) {
            db.prepare('INSERT OR IGNORE INTO waiter(ticket, token, name, pid, started, agent, repo, since, heartbeat, landing, item_check, diagnostic, browser, item, kind, remote, classed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)').run(initialTicket, token, name, pid, started, agent, repo, queuedAt, Date.now(), Number(landing), Number(itemCheck || diagnostic), Number(diagnostic), Number(browser), item, kind, Number(remote));
            return { acquired: false, state: { ...snapshot(db, name), position: waiterPosition(db, name, initialTicket), rejoined: true } };
          }
          queuedAt = new Date().toISOString();
          const rejoined = db.prepare('INSERT INTO waiter(token, name, pid, started, agent, repo, since, heartbeat, landing, item_check, diagnostic, browser, item, kind, remote, classed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)').run(token, name, pid, started, agent, repo, queuedAt, Date.now(), Number(landing), Number(itemCheck || diagnostic), Number(diagnostic), Number(browser), item, kind, Number(remote));
          initialTicket = Number(rejoined.lastInsertRowid);
          return { acquired: false, state: { ...snapshot(db, name), position: waiterPosition(db, name, initialTicket), rejoined: true } };
        }
        db.prepare('UPDATE waiter SET heartbeat = ? WHERE token = ?').run(Date.now(), token);
        const spot = snapshot(db, name);
        const reportPosition = waiterPosition(db, name, waiter.ticket);
        const limit = db.prepare('SELECT capacity FROM resource WHERE name = ?').get(name).capacity;
        const executor = name === 'gate'
          ? gateAdmission(db, waiter.ticket, limit, runners)
          : (waiterPosition(db, name, waiter.ticket, { eligibleOnly: true }) === 1 && spot.holders.length < limit ? { host: '' } : null);
        if (executor) {
          db.prepare('DELETE FROM waiter WHERE token = ?').run(token);
          const acquiredAt = new Date().toISOString();
          const holderName = executor.host ? runnerResourceName(executor.host) : name;
          db.prepare('INSERT INTO holder(token, name, pid, started, agent, repo, since, heartbeat, landing, item_check, diagnostic, browser, item, kind, runner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(token, holderName, pid, started, agent, repo, acquiredAt, Date.now(), Number(landing), Number(itemCheck || diagnostic), Number(diagnostic), Number(browser), item, kind, executor.host);
          return { acquired: true, state: { ...spot, position: 0 }, ticket: waiter.ticket, runner: executor.host ? executor : undefined };
        }
        return { acquired: false, state: { ...spot, position: reportPosition } };
      });
      if (acquired.acquired) {
        const acquiredWaitMs = priorWaitMs + Math.max(0, Date.now() - waitStartedAt);
        let released = false;
        let transferred = false;
        let lost = false;
        let heartbeat;
        /** Keep the active holder lease alive while its executor is running. */
        const startHeartbeat = () => {
          heartbeat = setInterval(() => {
            if (released || transferred || lost) return;
            try {
              const changed = update(db, () => db.prepare('UPDATE holder SET heartbeat = ? WHERE token = ?').run(Date.now(), token).changes);
              if (!changed) { lost = true; clearInterval(heartbeat); }
            } catch { /* Lease expiry remains the crash fallback. */ }
          }, HEARTBEAT_MS);
          heartbeat.unref();
        };
        startHeartbeat();
        /** Release this holder and close its SQLite handle unless ownership was transferred. */
        const release = () => {
          if (released || transferred) return;
          released = true;
          clearInterval(heartbeat);
          try {
            update(db, () => db.prepare('DELETE FROM holder WHERE token = ?').run(token));
          }
          finally { db.close(); }
        };
        /** Refresh this lease, or refuse if another process already evicted it. */
        const renew = () => {
          if (released || transferred || lost) throw new Refused('RESOURCE_LEASE_LOST', `resource lease for "${name}" is no longer held`);
          const changed = update(db, () => db.prepare('UPDATE holder SET heartbeat = ? WHERE token = ?').run(Date.now(), token).changes);
          if (!changed) {
            lost = true;
            clearInterval(heartbeat);
            throw new Refused('RESOURCE_LEASE_LOST', `resource lease for "${name}" is no longer held`);
          }
        };
        /** Quarantine a failed remote host and retry this exact ticket on another executor. */
        const requeueRunner = async () => {
          if (!acquired.runner) throw new Refused('LOCAL_RUNNER_REQUEUE', 'only a remote lease can be returned to the runner queue');
          if (released || transferred || lost) throw new Refused('RESOURCE_LEASE_LOST', `resource lease for "${name}" is no longer held`);
          transferred = true;
          clearInterval(heartbeat);
          let requeueTicket = acquired.ticket;
          try {
            update(db, () => {
              db.prepare('INSERT INTO runner_unavailable(host, since, detail) VALUES (?, ?, ?) ON CONFLICT(host) DO UPDATE SET since = excluded.since, detail = excluded.detail')
                .run(acquired.runner.host, new Date().toISOString(), 'TRANSPORT_LOST');
              const holderName = runnerResourceName(acquired.runner.host);
              const holder = db.prepare('SELECT token FROM holder WHERE token = ? AND name = ? AND runner = ?').get(token, holderName, acquired.runner.host);
              if (!holder) throw new Refused('RESOURCE_LEASE_LOST', `remote lease for "${name}" is no longer held`);
              // Under the class order the run keeps its original arrival ticket, so first come, first
              // served holds within each class (and its queuedAt, so its aging). Under arrival order,
              // which an older pullboard waiting in the line forces, it takes #663's front ticket ahead
              // of its landing tier, as that older pullboard expects.
              if (classOrderInEffect(db.prepare("SELECT classed FROM waiter WHERE name = 'gate'").all())) requeueTicket = acquired.ticket;
              else {
                const minimumTicket = db.prepare("SELECT MIN(ticket) AS ticket FROM waiter WHERE name = 'gate' AND landing = ?").get(Number(landing)).ticket;
                requeueTicket = Math.min(0, minimumTicket ?? 0) - 1;
              }
              db.prepare('DELETE FROM holder WHERE token = ?').run(token);
              db.prepare('INSERT INTO waiter(ticket, token, name, pid, started, agent, repo, since, heartbeat, landing, item_check, diagnostic, browser, item, kind, remote, classed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)')
                .run(requeueTicket, token, name, pid, started, agent, repo, queuedAt, Date.now(), Number(landing), Number(itemCheck || diagnostic), Number(diagnostic), Number(browser), item, kind, Number(remote));
            });
          } catch (error) {
            transferred = false;
            startHeartbeat();
            throw error;
          }
          db.close();
          return takeResource({ ...options, _resume: { token, ticket: requeueTicket ?? acquired.ticket,
            queuedAt, requestedAt, priorWaitMs: acquiredWaitMs, waitStartedAt: Date.now() } });
        };
        return { name, scope, token, pool, browser, ...(acquired.runner ? { runner: acquired.runner } : {}),
          waitMs: acquiredWaitMs, release, renew,
          ...(acquired.runner ? { requeueRunner } : {}) };
      }
      options.onWait?.(acquired.state);
      await pause(POLL_MS);
    }
  } catch (error) {
    try { update(db, () => db.prepare('DELETE FROM waiter WHERE token = ?').run(token)); } catch { /* Preserve the original error. */ }
    db.close();
    throw error;
  }
}

/** Reuse a same-machine gate lease in a child without queueing or acquiring a partial browser slot. */
export function inheritedGateSlot({ root = process.cwd(), browser = false } = {}) {
  const markedPool = process.env[GATE_SLOT_POOL_ENV] ?? '';
  const token = process.env[GATE_SLOT_TOKEN_ENV] ?? '';
  if (!markedPool && !token) return null;
  if (!markedPool) throw new Refused('GATE_SLOT_MARKER_INVALID', 'the inherited gate token has no pool marker; start the child with gateSlotEnvironment(lease)');
  const pool = canonicalResourceFile(machineResourceFile());
  // A process with a different PULLBOARD_MACHINE_HOME is independent and must join its own queue.
  if (canonicalResourceFile(markedPool) !== pool) return null;
  if (process.env[GATE_SLOT_HELD_ENV] !== '1') throw new Refused('GATE_SLOT_MARKER_INVALID', 'the inherited gate lease is missing its legacy held marker; start the child with gateSlotEnvironment(lease)');
  if (!token) throw new Refused('GATE_SLOT_TOKEN_REQUIRED', 'the inherited gate pool marker has no lease token; restart the child with gateSlotEnvironment(lease)');
  const db = open(pool, true);
  let holder;
  try {
    holder = update(db, () => db.prepare("SELECT browser FROM holder WHERE name = 'gate' AND token = ?").get(token));
  } finally { db.close(); }
  if (!holder) throw new Refused('GATE_SLOT_LEASE_LOST', 'the inherited gate lease is missing or expired; remove stale gate markers or let the parent reacquire the gate slot');
  const expectedBrowserMarker = holder.browser === 1 ? '1' : '';
  if (process.env[BROWSER_SLOT_HELD_ENV] !== expectedBrowserMarker) throw new Refused('GATE_SLOT_MARKER_INVALID', 'the inherited browser marker does not match its live gate lease; restart the child with gateSlotEnvironment(lease)');
  if (browser && holder.browser !== 1) throw new Refused('BROWSER_SLOT_REQUIRED', 'the inherited gate lease does not hold the browser slot; release it and reacquire gate with browser: true before launching Chrome');
  return {
    name: 'gate', scope: 'machine', token, pool, browser: holder.browser === 1, waitMs: 0,
    release() {}, renew() {},
  };
}

/** Change a resource's capacity only while its queue is empty, persisting related settings under the same lock. */
export function setResourceCapacity({ name, capacity, scope = 'machine', root = process.cwd(), persist = () => {} }) {
  if (typeof name !== 'string' || !name.trim() || name.trim() !== name) throw new Refused('BAD_RESOURCE_NAME', 'resource name must be nonempty trimmed text');
  if (name.startsWith('runner:')) throw new Refused('RESERVED_RUNNER_RESOURCE', 'runner resource rows are managed by the machine gate; use runner settings');
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Refused('BAD_RESOURCE_CAPACITY', 'resource capacity must be a positive integer');
  const db = open(databaseFile(scope, root), scope === 'machine');
  try {
    return update(db, () => {
      const state = snapshot(db, name);
      if (state.holders.length || state.line.length) {
        throw new Refused('RESOURCE_BUSY', `resource "${name}" has ${state.holders.length} holder(s) and ${state.line.length} waiter(s); wait for it to become idle, then retry pullboard settings ${name === 'browser' ? 'browserSlots' : 'gateSlots'} ${capacity}`);
      }
      persist();
      db.prepare('INSERT INTO resource(name, capacity) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET capacity = excluded.capacity').run(name, capacity);
      return { name, capacity };
    });
  } finally { db.close(); }
}

/** List resources and prune leases whose process died or lease expired. */
export function listResources({ scope = 'machine', root = process.cwd() } = {}) {
  const db = open(databaseFile(scope, root), scope === 'machine');
  try {
    return update(db, () => db.prepare('SELECT name, capacity FROM resource ORDER BY name').all().map(({ name, capacity }) => ({ name, capacity, ...snapshot(db, name) })));
  } finally { db.close(); }
}
