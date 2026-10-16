/** Real-process resource queue and lease coverage [Q1,Q2,Q3]. */
import assert from 'node:assert/strict';
import { startFixtureChild as spawn, runFixtureChild as spawnSync, reportFixtureChildFailure, runFixtureChild, runFixtureChildAsync, runFixtureGit } from './fixture-child.js';
import { performance } from 'node:perf_hooks';
import { once } from 'node:events';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { listResources, setResourceCapacity, takeResource } from '../src/resources.js';
import { checkNeedsBrowser } from '../src/browser-admission.js';

const TEMP = [];
const CHILDREN = new Set();
const MODULE = pathToFileURL(resolve(import.meta.dirname, '../src/resources.js')).href;
const GATE_MODULE = pathToFileURL(resolve(import.meta.dirname, '../src/gate.js')).href;
const SETTINGS_MODULE = pathToFileURL(resolve(import.meta.dirname, '../src/settings.js')).href;
const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const TEST_RUNNER = resolve(import.meta.dirname, '../bin/run-tests.js');
const POOL_MODULE_WORKER = `
import { takeResource } from ${JSON.stringify(MODULE)};
import { loadMachineSettings } from ${JSON.stringify(SETTINGS_MODULE)};
let announced = false;
const [root, agent, browserText, item, kind, landingText] = process.argv.slice(1);
const lease = await takeResource({
  name: 'gate', capacity: 2, scope: 'machine', root, agent,
  browserCapacityProvider: () => loadMachineSettings().browserSlots,
  browser: browserText === 'true', item, kind, itemCheck: kind === 'review',
  diagnostic: kind === 'diagnostic', landing: landingText === 'true',
  onWait: (state) => {
    if (!announced) { announced = true; console.log(JSON.stringify({ queued: state })); }
  },
});
try {
  console.log(JSON.stringify({ acquired: agent }));
  for await (const line of process.stdin) {
    if (String(line).trim() === 'release') break;
  }
} finally { lease.release(); }
`;
const SUBMIT_CHECK = `
import { runSubmitGate } from ${JSON.stringify(GATE_MODULE)};
const [root, base, check] = process.argv.slice(1);
const result = await runSubmitGate(root, { gate: 'true', affectedTests: 'node bin/run-tests.js test/cpu-check.test.js' }, {
  base, changed: ['test/cpu-check.test.js'], check, agent: 'submit-check', item: '636',
});
process.stdout.write(JSON.stringify({ green: result.isGreen, full: result.full, reason: result.reason, files: result.files, checkGreen: result.check.green }) + '\\n');
`;
const PROCESS_INFO_POLICY = '(version 1)(allow default)(deny process-info*)';
const SANDBOX_EXEC = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
const PERL_FORK = process.platform === 'darwin' && existsSync('/usr/bin/perl');
const WORKER = `
import { takeResource } from ${JSON.stringify(MODULE)};
const [name, capacity, scope, root, agent, stallMs, landingText] = process.argv.slice(1);
let lastWait = '';
const lease = await takeResource({ name, capacity: Number(capacity), scope, root, agent, landing: landingText === 'true', onWait: ({position, holders, line, rejoined}) => {
  const state = JSON.stringify({waiting:position, holders, line, rejoined:rejoined ?? false});
  if (!lastWait || rejoined) { lastWait = state; console.log(state); }
} });
console.log(JSON.stringify({acquired:agent}));
let secondLease;
if (Number(stallMs) > 0) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(stallMs));
  console.log(JSON.stringify({resumed:true}));
}
process.stdin.setEncoding('utf8');
for await (const line of process.stdin) {
  if (line.trim() === 'second') {
    takeResource({ name, capacity: Number(capacity), scope, root, agent, landing: true }).then((nextLease) => {
      secondLease = nextLease;
      console.log(JSON.stringify({secondAcquired: agent}));
    });
  }
  if (line.trim() === 'renew') {
    try { lease.renew(); console.log(JSON.stringify({renewed:true})); }
    catch (error) { console.log(JSON.stringify({renewError:error.code})); }
  }
  if (line.trim() === 'release') { lease.release(); secondLease?.release(); break; }
}
`;

/** Create isolated machine storage and a pair of real Git repositories. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-resources-'));
  TEMP.push(dir);
  const home = join(dir, 'home');
  const first = join(dir, 'repo-a');
  const second = join(dir, 'repo-b');
  for (const repo of [first, second]) {
    mkdirSync(repo);
    const result = runFixtureChild('git', ['init', '-q', repo], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.failure);
  }
  return { dir, home, first, second, env: { ...process.env, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: home } };
}

/** Wait for a fixture command to create a marker file, with a hang ceiling only for failure. */
function waitForMarker(path, timeoutMs = 10_000) {
  if (existsSync(path)) return Promise.resolve();
  const watcher = watch(dirname(path), { persistent: false });
  return new Promise((resolveMarker, rejectMarker) => {
    const timer = setTimeout(() => rejectMarker(new Error(`timed out waiting for ${path}`)), timeoutMs);
    const check = () => {
      if (!existsSync(path)) return;
      clearTimeout(timer);
      watcher.close();
      resolveMarker();
    };
    watcher.on('error', error => { clearTimeout(timer); rejectMarker(error); });
    watcher.on('change', check);
    watcher.on('rename', check);
    check();
  }).finally(() => watcher.close());
}

/** Create a minimal real board whose CPU check and affected tests share the private gate pool. */
function checkProject(box) {
  const repo = box.first;
  runFixtureGit(['branch', '-M', 'main'], { cwd: repo, env: box.env });
  const initialized = runFixtureChild(process.execPath, [BIN, 'init'], { cwd: repo, env: box.env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  const configPath = join(repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, `${JSON.stringify({ ...config, gate: 'true', spec: 'SPEC.md', affectedTests: 'node bin/run-tests.js', lanes: { web: { owns: ['web/'], specs: ['G1'] } }, shared: [] }, null, 2)}\n`);
  writeFileSync(join(repo, 'SPEC.md'), '# CPU check fixture\n\n## G · Goals\n- G1 [approved, must] The fixture keeps its board. | gate: true\n');
  writeFileSync(join(repo, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(repo, 'bin'), { recursive: true });
  cpSync(resolve(import.meta.dirname, '../src'), join(repo, 'src'), { recursive: true });
  copyFileSync(TEST_RUNNER, join(repo, 'bin/run-tests.js'));
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(join(repo, 'test/unrelated.test.js'), "import { test } from 'node:test'; test('unrelated test', () => {});\n");
  runFixtureGit(['add', '-A'], { cwd: repo, env: box.env });
  runFixtureGit(['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Resource fixture', '-c', 'user.email=resource@example.invalid', 'commit', '-q', '-m', 'fixture: initialize board'], { cwd: repo, env: box.env });
  const base = runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo, env: box.env });
  writeFileSync(join(repo, 'test/cpu-check.test.js'), `import { writeFileSync } from 'node:fs';\nimport { test } from 'node:test';\ntest('item check marker', () => writeFileSync('item-check-started', 'started'));\ntest('submit check marker', () => writeFileSync('submit-check-started', 'started'));\n`);
  runFixtureGit(['add', 'test/cpu-check.test.js'], { cwd: repo, env: box.env });
  runFixtureGit(['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Resource fixture', '-c', 'user.email=resource@example.invalid', 'commit', '-q', '-m', 'test: add CPU check'], { cwd: repo, env: box.env });
  return { repo, base };
}

/** Create the previous private queue schema so simultaneous openers exercise its migration. */
function oldSchema(box) {
  mkdirSync(box.home, { recursive: true });
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    db.exec(`CREATE TABLE resource (name TEXT PRIMARY KEY, capacity INTEGER NOT NULL);
      CREATE TABLE holder (token TEXT PRIMARY KEY, name TEXT NOT NULL, pid INTEGER NOT NULL, agent TEXT NOT NULL, repo TEXT NOT NULL, since TEXT NOT NULL, heartbeat INTEGER NOT NULL);
      CREATE INDEX holder_name ON holder(name);
      CREATE TABLE waiter (ticket INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pid INTEGER NOT NULL, agent TEXT NOT NULL, repo TEXT NOT NULL, since TEXT NOT NULL, heartbeat INTEGER NOT NULL);
      CREATE INDEX waiter_name_ticket ON waiter(name, ticket);`);
  } finally { db.close(); }
}

/** Force a stale private fixture row with a mismatched process start identity. */
function staleIdentity(box, table, agent) {
  assert.ok(['holder', 'waiter'].includes(table));
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    const result = db.prepare(`UPDATE ${table} SET started = ?, heartbeat = 0 WHERE agent = ?`).run('old-process-start', agent);
    assert.equal(result.changes, 1, `${agent} has a private ${table} row`);
  } finally { db.close(); }
}

/** Expire a private lease heartbeat without changing its recorded OS identity. */
function expireHeartbeat(box, table, agent) {
  assert.ok(['holder', 'waiter'].includes(table));
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    const result = db.prepare(`UPDATE ${table} SET heartbeat = 0 WHERE agent = ?`).run(agent);
    assert.equal(result.changes, 1, `${agent} has a private ${table} row`);
  } finally { db.close(); }
}

/** Read a private machine database without changing the process environment for other fixtures. */
function privateList(box, scope = 'machine', root = process.cwd()) {
  const previous = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = box.home;
  process.env.PULLBOARD_MACHINE_HOME = box.home;
  try { return listResources({ scope, root }); }
  finally {
    if (previous === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previous;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
}

/** Launch one independent process that takes a resource and waits for a release command. */
function worker(box, { name = 'gate', capacity = 1, scope = 'machine', root = box.first, agent, stallMs = 0, landing = false, env = {}, sandboxProcessInfo = false }) {
  const workerArgs = ['--input-type=module', '-e', WORKER, name, String(capacity), scope, root, agent, String(stallMs), String(landing)];
  const executable = sandboxProcessInfo ? '/usr/bin/sandbox-exec' : process.execPath;
  const args = sandboxProcessInfo ? ['-p', PROCESS_INFO_POLICY, process.execPath, ...workerArgs] : workerArgs;
  const startedAt = performance.now();
  const workerEnv = { ...box.env, ...env };
  const child = spawn(executable, args, {
    env: workerEnv, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.startedAt = startedAt;
  child.spawnEnv = workerEnv;
  child.lines = createInterface({ input: child.stdout });
  child.errors = '';
  child.pendingLines = [];
  child.lineWaiters = [];
  child.exitResult = null;
  child.failureReported = false;
  let spawnError = null;
  child.once('error', (error) => { spawnError = error; });
  child.finished = new Promise((resolveExit) => child.once('close', (code, signal) => {
    child.exitResult = { code, signal };
    CHILDREN.delete(child);
    if ((code !== 0 || signal || spawnError) && !child.failureReported) {
      child.failureReported = true;
      child.failure = reportFixtureChildFailure({ command: executable, args, status: code, signal,
        elapsedMs: performance.now() - startedAt, stderr: child.errors, env: workerEnv,
        detail: spawnError?.message ?? '' });
    }
    for (const waiter of child.lineWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(child.failure ?? `worker exited ${code}/${signal}: ${child.errors}`));
    }
    resolveExit(child.exitResult);
  }));
  child.stderr.setEncoding('utf8').on('data', (chunk) => { child.errors += chunk; });
  child.lines.on('line', (line) => {
    const waiter = child.lineWaiters.shift();
    if (waiter) { clearTimeout(waiter.timer); waiter.resolve(line); }
    else child.pendingLines.push(line);
  });
  CHILDREN.add(child);
  return child;
}

/** Launch a dedicated gate-pool worker carrying browser and queue-priority metadata. */
function poolWorker(box, { agent, browser = false, item = '', kind = '', landing = false }) {
  const workerArgs = ['--input-type=module', '-e', POOL_MODULE_WORKER, box.first, agent, String(browser), item, kind, String(landing)];
  const startedAt = performance.now();
  const child = spawn(process.execPath, workerArgs, {
    env: box.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.startedAt = startedAt;
  child.spawnEnv = box.env;
  child.lines = createInterface({ input: child.stdout });
  child.errors = '';
  child.pendingLines = [];
  child.lineWaiters = [];
  child.exitResult = null;
  child.failureReported = false;
  let spawnError = null;
  child.once('error', (error) => { spawnError = error; });
  child.finished = new Promise((resolveExit) => child.once('close', (code, signal) => {
    child.exitResult = { code, signal };
    CHILDREN.delete(child);
    if ((code !== 0 || signal || spawnError) && !child.failureReported) {
      child.failureReported = true;
      child.failure = reportFixtureChildFailure({ command: process.execPath, args: workerArgs, status: code, signal,
        elapsedMs: performance.now() - startedAt, stderr: child.errors, env: box.env,
        detail: spawnError?.message ?? '' });
    }
    for (const waiter of child.lineWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(child.failure ?? `pool worker exited ${code}/${signal}: ${child.errors}`));
    }
    resolveExit(child.exitResult);
  }));
  child.stderr.setEncoding('utf8').on('data', (chunk) => { child.errors += chunk; });
  child.lines.on('line', (line) => {
    const waiter = child.lineWaiters.shift();
    if (waiter) { clearTimeout(waiter.timer); waiter.resolve(line); }
    else child.pendingLines.push(line);
  });
  CHILDREN.add(child);
  return child;
}

/** Configure browser slots through the public CLI in this fixture's private machine home. */
function configureBrowserSlots(box, slots) {
  return runFixtureChild(process.execPath, [BIN, 'settings', 'browserSlots', String(slots), '--json'], {
    cwd: box.first, env: box.env, encoding: 'utf8',
  });
}

/** Set or remove the opt-in browser-free-check policy in a fixture's machine settings. */
function setBrowserFreeChecks(box, value) {
  const file = join(box.home, 'settings.json');
  if (value === undefined) { rmSync(file, { force: true }); return; }
  mkdirSync(box.home, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ gate: { browserFreeChecks: value } }, null, 2)}\n`);
}

/** Write a fixture's machine queue-order settings (gate.queue); undefined removes the settings file. */
function setQueueOrder(box, queue) {
  const file = join(box.home, 'settings.json');
  if (queue === undefined) { rmSync(file, { force: true }); return; }
  mkdirSync(box.home, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ gate: { queue } }, null, 2)}\n`);
}

/** Read the next worker event, failing promptly with its stderr if it exits unexpectedly. */
async function event(child, timeoutMs = 10_000) {
  if (child.pendingLines.length) return JSON.parse(child.pendingLines.shift());
  if (child.exitResult) throw new Error(child.failure ?? `worker exited ${child.exitResult.code}/${child.exitResult.signal}: ${child.errors}`);
  const line = await new Promise((resolveLine, reject) => {
    const waiter = { resolve: resolveLine, reject, timer: setTimeout(() => {
      child.lineWaiters.splice(child.lineWaiters.indexOf(waiter), 1);
      child.failureReported = true;
      const failure = reportFixtureChildFailure({ command: child.spawnfile, args: child.spawnargs.slice(1),
        status: child.exitResult?.code ?? null, signal: child.exitResult?.signal ?? null,
        elapsedMs: performance.now() - child.startedAt, stderr: child.errors, env: child.spawnEnv,
        detail: `worker timed out waiting for its event after ${timeoutMs}ms` });
      reject(new Error(failure));
    }, timeoutMs) };
    child.lineWaiters.push(waiter);
  });
  return JSON.parse(line);
}

/** Read worker events until its real process acquires a resource place. */
async function acquired(child) {
  while (true) {
    const state = await event(child);
    if (state.acquired) return state;
  }
}

/** Read the OS process state for an exact PID under stable locale settings. */
function processState(pid) {
  const result = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' },
  });
  return result.status === 0 ? result.stdout.trim().split(/\s+/u)[0] ?? '' : '';
}

/** Wait until the OS reports a requested process state, or fail with the last state observed. */
async function waitForProcessState(pid, state, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let actual = processState(pid);
  while (!actual.startsWith(state) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
    actual = processState(pid);
  }
  assert.ok(actual.startsWith(state), `process ${pid} has state ${actual || '(unreadable)'}, expected ${state}`);
}

/** Sleep without blocking the test runner event loop. */
function delay(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }

/** Wait for one private queue observation without imposing a longer lease or gate timeout. */
async function waitUntil(predicate, description, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail(`timed out waiting for ${description}`);
}

/** Add an expired holder row to a private fixture database. */
function insertExpiredHolder(box, { name, pid, agent, started = '' }) {
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    db.prepare('INSERT INTO resource(name, capacity) VALUES (?, 1)').run(name);
    db.prepare('INSERT INTO holder(token, name, pid, started, agent, repo, since, heartbeat) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`fixture-${agent}`, name, pid, started, agent, realpathSync(box.first), new Date(Date.now() - 60_000).toISOString(), Date.now() - 60_000);
  } finally { db.close(); }
}

/** Ask a holder to release and wait for clean process exit. */
async function release(child) {
  child.stdin.end('release\n');
  const { code } = await child.finished;
  child.lines.close();
  assert.equal(code, 0, child.errors);
}

test('single-quoted named-test checks skip the browser slot [C7]', async () => {
  const box = fixture();
  const { repo } = checkProject(box);
  const itemCheck = 'node bin/run-tests.js --test-name-pattern "item check marker" test/cpu-check.test.js';
  /** Keep assertions about the parser independent of worker custody inherited by the test process. */
  const classify = command => checkNeedsBrowser(repo, command, { env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(await classify(itemCheck), false, 'an explicit CPU-only test file is classifiable');
  const outputPattern = '^[[:space:]]*ok [0-9]+ - item check marker';
  const newlinePrint = ([quote, backslashes]) => `printf ${quote}%s${'\\'.repeat(backslashes)}n${quote} "$out"`;
  const capturedCheck = (formats, patternQuotes) => `out=$(${itemCheck} 2>&1); ${newlinePrint(formats[0])}; ${newlinePrint(formats[1])} | grep -Eq ${patternQuotes[0]}${outputPattern}${patternQuotes[0]} && ${newlinePrint(formats[2])} | grep -Eq ${patternQuotes[1]}^# fail 0$${patternQuotes[1]}`;
  const oneBackslash = [1, 1, 1];
  const accepted = [
    { formats: oneBackslash.map(count => ['\'', count]), patternQuotes: ['\'', '\''] },
    { formats: [['\'', 1], ['"', 1], ['\'', 1]], patternQuotes: ['"', '\''] },
    { formats: [['"', 1], ['\'', 1], ['"', 1]], patternQuotes: ['\'', '"'] },
    { formats: oneBackslash.map(count => ['"', count]), patternQuotes: ['"', '"'] },
  ];
  for (const variant of accepted) {
    assert.equal(await classify(capturedCheck(variant.formats, variant.patternQuotes)), false,
      `the exact capture wrapper accepts quote changes with one literal backslash: ${JSON.stringify(variant)}`);
  }
  for (let index = 0; index < 3; index += 1) {
    const formats = oneBackslash.map(count => ['\'', count]);
    formats[index] = ['\'', 2];
    assert.equal(await classify(capturedCheck(formats, ['\'', '\''])), true,
      `a two-backslash printf at position ${index + 1} stays browser-gated`);
  }
  assert.equal(await classify(`${capturedCheck(accepted[0].formats, accepted[0].patternQuotes)}; :`), true,
    'an arbitrary suffix remains outside the exact capture wrapper');
  const substituted = capturedCheck(accepted[0].formats, accepted[0].patternQuotes)
    .replace('printf \'%s\\n\' "$out"', 'printf \'%s\\n\' "$(printf %s "$out")"');
  assert.equal(await classify(substituted), true, 'a command substitution remains outside the exact printf wrapper');
  assert.equal(await classify('node bin/run-tests.js test/cockpit/brief.test.js'), true,
    'known browser suites remain browser-gated');
  assert.equal(await checkNeedsBrowser(repo, itemCheck, {
    env: { ...process.env, NODE_OPTIONS: '--import=unknown-preload.mjs' },
  }), true, 'an unclassified preload keeps the check browser-gated');
});

test('a non-browser check does not wait for the browser slot [C7]', async () => {
  const box = fixture();
  setBrowserFreeChecks(box, true);
  const { repo, base } = checkProject(box);
  const itemCheck = 'node bin/run-tests.js --test-name-pattern "item check marker" test/cpu-check.test.js';
  const submitCheck = 'node bin/run-tests.js --test-name-pattern "submit check marker" test/cpu-check.test.js';
  const added = runFixtureChild(process.execPath, [BIN, 'add', 'coordinator', 'CPU check item', '--check', itemCheck, '--wait', '--json'], {
    cwd: repo, env: box.env, encoding: 'utf8',
  });
  assert.equal(added.status, 0, added.stderr);
  const item = JSON.parse(added.stdout).item.item_id;
  assert.equal(existsSync(join(repo, 'item-check-started')), false, 'the setup baseline ran in its private clone');

  const browserHolder = poolWorker(box, { agent: 'check-browser-holder', browser: true, item: '636', kind: 'gate' });
  await acquired(browserHolder);
  const itemMarker = join(repo, 'item-check-started');
  const itemStarted = waitForMarker(itemMarker);
  const itemRun = runFixtureChildAsync(process.execPath, [BIN, 'check', String(item), '--yes'], { cwd: repo, env: box.env });
  let itemResult;
  try {
    await itemStarted;
    assert.ok(privateList(box).find(({ name }) => name === 'browser')?.holders.some(({ agent }) => agent === 'check-browser-holder'),
      'the item check starts while the unrelated browser lease remains held');
  } finally {
    await release(browserHolder);
    itemResult = await itemRun;
  }
  assert.equal(itemResult.status, 0, itemResult.failure ?? itemResult.stderr);
  assert.equal(readFileSync(itemMarker, 'utf8'), 'started');

  const nextBrowserHolder = poolWorker(box, { agent: 'submit-browser-holder', browser: true, item: '636', kind: 'gate' });
  await acquired(nextBrowserHolder);
  const submitMarker = join(repo, 'submit-check-started');
  const submitStarted = waitForMarker(submitMarker);
  const submitRun = runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', SUBMIT_CHECK, repo, base, submitCheck], { cwd: repo, env: box.env });
  let submitResult;
  let submitStartFailure = null;
  try {
    try { await submitStarted; }
    catch (error) { submitStartFailure = error; }
    assert.ok(privateList(box).find(({ name }) => name === 'browser')?.holders.some(({ agent }) => agent === 'submit-browser-holder'),
      'the submission check starts while the unrelated browser lease remains held');
  } finally {
    await release(nextBrowserHolder);
    submitResult = await submitRun;
  }
  assert.equal(submitStartFailure, null, `${submitStartFailure?.message ?? ''}\n${submitResult.stdout}\n${submitResult.stderr}`);
  assert.equal(submitResult.status, 0, submitResult.failure ?? submitResult.stderr);
  assert.deepEqual(JSON.parse(submitResult.stdout), {
    green: true, full: false, reason: '', files: ['test/cpu-check.test.js'], checkGreen: true,
  }, submitResult.stderr);
});

test('browser-free checks skip the slot only when the machine allows it [C7]', async () => {
  const box = fixture();
  const { repo } = checkProject(box);
  const check = `out=$(node bin/run-tests.js --test-name-pattern "item check marker" test/cpu-check.test.js 2>&1); printf '%s\\n' "$out"; printf '%s\\n' "$out" | grep -Eq '^[[:space:]]*ok [0-9]+ - item check marker' && printf '%s\\n' "$out" | grep -Eq '^# fail 0$'`;
  const added = runFixtureChild(process.execPath, [BIN, 'add', 'coordinator', 'Browser-free policy check', '--check', check, '--wait', '--json'], {
    cwd: repo, env: box.env, encoding: 'utf8',
  });
  assert.equal(added.status, 0, added.stderr);
  const item = JSON.parse(added.stdout).item.item_id;
  const marker = join(repo, 'item-check-started');

  async function checkWithPolicy(value, shouldStartWithBrowserHeld) {
    setBrowserFreeChecks(box, value);
    rmSync(marker, { force: true });
    const browserHolder = poolWorker(box, { agent: `policy-browser-${String(value)}`, browser: true, item: '681', kind: 'gate' });
    await acquired(browserHolder);
    const started = waitForMarker(marker);
    const resultPromise = runFixtureChildAsync(process.execPath, [BIN, 'check', String(item), '--yes'], { cwd: repo, env: box.env });
    let result;
    try {
      if (shouldStartWithBrowserHeld) {
        await started;
        assert.ok(privateList(box).find(({ name }) => name === 'browser')?.holders.some(({ agent }) => agent === `policy-browser-${String(value)}`),
          'the browser lease stays live while an opted-in browser-free check runs');
      } else {
        await waitUntil(() => privateList(box).find(({ name }) => name === 'gate')?.line.some(({ kind, item: waitingItem }) => kind === 'check' && waitingItem === String(item)),
          'a browser-disabled check to wait in the gate queue');
        assert.equal(existsSync(marker), false, 'the check does not start while browser-free checks are disabled or absent');
      }
    } finally {
      await release(browserHolder);
      result = await resultPromise;
    }
    assert.equal(result.status, 0, result.failure ?? result.stderr);
    assert.equal(readFileSync(marker, 'utf8'), 'started');
  }

  await checkWithPolicy(false, false);
  await checkWithPolicy(true, true);
  await checkWithPolicy(undefined, false);
});

/** Kill and reap every fixture worker before deleting its private files. */
after(async () => {
  const running = [...CHILDREN];
  for (const child of running) if (!child.exitResult) child.kill('SIGKILL');
  await Promise.all(running.map((child) => child.finished));
  for (const child of running) child.lines.close();
  TEMP.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

/** Prove the machine setting changes real browser admission while retaining the single-slot default [C7]. */
test('browserSlots admits that many browser runs and no more [C7]', async () => {
  const defaults = fixture();
  const defaultSettings = runFixtureChild(process.execPath, [BIN, 'settings', '--json'], {
    cwd: defaults.first, env: defaults.env, encoding: 'utf8',
  });
  assert.equal(defaultSettings.status, 0, defaultSettings.stderr);
  assert.equal(JSON.parse(defaultSettings.stdout).settings.browserSlots, 1, 'an unset machine keeps the existing single browser slot');

  const box = fixture();
  const configured = configureBrowserSlots(box, 2);
  assert.equal(configured.status, 0, configured.stderr);
  assert.equal(JSON.parse(configured.stdout).settings.browserSlots, 2);
  const readBack = runFixtureChild(process.execPath, [BIN, 'settings', '--json'], {
    cwd: box.first, env: box.env, encoding: 'utf8',
  });
  assert.equal(readBack.status, 0, readBack.stderr);
  assert.equal(JSON.parse(readBack.stdout).settings.browserSlots, 2, 'the machine setting persists for other processes');
  assert.equal(privateList(box).find(({ name }) => name === 'browser').capacity, 2,
    'the shared browser resource row has the configured capacity before workers start');
  const invalid = configureBrowserSlots(box, 3);
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).error.code, 'BAD_BROWSER_SLOTS');
  assert.match(JSON.parse(invalid.stdout).error.message, /pullboard settings gateSlots/u);

  const first = poolWorker(box, { agent: 'browser-one', browser: true });
  assert.equal((await acquired(first)).acquired, 'browser-one');
  const second = poolWorker(box, { agent: 'browser-two', browser: true });
  const secondStart = await event(second);
  if (!secondStart.acquired) {
    const gate = privateList(box).find(({ name }) => name === 'gate');
    const browser = privateList(box).find(({ name }) => name === 'browser');
    assert.fail(`the configured second browser lease queued: ${JSON.stringify({ state: secondStart.queued, gate, browser })}`);
  }
  assert.equal(secondStart.acquired, 'browser-two', 'the configured second browser lease starts while the first is held');
  const third = poolWorker(box, { agent: 'browser-three', browser: true });
  assert.equal((await event(third)).queued.position, 1, 'the next browser run waits for a configured slot');
  const browser = privateList(box).find(({ name }) => name === 'browser');
  assert.equal(browser.capacity, 2, 'resource listing reflects the machine browserSlots setting');
  assert.equal(browser.holders.length, 2);
  assert.deepEqual(browser.holders.map(({ agent }) => agent).sort(), ['browser-one', 'browser-two']);
  assert.deepEqual(browser.line.map(({ agent }) => agent), ['browser-three']);

  await release(first);
  assert.equal((await acquired(third)).acquired, 'browser-three', 'a released browser lease admits the oldest waiting browser run');
  await release(second);
  await release(third);
});

test('[Q1,Q2] capacity-one takers acquire in strict FIFO arrival order', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'holder' });
  assert.equal((await event(holder)).acquired, 'holder');
  const waiting = [];
  let firstQueuedAt = 0;
  for (const agent of ['first', 'second', 'third']) {
    const child = worker(box, { agent });
    waiting.push(child);
    const state = await event(child);
    assert.equal(state.waiting, waiting.length, `${agent} reports its FIFO place`);
    assert.equal(state.holders[0].agent, 'holder', `${agent} says who holds the place`);
    if (agent === 'first') {
      assert.equal(state.holders[0].repo, realpathSync(box.first), 'machine-scope listings still identify the Git root');
      firstQueuedAt = Date.parse(state.line[0].since);
      assert.ok(Number.isFinite(firstQueuedAt));
    }
  }
  const order = [];
  let current = holder;
  for (const [index, child] of waiting.entries()) {
    await release(current);
    assert.equal((await event(child)).acquired, ['first', 'second', 'third'][index]);
    if (index === 0) {
      const displayed = privateList(box).find((resource) => resource.name === 'gate').holders[0];
      assert.ok(Date.parse(displayed.since) > firstQueuedAt, 'holder since is when capacity was acquired, not when it joined the queue');
    }
    order.push(['first', 'second', 'third'][index]);
    current = child;
  }
  await release(current);
  assert.deepEqual(order, ['first', 'second', 'third']);
});

test('[Q1,Q2] landing waiters jump ordinary gates but keep FIFO within each class [Q1,Q2]', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'holder' });
  assert.equal((await event(holder)).acquired, 'holder');
  const ordinaryFirst = worker(box, { agent: 'ordinary-first' });
  assert.equal((await event(ordinaryFirst)).waiting, 1);
  const landingFirst = worker(box, { agent: 'landing-first', landing: true });
  assert.equal((await event(landingFirst)).waiting, 1);
  const ordinarySecond = worker(box, { agent: 'ordinary-second' });
  assert.equal((await event(ordinarySecond)).waiting, 3);
  const landingSecond = worker(box, { agent: 'landing-second', landing: true });
  assert.equal((await event(landingSecond)).waiting, 2);
  const listed = privateList(box)[0].line;
  assert.deepEqual(listed.map(({ agent, landing }) => [agent, landing]), [
    ['landing-first', true], ['landing-second', true], ['ordinary-first', false], ['ordinary-second', false],
  ]);

  await release(holder);
  assert.equal((await event(landingFirst)).acquired, 'landing-first');
  await release(landingFirst);
  assert.equal((await event(landingSecond)).acquired, 'landing-second');
  await release(landingSecond);
  assert.equal((await event(ordinaryFirst)).acquired, 'ordinary-first');
  await release(ordinaryFirst);
  assert.equal((await event(ordinarySecond)).acquired, 'ordinary-second');
  await release(ordinarySecond);
});

test('the pool alone orders submits, reviews and browser runs [C7]', async () => {
  const orderBox = fixture();
  const orderHolder = poolWorker(orderBox, { agent: 'order-holder' });
  const otherHolder = poolWorker(orderBox, { agent: 'other-holder' });
  assert.equal((await acquired(orderHolder)).acquired, 'order-holder');
  assert.equal((await acquired(otherHolder)).acquired, 'other-holder');

  const olderReview = poolWorker(orderBox, { agent: 'older-review', browser: true, item: '620', kind: 'review' });
  assert.equal((await event(olderReview)).queued.position, 1);
  const laterFocused = poolWorker(orderBox, { agent: 'later-focused', kind: 'focused' });
  assert.ok((await event(laterFocused)).queued, 'later focused work has joined behind the review');

  await release(orderHolder);
  await waitUntil(() => privateList(orderBox).find(({ name }) => name === 'gate').holders
    .some(({ agent }) => agent === 'older-review' || agent === 'later-focused'), 'the first eligible waiter to acquire');
  let orderedGate = privateList(orderBox).find(({ name }) => name === 'gate');
  assert.ok(orderedGate.holders.some(({ agent, itemCheck, item }) =>
    agent === 'older-review' && itemCheck && item === '620'),
  'an older eligible review stays ahead of later focused work');
  assert.ok(!orderedGate.holders.some(({ agent }) => agent === 'later-focused'),
    'later focused work cannot jump the older review');
  assert.equal((await acquired(olderReview)).acquired, 'older-review');

  const diagnosticOne = poolWorker(orderBox, { agent: 'diagnostic-one', kind: 'diagnostic' });
  assert.equal((await event(diagnosticOne)).queued.position, 2);
  const laterReview = poolWorker(orderBox, { agent: 'later-review', item: '621', kind: 'review' });
  assert.equal((await event(laterReview)).queued.position, 3);
  const diagnosticTwo = poolWorker(orderBox, { agent: 'diagnostic-two', kind: 'diagnostic' });
  assert.equal((await event(diagnosticTwo)).queued.position, 4);
  const laterGate = poolWorker(orderBox, { agent: 'later-gate', kind: 'focused' });
  assert.equal((await event(laterGate)).queued.position, 5);
  const laterLanding = poolWorker(orderBox, { agent: 'later-landing', landing: true });
  await event(laterLanding);
  orderedGate = privateList(orderBox).find(({ name }) => name === 'gate');
  assert.deepEqual(orderedGate.line.map(({ agent, landing, diagnostic, itemCheck, kind }) =>
    [agent, landing, diagnostic === true, itemCheck, kind ?? '']), [
    ['later-landing', true, false, false, ''],
    ['later-focused', false, false, false, 'focused'],
    ['diagnostic-one', false, true, false, 'diagnostic'],
    ['later-review', false, false, true, 'review'],
    ['diagnostic-two', false, true, false, 'diagnostic'],
    ['later-gate', false, false, false, 'focused'],
  ], 'landing moves ahead while all other kinds retain their arrival order');

  await release(otherHolder);
  assert.equal((await acquired(laterLanding)).acquired, 'later-landing',
    'a later landing jumps the older focused and diagnostic waiters');
  orderedGate = privateList(orderBox).find(({ name }) => name === 'gate');
  assert.ok(orderedGate.holders.some(({ agent, landing }) => agent === 'later-landing' && landing));

  await release(laterLanding);
  assert.equal((await acquired(laterFocused)).acquired, 'later-focused',
    'the oldest eligible non-landing waiter acquires next');
  await release(laterFocused);
  assert.equal((await acquired(diagnosticOne)).acquired, 'diagnostic-one');
  await release(diagnosticOne);
  assert.equal((await acquired(laterReview)).acquired, 'later-review',
    'a diagnostic does not yield its older ticket to a later item check');
  await release(laterReview);
  assert.equal((await acquired(diagnosticTwo)).acquired, 'diagnostic-two',
    'diagnostics keep their FIFO place around a later item check');
  await release(diagnosticTwo);
  assert.equal((await acquired(laterGate)).acquired, 'later-gate',
    'a diagnostic does not yield its older ticket to later ordinary gate work');
  await release(laterGate);
  await release(olderReview);

  const box = fixture();
  const firstHolder = poolWorker(box, { agent: 'submit-one' });
  const secondHolder = poolWorker(box, { agent: 'submit-two' });
  assert.equal((await acquired(firstHolder)).acquired, 'submit-one');
  assert.equal((await acquired(secondHolder)).acquired, 'submit-two');

  const firstReview = poolWorker(box, { agent: 'review-one', browser: true, item: '618', kind: 'review' });
  const firstQueued = await event(firstReview);
  assert.equal(firstQueued.queued.position, 1, 'a review waits while both submit slots are occupied');
  let browser = privateList(box).find(({ name }) => name === 'browser');
  assert.ok(browser, 'the pool must expose browser capacity and its waiting review');
  assert.equal(browser.capacity, 1, 'the browser pool has its fixed single slot');
  assert.deepEqual(browser.line.map(({ agent, browser: ownsBrowser, itemCheck, item, kind }) =>
    [agent, ownsBrowser, itemCheck, item, kind]), [['review-one', true, true, '618', 'review']]);

  // Releasing one holder is the only signal; the oldest eligible review acquires on its own poll.
  await release(firstHolder);
  assert.equal((await acquired(firstReview)).acquired, 'review-one');
  let gate = privateList(box).find(({ name }) => name === 'gate');
  assert.ok(gate.holders.some(({ agent, browser: ownsBrowser, itemCheck, item, kind }) =>
    agent === 'review-one' && ownsBrowser && itemCheck && item === '618' && kind === 'review'));

  const secondReview = poolWorker(box, { agent: 'review-two', browser: true, item: '619', kind: 'review' });
  const secondQueued = await event(secondReview);
  assert.equal(secondQueued.queued.position, 1, 'the browser waiter reports its actual queue position');
  const thirdSubmit = poolWorker(box, { agent: 'submit-three' });
  const submitQueued = await event(thirdSubmit);
  assert.equal(submitQueued.queued.position, 2,
    'the visible queue preserves FIFO position behind its earlier browser waiter');
  browser = privateList(box).find(({ name }) => name === 'browser');
  assert.deepEqual(browser.line.map(({ agent, itemCheck, item, kind }) => [agent, itemCheck, item, kind]), [
    ['review-two', true, '619', 'review'],
  ], 'the active browser review is listed as a holder, not as a waiter');
  assert.ok(browser.holders.some(({ agent, browser: ownsBrowser, itemCheck, item, kind }) =>
    agent === 'review-one' && ownsBrowser && itemCheck && item === '618' && kind === 'review'));

  // A free gate slot appears while the browser slot remains held; the queued submit proceeds.
  await release(secondHolder);
  assert.equal((await acquired(thirdSubmit)).acquired, 'submit-three');
  assert.ok(privateList(box).find(({ name }) => name === 'browser').line
    .some(({ agent }) => agent === 'review-two'), 'the second review stays queued while the browser slot is occupied');

  // Releasing both older leases lets the oldest eligible browser waiter proceed without a message.
  await release(thirdSubmit);
  await release(firstReview);
  assert.equal((await acquired(secondReview)).acquired, 'review-two');
  gate = privateList(box).find(({ name }) => name === 'gate');
  assert.ok(gate.holders.some(({ agent, browser: ownsBrowser, itemCheck, item, kind }) =>
    agent === 'review-two' && ownsBrowser && itemCheck && item === '619' && kind === 'review'));
  await release(secondReview);
});

test('the pool admits reviews before submits before focused runs, and waiting runs age up [C7,V4]', async () => {
  const AGE_MS = 30 * 60_000;
  const box = fixture();
  setQueueOrder(box, { reviewsFirst: true }); // #697: class order is a machine opt-in.
  const holders = [poolWorker(box, { agent: 'holder-one' }), poolWorker(box, { agent: 'holder-two' })];
  for (const holder of holders) await acquired(holder);
  const waiting = new Map();
  const positions = {};
  for (const [agent, options] of [
    ['focused-one', { kind: 'focused' }],
    ['diagnostic-one', { kind: 'diagnostic' }],
    ['submit-one', { kind: 'submit', item: '650' }],
    ['review-one', { kind: 'review', item: '651' }],
    ['landing-one', { landing: true }],
    ['focused-two', { kind: 'focused' }],
  ]) {
    const child = poolWorker(box, { agent, ...options });
    waiting.set(agent, child);
    positions[agent] = (await event(child)).queued.position;
  }
  assert.deepEqual(positions, { 'focused-one': 1, 'diagnostic-one': 2, 'submit-one': 1, 'review-one': 1, 'landing-one': 1, 'focused-two': 6 },
    'each arrival takes its place by class, behind earlier runs of its own class');
  const line = () => privateList(box).find(({ name }) => name === 'gate').line
    .map(({ agent, queueClass: listed, agedFrom }) => [agent, listed, agedFrom ?? '']);
  assert.deepEqual(line(), [
    ['landing-one', 'landing', ''],
    ['review-one', 'review', ''],
    ['submit-one', 'submit', ''],
    ['focused-one', 'other', ''],
    ['diagnostic-one', 'other', ''],
    ['focused-two', 'other', ''],
  ], 'landing, then reviews, then submits, then focused and other runs, first come first served within each');

  // Waiting time is the only input to aging; backdating the queued time stands in for the clock.
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    const backdate = db.prepare('UPDATE waiter SET since = ? WHERE agent = ?');
    backdate.run(new Date(Date.now() - 2 * AGE_MS - 60_000).toISOString(), 'focused-two');
    backdate.run(new Date(Date.now() - AGE_MS - 60_000).toISOString(), 'diagnostic-one');
  } finally { db.close(); }
  assert.deepEqual(line(), [
    ['landing-one', 'landing', ''],
    ['review-one', 'review', ''],
    ['focused-two', 'review', 'other'],
    ['diagnostic-one', 'submit', 'other'],
    ['submit-one', 'submit', ''],
    ['focused-one', 'other', ''],
  ], 'a run waiting an hour ranks with reviews and one waiting half an hour with submits, keeping its arrival place there');

  const order = [];
  let releasing = [...holders];
  for (const agent of ['landing-one', 'review-one', 'focused-two', 'diagnostic-one', 'submit-one', 'focused-one']) {
    await release(releasing.shift());
    const child = waiting.get(agent);
    assert.equal((await acquired(child)).acquired, agent, `${agent} is admitted next`);
    order.push(agent);
    releasing.push(child);
  }
  for (const child of releasing) await release(child);
  assert.deepEqual(order, ['landing-one', 'review-one', 'focused-two', 'diagnostic-one', 'submit-one', 'focused-one']);

  // The class rule itself, against an injected clock rather than real waiting.
  const { QUEUE_AGE_MS, queueClass } = await import('../src/resources.js');
  const queuedAt = Date.parse('2026-10-15T19:37:00.000Z');
  const at = (minutes) => queuedAt + minutes * 60_000;
  const since = new Date(queuedAt).toISOString();
  assert.equal(QUEUE_AGE_MS, 30 * 60_000, 'a waiter moves up one class every 30 minutes');
  assert.deepEqual([0, 29, 30, 60, 90, 300].map((minutes) => queueClass({ kind: 'focused', since }, at(minutes)).name),
    ['other', 'other', 'submit', 'review', 'landing', 'landing'], 'a focused run ages up one class per 30 minutes waited');
  assert.equal(queueClass({ kind: 'review', since }, at(30)).name, 'landing');
  assert.equal(queueClass({ kind: 'main-red', diagnostic: 1, itemCheck: 1, since }, at(0)).name, 'other', 'a diagnostic is optional work');
  assert.equal(queueClass({ kind: 'check', itemCheck: 1, since }, at(0)).name, 'submit', 'an item check ranks with submits');
  assert.equal(queueClass({ landing: 1, since }, at(0)).name, 'landing');
});

test('a line holding an older pullboard waiter keeps arrival order, so mixed versions never deadlock [C7]', async () => {
  const box = fixture();
  setQueueOrder(box, { reviewsFirst: true }); // #697: class order is a machine opt-in.
  const holders = [poolWorker(box, { agent: 'mixed-holder-one' }), poolWorker(box, { agent: 'mixed-holder-two' })];
  for (const holder of holders) await acquired(holder);
  const older = poolWorker(box, { agent: 'older-focused', kind: 'focused' });
  await event(older);
  // An older pullboard writes no class marker; it admits landings first and then by ticket.
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try { db.prepare("UPDATE waiter SET classed = 0 WHERE agent = 'older-focused'").run(); }
  finally { db.close(); }
  const review = poolWorker(box, { agent: 'newer-review', kind: 'review', item: '651' });
  assert.equal((await event(review)).queued.position, 2, 'the review waits behind the older waiter\'s earlier ticket');
  const gate = () => privateList(box).find(({ name }) => name === 'gate');
  assert.equal(gate().order, 'arrival');
  assert.deepEqual(gate().line.map(({ agent }) => agent), ['older-focused', 'newer-review']);

  await release(holders[0]);
  assert.equal((await acquired(older)).acquired, 'older-focused', 'both versions agree the earlier ticket goes first');
  assert.equal(gate().order, undefined, 'class order resumes once only marked waiters remain');
  await release(holders[1]);
  assert.equal((await acquired(review)).acquired, 'newer-review');
  await release(older);
  await release(review);
});

test('queue order follows the machine settings [C7,O5]', async () => {
  const gate = (box) => privateList(box).find(({ name }) => name === 'gate');
  const line = (box) => gate(box).line.map(({ agent, queueClass: listed, agedFrom }) => [agent, listed, agedFrom ?? '']);
  /** Backdate a waiter's queued time: the test clock that stands in for real waiting. */
  const backdate = (box, agent, ms) => {
    const queuedAt = new Date(Date.now() - ms).toISOString();
    const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
    let changed;
    try { changed = db.prepare('UPDATE waiter SET since = ? WHERE agent = ?').run(queuedAt, agent).changes; }
    finally { db.close(); }
    assert.equal(changed, 1, `${agent} has a private waiter row`);
  };
  /** Run pullboard settings against the fixture's private machine home. */
  const settingsCli = (box, ...flags) => runFixtureChild(process.execPath, [BIN, 'settings', ...flags], { cwd: box.first, env: box.env, encoding: 'utf8' });

  // No settings: landings first, then arrival, so a review waits behind an earlier focused run.
  const plain = fixture();
  const plainHolders = [poolWorker(plain, { agent: 'plain-holder-one' }), poolWorker(plain, { agent: 'plain-holder-two' })];
  for (const holder of plainHolders) await acquired(holder);
  const plainFocused = poolWorker(plain, { agent: 'plain-focused', kind: 'focused' });
  assert.equal((await event(plainFocused)).queued.position, 1);
  const plainReview = poolWorker(plain, { agent: 'plain-review', kind: 'review', item: '697' });
  assert.equal((await event(plainReview)).queued.position, 2, 'with no settings a review waits its arrival turn');
  assert.deepEqual(gate(plain).line.map(({ agent }) => agent), ['plain-focused', 'plain-review'], 'with no settings the line is in arrival order');
  // agingMinutes alone does nothing: aging is used only while a class order is on.
  setQueueOrder(plain, { agingMinutes: 1 });
  backdate(plain, 'plain-review', 5 * 60_000);
  assert.deepEqual(line(plain), [['plain-focused', 'other', ''], ['plain-review', 'review', '']],
    'with reviewsFirst off no waiter ages up, even with a short agingMinutes');
  setQueueOrder(plain, undefined);
  const plainPrinted = settingsCli(plain);
  assert.equal(plainPrinted.status, 0, plainPrinted.stderr);
  assert.match(plainPrinted.stdout, /^gate\.queue\.reviewsFirst: false\b/mu, 'pullboard settings prints reviewsFirst, default false');
  assert.match(plainPrinted.stdout, /^gate\.queue\.agingMinutes: 30\b/mu, 'pullboard settings prints agingMinutes, default 30');
  await release(plainHolders[0]);
  assert.equal((await acquired(plainFocused)).acquired, 'plain-focused', 'with no settings the earlier focused run is admitted first');
  await release(plainHolders[1]);
  assert.equal((await acquired(plainReview)).acquired, 'plain-review');
  await release(plainFocused);
  await release(plainReview);

  // reviewsFirst true: the same review is admitted ahead of the earlier focused run.
  const classed = fixture();
  setQueueOrder(classed, { reviewsFirst: true });
  const classedHolders = [poolWorker(classed, { agent: 'classed-holder-one' }), poolWorker(classed, { agent: 'classed-holder-two' })];
  for (const holder of classedHolders) await acquired(holder);
  const classedFocused = poolWorker(classed, { agent: 'classed-focused', kind: 'focused' });
  assert.equal((await event(classedFocused)).queued.position, 1);
  const classedReview = poolWorker(classed, { agent: 'classed-review', kind: 'review', item: '697' });
  assert.equal((await event(classedReview)).queued.position, 1, 'with reviewsFirst true a review joins ahead of focused runs');
  assert.deepEqual(gate(classed).line.map(({ agent }) => agent), ['classed-review', 'classed-focused'], 'with reviewsFirst true the line is in class order');
  await release(classedHolders[0]);
  assert.equal((await acquired(classedReview)).acquired, 'classed-review', 'with reviewsFirst true the review is admitted first');
  await release(classedHolders[1]);
  assert.equal((await acquired(classedFocused)).acquired, 'classed-focused');
  await release(classedReview);
  await release(classedFocused);

  // agingMinutes 1: a focused run waiting just over a minute moves up one class, ahead of a later submit.
  const aging = fixture();
  setQueueOrder(aging, { reviewsFirst: true, agingMinutes: 1 });
  const agingHolders = [poolWorker(aging, { agent: 'aging-holder-one' }), poolWorker(aging, { agent: 'aging-holder-two' })];
  for (const holder of agingHolders) await acquired(holder);
  const agingFocused = poolWorker(aging, { agent: 'aging-focused', kind: 'focused' });
  await event(agingFocused);
  const agingSubmit = poolWorker(aging, { agent: 'aging-submit', kind: 'submit', item: '697' });
  assert.equal((await event(agingSubmit)).queued.position, 1, 'a fresh submit goes ahead of a fresh focused run');
  assert.deepEqual(line(aging), [['aging-submit', 'submit', ''], ['aging-focused', 'other', '']]);
  backdate(aging, 'aging-focused', 61_000);
  assert.deepEqual(line(aging), [['aging-focused', 'submit', 'other'], ['aging-submit', 'submit', '']],
    'after agingMinutes 1 the focused run ranks with submits and keeps its earlier ticket there');
  const agingPrinted = settingsCli(aging);
  assert.equal(agingPrinted.status, 0, agingPrinted.stderr);
  assert.match(agingPrinted.stdout, /^gate\.queue\.reviewsFirst: true$/mu, 'pullboard settings prints the reviewsFirst set on this machine');
  assert.match(agingPrinted.stdout, /^gate\.queue\.agingMinutes: 1$/mu, 'pullboard settings prints the agingMinutes set on this machine');
  assert.deepEqual(JSON.parse(settingsCli(aging, '--json').stdout).settings.gate.queue, { reviewsFirst: true, agingMinutes: 1 });
  await release(agingHolders[0]);
  assert.equal((await acquired(agingFocused)).acquired, 'aging-focused', 'the aged focused run is admitted before the later submit');
  await release(agingHolders[1]);
  assert.equal((await acquired(agingSubmit)).acquired, 'aging-submit');
  await release(agingFocused);
  await release(agingSubmit);
  // The class rule against an injected clock: one class per agingMinutes waited.
  const { queueClass } = await import('../src/resources.js');
  const queuedAt = Date.parse('2026-10-16T16:00:00.000Z');
  const since = new Date(queuedAt).toISOString();
  assert.deepEqual([0, 0.99, 1, 2, 3].map((minutes) => queueClass({ kind: 'focused', since }, queuedAt + minutes * 60_000, 60_000).name),
    ['other', 'other', 'submit', 'review', 'landing'], 'a one-minute aging moves a waiting run up one class per minute');

  // An unusable value is refused by name, with the fix.
  setQueueOrder(aging, { reviewsFirst: 'yes' });
  const badFlag = settingsCli(aging, '--json');
  assert.equal(badFlag.status, 1, 'a non-boolean reviewsFirst is refused');
  assert.equal(JSON.parse(badFlag.stdout).error.code, 'BAD_MACHINE_SETTINGS');
  assert.match(JSON.parse(badFlag.stdout).error.message, /gate\.queue\.reviewsFirst .* must be true or false/u);
  setQueueOrder(aging, { reviewsFirst: true, agingMinutes: 0 });
  const badAging = settingsCli(aging, '--json');
  assert.equal(badAging.status, 1, 'agingMinutes 0 is refused');
  assert.match(JSON.parse(badAging.stdout).error.message, /gate\.queue\.agingMinutes .* must be a positive whole number/u);
});

test('[Q1,Q2] a waiting landing keeps a current holder from taking the second slot [Q1,Q2]', async () => {
  const box = fixture();
  const firstHolder = worker(box, { capacity: 2, agent: 'same-run' });
  const secondHolder = worker(box, { capacity: 2, agent: 'other-run' });
  assert.equal((await acquired(firstHolder)).acquired, 'same-run');
  assert.equal((await acquired(secondHolder)).acquired, 'other-run');
  const landing = worker(box, { capacity: 2, agent: 'landing', landing: true });
  assert.equal((await event(landing)).waiting, 1);
  const secondSlot = worker(box, { capacity: 2, agent: 'same-run' });
  assert.equal((await event(secondSlot)).waiting, 2);
  assert.deepEqual(privateList(box)[0].line.map(({ agent, landing: isLanding }) => [agent, isLanding]), [['landing', true], ['same-run', false]]);

  await release(secondHolder);
  assert.equal((await event(landing)).acquired, 'landing');
  await assert.rejects(event(secondSlot, 250), /worker timed out/u, 'the holder cannot take its second slot ahead of a waiting landing'); // budget: declared negative observation window while an explicitly held landing blocks this waiter.
  await release(landing);
  assert.equal((await event(secondSlot)).acquired, 'same-run');
  await release(secondSlot);
  await release(firstHolder);
});

test('[Q1,Q2] a holder cannot queue a landing second slot ahead of another landing [Q1,Q2]', async () => {
  const box = fixture();
  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = box.home;
  process.env.PULLBOARD_MACHINE_HOME = box.home;
  let first;
  let second;
  let other;
  let landing;
  let extraLease;
  let extraPromise;
  try {
    first = await takeResource({ name: 'gate', capacity: 2, root: box.first, agent: 'same-run' });
    other = worker(box, { capacity: 2, agent: 'other-run' });
    assert.equal((await acquired(other)).acquired, 'other-run');
    extraPromise = takeResource({ name: 'gate', capacity: 2, root: box.second, agent: 'second-label', landing: true })
      .then((lease) => { extraLease = lease; return lease; });
    await waitUntil(() => privateList(box)[0].line.some(({ agent, landing: isLanding }) => agent === 'second-label' && isLanding), 'the same process second slot to queue');

    landing = worker(box, { capacity: 2, agent: 'next-landing', landing: true });
    assert.equal((await event(landing)).waiting, 1, 'the later landing is the first eligible landing');
    assert.deepEqual(privateList(box)[0].line.map(({ agent, landing: isLanding }) => [agent, isLanding]), [
      ['second-label', true], ['next-landing', true],
    ]);

    await release(other);
    other = null;
    assert.equal((await event(landing)).acquired, 'next-landing', 'a current holder cannot take a second slot ahead of a different landing run');
    const holderAgents = privateList(box)[0].holders.map(({ agent }) => agent).sort();
    assert.deepEqual(holderAgents, ['next-landing', 'same-run']);
    await release(landing);
    landing = null;
    second = await extraPromise;
    assert.deepEqual(privateList(box)[0].holders.map(({ agent }) => agent), ['same-run', 'second-label']);
  } finally {
    if (other && !other.exitResult) await release(other);
    if (landing && !landing.exitResult) {
      first?.release();
      extraLease?.release();
      try { await acquired(landing); } catch { /* Preserve the assertion that led to cleanup. */ }
      if (!landing.exitResult) await release(landing);
    }
    first?.release();
    second?.release();
    extraLease?.release();
    if (extraPromise && !extraLease) {
      await Promise.race([extraPromise.then((lease) => lease.release()), delay(500)]);
    }
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
});

/** A capacity-three queue must not grant an empty slot to holders queued for their own second slot. */
test('[Q1,Q2] landing holders leave an empty slot for the next eligible landing [Q1,Q2]', async () => {
  const box = fixture();
  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = box.home;
  process.env.PULLBOARD_MACHINE_HOME = box.home;
  let firstA;
  let secondA;
  let holderB;
  let holderC;
  let secondAPromise;
  let secondAAcquired = false;
  try {
    firstA = await takeResource({ name: 'gate', capacity: 3, root: box.first, agent: 'holder-a' });
    holderB = worker(box, { capacity: 3, agent: 'holder-b' });
    holderC = worker(box, { capacity: 3, agent: 'holder-c' });
    assert.equal((await acquired(holderB)).acquired, 'holder-b');
    assert.equal((await acquired(holderC)).acquired, 'holder-c');

    secondAPromise = takeResource({ name: 'gate', capacity: 3, root: box.first, agent: 'holder-a', landing: true })
      .then((lease) => { secondAAcquired = true; secondA = lease; return lease; });
    await waitUntil(() => privateList(box)[0].line.some(({ agent, landing }) => agent === 'holder-a' && landing), 'holder A second landing to queue');
    holderB.stdin.write('second\n');
    await waitUntil(() => privateList(box)[0].line.filter(({ landing }) => landing).length === 2, 'holder B second landing to join');

    await release(holderC);
    holderC = null;
    await delay(300);
    assert.deepEqual(privateList(box)[0].holders.map(({ agent }) => agent).sort(), ['holder-a', 'holder-b'], 'neither holder takes the free third slot while the other holder landing waits');
    assert.equal(secondAAcquired, false, 'A second slot remains queued');
    assert.deepEqual(holderB.pendingLines.filter((line) => line.includes('secondAcquired')), [], 'B second slot remains queued');

    firstA.release();
    firstA = null;
    await secondAPromise;
    assert.ok(secondAAcquired, 'releasing A first makes its landing the next eligible landing');
    assert.equal((await event(holderB)).secondAcquired, 'holder-b', 'B can finish after A no longer waits');
    holderB.stdin.end('release\n');
    assert.equal((await holderB.finished).code, 0, holderB.errors);
    holderB.lines.close();
    holderB = null;
    secondA.release();
    secondA = null;
  } finally {
    for (const child of [holderB, holderC]) if (child && !child.exitResult) child.kill('SIGKILL');
    await Promise.all([holderB, holderC].filter(Boolean).map((child) => child.finished));
    for (const child of [holderB, holderC]) child?.lines.close();
    firstA?.release();
    secondA?.release();
    privateList(box); // Purge any dead child holder/waiter rows before dropping the private database.
    if (secondAPromise && !secondA) {
      await secondAPromise;
    }
    secondA?.release();
    privateList(box);
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
});

test('[Q1,Q2] landing priority preserves tickets while an older resource database migrates [Q1,Q2]', async () => {
  const box = fixture();
  oldSchema(box);
  const oldSince = new Date().toISOString();
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    db.prepare('INSERT INTO resource(name, capacity) VALUES (?, ?)').run('gate', 1);
    db.prepare('INSERT INTO holder(token, name, pid, agent, repo, since, heartbeat) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('old-holder', 'gate', process.pid, 'old-holder', realpathSync(box.first), oldSince, Date.now());
    for (const [ticket, agent] of [[4, 'old-first'], [9, 'old-second']]) {
      db.prepare('INSERT INTO waiter(ticket, token, name, pid, agent, repo, since, heartbeat) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(ticket, `old-${agent}`, 'gate', process.pid, agent, realpathSync(box.first), oldSince, Date.now());
    }
  } finally { db.close(); }

  let retainedLine;
  assert.doesNotThrow(() => { retainedLine = privateList(box)[0].line; }, 'the previous queue schema opens without losing its waiting runs');
  assert.deepEqual(retainedLine.map(({ agent, landing }) => [agent, landing]), [['old-first', false], ['old-second', false]]);
  const migrated = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    assert.deepEqual(migrated.prepare('SELECT ticket, landing FROM waiter ORDER BY ticket').all().map(({ ticket, landing }) => ({ ticket, landing })), [
      { ticket: 4, landing: 0 }, { ticket: 9, landing: 0 },
    ]);
  } finally { migrated.close(); }

  const landing = worker(box, { agent: 'new-landing', landing: true });
  assert.equal((await event(landing)).waiting, 1);
  assert.deepEqual(privateList(box)[0].line.map(({ agent, landing: isLanding }) => [agent, isLanding]), [
    ['new-landing', true], ['old-first', false], ['old-second', false],
  ]);
  const cleanup = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    cleanup.prepare('DELETE FROM waiter WHERE token IN (?, ?)').run('old-old-first', 'old-old-second');
    cleanup.prepare('DELETE FROM holder WHERE token = ?').run('old-holder');
  } finally { cleanup.close(); }
  assert.equal((await event(landing)).acquired, 'new-landing');
  await release(landing);
});

test('[Q1,Q2] capacity two admits two holders and serves the next waiter', async () => {
  const box = fixture();
  const first = worker(box, { name: 'two-slots', capacity: 2, agent: 'first-holder' });
  const second = worker(box, { name: 'two-slots', capacity: 2, agent: 'second-holder' });
  assert.equal((await acquired(first)).acquired, 'first-holder');
  assert.equal((await acquired(second)).acquired, 'second-holder');
  const next = worker(box, { name: 'two-slots', capacity: 2, agent: 'next-waiter' });
  assert.equal((await event(next)).waiting, 1);
  await release(first);
  assert.equal((await event(next)).acquired, 'next-waiter');
  await release(second);
  await release(next);
});

test('[Q2,Q3] a stopped head waiter keeps its place ahead of the next process', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'holder' });
  assert.equal((await event(holder)).acquired, 'holder');
  const first = worker(box, { agent: 'stopped-first' });
  assert.equal((await event(first)).waiting, 1);
  first.kill('SIGSTOP');
  const second = worker(box, { agent: 'second' });
  assert.equal((await event(second)).waiting, 2);
  await release(holder);
  await assert.rejects(event(second, 800), /worker timed out/u, 'the second waiter cannot jump the stopped head'); // budget: declared negative observation window while the stopped queue head blocks this waiter.
  first.kill('SIGCONT');
  assert.equal((await event(first)).acquired, 'stopped-first');
  await release(first);
  assert.equal((await event(second)).acquired, 'second');
  await release(second);
});

test('[Q2,Q3] an evicted live waiter rejoins the FIFO line after it resumes [Q2,Q3]', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'holder' });
  assert.equal((await event(holder)).acquired, 'holder');
  const waiter = worker(box, { agent: 'resumed-waiter' });
  assert.equal((await event(waiter)).waiting, 1);
  waiter.kill('SIGSTOP');
  staleIdentity(box, 'waiter', 'resumed-waiter');
  assert.deepEqual(privateList(box)[0].line, []);
  waiter.kill('SIGCONT');
  const rejoined = await event(waiter);
  assert.equal(rejoined.rejoined, true);
  assert.equal(rejoined.waiting, 1);
  await release(holder);
  assert.equal((await event(waiter)).acquired, 'resumed-waiter');
  await release(waiter);
});

test('[Q3] a live stalled holder keeps its place beyond the lease timeout', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'stalled-holder', stallMs: 22_000, env: { TZ: 'UTC' } });
  assert.equal((await event(holder)).acquired, 'stalled-holder');
  const waiter = worker(box, { agent: 'queued-behind-live-holder', env: { TZ: 'Pacific/Honolulu', PATH: '/usr/bin' } });
  assert.equal((await event(waiter)).waiting, 1);
  await assert.rejects(event(waiter, 20_500), /worker timed out/u, 'a live OS process must not be evicted when its heartbeat pauses'); // budget: declared 22000ms holder stall; observe it still held at 20500ms.
  assert.equal((await event(holder, 5_000)).resumed, true); // budget: hang ceiling for the stalled holder resume handshake; no throughput claim.
  await release(holder);
  assert.equal((await event(waiter)).acquired, 'queued-behind-live-holder');
  await release(waiter);
});

test('[Q3] concurrent openers serialize migration of a prior resource database', async () => {
  const box = fixture();
  oldSchema(box);
  const workers = Array.from({ length: 8 }, (_, index) => worker(box, { name: 'legacy', capacity: 8, agent: `migrator-${index}` }));
  const grants = await Promise.all(workers.map((child) => acquired(child)));
  assert.deepEqual(grants.map(({ acquired: agent }) => agent).sort(), workers.map((_, index) => `migrator-${index}`).sort());
  await Promise.all(workers.map(release));
});

test('[Q3] a held lease records its OS process start identity', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'identity-recorded' });
  assert.equal((await acquired(holder)).acquired, 'identity-recorded');
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    const row = db.prepare('SELECT started FROM holder WHERE agent = ?').get('identity-recorded');
    assert.ok(row?.started, 'a readable process identity is stored with its lease');
  } finally { db.close(); }
  await release(holder);
});

test('[Q3] process identity lookup ignores a misleading ps on PATH', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'path-spoof-holder' });
  assert.equal((await acquired(holder)).acquired, 'path-spoof-holder');
  expireHeartbeat(box, 'holder', 'path-spoof-holder');
  const fakeBin = join(box.dir, 'fake-bin');
  mkdirSync(fakeBin);
  const fakePs = join(fakeBin, 'ps');
  writeFileSync(fakePs, '#!/bin/sh\nprintf "Mon Jan 1 00:00:00 2001 S\\n"\n');
  chmodSync(fakePs, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = fakeBin;
  try {
    assert.equal(privateList(box)[0].holders[0]?.agent, 'path-spoof-holder', 'the stable absolute ps result keeps the lease');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  await release(holder);
});

test('[Q3] an unreadable process identity keeps a live holder', { skip: !SANDBOX_EXEC }, async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'sandbox-live-holder', stallMs: 27_000 });
  assert.equal((await acquired(holder)).acquired, 'sandbox-live-holder');
  const waiter = worker(box, { agent: 'sandbox-live-waiter', sandboxProcessInfo: true });
  assert.equal((await event(waiter)).waiting, 1);
  await assert.rejects(event(waiter, 20_500), /worker timed out/u, 'denied process-info access is not proof that a live PID died'); // budget: declared 22000ms holder stall with denied process-info access; observe at 20500ms.
  assert.equal((await event(holder, 8_000)).resumed, true); // budget: hang ceiling for the stalled holder resume handshake; no throughput claim.
  await release(holder);
  assert.equal((await acquired(waiter)).acquired, 'sandbox-live-waiter');
  await release(waiter);
});

test('[Q3] an unreadable process identity still releases a dead holder', { skip: !SANDBOX_EXEC }, async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'sandbox-dead-holder' });
  assert.equal((await acquired(holder)).acquired, 'sandbox-dead-holder');
  holder.kill('SIGKILL');
  const { signal } = await holder.finished;
  holder.lines.close();
  assert.equal(signal, 'SIGKILL');
  const waiter = worker(box, { agent: 'sandbox-dead-waiter', sandboxProcessInfo: true });
  assert.equal((await acquired(waiter)).acquired, 'sandbox-dead-waiter');
  await release(waiter);
});

test('[Q3] cached live identities expire so an actual zombie holder is released', { skip: !PERL_FORK }, async () => {
  const box = fixture();
  privateList(box);
  const script = 'my $pid = fork(); die "fork failed" unless defined $pid; if ($pid == 0) { select undef, undef, undef, 1.2; exit 0; } print "$pid\\n"; $| = 1; select undef, undef, undef, 30; waitpid($pid, 0);';
  const reaper = spawn('/usr/bin/perl', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = createInterface({ input: reaper.stdout });
  try {
    const pidText = await new Promise((resolveLine, reject) => {
      lines.once('line', resolveLine);
      reaper.once('error', reject);
      reaper.once('exit', (code) => reject(new Error(`zombie parent exited early: ${code}`)));
    });
    const pid = Number(pidText);
    assert.ok(Number.isInteger(pid) && pid > 0, `Perl reports its child PID: ${pidText}`);
    insertExpiredHolder(box, { name: 'zombie-cache', pid, agent: 'zombie-holder' });
    const cached = privateList(box).find(({ name }) => name === 'zombie-cache');
    assert.equal(cached.holders[0]?.agent, 'zombie-holder', 'the live child with an empty stored identity is kept');
    const cacheAt = Date.now();
    await waitForProcessState(pid, 'Z');
    await delay(Math.max(0, cacheAt + 3_200 - Date.now()));
    const afterExpiry = privateList(box).find(({ name }) => name === 'zombie-cache');
    assert.deepEqual(afterExpiry.holders, [], 'the refreshed process state identifies and releases the zombie');
  } finally {
    lines.close();
    if (reaper.exitCode === null && reaper.signalCode === null) {
      reaper.kill('SIGKILL');
      await once(reaper, 'exit');
    }
  }
});

test('[Q3] renew refuses after an OS start-identity mismatch evicts the holder', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'evicted-holder' });
  assert.equal((await event(holder)).acquired, 'evicted-holder');
  staleIdentity(box, 'holder', 'evicted-holder');
  assert.deepEqual(privateList(box)[0].holders, []);
  holder.stdin.write('renew\n');
  assert.equal((await event(holder)).renewError, 'RESOURCE_LEASE_LOST');
  holder.stdin.end('release\n');
  assert.equal((await holder.finished).code, 0, holder.errors);
});

test('[Q3] SIGKILL of a holder frees its lease for the next process', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'doomed-holder' });
  assert.equal((await event(holder)).acquired, 'doomed-holder');
  const next = worker(box, { agent: 'successor' });
  const waiting = await event(next);
  assert.equal(waiting.waiting, 1);
  holder.kill('SIGKILL');
  await holder.finished;
  assert.equal((await event(next)).acquired, 'successor');
  await release(next);
});

test('[Q2,Q3] a SIGKILLed waiter is skipped while the next live waiter advances', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'holder' });
  assert.equal((await event(holder)).acquired, 'holder');
  const dead = worker(box, { agent: 'dead-waiter' });
  assert.equal((await event(dead)).waiting, 1);
  const live = worker(box, { agent: 'live-waiter' });
  assert.equal((await event(live)).waiting, 2);
  dead.kill('SIGKILL');
  await dead.finished;
  await release(holder);
  assert.equal((await event(live)).acquired, 'live-waiter');
  await release(live);
});

test('[Q4] machine capacity changes atomically refuse an occupied or queued resource', async () => {
  const box = fixture();
  const oldHome = process.env.PULLBOARD_HOME;
  const oldMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = box.home;
  process.env.PULLBOARD_MACHINE_HOME = box.home;
  const holder = worker(box, { agent: 'capacity-holder' });
  try {
    assert.equal((await event(holder)).acquired, 'capacity-holder');
    const waiter = worker(box, { agent: 'capacity-waiter' });
    assert.equal((await event(waiter)).waiting, 1);
    let persisted = false;
    assert.throws(() => setResourceCapacity({ name: 'gate', capacity: 3, persist: () => { persisted = true; } }), (error) => error.code === 'RESOURCE_BUSY');
    assert.equal(persisted, false, 'settings remain unchanged while a holder and waiter exist');
    await release(holder);
    assert.equal((await event(waiter)).acquired, 'capacity-waiter');
    assert.throws(() => setResourceCapacity({ name: 'gate', capacity: 3, persist: () => { persisted = true; } }), (error) => error.code === 'RESOURCE_BUSY');
    await release(waiter);
    const changed = setResourceCapacity({ name: 'gate', capacity: 3, persist: () => { persisted = true; } });
    assert.deepEqual(changed, { name: 'gate', capacity: 3 });
    assert.equal(persisted, true, 'settings persist under the same queue lock as the capacity');
    assert.equal(privateList(box)[0].capacity, 3);
    const lease = await takeResource({ name: 'gate', capacity: 3, capacityProvider: () => 4, allowIdleCapacityUpdate: true, root: box.first, agent: 'fresh-capacity' });
    assert.equal(privateList(box)[0].capacity, 4, 'a queued gate reads the latest setting after taking the SQLite lock');
    lease.release();
  } finally {
    if (!holder.exitResult) await release(holder);
    if (oldHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = oldHome;
    if (oldMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = oldMachineHome;
  }
});

test('[Q1] machine scope is shared, repo scope stays local, and board scope names relay requirement', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'repo-a', root: box.first });
  assert.equal((await event(holder)).acquired, 'repo-a');
  const otherRepo = worker(box, { agent: 'repo-b', root: box.second });
  assert.equal((await event(otherRepo)).waiting, 1);
  await release(holder);
  assert.equal((await event(otherRepo)).acquired, 'repo-b');
  await release(otherRepo);
  const localA = worker(box, { name: 'repo-only', scope: 'repo', agent: 'repo-a', root: box.first });
  const localB = worker(box, { name: 'repo-only', scope: 'repo', agent: 'repo-b', root: box.second });
  assert.equal((await event(localA)).acquired, 'repo-a');
  assert.equal((await event(localB)).acquired, 'repo-b');
  await release(localA);
  await release(localB);
  const refused = spawnSync(process.execPath, ['--input-type=module', '-e', `import {takeResource} from ${JSON.stringify(MODULE)}; await takeResource({name:'x',capacity:1,scope:'board'});`], { env: box.env, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /BOARD_SCOPE_UNAVAILABLE.*relay/i);
});

test('[Q4] a red gate releases its lease before the same process starts another gate', async () => {
  const box = fixture();
  const setting = spawnSync(process.execPath, [resolve(import.meta.dirname, '../bin/pullboard.js'), 'settings', 'gateSlots', '1'], {
    cwd: box.first, env: box.env, encoding: 'utf8',
  });
  assert.equal(setting.status, 0, setting.stderr);
  const command = join(box.dir, 'red-then-green.cjs');
  const counter = join(box.dir, 'gate-count');
  const eventsFile = join(box.dir, 'gate-runs.log');
  writeFileSync(command, [
    "const fs = require('node:fs');",
    'const [counter, events] = process.argv.slice(2);',
    'const count = Number(fs.existsSync(counter) ? fs.readFileSync(counter, "utf8") : 0);',
    'fs.writeFileSync(counter, String(count + 1));',
    "fs.appendFileSync(events, 'start\\nend\\n');",
    'process.exit(count === 0 ? 7 : 0);',
  ].join('\n'));
  const gateCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(command)} ${JSON.stringify(counter)} ${JSON.stringify(eventsFile)}`;
  const worker = `
    import { runGate } from ${JSON.stringify(GATE_MODULE)};
    const first = await runGate(process.cwd(), { gate: process.argv[1] });
    const second = await runGate(process.cwd(), { gate: process.argv[1] });
    console.log(JSON.stringify({ firstGreen: first.isGreen, secondGreen: second.isGreen }));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', worker, gateCommand], {
    cwd: box.first, env: box.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolveClose) => child.once('close', (code, signal) => resolveClose({ code, signal })));
  let timer;
  try {
    const result = await Promise.race([
      closed,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the red gate kept its lease and blocked the same process')), 5_000); }), // budget: hang ceiling for the same process to reacquire its released gate slot.
    ]);
    assert.equal(result.code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout.trim()), { firstGreen: false, secondGreen: true });
    assert.deepEqual(readFileSync(eventsFile, 'utf8').trim().split(/\r?\n/u), ['start', 'end', 'start', 'end']);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
    if (child.exitCode === null && child.signalCode === null) await closed;
  }
});
