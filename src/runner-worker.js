/** Standalone SSH runner worker source; intentionally imports only Node built-ins. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
    || typeof value.command !== 'string' || !value.command.trim()
    || typeof value.pipefail !== 'boolean' || !Number.isSafeInteger(value.slots) || value.slots < 1
    || !Number.isSafeInteger(value.browser) || value.browser < 0
    || typeof value.browserRequired !== 'boolean'
    || !value.runtime || typeof value.runtime !== 'object' || !value.runtime.files || typeof value.runtime.files !== 'object'
    || typeof value.runtime.sha256 !== 'string') throw new Error('invalid work specification');
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
function scopedEnvironment(home, temporary, machineHomePath, gateLease, resourcesApi) {
  return {
    ...childEnvironment(home, temporary, machineHomePath),
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
  child.once('error', error => settle({ error }));
  child.once('close', (code, signal) => settle({ code, signal }));
  return record;
}

/** Stop and fully drain one owned process group before its gate lease can be released. */
function drainOwned(record, terminate = false) {
  if (!record) return Promise.resolve();
  record.drainPromise ??= (async () => {
    if (terminate) await stopOwnedGroup(record.pid, record.closed);
    else {
      await record.closed;
      await stopOwnedGroup(record.pid, record.closed);
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
    rejectPendingFrame?.(new Error('runner transport was lost'));
    clearInterval(heartbeatTimer);
    const active = [...ownedChildren.values()];
    transportDrain = Promise.all(active.map(record => drainOwned(record, true)));
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

/** Receive the entire stdin pack before queueing so a capacity wait cannot back up the SSH input pipe. */
async function receivePack(packFile) {
  await pipeline(process.stdin, createWriteStream(packFile, { mode: 0o600, flags: 'wx' }));
}

/** Index the received pack, then attach only its exact commit as shallow history. */
async function unpackSource(root, packFile, spec, env) {
  const index = spawnOwned('git', ['index-pack', '--stdin'], { cwd: root, env, stdio: ['pipe', 'ignore', 'ignore'] });
  try {
    await pipeline(createReadStream(packFile), index.child.stdin);
    const result = await index.closed;
    await drainOwned(index);
    if (result.error || result.code !== 0 || result.signal) throw new Error('source pack could not be indexed');
  } catch (error) {
    await drainOwned(index, true);
    throw error;
  }
  writeFileSync(join(root, '.git', 'shallow'), `${spec.commit}\n`, { mode: 0o600 });
  await git(root, ['update-ref', 'refs/heads/pullboard-run', spec.commit], env);
  await git(root, ['checkout', '--detach', spec.commit], env);
  if (await git(root, ['rev-parse', `${spec.commit}^{tree}`], env) !== spec.tree) throw new Error('source tree did not match the requested commit');
  if (await git(root, ['rev-parse', 'HEAD'], env) !== spec.commit) throw new Error('source commit did not match the requested commit');
  if (await git(root, ['rev-list', '--count', 'HEAD'], env) !== '1') throw new Error('source pack included commit history');
  const reachable = new Set((await git(root, ['rev-list', '--objects', 'HEAD'], env)).split(/\r?\n/u)
    .map(line => line.match(/^([a-f0-9]{40,64})(?:\s|$)/u)?.[1]).filter(Boolean));
  reachable.add(spec.commit);
  const packDirectory = join(root, '.git', 'objects', 'pack');
  const indexes = readdirSync(packDirectory).filter(name => name.endsWith('.idx'));
  if (indexes.length !== 1) throw new Error('source pack was not the single requested object set');
  const packed = new Set((await git(root, ['verify-pack', '-v', join(packDirectory, indexes[0])], env))
    .split(/\r?\n/u).map(line => line.match(/^([a-f0-9]{40,64})\s+(?:commit|tree|blob|tag)\s/u)?.[1]).filter(Boolean));
  if (packed.size !== reachable.size || [...packed].some(object => !reachable.has(object))) throw new Error('source pack contains objects outside the requested tree');
  rmSync(packFile, { force: true });
}

/** Install committed npm dependencies through an isolated content-addressed cache, refusing unknown lock managers. */
async function installDependencies(api, root, runnerRoot, privateHome, env, commitTree) {
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
  const cacheRoot = join(runnerRoot, 'cache', 'npm');
  const installCache = join(cacheRoot, 'installed');
  const contentCache = join(cacheRoot, 'content');
  const cache = join(installCache, key);
  mkdirSync(installCache, { recursive: true, mode: 0o700 });
  mkdirSync(contentCache, { recursive: true, mode: 0o700 });
  chmodSync(cacheRoot, 0o700); chmodSync(installCache, 0o700); chmodSync(contentCache, 0o700);
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  const cachePool = join(runnerRoot, 'cache', 'resource-pool');
  let releaseCache = null;
  try {
    if (!existsSync(cache)) {
      const lease = await acquireResourceApi(api, {
        name: `npm-cache-${key}`, capacity: 1, scope: 'machine', root: runnerRoot,
        repo: runnerRoot, agent: 'pullboard-runner-cache', kind: 'npm-cache',
        onWait: () => assertTransportLive(),
      }, cachePool);
      releaseCache = lease.release;
    }
    if (!existsSync(cache)) {
      const build = mkdtempSync(join(installCache, `${key}.build-`));
      try {
        rmSync(join(root, 'node_modules'), { recursive: true, force: true });
        const npm = spawnOwned('npm', ['ci', '--cache', contentCache], {
          cwd: root, env, stdio: ['ignore', 'ignore', 'ignore'],
        });
        const result = await npm.closed;
        await drainOwned(npm);
        if (result.error || result.code !== 0 || result.signal) throw new Error('committed npm dependencies could not be installed');
        mkdirSync(join(root, 'node_modules'), { recursive: true, mode: 0o700 });
        cpSync(join(root, 'node_modules'), join(build, 'node_modules'), { recursive: true, errorOnExist: true, verbatimSymlinks: true });
        renameSync(build, cache);
      } finally { rmSync(build, { recursive: true, force: true }); }
    }
    const from = join(cache, 'node_modules');
    if (!existsSync(join(root, 'node_modules'))) cpSync(from, join(root, 'node_modules'), { recursive: true, errorOnExist: true, verbatimSymlinks: true });
  } finally {
    try { releaseCache?.(); }
    finally {
      if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
      else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
    }
  }
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
  // Give the whole owned group two seconds to handle TERM, even if its leader exits first.
  const graceUntil = Date.now() + 2_000;
  let alive = true;
  while (alive && Date.now() < graceUntil) {
    try { process.kill(-pid, 0); }
    catch (error) { if (error.code === 'ESRCH') { alive = false; break; } throw error; }
    await new Promise(resolvePause => setTimeout(resolvePause, 25));
  }
  if (alive) {
    try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  for (;;) {
    try { process.kill(-pid, 0); }
    catch (error) { if (error.code === 'ESRCH') break; throw error; }
    await new Promise(resolvePause => setTimeout(resolvePause, 50));
  }
  await closed;
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
  await writes;
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
    await receivePack(packFile);
    lease = await acquireResourceApi(api, {
      name: 'gate', capacity: gateCapacity, scope: 'machine', root: runnerRoot,
      repo: runnerRoot, agent: `pullboard-ssh-${spec.id}`,
      landing: spec.landing === true, itemCheck: spec.itemCheck === true,
      diagnostic: spec.diagnostic === true, browser: spec.browserRequired,
      item: spec.item ?? '', kind: spec.kind ?? 'remote-command',
      onWait: () => assertTransportLive(),
    }, machineHomePath);
    const canonicalMachineHome = machineHomePath;
    const env = scopedEnvironment(privateHome, temporary, canonicalMachineHome, lease, api);
    const init = spawnOwned('git', ['init', '-q', `--object-format=${spec.commit.length === 64 ? 'sha256' : 'sha1'}`, root], {
      cwd: runDirectory, env, stdio: ['ignore', 'ignore', 'ignore'],
    });
    const initResult = await init.closed;
    await drainOwned(init);
    if (initResult.error || initResult.code !== 0 || initResult.signal) throw new Error('source checkout could not be initialized');
    await unpackSource(root, packFile, spec, env);
    await installDependencies(api, root, runnerRoot, privateHome, env, spec.tree);
    final = { ...(await runCommand(spec, root, env, sink)), root };
  } catch (error) {
    const message = safeSetupMessage(error);
    if (!transportLost) await sink.write(`${message}\n`);
    final = { code: 1, signal: transportLost ? 'SIGHUP' : null, error: message, root: '' };
  } finally {
    await drainAllOwned();
    if (lease) {
      try { lease.release(); } catch { /* Retaining a lease on cleanup error is safer than speculative deletion. */ }
    }
    if (runDirectory) { try { rmSync(runDirectory, { recursive: true, force: true }); } catch {} }
  }
  if (transportLost) { process.exitCode = 1; return; }
  await receipt(spec, final, sink);
  process.exitCode = 0;
}

main().catch(() => { process.exitCode = 1; });
