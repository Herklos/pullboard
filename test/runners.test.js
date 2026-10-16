/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
import assert from 'node:assert/strict';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, watch, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { listResources, takeResource } from '../src/resources.js';
import { parseProcessCensus } from '../src/process-census.js';
import { listResources as listPreRunnerResources, takeResource as takePreRunnerResource } from './fixtures/resources-pre-runners.js';
import { runFixtureChild, runFixtureChildAsync, startFixtureChild } from './fixture-child.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const TEMP = [];
const SECRET = ['fixture', 'runner', 'secret', 'must', 'stay', 'local'].join('-');
const HOST = 'fixture-host';
const TOOLING_SNAPSHOTS = new Map();

/** Quote one literal value for the fixture's POSIX shell command. */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Run Git in the private source repository and preserve useful failure context. */
function git(repo, env, ...args) {
  const result = runFixtureChild('git', args, { cwd: repo, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.context);
  return result.stdout.trim();
}

/** Copy current tooling bytes into a private committed checkout for runner source validation. */
function committedToolingSnapshot(sourceRoot, env) {
  const key = realpathSync(sourceRoot);
  const cached = TOOLING_SNAPSHOTS.get(key);
  if (cached) return cached.root;
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-runner-tooling-'));
  const root = join(directory, 'tooling');
  const home = join(directory, 'home');
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  try {
    copyFileSync(join(key, 'package.json'), join(root, 'package.json'));
    cpSync(join(key, 'src'), join(root, 'src'), { recursive: true });
    cpSync(join(key, 'bin'), join(root, 'bin'), { recursive: true });
    const gitEnv = { ...env, HOME: home, PULLBOARD_HOME: join(home, '.pullboard'),
      PULLBOARD_MACHINE_HOME: join(home, '.pullboard'), GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0',
      GIT_AUTHOR_NAME: 'Runner Tooling Fixture', GIT_AUTHOR_EMAIL: 'runner-tooling@example.invalid',
      GIT_COMMITTER_NAME: 'Runner Tooling Fixture', GIT_COMMITTER_EMAIL: 'runner-tooling@example.invalid' };
    for (const key of ['GIT_CONFIG_PARAMETERS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete gitEnv[key];
    git(root, gitEnv, 'init', '-q', '-b', 'main');
    git(root, gitEnv, 'add', 'package.json', 'src', 'bin');
    git(root, gitEnv, 'commit', '-q', '-m', 'test: snapshot current runner tooling');
  } catch (error) {
    process.stderr.write(`retained incomplete runner tooling snapshot at ${directory}: ${error.message}\n`);
    throw error;
  }
  TOOLING_SNAPSHOTS.set(key, { root, directory, active: 0, retained: false });
  return root;
}

after(() => {
  for (const record of TOOLING_SNAPSHOTS.values()) {
    if (record.active || record.retained) {
      process.stderr.write(`retained runner tooling snapshot at ${record.directory}\n`);
      continue;
    }
    rmSync(record.directory, { recursive: true, force: true });
  }
  TOOLING_SNAPSHOTS.clear();
});

/** Spawn the exact checked-in CLI from a fixture checkout. */
function cli(repo, env, ...args) {
  return runFixtureChild(process.execPath, [BIN, ...args], { cwd: repo, env, encoding: 'utf8' });
}

/**
 * Make a local ssh stand-in that executes the actual worker command in a second private machine.
 * It appends "dispatched" and "returned" to <requests>.phases so a round trip can be timed by phase,
 * and `hold` ('dispatch', 'run' or 'return') keeps it alive at that phase, as a stuck runner would.
 */
function installSshStandIn({ bin, worker, home, machineHome, requests, starts, nodeCommand = 'node', dropFirst = false, dropAfterMarker, hold = '' }) {
  const ssh = join(bin, 'ssh');
  const source = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
const argv = process.argv.slice(2);
const divider = argv.indexOf('--');
const host = divider >= 0 ? argv[divider + 1] : '';
const remoteCommand = divider >= 0 ? argv[divider + 2] : '';
const requests = ${JSON.stringify(requests)};
const starts = ${JSON.stringify(starts ?? '')};
const worker = ${JSON.stringify(worker)};
const home = ${JSON.stringify(home)};
const machineHome = ${JSON.stringify(machineHome)};
const configuredNode = ${JSON.stringify(`${shellQuote(nodeCommand)} --input-type=module -e `)};
const dropAfterMarker = ${JSON.stringify(dropAfterMarker ?? '')};
const secret = ${JSON.stringify(SECRET)};
const call = existsSync(requests) ? readFileSync(requests, 'utf8').split('\\n').filter(Boolean).length + 1 : 1;
const stdinHash = createHash('sha256');
let stdinBytes = 0;
process.stdin.on('data', part => { stdinBytes += part.length; stdinHash.update(part); });
const record = extra => appendFileSync(requests, JSON.stringify({ call, host,
  options: divider < 0 ? [] : argv.slice(0, divider), remoteHasSecret: remoteCommand.includes(secret),
  framed: divider >= 0 && argv[divider] === '--', remoteCommandPresent: Boolean(remoteCommand),
  remoteStartsWithConfiguredNode: remoteCommand.startsWith(configuredNode),
  remoteHasLocalPath: remoteCommand.includes(${JSON.stringify(worker)}),
  remoteHasSourceHome: remoteCommand.includes(${JSON.stringify(home)}),
  remoteHasSourceMachineHome: remoteCommand.includes(${JSON.stringify(machineHome)}), ...extra }) + '\\n');
const waitForMarker = path => {
  let cancel = () => {};
  const promise = new Promise((resolve, reject) => {
    if (existsSync(path)) return resolve(true);
    const watcher = watch(dirname(path), { persistent: false });
    let timer;
    let settled = false;
    const finish = (error, found = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); watcher.close(); error ? reject(error) : resolve(found);
    };
    cancel = () => finish(null, false);
    const check = (_event, filename) => {
      if ((filename === null || String(filename) === basename(path)) && existsSync(path)) finish();
    };
    watcher.on('change', check);
    watcher.once('error', finish);
    timer = setTimeout(() => finish(new Error('setup marker hang ceiling exceeded')), 20_000); // budget: bound the SSH-to-setup disconnect handshake.
    check('rename', basename(path));
  });
  return { promise, cancel: () => cancel() };
};
let cancelDropWait = () => {};
if (host !== ${JSON.stringify(HOST)} && host !== ${JSON.stringify(`${HOST}-drop`)} && host !== ${JSON.stringify(`${HOST}-setup`)}) {
  record({ refused: true, stdinBytes }); process.exit(255);
}
if (starts) appendFileSync(starts, JSON.stringify({ call, host }) + '\\n');
const phases = requests + '.phases';
const hold = ${JSON.stringify(hold)};
const holdHere = () => new Promise(() => { setInterval(() => {}, 60_000); });
if (hold === 'dispatch') await holdHere();
appendFileSync(phases, 'dispatched\\n');
if (hold === 'run') await holdHere();
${dropFirst ? `if (host.endsWith('-drop') && call === 1) {
  process.stdin.once('data', () => {
    record({ dropped: true, stdinBytes, stdinSha256: stdinHash.digest('hex') }); process.exit(255);
  });
  process.stdin.resume();
} else` : ''} {
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR,
    PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
  // Replace the marker-driven shell so the injected HUP reaches the actual worker process.
  const child = spawn('/bin/sh', ['-c', remoteCommand], { cwd: worker, env,
    stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  process.stdin.pipe(child.stdin);
  let droppedAfterSetup = false;
  if (dropAfterMarker) {
    const waiting = waitForMarker(dropAfterMarker);
    cancelDropWait = waiting.cancel;
    waiting.promise.then(found => {
      if (found === false) return;
      droppedAfterSetup = true;
      process.kill(child.pid, 'SIGHUP');
    }, error => { record({ setupMarkerError: error.message }); child.kill('SIGKILL'); });
  }
  child.once('error', error => { record({ spawnError: error.code ?? error.name, stdinBytes }); process.exitCode = 255; });
  child.once('close', (code, signal) => {
    appendFileSync(phases, 'returned\\n');
    if (hold === 'return') setInterval(() => {}, 60_000);
    cancelDropWait();
    record({ workerStarted: true, code, signal, stdinBytes, stdinSha256: stdinHash.digest('hex'),
      droppedAfterSetup,
      secretInLocalSshEnv: Object.hasOwn(process.env, 'PULLBOARD_RUNNER_FIXTURE_SECRET'),
      localPoolMarkerInLocalSshEnv: Object.hasOwn(process.env, 'PULLBOARD_GATE_SLOT_POOL'),
      localHeldMarkerInLocalSshEnv: Object.hasOwn(process.env, 'PULLBOARD_GATE_SLOT_HELD'),
      localTokenMarkerInLocalSshEnv: Object.hasOwn(process.env, 'PULLBOARD_GATE_SLOT_TOKEN'),
      localMachineHomeInSshEnv: Object.hasOwn(process.env, 'PULLBOARD_MACHINE_HOME') });
    process.exitCode = signal ? 128 : (code ?? 255);
  });
}
`;
  writeFileSync(ssh, source, { mode: 0o700 });
  chmodSync(ssh, 0o700);
  return ssh;
}

/** Build one committed probe that observes the actual checkout and remote process environment. */
function writeProbe(repo, { remoteStateRoot, remoteMachineHome, sourceHome, sourceMachineHome, callerPool, callerToken,
  historyBaseCommit, annotatedTagObject, lightweightTagObject }) {
  const probe = `import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
test('runner executed the committed source in its private checkout', () => {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim();
  const count = execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim();
  const history = execFileSync('git', ['log', '--follow', '--format=%H', '--', 'history-renamed.txt'], { encoding: 'utf8' }).trim().split(/\\r?\\n/u);
  const runnerHome = process.env.HOME;
  const privateHomeRelative = relative(${JSON.stringify(remoteStateRoot)}, runnerHome);
  assert.ok(privateHomeRelative && !privateHomeRelative.startsWith('..' + sep) && privateHomeRelative !== '..', runnerHome);
  const checkoutRelative = relative(${JSON.stringify(remoteStateRoot)}, process.cwd());
  assert.equal(checkoutRelative.split(sep)[0], 'jobs', checkoutRelative);
  assert.notEqual(process.cwd(), ${JSON.stringify(sourceHome)});
  assert.ok(checkoutRelative && !checkoutRelative.startsWith('..' + sep) && checkoutRelative !== '..', process.cwd());
  assert.ok(isAbsolute(process.env.HOME));
  assert.equal(relative(process.cwd(), runnerHome), join('..', 'home'));
  assert.equal(process.env.PULLBOARD_MACHINE_HOME, ${JSON.stringify(remoteMachineHome)});
  assert.equal(shallow, 'false', 'the worker receives full selected-candidate history');
  assert.equal(count, '3', 'the full selected candidate has the fixture base, rename, and probe commits');
  assert.ok(history.includes(${JSON.stringify(historyBaseCommit)}), 'the rename retains its original committed file in history');
  assert.equal(execFileSync('git', ['rev-parse', 'refs/tags/runner-release'], { encoding: 'utf8' }).trim(),
    ${JSON.stringify(annotatedTagObject)}, 'the annotated tag ref keeps its original object identity');
  assert.equal(execFileSync('git', ['rev-parse', 'refs/tags/runner-lightweight'], { encoding: 'utf8' }).trim(),
    ${JSON.stringify(lightweightTagObject)}, 'the lightweight tag ref points to its original commit');
  const annotation = execFileSync('git', ['cat-file', '-p', 'refs/tags/runner-release'], { encoding: 'utf8' });
  assert.match(annotation, /runner release annotation witness/u);
  const annotatedArchive = execFileSync('git', ['archive', '--format=tar', 'refs/tags/runner-release', 'history-original.txt']);
  const lightweightArchive = execFileSync('git', ['archive', '--format=tar', 'refs/tags/runner-lightweight', 'history-original.txt']);
  assert.ok(annotatedArchive.length > 512 && annotatedArchive.includes(Buffer.from('history-original.txt')),
    'the annotated archive can read the tagged historical file');
  assert.ok(lightweightArchive.length > 512 && lightweightArchive.includes(Buffer.from('history-original.txt')),
    'the lightweight archive can read the tagged historical file');
  assert.deepEqual(execFileSync('git', ['tag', '--list', 'runner-unrelated'], { encoding: 'utf8' }).trim(), '',
    'a tag outside candidate ancestry is not copied');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), '');
  assert.equal(existsSync('.env'), false, 'ignored, untracked caller files are not transferred');
  assert.equal(process.env.PULLBOARD_RUNNER_FIXTURE_SECRET, undefined);
  assert.equal(process.env.PULLBOARD_GATE_SLOT_HELD, '1');
  assert.ok(process.env.PULLBOARD_GATE_SLOT_POOL.endsWith('/resources.sqlite'));
  assert.notEqual(process.env.PULLBOARD_GATE_SLOT_POOL, ${JSON.stringify(callerPool)});
  assert.ok(process.env.PULLBOARD_GATE_SLOT_TOKEN);
  assert.notEqual(process.env.PULLBOARD_GATE_SLOT_TOKEN, ${JSON.stringify(callerToken)});
  assert.equal(process.env.PULLBOARD_BROWSER_SLOT_HELD, '1');
  const db = new DatabaseSync(process.env.PULLBOARD_GATE_SLOT_POOL, { readOnly: true });
  try {
    const holder = db.prepare('SELECT pid, browser, kind FROM holder WHERE token = ?').get(process.env.PULLBOARD_GATE_SLOT_TOKEN);
    assert.ok(holder, 'the child inherited a live remote parent lease');
    assert.notEqual(holder.pid, process.pid);
    assert.equal(holder.browser, 1);
    assert.equal(holder.kind, 'check');
  } finally { db.close(); }
  assert.equal(process.env.SSH_AUTH_SOCK, undefined);
  assert.notEqual(process.env.PULLBOARD_HOME, ${JSON.stringify(sourceHome)});
  assert.notEqual(process.env.PULLBOARD_MACHINE_HOME, ${JSON.stringify(sourceMachineHome)});
  console.log('RUNNER_FACT ' + JSON.stringify({ commit, tree, cwd: process.cwd(), home: process.env.HOME,
    runnerHome, stateRoot: ${JSON.stringify(remoteStateRoot)}, machineHome: process.env.PULLBOARD_MACHINE_HOME, gatePool: process.env.PULLBOARD_GATE_SLOT_POOL,
    gateToken: process.env.PULLBOARD_GATE_SLOT_TOKEN, browser: process.env.PULLBOARD_BROWSER_SLOT_HELD,
    landing: process.env.PULLBOARD_LANDING_RUN }));
});
`;
  writeFileSync(join(repo, 'runner-probe.test.js'), probe);
}

/** Build a committed probe for the cache copy of one local workspace dependency. */
function writeCacheProbe(repo, { remoteStateRoot, nodePath, historyBaseCommit }) {
  const probe = `import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { test } from 'node:test';
test('a cached workspace link resolves inside this fresh runner checkout', () => {
  const root = process.cwd();
  const stateRelative = relative(${JSON.stringify(remoteStateRoot)}, root);
  assert.ok(stateRelative && !stateRelative.startsWith('..' + sep) && stateRelative !== '..');
  assert.equal(process.execPath, ${JSON.stringify(nodePath)}, 'the configured runner Node executes the command');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  const generated = JSON.parse(readFileSync(join(root, 'generated/config.json'), 'utf8'));
  assert.equal(generated.root, root, 'root prepare ran in this fresh checkout and generated a job-local file');
  const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim();
  const count = execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim();
  const history = execFileSync('git', ['log', '--follow', '--format=%H', '--', 'history-renamed.txt'], { encoding: 'utf8' }).trim().split(/\\r?\\n/u);
  assert.equal(shallow, 'false', 'the cache contains full candidate history');
  assert.equal(count, '3', 'the cache preserves the complete selected history');
  assert.ok(history.includes(${JSON.stringify(historyBaseCommit)}), 'cached history follows the original filename through the rename');
  const committed = execFileSync('git', ['show', 'HEAD:packages/runner-fixture-dep/witness.txt'], { encoding: 'utf8' });
  assert.equal(readFileSync('node_modules/.runner-cache-witness', 'utf8'), committed);
  const link = readlinkSync('node_modules/runner-fixture-dep');
  assert.equal(isAbsolute(link), false, 'the cached workspace symlink stays relative');
  const target = realpathSync(join(root, 'node_modules/runner-fixture-dep'));
  assert.equal(target, join(root, 'packages/runner-fixture-dep'));
  const targetRelative = relative(root, target);
  assert.ok(targetRelative && !targetRelative.startsWith('..' + sep) && targetRelative !== '..');
  console.log('RUNNER_CACHE_FACT ' + JSON.stringify({ root, link, target, commit, tree, shallow, count, history, generatedRoot: generated.root }));
});
`;
  writeFileSync(join(repo, 'runner-cache-probe.test.js'), probe);
}

/** Start the current CLI from the same clean committed tooling snapshot used by API fixtures. */
function startToolingCli(repo, env, args, { toolingRoot = resolve(import.meta.dirname, '..'), ...options } = {}) {
  const sourceRoot = realpathSync(toolingRoot);
  const bin = join(committedToolingSnapshot(sourceRoot, env), 'bin', 'pullboard.js');
  const snapshot = TOOLING_SNAPSHOTS.get(sourceRoot);
  snapshot.active++;
  try {
    const child = startFixtureChild(process.execPath, [bin, ...args], {
      cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], ...options,
    });
    let settled = false;
    const finish = (status, signal, failed) => {
      if (settled) return;
      settled = true;
      snapshot.active--;
      if (failed || status !== 0 || signal) snapshot.retained = true;
    };
    child.once('close', (status, signal) => finish(status, signal, false));
    child.once('error', () => finish(null, null, true));
    return child;
  } catch (error) {
    snapshot.active--;
    snapshot.retained = true;
    throw error;
  }
}

/** Per-phase deadlines for one runner round trip; together they stay near the 60-second hang ceiling. */
const ROUND_TRIP_DEADLINES = { dispatch: 20_000, 'remote run': 30_000, 'result return': 10_000 }; // budget: a stuck runner fails by name in about a minute, far under the 660-second per-test limit.

/** Count the stand-in's phase markers; a missing file means nothing was dispatched yet. */
function phaseCounts(file) {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  return { dispatched: lines.filter(line => line === 'dispatched').length, returned: lines.filter(line => line === 'returned').length };
}

/** Stop a detached fixture child's whole process group, escalating if TERM is ignored. */
async function stopGroup(child, closed) {
  const signal = name => { try { process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  signal('SIGTERM');
  const settled = await Promise.race([closed.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 5_000))]); // budget: TERM grace before KILL.
  signal('SIGKILL');
  if (!settled) await closed;
}

/**
 * Wait for a runner round trip phase by phase: dispatch (until the stand-in is reached), remote run
 * (until the worker returns) and result return (until the controller exits). A phase past its
 * deadline stops the whole controller group and throws an error naming that phase, so a stuck
 * runner fails the test in about a minute instead of holding it to the per-test limit.
 */
async function awaitRoundTrip(child, closed, phasesFile, deadlines = ROUND_TRIP_DEADLINES) {
  const limits = { ...ROUND_TRIP_DEADLINES, ...deadlines };
  let done = null;
  closed.then(result => { done = result; });
  const timings = [];
  // The marker file may already hold earlier round trips of the same fixture; count only this one.
  const before = phasesFile ? phaseCounts(phasesFile) : { dispatched: 0, returned: 0 };
  let phase = 'dispatch';
  let phaseStarted = Date.now();
  while (!done) {
    const total = phasesFile ? phaseCounts(phasesFile) : before;
    const counts = { dispatched: total.dispatched - before.dispatched, returned: total.returned - before.returned };
    const next = counts.dispatched > counts.returned ? 'remote run' : counts.dispatched > 0 ? 'result return' : 'dispatch';
    if (next !== phase) { timings.push(`${phase} ${Date.now() - phaseStarted}ms`); phase = next; phaseStarted = Date.now(); }
    const spent = Date.now() - phaseStarted;
    if (spent > limits[phase]) {
      await stopGroup(child, closed);
      throw new Error(`runner round trip stuck in phase "${phase}": no progress after ${spent} ms (deadline ${limits[phase]} ms); earlier phases: ${timings.join(', ') || 'none'}\n${fixtureResultContext(done ?? {})}`);
    }
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 50))]); // budget: polling interval for the stand-in's phase markers.
  }
  timings.push(`${phase} ${Date.now() - phaseStarted}ms`);
  process.stderr.write(`runner round trip phases: ${timings.join(', ')}\n`);
  return done;
}

/**
 * Run a gate command through its real lease and return the profile/result emitted by the API child.
 * `requests` names the stand-in's request log, whose .phases file times the round trip by phase.
 */
async function runThroughGate(repo, env, command, { browser = true, item = '663', kind = 'check', landing = false, toolingRoot = resolve(import.meta.dirname, '..'), requests, deadlines } = {}) {
  const sourceRoot = realpathSync(toolingRoot);
  const gateUrl = pathToFileURL(join(committedToolingSnapshot(sourceRoot, env), 'src', 'gate.js')).href;
  const snapshot = TOOLING_SNAPSHOTS.get(sourceRoot);
  snapshot.active++;
  const script = `const { runProfiledShell, withGateSlot } = await import(${JSON.stringify(gateUrl)});
const result = await withGateSlot(${JSON.stringify(repo)}, lease => runProfiledShell(${JSON.stringify(repo)}, ${JSON.stringify(command)}, { gateLease: lease, landing: ${landing} }),
  { browser: ${browser}, item: ${JSON.stringify(item)}, kind: ${JSON.stringify(kind)}, landing: ${landing}, agent: 'runner-fixture' });
process.stdout.write(result.output);
process.stdout.write('PULLBOARD_RUN_RESULT ' + JSON.stringify({ isGreen: result.isGreen, runner: result.profile.executionRunner, profile: result.profile }) + '\\n');
process.exitCode = result.isGreen ? 0 : 1;
`;
  try {
    // Its own process group, so a stuck phase can stop the controller, the stand-in and the worker together.
    const closed = runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', script], { cwd: repo, env, detached: true });
    const result = await awaitRoundTrip(closed.child, closed, requests ? `${requests}.phases` : '', deadlines);
    if (result.status !== 0) snapshot.retained = true;
    return result;
  } catch (error) {
    snapshot.retained = true;
    throw error;
  } finally { snapshot.active--; }
}

/** Parse the bounded final API line without rewriting the command's raw TAP output. */
function gateResult(stdout) {
  const line = stdout.split(/\r?\n/u).findLast(value => value.startsWith('PULLBOARD_RUN_RESULT '));
  assert.ok(line, stdout);
  return JSON.parse(line.slice('PULLBOARD_RUN_RESULT '.length));
}

/** Include bounded command output when a remote fixture assertion fails. */
function fixtureResultContext(result) {
  return `${result.context}\nstdout tail:\n${String(result.stdout ?? '').slice(-4_000)}\nstderr tail:\n${String(result.stderr ?? '').slice(-4_000)}`;
}

/** Read the remote machine's live gate holders without changing its shared admission state. */
function readRemoteGateHolders(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    return db.prepare("SELECT token, pid, agent, browser, item, kind FROM holder WHERE name = 'gate'").all();
  } finally { db.close(); }
}

/** Wait for a marker from an external queue observer, with a ceiling for a broken fixture. */
async function waitForMarker(path) {
  if (existsSync(path)) return;
  const watcher = watch(dirname(path), { persistent: false });
  let timer;
  try {
    const changed = new Promise((resolve, reject) => {
      const check = (_event, filename) => {
        if ((filename === null || String(filename) === basename(path)) && existsSync(path)) resolve();
      };
      watcher.on('change', check);
      watcher.once('error', reject);
      check('rename', basename(path));
    });
    if (existsSync(path)) return;
    await Promise.race([changed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`fixture marker did not arrive: ${path}`)), 20_000); // budget: hang ceiling for the queue-to-parent handoff.
    })]);
  } finally { clearTimeout(timer); watcher.close(); }
}

/** Poll a concrete process/resource state; the deadline only bounds a broken cleanup handshake. */
async function waitForCondition(check, label) {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`fixture cleanup state did not arrive: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20)); // budget: polling interval for an observable cleanup condition.
  }
}

/** Check exact PID presence without signalling or treating permission denial as absence. */
function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

/** Start an API child that requeues only an incomplete runner transport on its original ticket. */
function startQueueController(repo, env, command, { item, queueMarker, firstItem = 'retry-first', remote = true, toolingRoot = resolve(import.meta.dirname, '..') } = {}) {
  const sourceRoot = realpathSync(toolingRoot);
  const gateUrl = pathToFileURL(join(committedToolingSnapshot(sourceRoot, env), 'src', 'gate.js')).href;
  const snapshot = TOOLING_SNAPSHOTS.get(sourceRoot);
  snapshot.active++;
  const script = `import { writeFileSync } from 'node:fs';
const { runProfiledShell, withGateSlot } = await import(${JSON.stringify(gateUrl)});
const root = ${JSON.stringify(repo)};
const command = ${JSON.stringify(command)};
const queueMarker = ${JSON.stringify(queueMarker)};
const firstItem = ${JSON.stringify(firstItem)};
const result = await withGateSlot(root, async lease => {
  const run = await runProfiledShell(root, command, { gateLease: lease });
  process.stdout.write(run.output);
  process.stdout.write('PULLBOARD_RUN_RESULT ' + JSON.stringify({ isGreen: run.isGreen, runner: run.profile.executionRunner }) + '\\n');
  return run;
},
  { browser: true, remote: ${remote}, item: ${JSON.stringify(item)}, kind: 'runner-retry-test', agent: ${JSON.stringify(item)},
  onWait(state) {
    const rows = state.line ?? [];
    if (queueMarker && rows.some(row => row.item === ${JSON.stringify(item)}) && (firstItem === null || rows.some(row => row.item === firstItem))) {
      writeFileSync(${JSON.stringify(queueMarker)}, 'both retry tickets are queued\\n');
    }
  }
});
process.exitCode = result.isGreen ? 0 : 1;
`;
  try {
    const child = startFixtureChild(process.execPath, ['--input-type=module', '-e', script], {
      cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const finish = (status, signal, failed) => {
      if (settled) return;
      settled = true;
      snapshot.active--;
      if (failed || status !== 0 || signal) snapshot.retained = true;
    };
    child.once('close', (status, signal) => finish(status, signal, false));
    child.once('error', () => finish(null, null, true));
    return child;
  } catch (error) {
    snapshot.active--;
    snapshot.retained = true;
    throw error;
  }
}

/** Observe a running fixture child without hiding stdout, stderr, or its exit status. */
function observe(child) {
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', part => { stdout += part; });
  child.stderr.setEncoding('utf8').on('data', part => { stderr += part; });
  const closed = once(child, 'close').then(([status, signal]) => ({ status, signal, stdout, stderr }));
  return { child, closed };
}

test('a queued run executes on a registered runner and its result comes back (host checkout isolation) [C7]', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-tooling-isolation-')));
  let completedCleanly = false;
  t.after(() => {
    if (!completedCleanly) {
      t.diagnostic('retained runner tooling isolation fixture at ' + dir);
      return;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const home = join(dir, 'home');
  const machineHome = join(home, '.pullboard');
  const remoteHome = join(dir, 'worker-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const remoteStateRoot = join(remoteHome, '.pullboard-runner');
  const repo = join(dir, 'repo');
  const worker = join(dir, 'second-machine');
  const bin = join(dir, 'bin');
  const toolingRoot = join(dir, 'owned-tooling');
  const requests = join(dir, 'ssh-requests.jsonl');
  for (const folder of [repo, worker, bin, home, machineHome, remoteHome, remoteMachineHome, remoteStateRoot, toolingRoot]) {
    mkdirSync(folder, { recursive: true });
  }
  const env = {
    ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
    PATH: bin + ':' + process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Runner Tooling Isolation Fixture', GIT_AUTHOR_EMAIL: 'runner-tooling-isolation@example.invalid',
    GIT_COMMITTER_NAME: 'Runner Tooling Isolation Fixture', GIT_COMMITTER_EMAIL: 'runner-tooling-isolation@example.invalid',
  };
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
  const initialized = runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.context);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(repo, 'tracked.txt'), 'host checkout isolation fixture\n');
  git(repo, env, 'add', 'pullboard.json', 'tracked.txt');
  git(repo, env, 'commit', '-q', '-m', 'test: prepare host checkout isolation fixture');

  const suiteRoot = resolve(import.meta.dirname, '..');
  copyFileSync(join(suiteRoot, 'package.json'), join(toolingRoot, 'package.json'));
  cpSync(join(suiteRoot, 'src'), join(toolingRoot, 'src'), { recursive: true });
  cpSync(join(suiteRoot, 'bin'), join(toolingRoot, 'bin'), { recursive: true });
  git(toolingRoot, env, 'init', '-q', '-b', 'main');
  git(toolingRoot, env, 'add', 'package.json', 'src', 'bin');
  git(toolingRoot, env, 'commit', '-q', '-m', 'test: commit current tooling bytes');
  const ownedCommit = git(toolingRoot, env, 'rev-parse', 'HEAD');
  writeFileSync(join(toolingRoot, 'LOCAL-NOTE.txt'), 'unrelated local note\n');
  assert.match(git(toolingRoot, env, 'status', '--porcelain'), /^\?\? LOCAL-NOTE\.txt$/u);
  const cleanToolingRoot = committedToolingSnapshot(toolingRoot, env);

  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests });
  const added = cli(repo, env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json');
  assert.equal(added.status, 0, added.context);
  const command = `node -e ${shellQuote('process.stdout.write("HOST_CHECKOUT_ISOLATED\\n")')}`;
  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = home;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  let held;
  try {
    held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo,
      agent: 'tooling-isolation-local-holder', item: 'tooling-isolation-local-holder', kind: 'force-registered-runner' });
    const run = await runThroughGate(repo, env, command, { item: 'tooling-isolation', toolingRoot, requests });
    assert.equal(run.status, 0, fixtureResultContext(run));
    assert.match(run.stdout, /HOST_CHECKOUT_ISOLATED/u);
    const result = gateResult(run.stdout);
    assert.equal(result.isGreen, true);
    assert.equal(result.runner, HOST);
    assert.equal(result.profile.executionRunner, HOST);
    assert.equal(result.profile.executionSource.tooling.name, 'pullboard');
    assert.equal(result.profile.executionSource.tooling.kind, 'git-checkout');
    assert.equal(result.profile.executionSource.tooling.commit, git(cleanToolingRoot, env, 'rev-parse', 'HEAD'),
      'the execution imports its clean private tooling snapshot, not the unrelated-note checkout');
    assert.notEqual(result.profile.executionSource.tooling.commit, ownedCommit);
    const requestsSeen = readFileSync(requests, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
    assert.equal(requestsSeen.length, 1, 'the actual remote command is sent exactly once');
    assert.equal(requestsSeen[0].host, HOST);
    assert.equal(requestsSeen[0].workerStarted, true);
    assert.equal(requestsSeen[0].code, 0);
    const cliRun = observe(startToolingCli(repo, env, ['gate', '--json'], { toolingRoot, detached: true }));
    const cliResult = await awaitRoundTrip(cliRun.child, cliRun.closed, `${requests}.phases`);
    assert.equal(cliResult.status, 0, fixtureResultContext(cliResult));
    assert.equal(JSON.parse(cliResult.stdout.trim()).green, true);
    const allRequests = readFileSync(requests, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
    assert.equal(allRequests.length, 2, 'both the API and actual CLI execute remotely from clean tooling snapshots');
    assert.ok(allRequests.every(request => request.host === HOST && request.workerStarted && request.code === 0));
    assert.equal(git(toolingRoot, env, 'status', '--porcelain'), '?? LOCAL-NOTE.txt',
      'the owned source fixture remains dirty only by its unrelated note');
    completedCleanly = true;
  } finally {
    if (held) held.release();
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
});

test('a queued run executes on a registered runner and its result comes back [C7]', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-')));
  TEMP.push(dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const machineHome = join(home, '.pullboard');
  const remoteHome = join(dir, 'worker-home');
  const remoteStateRoot = join(remoteHome, '.pullboard-runner');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const repo = join(dir, 'repo');
  const worker = join(dir, 'second-machine');
  const bin = join(dir, 'bin');
  const requests = join(dir, 'ssh-requests.jsonl');
  for (const folder of [repo, worker, bin, home, remoteHome, remoteStateRoot, remoteMachineHome, machineHome]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
  const env = {
    ...process.env,
    HOME: home,
    PULLBOARD_HOME: home,
    PULLBOARD_MACHINE_HOME: machineHome,
    PULLBOARD_GATE_SLOT_HELD: '1',
    PULLBOARD_GATE_SLOT_POOL: 'caller-pool-marker',
    PULLBOARD_GATE_SLOT_TOKEN: 'caller-token-marker',
    PULLBOARD_BROWSER_SLOT_HELD: '1',
    PULLBOARD_RUNNER_FIXTURE_SECRET: SECRET,
    SSH_AUTH_SOCK: join(dir, 'must-not-forward.sock'),
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Runner Fixture',
    GIT_AUTHOR_EMAIL: 'runner-fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Runner Fixture',
    GIT_COMMITTER_EMAIL: 'runner-fixture@example.invalid',
  };
  const initialized = runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.context);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(repo, 'tracked.txt'), 'committed runner source\n');
  writeFileSync(join(repo, 'history-original.txt'), 'committed history witness\n');
  writeFileSync(join(repo, '.gitignore'), '.env\n');
  git(repo, env, 'add', '.gitignore', 'pullboard.json', 'tracked.txt', 'history-original.txt');
  git(repo, env, 'commit', '-q', '-m', 'test: prepare registered runner fixture');
  const historyBaseCommit = git(repo, env, 'rev-parse', 'HEAD');
  git(repo, env, 'tag', '-a', 'runner-release', '-m', 'runner release annotation witness', historyBaseCommit);
  git(repo, env, 'tag', 'runner-lightweight', historyBaseCommit);
  const annotatedTagObject = git(repo, env, 'rev-parse', 'refs/tags/runner-release');
  const lightweightTagObject = git(repo, env, 'rev-parse', 'refs/tags/runner-lightweight');
  const unrelatedCommit = git(repo, env, 'commit-tree', `${historyBaseCommit}^{tree}`, '-m', 'unrelated tag target');
  git(repo, env, 'tag', 'runner-unrelated', unrelatedCommit);
  git(repo, env, 'mv', 'history-original.txt', 'history-renamed.txt');
  git(repo, env, 'commit', '-q', '-m', 'test: preserve renamed runner history witness');
  writeFileSync(join(repo, '.env'), SECRET);
  const commit = git(repo, env, 'rev-parse', 'HEAD');
  const tree = git(repo, env, 'rev-parse', 'HEAD^{tree}');
  assert.equal(git(repo, env, 'status', '--porcelain'), '', 'the ignored secret is not a dirty tracked change');

  const ssh = installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests });
  assert.ok(existsSync(ssh));
  writeProbe(repo, { remoteStateRoot, remoteMachineHome, sourceHome: home, sourceMachineHome: machineHome, historyBaseCommit,
    annotatedTagObject, lightweightTagObject,
    callerPool: 'caller-pool-marker', callerToken: 'caller-token-marker' });
  git(repo, env, 'add', 'runner-probe.test.js');
  git(repo, env, 'commit', '-q', '-m', 'test: add remote source probe [C7]');
  const selectedCommit = git(repo, env, 'rev-parse', 'HEAD');
  const selectedTree = git(repo, env, 'rev-parse', 'HEAD^{tree}');

  // This is the first behavior checked: on the old implementation the real CLI rejects `runner add`
  // before any new runner module/import is reached, giving a meaningful old-source red.
  const added = cli(repo, env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json');
  assert.equal(added.status, 0, added.context);
  const resources = cli(repo, env, 'resources', '--json');
  assert.equal(resources.status, 0, resources.context);
  const listed = JSON.parse(resources.stdout);
  assert.ok(listed.runners?.some(entry => entry.host === HOST && entry.slots === 1 && entry.browser === 1), resources.stdout);

  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = home;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  let held;
  try {
    held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo,
      agent: 'fixture-local-holder', item: 'runner-local-holder', kind: 'force-registered-runner' });
    const successful = await runThroughGate(repo, env, 'node --test --test-reporter=tap runner-probe.test.js', { landing: true, requests });
  assert.equal(successful.status, 0, fixtureResultContext(successful));
  assert.match(successful.stdout, /TAP version 13/);
  assert.match(successful.stdout, /RUNNER_FACT /);
  const fact = JSON.parse(/RUNNER_FACT (\{[^\n]+\})/u.exec(successful.stdout)?.[1] ?? 'null');
  assert.equal(fact.commit, selectedCommit);
  assert.equal(fact.tree, selectedTree);
  assert.equal(fact.landing, '1', 'the remote landing command receives the trusted landing marker');
  assert.notEqual(fact.cwd, repo);
  const remotePath = relative(remoteStateRoot, fact.cwd);
  assert.ok(remotePath && !remotePath.startsWith('..' + sep) && remotePath !== '..');
  assert.ok(fact.home.startsWith(fact.cwd.slice(0, fact.cwd.indexOf('/checkout'))));
  assert.notEqual(fact.gatePool, 'caller-pool-marker');
  assert.notEqual(fact.gateToken, 'caller-token-marker');
  assert.equal(fact.browser, '1');
  const result = gateResult(successful.stdout);
  assert.equal(result.isGreen, true);
  assert.equal(result.runner, HOST);
  assert.equal(result.profile.executionRunner, HOST);
  assert.equal(result.profile.tests.length, 1, 'TAP results are retained in the ordinary profile');
  const source = result.profile.executionSource;
  assert.equal(source.commit, selectedCommit);
  assert.equal(source.tree, selectedTree);
  assert.equal(source.tooling.name, 'pullboard');
  assert.equal(source.tooling.kind, 'git-checkout');
  assert.match(source.tooling.sha256, /^[a-f0-9]{64}$/u);
  assert.notEqual(source.tooling.commit, selectedCommit, 'the tooling checkout has provenance separate from the tiny fixture project');
  const request = JSON.parse(readFileSync(requests, 'utf8').trim().split('\n')[0]);
  assert.equal(request.host, HOST);
  assert.equal(request.framed, true);
  assert.equal(request.remoteCommandPresent, true);
  for (const option of ['-T', 'BatchMode=yes', 'ForwardAgent=no', 'ClearAllForwardings=yes', 'SendEnv=-*',
    'ConnectTimeout=10', 'ServerAliveInterval=10', 'ServerAliveCountMax=3']) {
    assert.ok(request.options.includes(option), `SSH includes ${option}`);
  }
  assert.equal(request.remoteHasSecret, false);
  assert.equal(request.remoteHasLocalPath, false);
  assert.equal(request.remoteHasSourceHome, false);
  assert.equal(request.remoteHasSourceMachineHome, false);
  assert.ok(request.stdinBytes > 0, 'the exact commit objects arrived through binary stdin');
  assert.equal(request.secretInLocalSshEnv, false);
  assert.equal(request.localPoolMarkerInLocalSshEnv, false);
  assert.equal(request.localHeldMarkerInLocalSshEnv, false);
  assert.equal(request.localTokenMarkerInLocalSshEnv, false);
  assert.equal(request.localMachineHomeInSshEnv, false);
  assert.doesNotMatch(successful.stdout + successful.stderr, new RegExp(SECRET, 'u'));

  const red = await runThroughGate(repo, env, "node -e 'if (process.env.PULLBOARD_LANDING_RUN !== \"0\") process.exit(9); process.stdout.write(\"RUNNER_EXIT_7\\n\"); process.exit(7)'", { requests });
  assert.equal(red.status, 1, fixtureResultContext(red));
  assert.match(red.stdout, /RUNNER_EXIT_7/);
  const redResult = gateResult(red.stdout);
  assert.equal(redResult.isGreen, false);
  assert.equal(redResult.runner, HOST);
  const callsAfterExit7 = readFileSync(requests, 'utf8').trim().split('\n').length;
  assert.equal(callsAfterExit7, 2, 'a complete exit-7 receipt is a test failure, not a dropped-run retry');

  // A real full-suite runner produced more than ten thousand small process journals.
  // Exercise that boundary in the worker without launching thousands of fixture processes.
  writeFileSync(join(repo, 'runner-many-journals.js'), `import { readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const option = /(?:^|\\s)--import=(?:"([^"]+)"|'([^']+)'|(\\S+))/u.exec(process.env.NODE_OPTIONS || '');
if (!option) throw new Error('runner preload path was not passed to the committed job');
const journal = join(dirname(fileURLToPath(option[1] || option[2] || option[3])), 'child-journal');
for (let index = 0; index < 10_001; index++) {
  const pid = 2_000_000 + index;
  writeFileSync(join(journal, 'children-' + pid + '.jsonl'), JSON.stringify({
    type: 'boot', pid, ppid: process.pid, instance: 'bounded-journal-fixture-' + index,
  }) + '\\n');
}
console.log('RUNNER_JOURNAL_FILES ' + readdirSync(journal).filter(name => /^children-\\d+\\.jsonl$/u.test(name)).length);
`);
  git(repo, env, 'add', 'runner-many-journals.js');
  git(repo, env, 'commit', '-q', '-m', 'test: cover a bounded large runner journal');
  const manyJournals = await runThroughGate(repo, env, 'node runner-many-journals.js', { requests });
  assert.equal(manyJournals.status, 0, fixtureResultContext(manyJournals));
  const journalCount = Number(/RUNNER_JOURNAL_FILES (\d+)/u.exec(manyJournals.stdout)?.[1]);
  assert.ok(journalCount > 10_000, 'the real worker saw more journal files than the old limit');
  const manyResult = gateResult(manyJournals.stdout);
  assert.equal(manyResult.isGreen, true, 'the bounded journal returns a complete successful receipt');
  assert.equal(manyResult.runner, HOST);
  assert.equal(readRemoteGateHolders(join(remoteMachineHome, 'resources.sqlite')).length, 0,
    'the physical runner lease is released after successful cleanup');
  const callsAfterManyJournals = readFileSync(requests, 'utf8').trim().split('\n').length;
  assert.equal(callsAfterManyJournals, 3, 'the large-journal command ran remotely exactly once');

  const tagSecretAssignment = `${['RUNNER', 'FIXTURE', 'SECRET'].join('_')}=${SECRET}`;
  git(repo, env, 'tag', '-a', 'runner-private-tag', '-m', tagSecretAssignment, 'HEAD');
  const privateTag = await runThroughGate(repo, env, 'node -e "process.stdout.write(\'PRIVATE_TAG_SCAN_REACHED\\n\')"', { requests });
  assert.equal(privateTag.status, 1, fixtureResultContext(privateTag));
  assert.match(privateTag.stdout + privateTag.stderr, /RUNNER_SECRET/u);
  assert.doesNotMatch(privateTag.stdout + privateTag.stderr, new RegExp(SECRET, 'u'));
  assert.equal(readFileSync(requests, 'utf8').trim().split('\n').length, callsAfterManyJournals,
    'a secret annotated tag is refused before opening an SSH request');
  git(repo, env, 'tag', '-d', 'runner-private-tag');

  // The secret is absent from HEAD but remains in a reachable commit; full-history scanning must
  // refuse before transferring those historical objects to the registered worker.
  git(repo, env, 'add', '-f', '.env');
  git(repo, env, 'commit', '-q', '-m', 'test: add temporary historical private file');
  git(repo, env, 'rm', '--cached', '.env');
  git(repo, env, 'commit', '-q', '-m', 'test: remove current private file but retain history');
  assert.doesNotMatch(git(repo, env, 'ls-tree', '-r', '--name-only', 'HEAD'), /(?:^|\n)\.env(?:$|\n)/u);
  assert.equal(readFileSync(join(repo, '.env'), 'utf8'), SECRET, 'the ignored local fixture remains private');
  const historicalRed = await runThroughGate(repo, env, 'node -e "process.stdout.write(\'HISTORICAL_SECRET_SCAN_REACHED\\n\')"', { requests });
  assert.equal(historicalRed.status, 1, fixtureResultContext(historicalRed));
  assert.match(historicalRed.stdout + historicalRed.stderr, /RUNNER_SECRET/u);
  assert.doesNotMatch(historicalRed.stdout + historicalRed.stderr, new RegExp(SECRET, 'u'));
  assert.equal(readFileSync(requests, 'utf8').trim().split('\n').length, callsAfterManyJournals,
    'historical secret scanning refuses before opening an SSH request');

  assert.equal(commit.length, 40);
  assert.equal(tree.length, 40);
  } finally {
    if (held) held.release();
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
});

/** List live processes whose command line mentions a fixture directory. */
function processesUnder(dir) {
  const listed = runFixtureChild('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.context);
  return listed.stdout.split('\n').filter(line => line.includes(dir) && !line.includes('/bin/ps'));
}

test('a queued runner run finishes or fails by name within its deadline [C7]', { timeout: 120_000 }, async (t) => { // budget: one real round trip plus three held phases, each stopped by its own deadline.
  // Linux lists kernel threads with process group 0. A census holding them must still parse, or
  // runner cleanup can never be verified on a real Linux host and every round trip waits forever.
  const linuxCensus = [
    '    1     0     1 Fri Oct 16 19:03:32 2026 Ss   systemd',
    '    2     0     0 Fri Oct 16 19:03:32 2026 S    kthreadd',
    '    3     2     0 Fri Oct 16 19:03:32 2026 I<   kworker/R-rcu_g',
    '  812     1   812 Fri Oct 16 19:05:01 2026 Ss   node',
  ].join('\n');
  const parsed = parseProcessCensus(linuxCensus);
  assert.ok(parsed, 'a census with kernel threads in process group 0 still parses');
  assert.deepEqual([...parsed.keys()], [1, 812], 'kernel threads are skipped; real processes are kept');
  assert.equal(parseProcessCensus('    5     1     5 Fri Oct 16 19:03:32 2026 S    node\nnot a census row'), null, 'a malformed row still voids the census');

  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-deadline-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const machineHome = join(home, '.pullboard');
  const remoteHome = join(dir, 'worker-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const repo = join(dir, 'repo');
  const worker = join(dir, 'second-machine');
  const bin = join(dir, 'bin');
  const requests = join(dir, 'ssh-requests.jsonl');
  for (const folder of [repo, worker, bin, home, machineHome, remoteHome, remoteMachineHome]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
  const env = {
    ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Runner Fixture', GIT_AUTHOR_EMAIL: 'runner-fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Runner Fixture', GIT_COMMITTER_EMAIL: 'runner-fixture@example.invalid',
  };
  const initialized = runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.context);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(repo, 'tracked.txt'), 'committed runner source\n');
  git(repo, env, 'add', 'pullboard.json', 'tracked.txt');
  git(repo, env, 'commit', '-q', '-m', 'test: prepare runner deadline fixture');
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests });
  const added = cli(repo, env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json');
  assert.equal(added.status, 0, added.context);
  const command = `node -e ${shellQuote('process.stdout.write("ROUND_TRIP_DONE\\n")')}`;

  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = home;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  let held;
  try {
    // Fill the controller's own gate so every run below goes to the runner.
    held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo,
      agent: 'fixture-local-holder', item: 'local-holder', kind: 'force-registered-runner' });

    // The real round trip still passes inside its deadlines.
    const real = await runThroughGate(repo, env, command, { item: 'deadline-real', requests });
    assert.equal(real.status, 0, fixtureResultContext(real));
    assert.match(real.stdout, /ROUND_TRIP_DONE/u);
    assert.equal(gateResult(real.stdout).runner, HOST);
    assert.deepEqual(phaseCounts(`${requests}.phases`), { dispatched: 1, returned: 1 });

    /** Hold the fake runner at one phase and expect the round trip to fail naming it, in time. */
    const heldAt = async (hold, phase, deadlines, ceiling) => {
      installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests, hold });
      const started = Date.now();
      await assert.rejects(runThroughGate(repo, env, command, { item: `deadline-${hold}`, requests, deadlines }),
        new RegExp(`runner round trip stuck in phase "${phase}"`, 'u'), `a runner held at ${hold} fails naming the ${phase} phase`);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < ceiling, `the ${phase} failure arrives in ${elapsed} ms, under ${ceiling} ms`);
      assert.deepEqual(processesUnder(dir), [], `nothing from the held ${phase} round trip keeps running`);
    };
    // With the default deadlines a runner that never answers fails by name within about a minute.
    await heldAt('run', 'remote run', undefined, 60_000);
    await heldAt('dispatch', 'dispatch', { dispatch: 3_000 }, 15_000);
    await heldAt('return', 'result return', { 'result return': 3_000 }, 15_000);
  } finally {
    held?.release();
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
});

test('a queued run executes on a registered runner and its result comes back [C7] (dropped runner returns ticket before later work)', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-retry-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const machineHome = join(home, '.pullboard');
  const remoteHome = join(dir, 'worker-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const repo = join(dir, 'repo');
  const worker = join(dir, 'second-machine');
  const bin = join(dir, 'bin');
  const requests = join(dir, 'ssh-requests.jsonl');
  const queueReady = join(dir, 'both-waiters-queued');
  const firstStarted = join(dir, 'first-started');
  const releaseFirst = join(dir, 'release-first');
  const olderStarted = join(dir, 'older-local-started');
  const olderQueued = join(dir, 'older-local-queued');
  const order = join(dir, 'execution-order');
  for (const folder of [repo, worker, bin, home, remoteHome, remoteMachineHome, machineHome]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
  const env = {
    ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
    PULLBOARD_RUNNER_FIXTURE_SECRET: SECRET, SSH_AUTH_SOCK: join(dir, 'must-not-forward.sock'),
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Runner Fixture', GIT_AUTHOR_EMAIL: 'runner-fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Runner Fixture', GIT_COMMITTER_EMAIL: 'runner-fixture@example.invalid',
  };
  const initialized = runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.context);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(repo, 'tracked.txt'), 'committed runner source\n');
  git(repo, env, 'add', 'pullboard.json', 'tracked.txt');
  git(repo, env, 'commit', '-q', '-m', 'test: prepare dropped-runner fixture');
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests, dropFirst: true });
  const host = `${HOST}-drop`;
  const added = cli(repo, env, 'runner', 'add', host, '--slots', '1', '--browser', '1', '--json');
  assert.equal(added.status, 0, added.context);

  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = home;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  let held;
  let first;
  let second;
  try {
    held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo,
      agent: 'fixture-local-holder', item: 'local-holder', kind: 'controlled-hold' });
    const olderCode = `require('node:fs').appendFileSync(${JSON.stringify(order)}, 'older-local\\n'); require('node:fs').writeFileSync(${JSON.stringify(olderStarted)}, 'started\\n');`;
    const firstCode = `const fs=require('node:fs'); const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{ fs.writeFileSync(${JSON.stringify(firstStarted)}, 'started\\n'); fs.appendFileSync(${JSON.stringify(order)}, 'retry-first\\n');
while(!fs.existsSync(${JSON.stringify(releaseFirst)})) await sleep(5); })().catch(error=>{console.error(error);process.exitCode=2});`;
    second = observe(startQueueController(repo, env, `node -e ${shellQuote(olderCode)}`,
      { item: 'older-local', queueMarker: olderQueued, firstItem: null, remote: false }));
    await waitForMarker(olderQueued);
    first = observe(startQueueController(repo, env, `node -e ${shellQuote(firstCode)}`,
      { item: 'retry-first', queueMarker: queueReady, firstItem: 'older-local' }));
    // The SSH stand-in creates this file only after appending its first request record.
    await waitForMarker(requests);
    const dropped = JSON.parse(readFileSync(requests, 'utf8').trim().split('\n')[0]);
    assert.equal(dropped.dropped, true, 'the first SSH connection drops without a completion receipt');
    await waitForMarker(queueReady);
    held.release();
    held = null;
    await waitForMarker(firstStarted);
    assert.equal(readFileSync(order, 'utf8'), 'retry-first\n', 'the returned remote ticket jumps ahead of the older local-only waiter');
    writeFileSync(releaseFirst, 'continue\n');
    const [firstResult, secondResult] = await Promise.all([first.closed, second.closed]);
    assert.equal(firstResult.status, 0, `${firstResult.stdout}${firstResult.stderr}`);
    assert.equal(secondResult.status, 0, `${secondResult.stdout}${secondResult.stderr}`);
    assert.equal(readFileSync(order, 'utf8'), 'retry-first\nolder-local\n');
    assert.ok(existsSync(olderStarted), 'the older local-only waiter runs after the returned remote ticket');
    assert.equal(readFileSync(requests, 'utf8').trim().split('\n').length, 1,
      'the quarantined host is not contacted again for the front-of-queue local retry');
    const retried = gateResult(firstResult.stdout);
    assert.equal(retried.isGreen, true, `${firstResult.stdout}${firstResult.stderr}`);
    assert.notEqual(retried.runner, host, 'the retried command completes after the failed runner is quarantined');
  } finally {
    if (held) held.release();
    writeFileSync(releaseFirst, 'cleanup-release\n');
    for (const child of [first?.child, second?.child]) {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    await Promise.all([first?.closed, second?.closed].filter(Boolean));
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
});

test('a queued run executes on a registered runner and its result comes back [C7] (disconnect drains an npm setup child before releasing its gate holder)', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-setup-disconnect-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const machineHome = join(home, '.pullboard');
  const remoteHome = join(dir, 'worker-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const repo = join(dir, 'repo');
  const packageDirectory = join(repo, 'packages', 'setup-fixture-dep');
  const worker = join(dir, 'second-machine');
  const bin = join(dir, 'bin');
  const requests = join(dir, 'ssh-requests.jsonl');
  const setupReady = join(dir, 'setup-ready');
  const setupPid = join(dir, 'setup-pid');
  const setupTerm = join(dir, 'setup-term');
  const releaseSetup = join(dir, 'release-setup');
  const setupGone = join(dir, 'setup-gone');
  const remoteDatabase = join(remoteMachineHome, 'resources.sqlite');
  for (const folder of [repo, worker, bin, home, machineHome, remoteHome, remoteMachineHome, packageDirectory]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
  const env = {
    ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Runner Setup Fixture', GIT_AUTHOR_EMAIL: 'runner-setup@example.invalid',
    GIT_COMMITTER_NAME: 'Runner Setup Fixture', GIT_COMMITTER_EMAIL: 'runner-setup@example.invalid',
  };
  const initialized = runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.context);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(repo, 'package.json'), JSON.stringify({
    name: 'runner-setup-fixture', version: '1.0.0', private: true, type: 'module',
    workspaces: ['packages/setup-fixture-dep'], dependencies: { 'setup-fixture-dep': '1.0.0' },
  }, null, 2) + '\n');
  writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({
    name: 'setup-fixture-dep', version: '1.0.0', scripts: { postinstall: 'node postinstall.js' },
  }, null, 2) + '\n');
  writeFileSync(join(packageDirectory, 'witness.txt'), 'setup fixture package source\n');
  writeFileSync(join(packageDirectory, 'postinstall.js'), `import { existsSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
const ready = ${JSON.stringify(setupReady)};
const pidFile = ${JSON.stringify(setupPid)};
const term = ${JSON.stringify(setupTerm)};
const release = ${JSON.stringify(releaseSetup)};
const gone = ${JSON.stringify(setupGone)};
const waitForRelease = new Promise((resolve, reject) => {
  if (existsSync(release)) return resolve();
  const watcher = watch(dirname(release), { persistent: false });
  let timer;
  const finish = error => { clearTimeout(timer); watcher.close(); error ? reject(error) : resolve(); };
  const check = (_event, filename) => {
    if ((filename === null || String(filename) === basename(release)) && existsSync(release)) finish();
  };
  watcher.on('change', check);
  watcher.once('error', finish);
  timer = setTimeout(() => finish(new Error('postinstall release hang ceiling exceeded')), 20_000); // budget: bound a broken fixture handshake.
  check('rename', basename(release));
});
let stopping = false;
process.on('SIGTERM', () => {
  if (stopping) return;
  stopping = true;
  writeFileSync(term, 'term received\\n');
  waitForRelease.then(() => { writeFileSync(gone, 'setup child exited\\n'); process.exit(0); }, error => {
    console.error(error.message); process.exit(2);
  });
});
writeFileSync(pidFile, String(process.pid) + '\\n');
writeFileSync(ready, 'setup started\\n');
`);
  const npmPathResult = runFixtureChild('which', ['npm'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(npmPathResult.status, 0, npmPathResult.context);
  const packageLock = runFixtureChild(npmPathResult.stdout.trim(), ['install', '--package-lock-only', '--ignore-scripts', '--offline'], {
    cwd: repo, env, encoding: 'utf8',
  });
  assert.equal(packageLock.status, 0, packageLock.context);
  git(repo, env, 'add', '.gitignore', 'pullboard.json', 'package.json', 'package-lock.json', 'packages/setup-fixture-dep');
  git(repo, env, 'commit', '-q', '-m', 'test: prepare disconnect during runner setup');

  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests, dropAfterMarker: setupReady });
  const host = `${HOST}-setup`;
  const added = cli(repo, env, 'runner', 'add', host, '--slots', '1', '--browser', '1', '--json');
  assert.equal(added.status, 0, added.context);

  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = home;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  let held;
  let run;
  try {
    held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo,
      agent: 'fixture-local-holder', item: 'setup-local-holder', kind: 'force-registered-runner' });
    const code = `process.stdout.write('SETUP_RETRY_LOCAL\\n')`;
    run = observe(startQueueController(repo, env, `node -e ${shellQuote(code)}`,
      { item: 'setup-disconnect', firstItem: null }));

    await waitForMarker(setupReady);
    const childPid = Number(readFileSync(setupPid, 'utf8').trim());
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
    await waitForMarker(setupTerm);
    const liveHolders = readRemoteGateHolders(remoteDatabase);
    assert.equal(liveHolders.length, 1, 'the remote gate holder remains while its setup child is handling termination');
    assert.ok(liveHolders[0].agent.startsWith('pullboard-ssh-'));
    assert.equal(liveHolders[0].item, 'setup-disconnect');
    assert.equal(liveHolders[0].kind, 'runner-retry-test');
    assert.equal(liveHolders[0].browser, 1);
    assert.notEqual(liveHolders[0].pid, childPid, 'the holder belongs to the worker, not its npm setup child');
    assert.equal(existsSync(setupGone), false, 'the setup child has not exited before its release handshake');

    held.release();
    held = null;
    writeFileSync(releaseSetup, 'release setup child\\n');
    await waitForMarker(setupGone);
    const result = await run.closed;
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /SETUP_RETRY_LOCAL/u, 'the transport drop requeues the run onto the local slot');
    assert.equal(gateResult(result.stdout).isGreen, true);
    assert.equal(readFileSync(requests, 'utf8').trim().split('\n').length, 1);
    const request = JSON.parse(readFileSync(requests, 'utf8').trim().split('\n')[0]);
    assert.equal(request.droppedAfterSetup, true, 'the stand-in drops the connection after npm setup actually starts');
    assert.equal(request.workerStarted, true);
    assert.notEqual(request.code, 0, 'the worker exits without a complete success receipt after HUP');
    // Observe release through the actual pool, including its normal dead-worker lease reaping.
    await waitForCondition(() => {
      const previous = process.env.PULLBOARD_MACHINE_HOME;
      process.env.PULLBOARD_MACHINE_HOME = remoteMachineHome;
      try {
        return listResources({ scope: 'machine', root: worker })
          .some(resource => resource.name === 'gate' && resource.holders.length === 0);
      } finally {
        if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
        else process.env.PULLBOARD_MACHINE_HOME = previous;
      }
    }, 'the remote pool releases its setup holder after the owned child exits');
    assert.equal(readRemoteGateHolders(remoteDatabase).length, 0, 'the remote holder is released after the owned setup child exits');
  } finally {
    if (held) held.release();
    writeFileSync(releaseSetup, 'cleanup release\\n');
    if (run?.child && run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGTERM');
    await run?.closed;
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
});

test('a queued run executes on a registered runner and its result comes back [C7] (cached source and npm content retain fresh checkout lifecycles)', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-cache-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const machineHome = join(home, '.pullboard');
  const remoteHome = join(dir, 'worker-home');
  const remoteStateRoot = join(remoteHome, 'private-runner-root');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const repo = join(dir, 'repo');
  const worker = join(dir, 'second-machine');
  const bin = join(dir, 'bin');
  const requests = join(dir, 'ssh-requests.jsonl');
  const installWitnesses = join(dir, 'remote-install-witnesses');
  const packageDirectory = join(repo, 'packages', 'runner-fixture-dep');
  for (const folder of [repo, worker, bin, home, machineHome, remoteHome, remoteStateRoot, remoteMachineHome, packageDirectory]) {
    mkdirSync(folder, { recursive: true });
  }
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
  const env = {
    ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Runner Cache Fixture', GIT_AUTHOR_EMAIL: 'runner-cache@example.invalid',
    GIT_COMMITTER_NAME: 'Runner Cache Fixture', GIT_COMMITTER_EMAIL: 'runner-cache@example.invalid',
  };
  const initialized = runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.context);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\ngenerated/\n');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(repo, 'package.json'), JSON.stringify({
    name: 'runner-cache-fixture', version: '1.0.0', private: true, type: 'module',
    scripts: { prepare: 'node prepare.js' },
    workspaces: ['packages/runner-fixture-dep'], dependencies: { 'runner-fixture-dep': '1.0.0' },
  }, null, 2) + '\n');
  writeFileSync(join(repo, 'prepare.js'), `import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
mkdirSync('generated', { recursive: true });
writeFileSync('generated/config.json', JSON.stringify({ root: resolve('.') }) + '\\n');
`);
  writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({
    name: 'runner-fixture-dep', version: '1.0.0', type: 'module', scripts: { postinstall: 'node postinstall.js' },
  }, null, 2) + '\n');
  writeFileSync(join(packageDirectory, 'witness.txt'), 'committed workspace witness\n');
  writeFileSync(join(repo, 'history-original.txt'), 'committed cache history witness\n');
  writeFileSync(join(packageDirectory, 'postinstall.js'), `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const prefix = process.env.INIT_CWD;
if (!prefix) throw new Error('npm did not provide the install root');
writeFileSync(join(prefix, 'node_modules', '.runner-cache-witness'), readFileSync(new URL('./witness.txt', import.meta.url)));
appendFileSync(${JSON.stringify(installWitnesses)}, 'postinstall\\n');
`);
  const npmPathResult = runFixtureChild('which', ['npm'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(npmPathResult.status, 0, npmPathResult.context);
  const npmPath = npmPathResult.stdout.trim();
  const lock = runFixtureChild(npmPath, ['install', '--package-lock-only', '--ignore-scripts', '--offline'], {
    cwd: repo, env, encoding: 'utf8',
  });
  assert.equal(lock.status, 0, lock.context);
  git(repo, env, 'add', '.gitignore', 'pullboard.json', 'package.json', 'prepare.js', 'package-lock.json', 'packages/runner-fixture-dep', 'history-original.txt');
  git(repo, env, 'commit', '-q', '-m', 'test: prepare cached local workspace dependency');
  const historyBaseCommit = git(repo, env, 'rev-parse', 'HEAD');
  git(repo, env, 'mv', 'history-original.txt', 'history-renamed.txt');
  git(repo, env, 'commit', '-q', '-m', 'test: preserve cached runner history witness');
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests, nodeCommand: process.execPath });
  const added = cli(repo, env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--node', process.execPath,
    '--root', remoteStateRoot, '--json');
  assert.equal(added.status, 0, added.context);
  const registered = JSON.parse(added.stdout);
  assert.equal(registered.runner.node, process.execPath);
  assert.equal(registered.runner.root, remoteStateRoot);

  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = home;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  let held;
  try {
    held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo,
      agent: 'fixture-cache-local-holder', item: 'cache-local-holder', kind: 'force-registered-runner' });
    const command = 'node --test --test-reporter=tap runner-cache-probe.test.js';
    writeCacheProbe(repo, { remoteStateRoot, nodePath: process.execPath, historyBaseCommit });
    git(repo, env, 'add', 'runner-cache-probe.test.js');
    git(repo, env, 'commit', '-q', '-m', 'test: assert cache symlink stays job-local');
    const cacheCommit = git(repo, env, 'rev-parse', 'HEAD');
    const cacheTree = git(repo, env, 'rev-parse', 'HEAD^{tree}');
    const first = await runThroughGate(repo, env, command, { item: 'cache-first', requests });
    assert.equal(first.status, 0, fixtureResultContext(first));
    const firstFact = JSON.parse(/RUNNER_CACHE_FACT (\{[^\n]+\})/u.exec(first.stdout)?.[1] ?? 'null');
    assert.equal(firstFact.commit, cacheCommit);
    assert.equal(firstFact.tree, cacheTree);
    assert.equal(firstFact.shallow, 'false');
    assert.ok(firstFact.history.includes(historyBaseCommit));
    assert.equal(firstFact.root, firstFact.target.slice(0, firstFact.target.indexOf('/packages/runner-fixture-dep')));
    assert.equal(gateResult(first.stdout).runner, HOST);
    assert.equal(firstFact.generatedRoot, firstFact.root, 'the first fresh checkout ran root prepare');
    assert.equal(readFileSync(installWitnesses, 'utf8'), 'postinstall\n', 'the first fresh checkout runs the committed workspace postinstall');

    const second = await runThroughGate(repo, env, command, { item: 'cache-second', requests });
    assert.equal(second.status, 0, fixtureResultContext(second));
    const secondFact = JSON.parse(/RUNNER_CACHE_FACT (\{[^\n]+\})/u.exec(second.stdout)?.[1] ?? 'null');
    assert.equal(secondFact.commit, cacheCommit);
    assert.equal(secondFact.tree, cacheTree);
    assert.equal(secondFact.shallow, 'false');
    assert.ok(secondFact.history.includes(historyBaseCommit));
    assert.equal(secondFact.generatedRoot, secondFact.root, 'the second fresh checkout reran root prepare');
    assert.equal(gateResult(second.stdout).runner, HOST);
    assert.equal(secondFact.root, secondFact.target.slice(0, secondFact.target.indexOf('/packages/runner-fixture-dep')));
    assert.notEqual(firstFact.root, secondFact.root, 'each run unpacks a fresh checkout');
    assert.equal(git(repo, env, 'rev-parse', 'HEAD'), cacheCommit);
    assert.equal(git(repo, env, 'rev-parse', 'HEAD^{tree}'), cacheTree);
    assert.equal(readFileSync(installWitnesses, 'utf8'), 'postinstall\npostinstall\n', 'the second fresh checkout runs its own workspace postinstall');
    const requestsSeen = readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(requestsSeen.length, 2);
    assert.ok(requestsSeen[0].stdinBytes > requestsSeen[1].stdinBytes,
      'the same candidate sends fewer Git-pack bytes after its first cache import');
    assert.ok(requestsSeen.every(request => request.remoteStartsWithConfiguredNode), 'both remote workers use the configured absolute Node path');
  } finally {
    if (held) held.release();
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
});

test('a queued run executes on a registered runner and its result comes back [C7] (older resource clients keep local capacity separate)', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-old-resource-client-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const machineHome = join(home, '.pullboard');
  const remoteHome = join(dir, 'worker-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const repo = join(dir, 'repo');
  const worker = join(dir, 'second-machine');
  const bin = join(dir, 'bin');
  const requests = join(dir, 'ssh-requests.jsonl');
  const remoteReady = join(dir, 'remote-ready');
  const releaseRemote = join(dir, 'release-remote');
  const secondBrowserQueued = join(dir, 'second-browser-queued');
  const secondBrowserAcquired = join(dir, 'second-browser-acquired');
  const resourceDatabase = join(machineHome, 'resources.sqlite');
  for (const folder of [repo, worker, bin, home, machineHome, remoteHome, remoteMachineHome]) {
    mkdirSync(folder, { recursive: true });
  }
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 2 }));
  const env = {
    ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Legacy Resource Fixture', GIT_AUTHOR_EMAIL: 'legacy-resource@example.invalid',
    GIT_COMMITTER_NAME: 'Legacy Resource Fixture', GIT_COMMITTER_EMAIL: 'legacy-resource@example.invalid',
  };
  const initialized = runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.context);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(repo, 'tracked.txt'), 'registered runner fixture\n');
  git(repo, env, 'add', 'pullboard.json', 'tracked.txt');
  git(repo, env, 'commit', '-q', '-m', 'test: prepare mixed-version resource fixture');
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests });
  const added = cli(repo, env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json');
  assert.equal(added.status, 0, added.context);

  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = home;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  let initialBrowser;
  let localBrowser;
  let localCpu;
  let secondBrowser;
  let secondBrowserPromise;
  let remoteRun;
  const inspectCapacity = expectedLocal => {
    const db = new DatabaseSync(resourceDatabase, { readOnly: true });
    try {
      const local = db.prepare("SELECT name, runner, browser FROM holder WHERE name = 'gate'").all();
      const remote = db.prepare('SELECT name, runner, browser FROM holder WHERE runner = ?').all(HOST);
      assert.equal(db.prepare("SELECT capacity FROM resource WHERE name = 'gate'").get()?.capacity, 2);
      assert.equal(db.prepare("SELECT capacity FROM resource WHERE name = 'browser'").get()?.capacity, 1);
      const browserCount = local.filter(holder => holder.browser === 1).length;
      assert.ok(local.length <= 2, 'local gate holders stay within the real SQLite gate capacity');
      assert.ok(browserCount <= 1, 'local browser holders stay within the real SQLite browser capacity');
      assert.equal(local.length, expectedLocal);
      assert.equal(remote.length, 1, 'the remote runner holder remains independent of local capacity');
      assert.equal(remote[0].name, `runner:${HOST}`);
      return { local, remote, browserCount };
    } finally { db.close(); }
  };
  try {
    initialBrowser = await takePreRunnerResource({ name: 'gate', capacity: 2, scope: 'machine', root: repo,
      agent: 'pre-runner-initial-browser', item: 'pre-runner-initial-browser', kind: 'fixture-hold', browser: true });
    const remoteCode = `const fs=require('node:fs'); const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{ fs.writeFileSync(${JSON.stringify(remoteReady)}, 'ready\\n'); while(!fs.existsSync(${JSON.stringify(releaseRemote)})) await sleep(5); })().catch(error=>{console.error(error);process.exitCode=2});`;
    remoteRun = observe(startQueueController(repo, env, `node -e ${shellQuote(remoteCode)}`,
      { item: 'remote-capacity-holder', queueMarker: null, firstItem: null }));
    await waitForMarker(remoteReady);

    const heldBesideRemote = inspectCapacity(1);
    assert.equal(heldBesideRemote.browserCount, 1, 'the remote lease leaves the legacy local browser holder unchanged');

    initialBrowser.release();
    initialBrowser = null;
    localBrowser = await takePreRunnerResource({ name: 'gate', capacity: 2, scope: 'machine', root: repo,
      agent: 'pre-runner-browser-one', item: 'pre-runner-browser-one', kind: 'fixture-browser', browser: true });
    localCpu = await takePreRunnerResource({ name: 'gate', capacity: 2, scope: 'machine', root: repo,
      agent: 'pre-runner-cpu', item: 'pre-runner-cpu', kind: 'fixture-cpu' });
    secondBrowserPromise = takePreRunnerResource({ name: 'gate', capacity: 2, scope: 'machine', root: repo,
      agent: 'pre-runner-browser-two', item: 'pre-runner-browser-two', kind: 'fixture-browser', browser: true,
      onWait(state) {
        if (state.line?.some(waiter => waiter.item === 'pre-runner-browser-two')) {
          writeFileSync(secondBrowserQueued, 'queued\n');
        }
      },
    }).then(lease => {
      secondBrowser = lease;
      writeFileSync(secondBrowserAcquired, 'acquired\n');
      return lease;
    });
    await waitForMarker(secondBrowserQueued);
    assert.equal(existsSync(secondBrowserAcquired), false, 'a second local browser waits even while its first slot is held');

    const duringRemote = listPreRunnerResources({ scope: 'machine', root: repo });
    const localGate = duringRemote.find(resource => resource.name === 'gate');
    const runnerResource = duringRemote.find(resource => resource.name === `runner:${HOST}`);
    assert.equal(localGate.holders.length, 2, 'the old API admits one local browser and one local CPU lease');
    assert.equal(localGate.holders.filter(holder => holder.browser).length, 1);
    assert.equal(runnerResource.holders.length, 1, 'the registered runner remains held independently');
    assert.equal(inspectCapacity(2).browserCount, 1);
    assert.equal(existsSync(secondBrowserAcquired), false, 'local browser capacity remains one');

    localCpu.release();
    localCpu = null;
    localBrowser.release();
    localBrowser = null;
    await waitForMarker(secondBrowserAcquired);
    secondBrowser = await secondBrowserPromise;
    const afterHandoff = listPreRunnerResources({ scope: 'machine', root: repo });
    assert.equal(afterHandoff.find(resource => resource.name === 'gate').holders.length, 1);
    assert.equal(afterHandoff.find(resource => resource.name === `runner:${HOST}`).holders.length, 1,
      'the remote run is still live while the old API hands off the local browser slot');
    assert.equal(inspectCapacity(1).browserCount, 1);
    secondBrowser.release();
    secondBrowser = null;
    writeFileSync(releaseRemote, 'release\n');
    const completed = await remoteRun.closed;
    remoteRun = null;
    assert.equal(completed.status, 0, fixtureResultContext(completed));
    assert.equal(gateResult(completed.stdout).runner, HOST);
  } finally {
    for (const lease of [initialBrowser, localBrowser, localCpu, secondBrowser]) lease?.release();
    writeFileSync(releaseRemote, 'cleanup-release\n');
    if (secondBrowserPromise && !secondBrowser) {
      try { secondBrowser = await secondBrowserPromise; secondBrowser.release(); secondBrowser = null; } catch {}
    }
    if (remoteRun) {
      await remoteRun.closed;
    }
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
});

test('a queued run executes on a registered runner and its result comes back [C7] (parent death drains a detached worker descendant before releasing its lease)', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-parent-death-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const machineHome = join(home, '.pullboard');
  const remoteHome = join(dir, 'worker-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const remoteDatabase = join(remoteMachineHome, 'resources.sqlite');
  const repo = join(dir, 'repo');
  const worker = join(dir, 'second-machine');
  const bin = join(dir, 'bin');
  const requests = join(dir, 'ssh-requests.jsonl');
  const childReady = join(dir, 'detached-child-ready');
  const childPidFile = join(dir, 'detached-child-pid');
  const childTerm = join(dir, 'detached-child-term');
  const releaseChild = join(dir, 'release-detached-child');
  const childGone = join(dir, 'detached-child-gone');
  for (const folder of [repo, worker, bin, home, machineHome, remoteHome, remoteMachineHome]) {
    mkdirSync(folder, { recursive: true });
  }
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
  const env = {
    ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Parent Death Fixture', GIT_AUTHOR_EMAIL: 'parent-death@example.invalid',
    GIT_COMMITTER_NAME: 'Parent Death Fixture', GIT_COMMITTER_EMAIL: 'parent-death@example.invalid',
  };
  const initialized = runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.context);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(repo, 'tracked.txt'), 'parent-death runner fixture\n');
  writeFileSync(join(repo, 'remote-parent-death-launcher.js'), `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, [require.resolve('./remote-detached-child.js'), ...process.argv.slice(2)], {
  detached: true, stdio: 'ignore', env: process.env,
});
child.unref();
setInterval(() => {}, 1_000);
`);
  writeFileSync(join(repo, 'remote-detached-child.js'), `const { existsSync, writeFileSync } = require('node:fs');
const [ready, pidFile, term, release, gone] = process.argv.slice(2);
let handlingTerm = false;
process.on('SIGTERM', () => {
  if (handlingTerm) return;
  handlingTerm = true;
  writeFileSync(term, 'term\\n');
  const wait = setInterval(() => {
    if (!existsSync(release)) return;
    clearInterval(wait);
    writeFileSync(gone, 'gone\\n');
    process.exit(0);
  }, 5);
});
writeFileSync(pidFile, String(process.pid));
writeFileSync(ready, 'ready\\n');
setInterval(() => {}, 1_000);
`);
  git(repo, env, 'add', 'pullboard.json', 'tracked.txt', 'remote-parent-death-launcher.js', 'remote-detached-child.js');
  git(repo, env, 'commit', '-q', '-m', 'test: prepare committed detached-child launchers');
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests });
  const added = cli(repo, env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json');
  assert.equal(added.status, 0, added.context);

  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = home;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  let localHold;
  let remoteRun;
  let detachedPid;
  let remoteAgent;
  try {
    localHold = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo,
      agent: 'parent-death-local-holder', item: 'parent-death-local-holder', kind: 'fixture-hold', browser: true });
    const command = ['node remote-parent-death-launcher.js', ...[childReady, childPidFile, childTerm, releaseChild, childGone].map(shellQuote)].join(' ');
    remoteRun = observe(startQueueController(repo, env, command,
      { item: 'parent-death-remote-holder', queueMarker: null, firstItem: null }));
    await waitForMarker(childReady);
    detachedPid = Number(readFileSync(childPidFile, 'utf8').trim());
    assert.ok(Number.isSafeInteger(detachedPid) && detachedPid > 0);
    assert.notEqual(detachedPid, remoteRun.child.pid, 'the committed launcher owns a separate detached child');
    assert.equal(processIsAlive(detachedPid), true);
    const held = readRemoteGateHolders(remoteDatabase);
    assert.equal(held.length, 1, 'the remote worker keeps its physical gate holder while the launcher is live');
    remoteAgent = held[0].agent;
    assert.match(remoteAgent, /^pullboard-ssh-/u);

    remoteRun.child.kill('SIGTERM');
    await waitForMarker(childTerm);
    assert.equal(processIsAlive(detachedPid), true, 'the detached child remains alive in its controlled TERM handler');
    const duringDrain = readRemoteGateHolders(remoteDatabase);
    assert.equal(duringDrain.length, 1);
    assert.equal(duringDrain[0].agent, remoteAgent, 'the physical runner lease remains held during descendant cleanup');

    writeFileSync(releaseChild, 'release\n');
    await waitForMarker(childGone);
    await waitForCondition(() => !processIsAlive(detachedPid), 'the detached child PID exits');
    await waitForCondition(() => readRemoteGateHolders(remoteDatabase).every(holder => holder.agent !== remoteAgent),
      'the remote physical gate holder is released after child exit');
    const controller = await remoteRun.closed;
    remoteRun = null;
    assert.equal(controller.signal, 'SIGTERM', 'the owned API controller alone received SIGTERM');
  } finally {
    if (localHold) localHold.release();
    writeFileSync(releaseChild, 'cleanup-release\n');
    if (remoteRun && remoteRun.child.exitCode === null && remoteRun.child.signalCode === null) {
      remoteRun.child.kill('SIGTERM');
    }
    if (detachedPid && processIsAlive(detachedPid)) {
      try { process.kill(detachedPid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (remoteRun) await remoteRun.closed;
    if (detachedPid) await waitForCondition(() => !processIsAlive(detachedPid), 'fixture detached child cleanup');
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
});

test('a queued run executes on a registered runner and its result comes back [C7] (unverified cleanup times out as a named red result)', { timeout: 90_000 }, async (t) => { // budget: bounded 30-second remote cleanup timeout plus startup, transport and fixture cleanup ceiling.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-cleanup-timeout-')));
  const home = join(dir, 'home');
  const machineHome = join(home, '.pullboard');
  const remoteHome = join(dir, 'worker-home');
  const remoteStateRoot = join(remoteHome, '.pullboard-runner');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const remoteDatabase = join(remoteMachineHome, 'resources.sqlite');
  const repo = join(dir, 'repo');
  const worker = join(dir, 'second-machine');
  const bin = join(dir, 'bin');
  const requests = join(dir, 'ssh-requests.jsonl');
  const bodyRan = join(remoteStateRoot, 'cleanup-timeout-body-ran');
  const starts = join(dir, 'ssh-starts.jsonl');
  let commandChild;
  t.after(async () => {
    if (commandChild && commandChild.exitCode === null && commandChild.signalCode === null) {
      try { process.kill(-commandChild.pid, 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') t.diagnostic(`fixture process-group cleanup: ${error.message}`); }
      await once(commandChild, 'close').catch(error => t.diagnostic(`fixture child close: ${error.message}`));
    }
    if (existsSync(remoteDatabase)) {
      try { await waitForCondition(() => readRemoteGateHolders(remoteDatabase).length === 0,
        'fixture remote physical gate holder cleanup'); }
      catch (error) { t.diagnostic(error.message); }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  for (const folder of [repo, worker, bin, home, machineHome, remoteHome, remoteStateRoot, remoteMachineHome]) {
    mkdirSync(folder, { recursive: true });
  }
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
  const env = {
    ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Runner Cleanup Fixture', GIT_AUTHOR_EMAIL: 'runner-cleanup@example.invalid',
    GIT_COMMITTER_NAME: 'Runner Cleanup Fixture', GIT_COMMITTER_EMAIL: 'runner-cleanup@example.invalid',
  };
  const initialized = runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.context);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'node runner-cleanup-timeout.js' }));
  writeFileSync(join(repo, 'tracked.txt'), 'cleanup timeout fixture\n');
  writeFileSync(join(repo, 'runner-cleanup-timeout.js'), `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const option = /(?:^|\\s)--import=(?:"([^"]+)"|'([^']+)'|(\\S+))/u.exec(process.env.NODE_OPTIONS || '');
if (!option) throw new Error('runner preload path was not passed to the committed job');
const preload = fileURLToPath(option[1] || option[2] || option[3]);
const runDirectory = dirname(preload);
const journalDirectory = join(runDirectory, 'child-journal');
const runnerRoot = dirname(dirname(runDirectory));
if (!existsSync(journalDirectory)) throw new Error('private child journal is missing');
mkdirSync(runnerRoot, { recursive: true });
writeFileSync(join(journalDirectory, 'overflow'), 'fixture journal overflow\\n');
writeFileSync(join(runnerRoot, 'cleanup-timeout-body-ran'), 'ran\\n');
console.log('RUNNER_CLEANUP_TIMEOUT_BODY_RAN');
`);
  git(repo, env, 'add', 'pullboard.json', 'tracked.txt', 'runner-cleanup-timeout.js');
  git(repo, env, 'commit', '-q', '-m', 'test: prepare runner cleanup timeout fixture');
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests, starts });
  const added = cli(repo, env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json');
  assert.equal(added.status, 0, added.context);

  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = home;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  let held;
  try {
    held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo,
      agent: 'cleanup-timeout-local-holder', item: 'cleanup-timeout-local-holder', kind: 'fixture-hold', browser: true });
    // The real CLI must refuse this one response as RUNNER_CLEANUP_TIMEOUT; a missing or
    // incomplete transport result would take the retry path and could incorrectly run locally.
    commandChild = startToolingCli(repo, env, ['gate', '--json'], { detached: true });
    const command = observe(commandChild);
    const completed = await command.closed;
    assert.equal(completed.status, 1, `${completed.stderr}\n${completed.stdout}`);
    const response = JSON.parse(completed.stdout.trim());
    assert.equal(response.error?.code, 'RUNNER_CLEANUP_TIMEOUT', JSON.stringify(response));
    assert.match(response.error.message, /child spawn journal overflow or write failure/u,
      'the named refusal retains the worker reason instead of losing it at the controller');
    const jobId = /inspect job ([A-Za-z0-9_-]+)/u.exec(response.error.message)?.[1];
    assert.ok(jobId, 'the refusal identifies the exact failed job for inspection');
    const retained = readdirSync(join(remoteStateRoot, 'jobs')).find(name => name.startsWith(jobId + '-'));
    assert.ok(retained, 'a cleanup timeout retains its private job diagnostics');
    const diagnosis = JSON.parse(readFileSync(join(remoteStateRoot, 'jobs', retained, 'cleanup-timeout.json'), 'utf8'));
    assert.equal(diagnosis.id, jobId);
    assert.match(diagnosis.reason, /child spawn journal overflow or write failure/u);
    assert.ok(diagnosis.stage, 'the timeout records which cleanup step was running');
    assert.ok(existsSync(bodyRan), 'the committed command ran to completion and wrote its own overflow marker');
    assert.equal(readFileSync(starts, 'utf8').trim().split('\n').length, 1, 'the refused cleanup result is not retried or sent to a local runner');
    await waitForCondition(() => readRemoteGateHolders(remoteDatabase).length === 0,
      'remote physical gate holder releases after the named cleanup timeout');
    assert.equal(readRemoteGateHolders(join(machineHome, 'resources.sqlite')).length, 1,
      'the separate local fixture holder remains intact until explicitly released');
  } finally {
    if (commandChild && commandChild.exitCode === null && commandChild.signalCode === null) {
      try { process.kill(-commandChild.pid, 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      await once(commandChild, 'close').catch(() => {});
    }
    if (held) held.release();
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
});
