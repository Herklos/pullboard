/** Standalone SSH runner worker source; intentionally imports only Node built-ins. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';

const RECEIPT = 'PULLBOARD_RUNNER_RESULT';
const safePath = [dirname(process.execPath), process.env.PATH || '/usr/local/bin:/usr/bin:/bin'].join(delimiter);
const ownedChildren = new Map();
let transportLost = false;
let transportDrain = null;
let signalCustodyInstalled = false;
let transportDrop = () => {};
let heartbeatTimer = null;
let workerId = 'starting';
let rejectPendingFrame = null;
let activeDescendantTracker = null;
// Budget: report a named failure within 30 seconds after command exit or transport cancellation.
const CLEANUP_BUDGET_MS = 30_000;
let cleanupDeadline = Infinity;
let cleanupTimedOut = false;

/** Start the post-run budget once; later cleanup phases cannot extend it. */
function beginCleanup() {
  cleanupDeadline = Math.min(cleanupDeadline, Date.now() + CLEANUP_BUDGET_MS);
}

/** Report an unresolved cleanup once so the controller can fail without retrying the command. */
function reportCleanupTimeout() {
  if (cleanupTimedOut || Date.now() < cleanupDeadline) return;
  cleanupTimedOut = true;
  process.stderr.write(`PULLBOARD_RUNNER_CLEANUP_TIMEOUT ${workerId}\n`);
}

/** Parse and strictly validate the controller's one-shot work specification. */
async function readSpec() {
  let buffered = Buffer.alloc(0);
  let expected = null;
  let headerLength = null;
  const spec = await new Promise((resolve, reject) => {
    const cleanup = () => { process.stdin.off('data', onData); process.stdin.off('end', onEnd); process.stdin.off('error', onError); };
    rejectPendingFrame = error => { cleanup(); reject(error); };
    const onError = error => { cleanup(); reject(error); };
    const onEnd = () => { cleanup(); reject(new Error('incomplete work specification')); };
    const onData = chunk => {
      if (transportLost) { cleanup(); reject(new Error('runner transport was lost')); return; }
      buffered = Buffer.concat([buffered, chunk]);
      if (expected === null) {
        const newline = buffered.indexOf(10);
        if (newline < 0) {
          if (buffered.length > 9 || !/^\d*$/u.test(buffered.toString('ascii'))) { cleanup(); reject(new Error('invalid work specification frame')); }
          return;
        }
        const header = buffered.subarray(0, newline).toString('ascii');
        if (!/^\d{1,8}$/u.test(header)) { cleanup(); reject(new Error('invalid work specification frame')); return; }
        expected = Number(header);
        headerLength = newline + 1;
        if (!expected || expected > 1_048_576) { cleanup(); reject(new Error('invalid work specification frame')); return; }
      }
      if (buffered.length < headerLength + expected) return;
      const body = buffered.subarray(headerLength, headerLength + expected);
      const rest = buffered.subarray(headerLength + expected);
      cleanup();
      rejectPendingFrame = null;
      process.stdin.pause();
      if (rest.length) process.stdin.unshift(rest);
      try { resolve(JSON.parse(body.toString('utf8'))); } catch (error) { reject(error); }
    };
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('error', onError);
    process.stdin.resume();
  });
  const value = spec;
  if (!value || value.version !== 1 || !/^[A-Za-z0-9_-]{1,100}$/u.test(value.id)
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.commit)
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.tree)
    || value.commit.length !== value.tree.length
    || !/^[a-f0-9]{64}$/u.test(value.repoId ?? '')
    || typeof value.command !== 'string' || !value.command.trim()
    || typeof value.pipefail !== 'boolean' || !Number.isSafeInteger(value.slots) || value.slots < 1
    || !Number.isSafeInteger(value.browser) || value.browser < 0
    || typeof value.browserRequired !== 'boolean'
    || !value.runtime || typeof value.runtime !== 'object' || !value.runtime.files || typeof value.runtime.files !== 'object'
    || typeof value.runtime.sha256 !== 'string') throw new Error('invalid work specification');
  if (value.origin !== undefined) {
    if (typeof value.origin !== 'string') throw new Error('invalid work specification');
    let origin;
    try { origin = new URL(value.origin); } catch { throw new Error('invalid work specification'); }
    if (origin.protocol !== 'https:' || !origin.hostname || origin.username || origin.password || origin.search || origin.hash) {
      throw new Error('invalid work specification');
    }
  }
  if (value.originBase !== undefined
    && (typeof value.originBase !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.originBase)
      || value.originBase.length !== value.commit.length || !value.origin)) throw new Error('invalid work specification');
  const runtimeNames = ['resources.js', 'git.js', 'machine-home.js', 'refused.js'];
  if (Object.keys(value.runtime.files).length !== runtimeNames.length
    || runtimeNames.some(name => typeof value.runtime.files[name] !== 'string')) throw new Error('invalid work specification');
  if (createHash('sha256').update(JSON.stringify(value.runtime.files)).digest('hex') !== value.runtime.sha256) throw new Error('invalid trusted runtime');
  const workerFlag = process.execArgv.indexOf('-e');
  const workerSource = workerFlag >= 0 ? process.execArgv[workerFlag + 1] : null;
  const toolingFiles = { ...value.runtime.files, 'runner-worker.js': workerSource };
  if (!workerSource || !value.tooling || !['git-checkout', 'installed-package'].includes(value.tooling.kind)
    || value.tooling.name !== 'pullboard' || typeof value.tooling.version !== 'string'
    || createHash('sha256').update(JSON.stringify(toolingFiles)).digest('hex') !== value.tooling.sha256) {
    throw new Error('invalid trusted tooling identity');
  }
  for (const field of ['landing', 'itemCheck', 'diagnostic']) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') throw new Error('invalid work specification');
  }
  for (const field of ['item', 'kind']) {
    if (value[field] !== undefined && typeof value[field] !== 'string') throw new Error('invalid work specification');
  }
  if (value.root !== undefined && (typeof value.root !== 'string' || !isAbsolute(value.root))) throw new Error('invalid work specification');
  return value;
}

/** Construct a minimal environment from runner-owned values, excluding caller credentials and markers. */
function childEnvironment(home, temporary, machineHomePath = '', nodeOptions = '') {
  return {
    PATH: safePath,
    HOME: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    LANG: process.env.LANG || 'C.UTF-8',
    TZ: process.env.TZ || 'UTC',
    CI: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    NPM_CONFIG_USERCONFIG: join(home, 'npm-userconfig'),
    NPM_CONFIG_GLOBALCONFIG: join(home, 'npm-globalconfig'),
    ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
    ...(machineHomePath ? { PULLBOARD_MACHINE_HOME: machineHomePath } : {}),
  };
}

/** Add this worker's remote gate lease so nested test runners reuse the remote slot instead of deadlocking. */
function scopedEnvironment(home, temporary, machineHomePath, gateLease, resourcesApi, nodeOptions = '') {
  return {
    ...childEnvironment(home, temporary, machineHomePath, nodeOptions),
    ...resourcesApi.gateSlotEnvironment(gateLease),
  };
}

/** Install the trusted resource implementation supplied and hashed by the controller. */
async function loadResourceApi(runnerRoot, runtime) {
  const directory = join(runnerRoot, 'runtime', runtime.sha256);
  const parent = dirname(directory);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const build = mkdtempSync(join(parent, `${runtime.sha256}.build-`));
  try {
    const sourceDirectory = join(build, 'src');
    mkdirSync(sourceDirectory, { mode: 0o700 });
    writeFileSync(join(build, 'package.json'), '{"type":"module"}\n', { mode: 0o600 });
    for (const [name, source] of Object.entries(runtime.files)) writeFileSync(join(sourceDirectory, name), source, { mode: 0o600 });
    try { renameSync(build, directory); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
    }
    // Concurrent workers reuse only a complete, byte-identical trusted module graph.
    if (readFileSync(join(directory, 'package.json'), 'utf8') !== '{"type":"module"}\n'
      || Object.entries(runtime.files).some(([name, source]) => readFileSync(join(directory, 'src', name), 'utf8') !== source)) {
      throw new Error('trusted runtime cache does not match the request');
    }
  } finally { rmSync(build, { recursive: true, force: true }); }
  const sourceDirectory = join(directory, 'src');
  return import(pathToFileURL(join(sourceDirectory, 'resources.js')).href);
}

/** Start a subprocess in a private process group so this worker can drain only its own descendants. */
function spawnOwned(command, args, options = {}) {
  assertTransportLive();
  const child = spawn(command, args, { ...options, detached: true });
  let settle;
  const closed = new Promise(resolveClose => { settle = resolveClose; });
  const record = { child, pid: child.pid, closed, drainPromise: null };
  ownedChildren.set(child, record);
  activeDescendantTracker?.registerRoot(child.pid);
  child.once('error', error => settle({ error }));
  child.once('close', (code, signal) => settle({ code, signal }));
  return record;
}

/** Read one all-process POSIX census; a failed or malformed census is never interpreted as an empty machine. */
function processCensus() {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,stat=,comm='], {
    encoding: 'utf8', timeout: 2_000, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: safePath, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  const rows = new Map();
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2})\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})\s+(\S+)\s+(.+?)\s*$/u.exec(line);
    if (!match) return null;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const pgid = Number(match[3]);
    if (![pid, ppid, pgid].every(Number.isSafeInteger) || pid < 1 || ppid < 0 || pgid < 1 || rows.has(pid)) return null;
    const started = `${match[4]} ${match[5]} ${match[6]} ${match[7]} ${match[8]}`;
    const processSha256 = createHash('sha256').update(match[10]).digest('hex');
    rows.set(pid, { pid, ppid, pgid, started, state: match[9], processSha256 });
  }
  return rows.size ? rows : null;
}

/** Add a kernel start-time identity when procfs is available; otherwise retain a conservative census tuple. */
function processIdentity(row) {
  let birth = '';
  let exact = false;
  try {
    const stat = readFileSync(`/proc/${row.pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).trim().split(/\s+/u);
    if (close > 0 && Number(fields[1]) === row.ppid && Number(fields[2]) === row.pgid && /^\d+$/u.test(fields[19] ?? '')) {
      birth = `proc:${fields[19]}`;
      exact = true;
    }
  } catch { /* macOS and other POSIX hosts use the validated census tuple below. */ }
  if (!birth) birth = `ps:${row.started}`;
  return { ...row, birth, exact };
}

/** Make a private Node preload that records only child identity and a one-way command digest. */
function writeChildJournalPreload(directory) {
  const journalDirectory = join(directory, 'child-journal');
  mkdirSync(journalDirectory, { mode: 0o700 });
  const overflowPath = join(journalDirectory, 'overflow');
  const source = `
import diagnostics from 'node:diagnostics_channel';
import { closeSync, openSync, statSync, writeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const directory = ${JSON.stringify(journalDirectory)};
const overflowPath = ${JSON.stringify(overflowPath)};
const instance = randomUUID();
process.env.PULLBOARD_RUNNER_INSTANCE = instance;
const file = join(directory, 'children-' + process.pid + '.jsonl');
const fd = openSync(file, 'a', 0o600);
let bytes = statSync(file).size;
let overflow = false;
const limit = 131072;
function record(value) {
  if (overflow) return;
  try {
    const line = JSON.stringify(value) + '\\n';
    const size = Buffer.byteLength(line);
    if (bytes + size > limit) {
      overflow = true;
      try { writeFileSync(overflowPath, 'journal limit reached\\n', { flag: 'wx', mode: 0o600 }); } catch {}
      return;
    }
    writeSync(fd, line);
    bytes += size;
  } catch {
    try { writeFileSync(overflowPath, 'journal write failed\\n', { flag: 'wx', mode: 0o600 }); } catch {}
    overflow = true;
  }
}
record({ type: 'boot', pid: process.pid, ppid: process.ppid, instance });
const channel = diagnostics.channel('child_process');
const seen = new WeakSet();
channel.subscribe(message => {
  try {
    const child = message?.process;
    if (!child || typeof child.once !== 'function' || seen.has(child)) return;
    seen.add(child);
    const writeReceipt = () => {
      if (!Number.isSafeInteger(child.pid) || child.pid < 1) return;
      const commandSha256 = createHash('sha256').update(JSON.stringify({ command: child.spawnfile ?? '', args: child.spawnargs ?? [] })).digest('hex');
      record({ type: 'spawn', pid: child.pid, ppid: process.pid, instance, commandSha256 });
    };
    if (Number.isSafeInteger(child.pid)) writeReceipt();
    else child.once('spawn', writeReceipt);
  } catch {
    try { writeFileSync(overflowPath, 'child receipt could not be recorded\\n', { flag: 'wx', mode: 0o600 }); } catch {}
  }
});
process.once('exit', () => { try { closeSync(fd); } catch {} });
`;
  const preload = join(directory, 'child-spawn-preload.mjs');
  writeFileSync(preload, source, { mode: 0o600, flag: 'wx' });
  return { preload, journalDirectory, overflowPath, nodeOptions: `--import=${pathToFileURL(preload).href}` };
}

/** Track job descendants by PID plus OS start identity, joining spawn receipts with fresh census rows. */
function createDescendantTracker(directory) {
  const initial = processCensus();
  if (!initial) throw new Error('initial process identity census failed');
  const baseline = new Map([...initial].map(([pid, row]) => [pid, processIdentity(row)]));
  const journal = writeChildJournalPreload(directory);
  const roots = new Set();
  const rootLaunchIdentities = new Map();
  const known = new Map();
  const retired = new Set();
  const eventsByChild = new Map();
  const pendingIdentities = new Map();
  const consumedEvents = new Set();
  let eventCount = 0;
  const detachedGroups = new Map();
  const offsets = new Map();
  const partial = new Map();
  const instancePids = new Map();
  const overflowPath = journal.overflowPath;
  let current = baseline;
  let uncertain = false;
  let censusFailure = false;
  let reason = '';
  let busy = false;
  let warned = false;
  let timer = null;
  let stoppingPromise = null;

  function readJournal() {
    if (existsSync(overflowPath)) { uncertain = true; reason ||= 'child spawn journal overflow or write failure'; }
    let total = 0;
    const files = readdirSync(journal.journalDirectory).filter(name => /^children-\d+\.jsonl$/u.test(name)).sort();
    if (files.length > 10_000) { uncertain = true; reason ||= 'child spawn journal file limit exceeded'; return; }
    for (const name of files) {
      const file = join(journal.journalDirectory, name);
      let size;
      try { size = statSync(file).size; } catch { uncertain = true; reason ||= 'child spawn journal could not be inspected'; continue; }
      total += size;
      if (!Number.isSafeInteger(size) || size > 131_072 || total > 8 * 1024 * 1024) {
        uncertain = true; reason ||= 'child spawn journal size limit exceeded'; continue;
      }
      const offset = offsets.get(name) ?? 0;
      if (size < offset) { uncertain = true; reason ||= 'child spawn journal changed unexpectedly'; continue; }
      if (size === offset) continue;
      const length = size - offset;
      const fd = openSync(file, 'r');
      let text;
      try {
        const bytes = Buffer.alloc(length);
        const read = readSync(fd, bytes, 0, length, offset);
        if (read !== length) { uncertain = true; reason ||= 'child spawn journal read was incomplete'; continue; }
        text = (partial.get(name) ?? '') + bytes.toString('utf8');
      } finally { closeSync(fd); }
      offsets.set(name, size);
      const lines = text.split('\n');
      partial.set(name, lines.pop() ?? '');
      for (const line of lines) {
        if (!line) continue;
        if (line.length > 4_096) { uncertain = true; reason ||= 'child spawn journal record is oversized'; continue; }
        let record;
        try { record = JSON.parse(line); } catch { uncertain = true; reason ||= 'child spawn journal record is invalid'; continue; }
        if (record.type === 'boot' && Number.isSafeInteger(record.pid) && record.pid > 0 && typeof record.instance === 'string') {
          instancePids.set(record.instance, record.pid);
        } else if (record.type === 'spawn' && Number.isSafeInteger(record.pid) && record.pid > 0
          && Number.isSafeInteger(record.ppid) && record.ppid > 0
          && typeof record.instance === 'string' && /^[a-f0-9]{64}$/u.test(record.commandSha256)) {
          const childEvents = eventsByChild.get(record.pid) ?? [];
          eventCount += 1;
          childEvents.push({ ...record, eventId: `${name}:${eventCount}` });
          eventsByChild.set(record.pid, childEvents);
          if (eventCount > 100_000) { uncertain = true; reason ||= 'child spawn journal event limit exceeded'; return; }
        } else { uncertain = true; reason ||= 'child spawn journal identity is invalid'; }
      }
    }
  }

  function observe() {
    if (busy) return current;
    busy = true;
    try {
      readJournal();
      const rawCensus = processCensus();
      if (!rawCensus) { censusFailure = true; return null; }
      censusFailure = false;
      const census = new Map([...rawCensus].map(([pid, row]) => [pid, processIdentity(row)]));
      current = census;
      // A process first seen without its recorded parent stays unowned while alive.
      // Once a later census proves that exact birth identity gone, retire its receipts
      // so a reused PID cannot be adopted from stale launch evidence.
      for (const [pid, pending] of pendingIdentities) {
        const row = current.get(pid);
        if (row?.birth === pending.birth && !/^Z/u.test(row.state)) continue;
        for (const eventId of pending.eventIds) consumedEvents.add(eventId);
        pendingIdentities.delete(pid);
      }
      for (const [pid, identity] of known) {
        const row = current.get(pid);
        if (!row || row.birth !== identity.birth) retired.add(`${pid}:${identity.birth}`);
        else if (retired.has(`${pid}:${identity.birth}`)) {
          uncertain = true; reason ||= 'a previously observed process identity reappeared';
        }
      }
      const ownedPids = new Set();
      for (const pid of roots) {
        const row = current.get(pid);
        if (!row) continue;
        const prior = known.get(pid);
        const launched = rootLaunchIdentities.get(pid);
        if (prior && prior.birth !== row.birth) continue;
        if (launched && launched.birth !== row.birth) continue;
        if (!launched && row.ppid !== process.pid) continue;
        if (!launched && row.pgid !== pid) continue;
        if (retired.has(`${pid}:${row.birth}`)) { uncertain = true; reason ||= 'a retired process identity reappeared'; continue; }
        if (!launched) rootLaunchIdentities.set(pid, row);
        known.set(pid, { ...row, commandSha256: prior?.commandSha256 ?? '', root: true, group: pid });
        ownedPids.add(pid);
      }

      for (const row of current.values()) {
        if (/^Z/u.test(row.state)) continue;
        for (const event of eventsByChild.get(row.pid) ?? []) {
          if (consumedEvents.has(event.eventId)) continue;
          const parentPid = instancePids.get(event.instance);
          // A preload instance exists only in the private job environment. The receipt
          // binds its child to that exact process instance even after the parent exits.
          if (!parentPid || parentPid !== event.ppid) continue;
          const prior = known.get(row.pid);
          if (retired.has(`${row.pid}:${row.birth}`)) { uncertain = true; reason ||= 'a retired process identity reappeared'; continue; }
          if (prior && prior.birth === row.birth) { consumedEvents.add(event.eventId); ownedPids.add(row.pid); continue; }
          if (!prior && baseline.get(row.pid)?.birth === row.birth) { consumedEvents.add(event.eventId); continue; }
          // A spawn receipt must be observed while its exact parent instance still owns it.
          // A same-numbered PID first seen after reparenting is ambiguous and never adopted.
          if (row.ppid !== event.ppid) {
            const pending = pendingIdentities.get(row.pid);
            if (!pending || pending.birth !== row.birth) pendingIdentities.set(row.pid, { birth: row.birth, eventIds: new Set() });
            pendingIdentities.get(row.pid).eventIds.add(event.eventId);
            consumedEvents.add(event.eventId);
            reason ||= 'spawned process was first observed after reparenting';
            continue;
          }
          if (!ownedPids.has(event.ppid)) {
            pendingIdentities.set(row.pid, { birth: row.birth, eventIds: new Set([event.eventId]) });
            consumedEvents.add(event.eventId);
            reason ||= 'spawn receipt parent has not been independently identified';
            continue;
          }
          const parent = known.get(event.ppid);
          const inheritedGroup = parent?.group ?? [...roots].find(rootPid => known.get(rootPid)?.group === row.pgid);
          const group = row.pgid === row.pid ? row.pid : inheritedGroup;
          if (group === undefined) {
            pendingIdentities.set(row.pid, { birth: row.birth, eventIds: new Set([event.eventId]) });
            consumedEvents.add(event.eventId);
            reason ||= 'spawned process group has no owned parent';
            continue;
          }
          if (row.pgid === row.pid) detachedGroups.set(row.pid, row.birth);
          known.set(row.pid, { ...row, commandSha256: event.commandSha256, root: false, group });
          consumedEvents.add(event.eventId);
          pendingIdentities.delete(row.pid);
          ownedPids.add(row.pid);
        }
      }

      // Process ancestry captures non-Node children; journal receipts retain ownership after reparenting.
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of current.values()) {
          if (!ownedPids.has(row.ppid)) continue;
          const prior = known.get(row.pid);
          if (retired.has(`${row.pid}:${row.birth}`)) { uncertain = true; reason ||= 'a retired process identity reappeared'; continue; }
          if (prior && prior.birth === row.birth) { ownedPids.add(row.pid); continue; }
          if (!prior && baseline.get(row.pid)?.birth === row.birth) continue;
          const parent = known.get(row.ppid);
          const group = row.pgid === row.pid ? row.pid : parent?.group;
          if (group === undefined) {
            pendingIdentities.set(row.pid, { birth: row.birth, eventIds: new Set() });
            reason ||= 'descendant process group has no owned parent';
            continue;
          }
          if (row.pgid === row.pid) detachedGroups.set(row.pid, row.birth);
          known.set(row.pid, { ...row, commandSha256: '', root: false, group });
          pendingIdentities.delete(row.pid);
          ownedPids.add(row.pid); changed = true;
        }
      }
      // Detached children establish a private process group; census every member even
      // after the original launcher is reparented or exits.
      for (const row of current.values()) {
        if (/^Z/u.test(row.state)) continue;
        const leaderStarted = detachedGroups.get(row.pgid);
        if (!leaderStarted) continue;
        const leader = current.get(row.pgid);
        if (leader && leader.birth !== leaderStarted) {
          uncertain = true; reason ||= 'detached process group identity was reused';
          continue;
        }
        const prior = known.get(row.pid);
        if (retired.has(`${row.pid}:${row.birth}`)) { uncertain = true; reason ||= 'a retired process identity reappeared'; continue; }
        if (prior && prior.birth === row.birth) { ownedPids.add(row.pid); continue; }
        if (!prior && baseline.get(row.pid)?.birth === row.birth) continue;
        if ((!prior || prior.birth !== row.birth) && !ownedPids.has(row.ppid)) {
          pendingIdentities.set(row.pid, { birth: row.birth, eventIds: new Set() });
          reason ||= 'detached process group contains an unidentified member';
          continue;
        }
        known.set(row.pid, { ...row, commandSha256: '', root: false, group: row.pgid });
        ownedPids.add(row.pid);
      }
      // A recorded PGID does not prove an unseen member belongs to this job. Keep
      // the lease fail-closed when a root group contains a process lacking identity evidence.
      for (const rootPid of roots) {
        for (const row of current.values()) {
          if (row.pgid !== rootPid || /^Z/u.test(row.state)) continue;
          const identity = known.get(row.pid);
          if (identity?.birth === row.birth) continue;
          if (baseline.get(row.pid)?.birth === row.birth) continue;
          pendingIdentities.set(row.pid, { birth: row.birth, eventIds: new Set() });
          reason ||= 'owned process group contains an unidentified member';
        }
      }
      if (known.size > 100_000) { uncertain = true; reason ||= 'owned process identity limit exceeded'; }
      // Refresh live PGID/start data only when the PID still has the same start identity.
      for (const pid of ownedPids) {
        const row = current.get(pid);
        const prior = known.get(pid);
        if (row && prior?.birth === row.birth) Object.assign(prior, row);
      }
      return current;
    } catch {
      censusFailure = true; return null;
    } finally { busy = false; }
  }

  function registerRoot(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) return;
    roots.add(pid);
    // Bind the spawned leader while its actual parent is still this worker; later
    // group membership alone is never sufficient to adopt an unknown process.
    const census = processCensus();
    const row = census?.get(pid);
    if (row && row.ppid === process.pid && row.pgid === pid) rootLaunchIdentities.set(pid, processIdentity(row));
  }

  function liveDescendants() {
    const active = [];
    for (const [pid, identity] of known) {
      if (identity.root) continue;
      const row = current.get(pid);
      if (row && row.birth === identity.birth && !retired.has(`${pid}:${identity.birth}`) && !/^Z/u.test(row.state)) active.push({ ...identity });
    }
    return active;
  }

  function signalOwnedGroup(pgid, signal) {
    const census = observe();
    reportCleanupTimeout();
    if (!census || censusFailure) return null;
    // A journal error does not revoke known ownership, but an unidentified live
    // member prevents signaling the whole group until its identity is resolved.
    if ([...pendingIdentities].some(([pid, identity]) => {
      const row = current.get(pid);
      return row?.pgid === pgid && row.birth === identity.birth && !/^Z/u.test(row.state);
    })) return null;
    const ownedMember = [...known].some(([pid, identity]) => {
      const row = current.get(pid);
      return row && row.pgid === pgid && row.birth === identity.birth && !/^Z/u.test(row.state);
    });
    if (!ownedMember) return false;
    try { process.kill(-pgid, signal); }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    return true;
  }

  async function stopDescendantsLoop() {
    // Retry through ambiguous censuses rather than releasing the host lease on an unproven drain.
    for (;;) {
      const census = observe();
      reportCleanupTimeout();
      if (!census) {
        if (!warned) { process.stderr.write(`PULLBOARD_RUNNER_CLEANUP_UNVERIFIED ${workerId} ${reason}\n`); warned = true; }
        await new Promise(resolvePause => setTimeout(resolvePause, 1_000));
        continue;
      }
      if (censusFailure) { await new Promise(resolvePause => setTimeout(resolvePause, 250)); continue; }
      const live = liveDescendants();
      if (!live.length && !pendingIdentities.size && (!uncertain || cleanupTimedOut)) return;
      if ((pendingIdentities.size || uncertain) && !warned) {
        process.stderr.write(`PULLBOARD_RUNNER_CLEANUP_UNVERIFIED ${workerId} ${reason || 'unresolved process identity remains live'}\n`);
        warned = true;
      }
      if (!live.length) { await new Promise(resolvePause => setTimeout(resolvePause, 250)); continue; }
      // Signal each confirmed owned process group once; use PID signals only with exact kernel identity.
      const signaledGroups = new Set();
      for (const identity of live) {
        const row = current.get(identity.pid);
        if (!row || row.birth !== identity.birth || retired.has(`${identity.pid}:${identity.birth}`) || /^Z/u.test(row.state)) continue;
        const ownedGroup = identity.group;
        if (Number.isSafeInteger(ownedGroup) && row.pgid === ownedGroup && !signaledGroups.has(ownedGroup)) {
          const result = signalOwnedGroup(ownedGroup, 'SIGTERM');
          if (result === null) { censusFailure = true; break; }
          if (result) signaledGroups.add(ownedGroup);
          continue;
        }
        if (!identity.exact) { uncertain = true; reason ||= 'descendant lacks a safe process-group identity'; break; }
        try { process.kill(identity.pid, 'SIGTERM'); }
        catch (error) { if (error.code !== 'ESRCH') { uncertain = true; reason ||= 'owned descendant could not be stopped safely'; } }
      }
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        await new Promise(resolvePause => setTimeout(resolvePause, 50));
        if (!observe()) break;
        if (!liveDescendants().length) break;
      }
      if (!current || !liveDescendants().length) continue;
      const killedGroups = new Set();
      for (const identity of liveDescendants()) {
        const row = current.get(identity.pid);
        if (!row || row.birth !== identity.birth || retired.has(`${identity.pid}:${identity.birth}`) || /^Z/u.test(row.state)) continue;
        const ownedGroup = identity.group;
        if (Number.isSafeInteger(ownedGroup) && row.pgid === ownedGroup && !killedGroups.has(ownedGroup)) {
          const result = signalOwnedGroup(ownedGroup, 'SIGKILL');
          if (result === null) { censusFailure = true; break; }
          if (result) killedGroups.add(ownedGroup);
          continue;
        }
        if (!identity.exact) { uncertain = true; reason ||= 'descendant lacks a safe process-group identity'; break; }
        try { process.kill(identity.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') { uncertain = true; reason ||= 'owned descendant could not be killed safely'; } }
      }
      await new Promise(resolvePause => setTimeout(resolvePause, 100));
    }
  }

  function stopDescendants() {
    if (!stoppingPromise) {
      stoppingPromise = stopDescendantsLoop().finally(() => { stoppingPromise = null; });
    }
    return stoppingPromise;
  }

  async function verifyAfterGroups() {
    for (;;) {
      const census = observe();
      reportCleanupTimeout();
      if (census && (!uncertain || cleanupTimedOut) && !censusFailure) {
        const liveRoots = [...roots].some(pid => {
          const row = current.get(pid);
          const knownRoot = known.get(pid);
          return row && knownRoot?.birth === row.birth && !/^Z/u.test(row.state);
        });
        if (!liveRoots && !liveDescendants().length && !pendingIdentities.size) return;
      }
      if (!warned) { process.stderr.write(`PULLBOARD_RUNNER_CLEANUP_UNVERIFIED ${workerId} ${reason || 'owned process identity remains live'}\n`); warned = true; }
      await new Promise(resolvePause => setTimeout(resolvePause, 1_000));
    }
  }

  timer = setInterval(() => { if (!busy) observe(); }, 250);
  timer.unref();
  return {
    nodeOptions: journal.nodeOptions,
    registerRoot,
    stopDescendants,
    /** Revalidate a process group immediately before signaling; null means census ambiguity. */
    signalOwnedGroup,
    verifyAfterGroups,
    stopMonitoring() { clearInterval(timer); },
  };
}

/** Stop and fully drain one owned process group before its gate lease can be released. */
function drainOwned(record, terminate = false, tracker = activeDescendantTracker) {
  if (!record) return Promise.resolve();
  record.drainPromise ??= (async () => {
    if (terminate) await stopOwnedGroup(record.pid, record.closed, tracker);
    else {
      await record.closed;
      await stopOwnedGroup(record.pid, record.closed, tracker);
    }
    ownedChildren.delete(record.child);
  })();
  return record.drainPromise;
}

/** Install disconnect custody before receiving the pack or starting any setup subprocess. */
function installSignalCustody() {
  if (signalCustodyInstalled) return;
  signalCustodyInstalled = true;
  const disconnected = () => {
    if (transportLost) return;
    transportLost = true;
    beginCleanup();
    rejectPendingFrame?.(new Error('runner transport was lost'));
    clearInterval(heartbeatTimer);
    const active = [...ownedChildren.values()];
    transportDrain = (async () => {
      await activeDescendantTracker?.stopDescendants();
      await Promise.all(active.map(record => drainOwned(record, true)));
      await activeDescendantTracker?.verifyAfterGroups();
    })();
    transportDrain.catch(() => {});
  };
  transportDrop = disconnected;
  process.on('SIGHUP', disconnected);
  process.on('SIGTERM', disconnected);
  process.stdin.on('error', disconnected);
  process.stdout.on('error', disconnected);
  process.stderr.on('error', disconnected);
  let heartbeatPending = false;
  heartbeatTimer = setInterval(() => {
    if (transportLost || heartbeatPending) return;
    heartbeatPending = true;
    process.stderr.write(`PULLBOARD_RUNNER_HEARTBEAT ${workerId}\n`, error => {
      heartbeatPending = false;
      if (error) disconnected();
    });
  }, 5_000);
  heartbeatTimer.unref();
}

/** Stop queue/setup work promptly after the controller's transport disappears. */
function assertTransportLive() {
  if (transportLost) throw new Error('runner transport was lost');
}

/** Wait for every owned group, terminating any still present after its leader exits. */
async function drainAllOwned() {
  await Promise.all([...ownedChildren.values()].map(record => drainOwned(record, transportLost)));
  if (transportDrain) await transportDrain;
}

/** Select only the explicit pool while acquiring its lease; restore the worker environment afterward. */
async function acquireResourceApi(api, options, machineHomePath) {
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = machineHomePath;
  try { return await api.takeResource(options); }
  finally {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
  }
}

/** Invoke one bounded Git command in an owned group and return its exact stdout. */
async function git(root, args, env) {
  const owned = spawnOwned('git', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'ignore'] });
  const output = [];
  let bytes = 0;
  let overflow = false;
  owned.child.stdout.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 128 * 1024 * 1024) {
      if (!overflow) { overflow = true; drainOwned(owned, true).catch(() => {}); }
    } else if (!overflow) output.push(chunk);
  });
  const result = await owned.closed;
  await drainOwned(owned);
  if (overflow || result.error || result.code !== 0 || result.signal) throw new Error('source checkout could not be verified');
  return Buffer.concat(output).toString('utf8').trim();
}

/** Receive the negotiated history pack after the worker announces the cache's candidate tips. */
async function receivePack(packFile) {
  await pipeline(process.stdin, createWriteStream(packFile, { mode: 0o600, flags: 'wx' }));
}

/** Receive only missing ancestry, validate the full graph, then copy the exact commit into a clean job repository. */
async function checkoutHistory(api, runnerRoot, root, packFile, spec, env) {
  const repositories = join(runnerRoot, 'repos');
  mkdirSync(repositories, { recursive: true, mode: 0o700 });
  chmodSync(repositories, 0o700);
  const cache = join(repositories, `${spec.repoId}.git`);
  const cacheLease = await acquireResourceApi(api, {
    name: `repo-${spec.repoId}`, capacity: 1, scope: 'machine', root: runnerRoot,
    repo: runnerRoot, agent: `pullboard-ssh-cache-${spec.id}`, kind: 'source-cache',
    onWait: () => assertTransportLive(),
  }, join(runnerRoot, 'cache', 'resource-pool'));
  try {
    if (!existsSync(cache)) {
      const build = mkdtempSync(join(repositories, `.repo-${spec.repoId}-`));
      const staged = join(build, 'cache.git');
      try {
        const initialize = async () => {
          const initialized = spawnOwned('git', ['init', '--bare', `--object-format=${spec.commit.length === 64 ? 'sha256' : 'sha1'}`, staged], {
            cwd: build, env, stdio: ['ignore', 'ignore', 'ignore'],
          });
          const result = await initialized.closed;
          await drainOwned(initialized);
          if (result.error || result.code !== 0 || result.signal) throw new Error('source history cache could not be initialized');
        };
        await initialize();
        if (spec.origin && spec.originBase) {
          let seeded = false;
          try {
            const fetch = spawnOwned('git', ['-c', 'protocol.version=2', 'fetch', '--no-tags', '--no-recurse-submodules', spec.origin, spec.originBase], {
              cwd: staged, env, stdio: ['ignore', 'ignore', 'ignore'],
            });
            const result = await fetch.closed;
            await drainOwned(fetch);
            seeded = !result.error && result.code === 0 && !result.signal
              && await git(staged, ['cat-file', '-t', spec.originBase], env) === 'commit'
              && Number(await git(staged, ['rev-list', '--count', spec.originBase], env)) > 0
              && !existsSync(join(staged, 'shallow'));
            if (seeded) await git(staged, ['update-ref', `refs/pullboard/published/${spec.originBase}`, spec.originBase], env);
          } catch { seeded = false; }
          if (!seeded) {
            rmSync(staged, { recursive: true, force: true });
            await initialize();
          }
        }
        renameSync(staged, cache);
      } finally { rmSync(build, { recursive: true, force: true }); }
    }
    if (await git(cache, ['rev-parse', '--is-bare-repository'], env) !== 'true'
      || await git(cache, ['rev-parse', '--show-object-format'], env) !== (spec.commit.length === 64 ? 'sha256' : 'sha1')
      || existsSync(join(cache, 'shallow')) || existsSync(join(cache, 'objects', 'info', 'alternates'))) {
      throw new Error('source history cache has an incompatible format');
    }
    const refLines = await git(cache, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/pullboard/candidates', 'refs/pullboard/published'], env);
    const tips = [];
    if (refLines) for (const line of refLines.split(/\r?\n/u)) {
      const split = /^(refs\/pullboard\/(?:candidates|published)\/.+) ([a-f0-9]{40,64})$/u.exec(line);
      if (!split || split[2].length !== spec.commit.length) {
        throw new Error('source history cache contains an invalid candidate ref');
      }
      if (split[1].slice(split[1].lastIndexOf('/') + 1) !== split[2]) {
        throw new Error('source history cache contains an invalid candidate ref');
      }
      if (await git(cache, ['cat-file', '-t', split[2]], env) !== 'commit') {
        throw new Error('source history cache contains a non-commit tip');
      }
      tips.push(split[2]);
    }
    const uniqueTips = [...new Set(tips)];
    if (uniqueTips.length > 1_024) throw new Error('source history cache needs maintenance');
    await new Promise((resolveWrite, rejectWrite) => process.stderr.write(
      `PULLBOARD_RUNNER_NEED ${spec.id} ${Buffer.from(JSON.stringify({ tips: uniqueTips })).toString('base64')}\n`,
      error => error ? rejectWrite(error) : resolveWrite()));
    await receivePack(packFile);

    const priorIndexes = new Set(readdirSync(join(cache, 'objects', 'pack')).filter(name => name.endsWith('.idx')));
    if (statSync(packFile).size < 12 + spec.commit.length / 2) throw new Error('source history pack is incomplete');
    {
      const index = spawnOwned('git', ['index-pack', '--stdin'], { cwd: cache, env, stdio: ['pipe', 'ignore', 'ignore'] });
      try {
        await pipeline(createReadStream(packFile), index.child.stdin);
        const result = await index.closed;
        await drainOwned(index);
        if (result.error || result.code !== 0 || result.signal) throw new Error('source history pack could not be indexed');
      } catch (error) { await drainOwned(index, true); throw error; }
    }
    const objectType = await git(cache, ['cat-file', '-t', spec.commit], env);
    if (objectType !== 'commit' || await git(cache, ['rev-parse', `${spec.commit}^{tree}`], env) !== spec.tree) {
      throw new Error('source history does not match the requested commit and tree');
    }
    const historyCount = Number(await git(cache, ['rev-list', '--count', spec.commit], env));
    if (!Number.isSafeInteger(historyCount) || historyCount < 1) throw new Error('source history is incomplete');
    if (spec.originBase) await git(cache, ['merge-base', '--is-ancestor', spec.originBase, spec.commit], env);
    const closure = new Set((await git(cache, ['rev-list', '--objects', spec.commit], env)).split(/\r?\n/u)
      .map(line => line.match(/^([a-f0-9]{40,64})(?:\s|$)/u)?.[1]).filter(Boolean));
    closure.add(spec.commit);
    const packDirectory = join(cache, 'objects', 'pack');
    const newIndexes = readdirSync(packDirectory).filter(name => name.endsWith('.idx') && !priorIndexes.has(name));
    const received = new Set();
    for (const indexName of newIndexes) {
      for (const line of (await git(cache, ['verify-pack', '-v', join(packDirectory, indexName)], env)).split(/\r?\n/u)) {
        const object = line.match(/^([a-f0-9]{40,64})\s+(?:commit|tree|blob|tag)\s/u)?.[1];
        if (object) received.add(object);
      }
    }
    if ([...received].some(object => !closure.has(object))) {
      throw new Error('source history pack contains missing or unrelated objects');
    }
    await git(cache, ['update-ref', `refs/pullboard/candidates/${spec.commit}`, spec.commit], env);
    await git(root, ['init', '-q', `--object-format=${spec.commit.length === 64 ? 'sha256' : 'sha1'}`], env);
    await git(root, ['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', cache, `refs/pullboard/candidates/${spec.commit}`], env);
    await git(root, ['checkout', '--detach', 'FETCH_HEAD'], env);
    if (await git(root, ['rev-parse', 'HEAD'], env) !== spec.commit
      || await git(root, ['rev-parse', 'HEAD^{tree}'], env) !== spec.tree
      || await git(root, ['rev-parse', '--is-shallow-repository'], env) !== 'false'
      || existsSync(join(root, '.git', 'objects', 'info', 'alternates'))) {
      throw new Error('isolated source checkout does not contain the complete requested history');
    }
  } finally {
    try { cacheLease.release(); } catch { /* Retaining the lease on cleanup error is safer than speculative deletion. */ }
  }
  rmSync(packFile, { force: true });
}

/** Install committed npm dependencies through an isolated content-addressed cache, refusing unknown lock managers. */
async function installDependencies(root, runnerRoot, env, tracker) {
  const packageFile = join(root, 'package.json');
  if (!existsSync(packageFile)) return;
  const packageText = readFileSync(packageFile, 'utf8');
  const manifest = JSON.parse(packageText);
  const lockFile = join(root, 'package-lock.json');
  if (existsSync(join(root, 'pnpm-lock.yaml')) || existsSync(join(root, 'yarn.lock'))) {
    throw new Error('dependency setup requires a single committed npm lock manager');
  }
  if (!existsSync(lockFile)) {
    if (Object.keys(manifest.dependencies ?? {}).length || Object.keys(manifest.devDependencies ?? {}).length) {
      throw new Error('dependency setup requires a committed npm package-lock.json');
    }
    return;
  }
  const cacheRoot = join(runnerRoot, 'cache', 'npm');
  const contentCache = join(cacheRoot, 'content');
  mkdirSync(contentCache, { recursive: true, mode: 0o700 });
  chmodSync(cacheRoot, 0o700); chmodSync(contentCache, 0o700);
  // node_modules is job-local because package lifecycle scripts may create sibling artifacts.
  // Reuse only npm's content-addressed download cache, never a prior job's installed tree.
  rmSync(join(root, 'node_modules'), { recursive: true, force: true });
  const npm = spawnOwned('npm', ['ci', '--cache', contentCache], {
    cwd: root, env, stdio: ['ignore', 'ignore', 'ignore'],
  });
  const result = await npm.closed;
  await tracker.stopDescendants();
  await drainOwned(npm);
  if (result.error || result.code !== 0 || result.signal) throw new Error('committed npm dependencies could not be installed');
}

/** Wait until all bytes written to stdout have passed through the stream before publishing a receipt. */
async function flushStdout() {
  if (process.stdout.writableNeedDrain) await once(process.stdout, 'drain');
  await new Promise((resolveFlush, rejectFlush) => process.stdout.write('', error => error ? rejectFlush(error) : resolveFlush()));
}

/** Emit command output through one stream while computing the receipt's byte-exact digest. */
function outputSink() {
  const hash = createHash('sha256');
  const wallStart = Date.now();
  let pipeFailed = false;
  const write = part => {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
    hash.update(bytes);
    if (!process.stdout.write(bytes)) return once(process.stdout, 'drain');
    return Promise.resolve();
  };
  return { hash, write, get pipeFailed() { return pipeFailed; }, set pipeFailed(value) { pipeFailed = value; }, wallStart };
}

/** Stop only the detached command process group owned by this worker, then await its close event. */
async function stopOwnedGroup(pid, closed, tracker) {
  if (!pid) return;
  const signal = async type => {
    for (;;) {
      const sent = tracker?.signalOwnedGroup(pid, type) ?? false;
      if (sent === true || sent === false) return sent;
      await new Promise(resolvePause => setTimeout(resolvePause, 250));
    }
  };
  await signal('SIGTERM');
  // Give the whole owned group two seconds to handle TERM, even if its leader exits first.
  const graceUntil = Date.now() + 2_000;
  while (Date.now() < graceUntil) {
    const sent = await signal('SIGTERM');
    if (!sent) break;
    await new Promise(resolvePause => setTimeout(resolvePause, 25));
  }
  for (;;) {
    const sent = await signal('SIGKILL');
    if (!sent) break;
    await new Promise(resolvePause => setTimeout(resolvePause, 50));
  }
  await closed;
}

/** Run the exact requested command in its isolated checkout, retaining raw output and real test exit status. */
async function runCommand(spec, root, env, sink, tracker) {
  let shell = '/bin/sh';
  let args = ['-c', spec.command];
  if (spec.pipefail) {
    const probe = spawnSync(shell, ['-c', 'set -o pipefail'], { env, stdio: 'ignore' });
    if (probe.status === 0) args = ['-c', `set -o pipefail\n${spec.command}`];
    else if (existsSync('/bin/bash')) { shell = '/bin/bash'; args = ['-o', 'pipefail', '-c', spec.command]; }
    else if (/(?:^|[^|])\|(?:[^|]|$)/u.test(spec.command)) throw new Error('runner shell cannot enforce pipefail');
  }
  const owned = spawnOwned(shell, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const child = owned.child;
  let outputError = null;
  let writes = Promise.resolve();
  const closed = owned.closed;
  const onDrop = () => { sink.pipeFailed = true; transportDrop(); };
  const forward = stream => stream.on('data', part => {
    stream.pause();
    if (!outputError) writes = writes.then(() => sink.write(part)).then(() => stream.resume()).catch(error => { outputError = error; onDrop(); });
  });
  forward(child.stdout); forward(child.stderr);
  const result = await closed;
  beginCleanup();
  await writes;
  await tracker.stopDescendants();
  await drainOwned(owned);
  if (transportDrain) await transportDrain;
  if (outputError) throw outputError;
  if (sink.pipeFailed) return { code: 1, signal: result.signal ?? 'SIGHUP' };
  if (result.error) throw result.error;
  return { code: Number.isInteger(result.code) ? result.code : 1, signal: result.signal ?? null };
}

/** Send the single nonce-bound result line after the complete merged output has drained. */
async function receipt(spec, fields, sink) {
  await flushStdout();
  const body = { id: spec.id, commit: spec.commit, tree: spec.tree, code: fields.code, signal: fields.signal,
    runtimeSha256: spec.runtime.sha256, toolingSha256: spec.tooling.sha256, root: fields.root ?? '', outputSha256: sink.hash.digest('hex'), wallMs: Math.max(0, Date.now() - sink.wallStart) };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64');
  await new Promise((resolveWrite, rejectWrite) => process.stderr.write(`${RECEIPT} ${spec.id} ${encoded}\n`, error => error ? rejectWrite(error) : resolveWrite()));
}

/** Turn an internal setup failure into a fixed safe line rather than disclosing paths or runner state. */
function safeSetupMessage(error) {
  const message = String(error?.message ?? '');
  if (message.includes('npm') || message.includes('dependency')) return 'runner setup refused: committed dependencies are unavailable';
  if (message.includes('capacity') || message.includes('queue')) return 'runner setup refused: remote capacity is unavailable';
  return 'runner setup refused: source checkout could not be prepared';
}

/** Execute one remote job end to end; stdout is reserved for raw command bytes and stderr for one receipt. */
async function main() {
  installSignalCustody();
  const spec = await readSpec();
  workerId = spec.id;
  if (spec.browserRequired && spec.browser < 1) throw new Error('browser capacity is not configured');
  const sink = outputSink();
  let api;
  let lease = null;
  let tracker = null;
  let runDirectory;
  let final = { code: 1, signal: null, root: '' };
  try {
    const runnerHome = isAbsolute(process.env.HOME || '') ? process.env.HOME : userInfo().homedir;
    const runnerRoot = spec.root ?? join(runnerHome, '.pullboard-runner');
    mkdirSync(runnerRoot, { recursive: true, mode: 0o700 });
    chmodSync(runnerRoot, 0o700);
    const configuredMachineHome = process.env.PULLBOARD_MACHINE_HOME;
    if (configuredMachineHome !== undefined && !isAbsolute(configuredMachineHome)) throw new Error('machine home is invalid');
    const machineHomePath = configuredMachineHome ?? join(runnerHome, '.pullboard');
    api = await loadResourceApi(runnerRoot, spec.runtime);
    const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
    let resources;
    try {
      process.env.PULLBOARD_MACHINE_HOME = machineHomePath;
      resources = api.listResources({ scope: 'machine', root: runnerRoot });
    } finally {
      if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
      else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
    }
    const gateCapacity = resources.find(resource => resource.name === 'gate')?.capacity ?? Math.min(spec.slots, 2);
    const base = join(runnerRoot, 'jobs');
    mkdirSync(base, { recursive: true, mode: 0o700 });
    chmodSync(base, 0o700);
    runDirectory = mkdtempSync(join(base, `${spec.id}-`));
    const root = join(runDirectory, 'checkout');
    const privateHome = join(runDirectory, 'home');
    const temporary = join(runDirectory, 'tmp');
    mkdirSync(root, { mode: 0o700 }); mkdirSync(privateHome, { mode: 0o700 }); mkdirSync(temporary, { mode: 0o700 });
    writeFileSync(join(privateHome, 'npm-userconfig'), '', { mode: 0o600 });
    writeFileSync(join(privateHome, 'npm-globalconfig'), '', { mode: 0o600 });
    const packFile = join(runDirectory, 'source.pack');
    lease = await acquireResourceApi(api, {
      name: 'gate', capacity: gateCapacity, scope: 'machine', root: runnerRoot,
      repo: runnerRoot, agent: `pullboard-ssh-${spec.id}`,
      landing: spec.landing === true, itemCheck: spec.itemCheck === true,
      diagnostic: spec.diagnostic === true, browser: spec.browserRequired,
      item: spec.item ?? '', kind: spec.kind ?? 'remote-command',
      onWait: () => assertTransportLive(),
    }, machineHomePath);
    const canonicalMachineHome = machineHomePath;
    tracker = createDescendantTracker(runDirectory);
    activeDescendantTracker = tracker;
    const env = scopedEnvironment(privateHome, temporary, canonicalMachineHome, lease, api, tracker.nodeOptions);
    await checkoutHistory(api, runnerRoot, root, packFile, spec, env);
    await installDependencies(root, runnerRoot, env, tracker);
    final = { ...(await runCommand(spec, root, env, sink, tracker)), root };
  } catch (error) {
    const message = safeSetupMessage(error);
    if (!transportLost) await sink.write(`${message}\n`);
    final = { code: 1, signal: transportLost ? 'SIGHUP' : null, error: message, root: '' };
  } finally {
    beginCleanup();
    if (tracker) await tracker.stopDescendants();
    await drainAllOwned();
    if (tracker) {
      await tracker.verifyAfterGroups();
      tracker.stopMonitoring();
      activeDescendantTracker = null;
    }
    if (lease) {
      try { lease.release(); } catch { /* Retaining a lease on cleanup error is safer than speculative deletion. */ }
    }
    if (runDirectory) { try { rmSync(runDirectory, { recursive: true, force: true }); } catch {} }
  }
  if (transportLost || cleanupTimedOut) { process.exitCode = 1; return; }
  await receipt(spec, final, sink);
  process.exitCode = 0;
}

main().catch(() => { process.exitCode = 1; });
