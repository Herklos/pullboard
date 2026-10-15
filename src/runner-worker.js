/** Standalone SSH runner worker source; intentionally imports only Node built-ins. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';

const RECEIPT = 'PULLBOARD_RUNNER_RESULT';
const HEARTBEAT_MS = 2_000;
const POLL_MS = 250;
const OWNER_UNKNOWN = Symbol('owner-unknown');
const safePath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
const processIdentities = new Map();

/** Parse and strictly validate the controller's one-shot work specification. */
function readSpec() {
  const encoded = process.argv[1];
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw new Error('invalid work specification');
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64') !== encoded) throw new Error('invalid work specification');
  const value = JSON.parse(decoded.toString('utf8'));
  if (!value || value.version !== 1 || !/^[A-Za-z0-9_-]{1,100}$/u.test(value.id)
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.commit)
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.tree)
    || value.commit.length !== value.tree.length
    || typeof value.command !== 'string' || !value.command.trim()
    || typeof value.pipefail !== 'boolean' || !Number.isSafeInteger(value.slots) || value.slots < 1
    || !Number.isSafeInteger(value.browser) || value.browser < 0
    || typeof value.browserRequired !== 'boolean') throw new Error('invalid work specification');
  for (const field of ['landing', 'itemCheck', 'diagnostic']) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') throw new Error('invalid work specification');
  }
  for (const field of ['item', 'kind']) {
    if (value[field] !== undefined && typeof value[field] !== 'string') throw new Error('invalid work specification');
  }
  return value;
}

/** Construct a minimal environment from runner-owned values, excluding caller credentials and markers. */
function childEnvironment(home, temporary, machineHomePath = '') {
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
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    NPM_CONFIG_USERCONFIG: join(home, 'npm-userconfig'),
    NPM_CONFIG_GLOBALCONFIG: join(home, 'npm-globalconfig'),
    ...(machineHomePath ? { PULLBOARD_MACHINE_HOME: machineHomePath } : {}),
  };
}

/** Add this worker's remote gate lease so nested test runners reuse the remote slot instead of deadlocking. */
function scopedEnvironment(spec, home, temporary, machineHomePath, gatePool, token) {
  return {
    ...childEnvironment(home, temporary, machineHomePath),
    PULLBOARD_GATE_SLOT_HELD: '1',
    PULLBOARD_GATE_SLOT_POOL: gatePool,
    PULLBOARD_GATE_SLOT_TOKEN: token,
    PULLBOARD_BROWSER_SLOT_HELD: spec.browserRequired ? '1' : '',
  };
}

/** Read a stable process start identity, returning unknown rather than guessing on unsupported hosts. */
function processIdentity(pid) {
  const cached = processIdentities.get(pid);
  if (cached && Date.now() - cached.checkedAt < 3_000) return cached.identity;
  try {
    const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8', env: { PATH: safePath, LANG: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const fields = result.stdout.trim().split(/\s+/u);
    const state = fields.pop();
    const identity = result.status === 0 && fields.length ? { started: fields.join(' '), zombie: state?.startsWith('Z') ?? false } : null;
    processIdentities.set(pid, { identity, checkedAt: Date.now() });
    return identity;
  } catch {
    processIdentities.set(pid, { identity: null, checkedAt: Date.now() });
    return null;
  }
}

/** Read the process start identity in the format used by the repository's lease reaper. */
function processStart(pid) {
  const identity = processIdentity(pid);
  return identity && !identity.zombie ? identity.started : OWNER_UNKNOWN;
}

/** Determine whether a stored owner is certainly gone or may still own its remote capacity. */
function ownerAlive(pid, started) {
  try { process.kill(pid, 0); } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code !== 'EPERM') return OWNER_UNKNOWN;
  }
  const current = processIdentity(pid);
  if (!current) return OWNER_UNKNOWN;
  if (current.zombie) return false;
  return current.started === started;
}

/** Open the runner-local SQLite admission database and create its shared holder/waiter state. */
function openPool(file) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(dirname(file), 0o700);
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  try {
    transaction(db, () => {
      db.exec(`CREATE TABLE IF NOT EXISTS resource (name TEXT PRIMARY KEY, capacity INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS holder (token TEXT PRIMARY KEY, name TEXT NOT NULL, pid INTEGER NOT NULL, started TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL, repo TEXT NOT NULL, since TEXT NOT NULL, heartbeat INTEGER NOT NULL, landing INTEGER NOT NULL DEFAULT 0, item_check INTEGER NOT NULL DEFAULT 0, diagnostic INTEGER NOT NULL DEFAULT 0, browser INTEGER NOT NULL DEFAULT 0, item TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', runner TEXT NOT NULL DEFAULT '');
        CREATE INDEX IF NOT EXISTS holder_name ON holder(name);
        CREATE TABLE IF NOT EXISTS waiter (ticket INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pid INTEGER NOT NULL, started TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL, repo TEXT NOT NULL, since TEXT NOT NULL, heartbeat INTEGER NOT NULL, landing INTEGER NOT NULL DEFAULT 0, item_check INTEGER NOT NULL DEFAULT 0, diagnostic INTEGER NOT NULL DEFAULT 0, browser INTEGER NOT NULL DEFAULT 0, item TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', remote INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS waiter_name_ticket ON waiter(name, ticket);
        CREATE TABLE IF NOT EXISTS npm_cache_lock (key TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, pid INTEGER NOT NULL, started TEXT NOT NULL, heartbeat INTEGER NOT NULL);`);
      for (const table of ['holder', 'waiter']) {
        const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
        for (const [column, definition] of Object.entries({
          started: "TEXT NOT NULL DEFAULT ''", landing: 'INTEGER NOT NULL DEFAULT 0', item_check: 'INTEGER NOT NULL DEFAULT 0',
          diagnostic: 'INTEGER NOT NULL DEFAULT 0', browser: 'INTEGER NOT NULL DEFAULT 0', item: "TEXT NOT NULL DEFAULT ''", kind: "TEXT NOT NULL DEFAULT ''",
          ...(table === 'holder' ? { runner: "TEXT NOT NULL DEFAULT ''" } : { remote: 'INTEGER NOT NULL DEFAULT 0' }),
        })) if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    });
  } catch (error) { db.close(); throw error; }
  return db;
}

/** Read host settings only for capacity defaults; the durable resource row remains authoritative. */
function configuredGateSlots(machineHomePath) {
  const file = join(machineHomePath, 'settings.json');
  if (!existsSync(file)) return 2;
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (value.gateSlots !== undefined && (!Number.isSafeInteger(value.gateSlots) || value.gateSlots < 1))) {
    throw new Error('machine settings are invalid');
  }
  return value.gateSlots ?? 2;
}

/** Resolve effective host limits without raising or replacing existing machine resources. */
function hostLimits(db, machineHomePath) {
  const existingGate = db.prepare("SELECT capacity FROM resource WHERE name = 'gate'").get()?.capacity;
  const fallbackGate = existingGate === undefined ? configuredGateSlots(machineHomePath) : existingGate;
  return transaction(db, () => {
    let gate = db.prepare("SELECT capacity FROM resource WHERE name = 'gate'").get()?.capacity;
    if (gate === undefined) {
      gate = fallbackGate;
      db.prepare("INSERT INTO resource(name, capacity) VALUES ('gate', ?)").run(gate);
    }
    let browser = db.prepare("SELECT capacity FROM resource WHERE name = 'browser'").get()?.capacity;
    if (browser === undefined) {
      browser = 1;
      db.prepare("INSERT INTO resource(name, capacity) VALUES ('browser', 1)").run();
    }
    return { gate, browser };
  });
}

/** Run one short SQLite transaction so all runner controllers observe atomic capacity decisions. */
function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}

/** Remove only leases whose PID is certainly dead or has a different known start identity. */
function reapKnownDead(db) {
  const deadHolders = db.prepare("SELECT token, pid, started FROM holder WHERE name = 'gate'").all()
    .filter(row => ownerAlive(row.pid, row.started) === false);
  const deadWaiters = db.prepare("SELECT token, pid, started FROM waiter WHERE name = 'gate'").all()
    .filter(row => ownerAlive(row.pid, row.started) === false);
  if (!deadHolders.length && !deadWaiters.length) return;
  transaction(db, () => {
    for (const row of deadHolders) db.prepare("DELETE FROM holder WHERE name = 'gate' AND token = ? AND pid = ? AND started = ?").run(row.token, row.pid, row.started);
    for (const row of deadWaiters) db.prepare("DELETE FROM waiter WHERE name = 'gate' AND token = ? AND pid = ? AND started = ?").run(row.token, row.pid, row.started);
  });
}

/** Queue for a runner-local slot and optional browser slot using the repository's shared resource schema. */
async function acquirePool(db, spec) {
  const pid = process.pid;
  const started = processStart(pid);
  if (started === OWNER_UNKNOWN) throw new Error('runner cannot establish process identity');
  const token = randomUUID();
  const browser = Number(spec.browserRequired);
  const landing = Number(spec.landing === true);
  const itemCheck = Number(spec.itemCheck === true || spec.diagnostic === true);
  const diagnostic = Number(spec.diagnostic === true);
  const item = spec.item ?? '';
  const kind = spec.kind ?? 'remote-command';
  reapKnownDead(db);
  transaction(db, () => {
    db.prepare("INSERT INTO waiter(token, name, pid, started, agent, repo, since, heartbeat, landing, item_check, diagnostic, browser, item, kind, remote) VALUES (?, 'gate', ?, ?, 'pullboard-ssh-runner', '', ?, ?, ?, ?, ?, ?, ?, ?, 0)")
      .run(token, pid, started, new Date().toISOString(), Date.now(), landing, itemCheck, diagnostic, browser, item, kind);
  });
  let held = false;
  try {
    for (;;) {
      reapKnownDead(db);
      const admitted = transaction(db, () => {
        const limits = {
          gate: db.prepare("SELECT capacity FROM resource WHERE name = 'gate'").get().capacity,
          browser: db.prepare("SELECT capacity FROM resource WHERE name = 'browser'").get().capacity,
        };
        db.prepare("UPDATE waiter SET heartbeat = ? WHERE name = 'gate' AND token = ?").run(Date.now(), token);
        const me = db.prepare("SELECT ticket FROM waiter WHERE name = 'gate' AND token = ?").get(token);
        if (!me) throw new Error('runner queue lease was lost');
        const waiters = db.prepare("SELECT ticket, landing, browser FROM waiter WHERE name = 'gate' ORDER BY landing DESC, ticket").all();
        const holders = db.prepare("SELECT browser FROM holder WHERE name = 'gate'").all();
        if (holders.length >= limits.gate) return false;
        const browserBusy = holders.filter(row => row.browser === 1).length;
        const next = waiters.find(waiter => waiter.browser !== 1 || browserBusy < limits.browser);
        if (!next || next.ticket !== me.ticket) return false;
        db.prepare("DELETE FROM waiter WHERE name = 'gate' AND token = ?").run(token);
        db.prepare("INSERT INTO holder(token, name, pid, started, agent, repo, since, heartbeat, landing, item_check, diagnostic, browser, item, kind) VALUES (?, 'gate', ?, ?, 'pullboard-ssh-runner', '', ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(token, pid, started, new Date().toISOString(), Date.now(), landing, itemCheck, diagnostic, browser, item, kind);
        return true;
      });
      if (admitted) { held = true; break; }
      await new Promise(resolvePause => setTimeout(resolvePause, POLL_MS));
    }
  } catch (error) {
    transaction(db, () => db.prepare("DELETE FROM waiter WHERE name = 'gate' AND token = ?").run(token));
    throw error;
  }
  const pulse = setInterval(() => {
    try { transaction(db, () => db.prepare("UPDATE holder SET heartbeat = ? WHERE name = 'gate' AND token = ?").run(Date.now(), token)); }
    catch { /* A DB error is visible on the next guarded operation; retaining the row is safer. */ }
  }, HEARTBEAT_MS);
  pulse.unref();
  return { token, release: () => {
    if (!held) return;
    held = false;
    clearInterval(pulse);
    transaction(db, () => db.prepare("DELETE FROM holder WHERE name = 'gate' AND token = ?").run(token));
  } };
}

/** Acquire one content-key cache build lease, recovering only rows proven dead outside SQLite transactions. */
async function acquireCacheBuild(db, key) {
  const pid = process.pid;
  const started = processStart(pid);
  if (started === OWNER_UNKNOWN) throw new Error('runner cannot establish cache owner identity');
  const token = randomUUID();
  for (;;) {
    const stale = db.prepare('SELECT key, token, pid, started FROM npm_cache_lock').all()
      .filter(row => ownerAlive(row.pid, row.started) === false);
    if (stale.length) transaction(db, () => {
      for (const row of stale) db.prepare('DELETE FROM npm_cache_lock WHERE key = ? AND token = ? AND pid = ? AND started = ?')
        .run(row.key, row.token, row.pid, row.started);
    });
    const acquired = transaction(db, () => {
      if (db.prepare('SELECT 1 FROM npm_cache_lock WHERE key = ?').get(key)) return false;
      db.prepare('INSERT INTO npm_cache_lock(key, token, pid, started, heartbeat) VALUES (?, ?, ?, ?, ?)')
        .run(key, token, pid, started, Date.now());
      return true;
    });
    if (acquired) break;
    await new Promise(resolvePause => setTimeout(resolvePause, POLL_MS));
  }
  const pulse = setInterval(() => {
    try { transaction(db, () => db.prepare('UPDATE npm_cache_lock SET heartbeat = ? WHERE key = ? AND token = ?').run(Date.now(), key, token)); }
    catch { /* Unknown cache owners keep their lock until process identity can be checked again. */ }
  }, HEARTBEAT_MS);
  pulse.unref();
  return () => {
    clearInterval(pulse);
    transaction(db, () => db.prepare('DELETE FROM npm_cache_lock WHERE key = ? AND token = ? AND pid = ? AND started = ?').run(key, token, pid, started));
  };
}

/** Invoke one bounded Git command with runner-owned environment and return its exact stdout. */
function git(root, args, env) {
  const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error('source checkout could not be verified');
  return result.stdout.trim();
}

/** Receive the entire stdin pack before queueing so a capacity wait cannot back up the SSH input pipe. */
async function receivePack(packFile) {
  await pipeline(process.stdin, createWriteStream(packFile, { mode: 0o600, flags: 'wx' }));
}

/** Index the received pack, then attach only its exact commit as shallow history. */
async function unpackSource(root, packFile, spec, env) {
  const index = spawn('git', ['index-pack', '--stdin'], { cwd: root, env, stdio: ['pipe', 'ignore', 'pipe'] });
  index.stderr.resume();
  const closed = once(index, 'close');
  await pipeline(createReadStream(packFile), index.stdin);
  const [code, signal] = await closed;
  if (code !== 0 || signal) throw new Error('source pack could not be indexed');
  writeFileSync(join(root, '.git', 'shallow'), `${spec.commit}\n`, { mode: 0o600 });
  git(root, ['update-ref', 'refs/heads/pullboard-run', spec.commit], env);
  git(root, ['checkout', '--detach', spec.commit], env);
  if (git(root, ['rev-parse', `${spec.commit}^{tree}`], env) !== spec.tree) throw new Error('source tree did not match the requested commit');
  if (git(root, ['rev-parse', 'HEAD'], env) !== spec.commit) throw new Error('source commit did not match the requested commit');
  if (git(root, ['rev-list', '--count', 'HEAD'], env) !== '1') throw new Error('source pack included commit history');
  const reachable = new Set(git(root, ['rev-list', '--objects', 'HEAD'], env).split(/\r?\n/u)
    .map(line => line.match(/^([a-f0-9]{40,64})(?:\s|$)/u)?.[1]).filter(Boolean));
  reachable.add(spec.commit);
  const packDirectory = join(root, '.git', 'objects', 'pack');
  const indexes = readdirSync(packDirectory).filter(name => name.endsWith('.idx'));
  if (indexes.length !== 1) throw new Error('source pack was not the single requested object set');
  const packed = new Set(git(root, ['verify-pack', '-v', join(packDirectory, indexes[0])], env)
    .split(/\r?\n/u).map(line => line.match(/^([a-f0-9]{40,64})\s+(?:commit|tree|blob|tag)\s/u)?.[1]).filter(Boolean));
  if (packed.size !== reachable.size || [...packed].some(object => !reachable.has(object))) throw new Error('source pack contains objects outside the requested tree');
  rmSync(packFile, { force: true });
}

/** Install committed npm dependencies through an isolated content-addressed cache, refusing unknown lock managers. */
async function installDependencies(db, root, runnerHome, privateHome, env, commitTree) {
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
  const lockText = readFileSync(lockFile, 'utf8');
  const key = createHash('sha256').update(packageText).update('\0').update(lockText).update('\0')
    .update(process.versions.modules).update('\0').update(process.platform).update('\0').update(process.arch).update('\0').update(commitTree).digest('hex');
  const cacheRoot = join(runnerHome, '.pullboard', 'runner-npm-cache');
  const cache = join(cacheRoot, key);
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  chmodSync(cacheRoot, 0o700);
  const releaseCache = existsSync(cache) ? null : await acquireCacheBuild(db, key);
  try {
    if (!existsSync(cache)) {
      const build = mkdtempSync(join(cacheRoot, `${key}.build-`));
      try {
        rmSync(join(root, 'node_modules'), { recursive: true, force: true });
        const npm = spawn('npm', ['ci', '--cache', join(privateHome, '.npm-cache')], {
          cwd: root, env, stdio: ['ignore', 'ignore', 'ignore'],
        });
        const [code, signal] = await once(npm, 'close');
        if (code !== 0 || signal) throw new Error('committed npm dependencies could not be installed');
        mkdirSync(join(root, 'node_modules'), { recursive: true, mode: 0o700 });
        cpSync(join(root, 'node_modules'), join(build, 'node_modules'), { recursive: true, errorOnExist: true, verbatimSymlinks: true });
        renameSync(build, cache);
      } finally { rmSync(build, { recursive: true, force: true }); }
    }
    const from = join(cache, 'node_modules');
    if (!existsSync(join(root, 'node_modules'))) cpSync(from, join(root, 'node_modules'), { recursive: true, errorOnExist: true, verbatimSymlinks: true });
  } finally { releaseCache?.(); }
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
async function stopOwnedGroup(pid, closed) {
  if (!pid) return;
  try { process.kill(-pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  let timer;
  try { await Promise.race([closed, new Promise(resolveTimeout => { timer = setTimeout(resolveTimeout, 2_000); })]); }
  finally { clearTimeout(timer); }
  try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  for (;;) {
    try { process.kill(-pid, 0); }
    catch (error) { if (error.code === 'ESRCH') break; throw error; }
    await new Promise(resolvePause => setTimeout(resolvePause, 50));
  }
}

/** Run the exact requested command in its isolated checkout, retaining raw output and real test exit status. */
async function runCommand(spec, root, env, sink) {
  let shell = '/bin/sh';
  let args = ['-c', spec.command];
  if (spec.pipefail) {
    const probe = spawnSync(shell, ['-c', 'set -o pipefail'], { env, stdio: 'ignore' });
    if (probe.status === 0) args = ['-c', `set -o pipefail\n${spec.command}`];
    else if (existsSync('/bin/bash')) { shell = '/bin/bash'; args = ['-o', 'pipefail', '-c', spec.command]; }
    else if (/(?:^|[^|])\|(?:[^|]|$)/u.test(spec.command)) throw new Error('runner shell cannot enforce pipefail');
  }
  const child = spawn(shell, args, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let outputError = null;
  let writes = Promise.resolve();
  let stopPromise = null;
  const closed = new Promise((resolveClose, rejectClose) => {
    child.once('error', rejectClose);
    child.once('close', (code, signal) => resolveClose({ code, signal }));
  });
  const onDrop = () => {
    sink.pipeFailed = true;
    stopPromise ??= stopOwnedGroup(child.pid, closed);
    stopPromise.catch(() => {});
  };
  const forward = stream => stream.on('data', part => {
    stream.pause();
    if (!outputError) writes = writes.then(() => sink.write(part)).then(() => stream.resume()).catch(error => { outputError = error; onDrop(); });
  });
  forward(child.stdout); forward(child.stderr);
  process.once('SIGHUP', onDrop);
  process.once('SIGTERM', onDrop);
  process.stdout.once('error', onDrop);
  try {
    const result = await closed;
    await writes;
    if (stopPromise) await stopPromise;
    if (outputError) throw outputError;
    if (sink.pipeFailed) return { code: 1, signal: result.signal ?? 'SIGHUP' };
    return { code: Number.isInteger(result.code) ? result.code : 1, signal: result.signal ?? null };
  } finally {
    process.removeListener('SIGHUP', onDrop);
    process.removeListener('SIGTERM', onDrop);
    process.stdout.removeListener('error', onDrop);
  }
}

/** Send the single nonce-bound result line after the complete merged output has drained. */
async function receipt(spec, fields, sink) {
  await flushStdout();
  const body = { id: spec.id, commit: spec.commit, tree: spec.tree, code: fields.code, signal: fields.signal,
    root: fields.root ?? '', outputSha256: sink.hash.digest('hex'), wallMs: Math.max(0, Date.now() - sink.wallStart) };
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
  const spec = readSpec();
  if (spec.browserRequired && spec.browser < 1) throw new Error('browser capacity is not configured');
  const sink = outputSink();
  let db;
  let lease = null;
  let runDirectory;
  let final = { code: 1, signal: null, root: '' };
  try {
    const runnerHome = isAbsolute(process.env.HOME || '') ? process.env.HOME : userInfo().homedir;
    const configuredMachineHome = process.env.PULLBOARD_MACHINE_HOME;
    if (configuredMachineHome !== undefined && !isAbsolute(configuredMachineHome)) throw new Error('machine home is invalid');
    const machineHomePath = configuredMachineHome ?? join(runnerHome, '.pullboard');
    const gatePoolFile = join(machineHomePath, 'resources.sqlite');
    const base = join(runnerHome, '.pullboard', 'runner-jobs');
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
    await receivePack(packFile);
    db = openPool(gatePoolFile);
    const gatePool = realpathSync(gatePoolFile);
    const canonicalMachineHome = realpathSync(machineHomePath);
    hostLimits(db, canonicalMachineHome);
    lease = await acquirePool(db, spec);
    const env = scopedEnvironment(spec, privateHome, temporary, canonicalMachineHome, gatePool, lease.token);
    const init = spawnSync('git', ['init', '-q', `--object-format=${spec.commit.length === 64 ? 'sha256' : 'sha1'}`, root], { cwd: runDirectory, env, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
    if (init.status !== 0) throw new Error('source checkout could not be initialized');
    await unpackSource(root, packFile, spec, env);
    await installDependencies(db, root, runnerHome, privateHome, env, spec.tree);
    final = { ...(await runCommand(spec, root, env, sink)), root };
  } catch (error) {
    const message = safeSetupMessage(error);
    await sink.write(`${message}\n`);
    final = { code: 1, signal: null, error: message, root: '' };
  } finally {
    if (lease) {
      try { lease.release(); } catch { /* Retaining a lease on cleanup error is safer than speculative deletion. */ }
    }
    if (db) { try { db.close(); } catch {} }
    if (runDirectory) { try { rmSync(runDirectory, { recursive: true, force: true }); } catch {} }
  }
  await receipt(spec, final, sink);
  process.exitCode = 0;
}

main().catch(() => { process.exitCode = 1; });
