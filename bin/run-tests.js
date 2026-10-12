#!/usr/bin/env node
/**
 * Run the test suite with a private home, no inherited Git identity or config, and a refusing CLI shim.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { after, afterEach, beforeEach } from 'node:test';
import { Worker } from 'node:worker_threads';
import { AGENT_SHELL_MARKERS, SSH_SHELL_MARKERS } from '../src/person.js';

const runner = fileURLToPath(import.meta.url);
export const DEFAULT_TEST_TIMEOUT_MS = 660_000;
export const DEFAULT_TEST_FILE_TIMEOUT_MS = 30_000;

const watchdogSource = `
const { parentPort } = require('node:worker_threads');
const { writeSync } = require('node:fs');
const timers = new Map();
parentPort.on('message', (message) => {
  if (message.type === 'stop') {
    const active = timers.get(message.id);
    if (active) {
      clearTimeout(active.timer);
      if (active.probe) clearTimeout(active.probe);
    }
    timers.delete(message.id);
    return;
  }
  if (message.type === 'file-diagnostic-update') {
    const active = timers.get(message.id);
    if (active) {
      active.handles = message.handles;
      active.observedAt = message.observedAt;
      active.updated = true;
    }
    return;
  }
  if (message.type === 'start-file') {
    const active = { handles: message.handles, observedAt: Date.now(), updated: false, timer: null, probe: null };
    active.probe = setTimeout(() => {
      parentPort.postMessage({ type: 'file-diagnostic-request', id: message.id });
    }, Math.max(0, message.timeoutMs - 50));
    active.timer = setTimeout(() => {
      const ports = active.handles.ports.length ? active.handles.ports.join(', ') : 'none';
      const handles = active.handles.types.length ? active.handles.types.join(', ') : 'none';
      const ageMs = Date.now() - active.observedAt;
      const freshness = active.updated ? 'latest responsive snapshot' : 'fallback; main thread did not answer';
      writeSync(2, 'run-tests: test file "' + message.file + '" failed: its process did not exit within ' +
        message.timeoutMs + 'ms file-exit timeout; listening ports: ' + ports + '; live handles: ' + handles +
        '; live-handle snapshot age: ' + ageMs + 'ms (' + freshness + ')\\n');
      try { process.kill(message.pid, 'SIGKILL'); } catch { /* The timed-out test-file process already exited. */ }
    }, message.timeoutMs);
    timers.set(message.id, active);
    return;
  }
  if (message.type !== 'start') return;
  const startedAt = Date.now();
  const timer = setTimeout(() => {
    const elapsedMs = Date.now() - startedAt;
    writeSync(2, 'run-tests: test "' + message.name + '" in ' + message.file +
      ' failed: it ran ' + (elapsedMs / 1000).toFixed(1) + 's, past the ' +
      message.timeoutMs + 'ms per-test timeout\\n');
    try { process.kill(message.pid, 'SIGKILL'); } catch { /* The timed-out test process already exited. */ }
  }, message.timeoutMs);
  timers.set(message.id, { timer });
});
`;

/**
 * Read the per-test timeout and reject malformed overrides before tests start.
 *
 * @param {string | undefined} value
 * @returns {number}
 */
function testTimeoutMs(value = process.env.PULLBOARD_TEST_TIMEOUT_MS) {
  if (value === undefined) return DEFAULT_TEST_TIMEOUT_MS;
  if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 2_147_483_647) {
    throw new Error('PULLBOARD_TEST_TIMEOUT_MS must be a positive integer no greater than 2147483647 milliseconds');
  }
  return Number(value);
}

/** Read the per-file exit ceiling so a completed file cannot keep the gate open. */
function testFileTimeoutMs(value = process.env.PULLBOARD_TEST_FILE_TIMEOUT_MS) {
  if (value === undefined) return DEFAULT_TEST_FILE_TIMEOUT_MS;
  if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 2_147_483_647) {
    throw new Error('PULLBOARD_TEST_FILE_TIMEOUT_MS must be a positive integer no greater than 2147483647 milliseconds');
  }
  return Number(value);
}

/** Describe listening ports and live handle types when the test-file exit ceiling expires. */
function activeHandleSummary() {
  const handles = process._getActiveHandles();
  const ports = [];
  const types = [];
  for (const handle of handles) {
    const type = handle?.constructor?.name ?? 'Unknown';
    types.push(type);
    if (typeof handle?.address !== 'function' || !handle.listening) continue;
    try {
      const address = handle.address();
      if (address && typeof address === 'object' && typeof address.port === 'number') {
        ports.push(`${address.address}:${address.port}`);
      }
    } catch { /* A handle may close while its diagnostic is collected. */ }
  }
  return { ports: [...new Set(ports)].slice(0, 20), types: [...new Set(types)].slice(0, 20) };
}

/**
 * Keep an independent watchdog for every active test in this test-file process.
 *
 * @returns {void}
 */
function installTestWatchdog() {
  const timeoutMs = testTimeoutMs();
  const fileTimeoutMs = testFileTimeoutMs();
  const file = process.env.PULLBOARD_TEST_FILE ?? process.argv[1] ?? '<unknown test file>';
  const watchdog = new Worker(watchdogSource, { eval: true });
  watchdog.on('message', (message) => {
    if (message.type !== 'file-diagnostic-request') return;
    watchdog.postMessage({
      type: 'file-diagnostic-update', id: message.id,
      handles: activeHandleSummary(), observedAt: Date.now(),
    });
  });
  // Message listeners ref the worker port; unref only after installing the diagnostic listener.
  watchdog.unref();
  const activeTests = new WeakMap();
  const runningTests = new Set();
  const fileId = `${process.pid}:file`;
  let fileWatchdogArmed = false;
  let nextTestId = 0;

  beforeEach((context) => {
    if (fileWatchdogArmed) {
      watchdog.postMessage({ type: 'stop', id: fileId });
      fileWatchdogArmed = false;
    }
    const id = `${process.pid}:${++nextTestId}`;
    const name = String(context.name).replace(/[\r\n\t\u0000-\u001f]/gu, ' ').slice(0, 200);
    activeTests.set(context, id);
    runningTests.add(id);
    watchdog.postMessage({ type: 'start', id, name, file, timeoutMs, pid: process.pid });
  });

  afterEach((context) => {
    const id = activeTests.get(context);
    if (id !== undefined) {
      watchdog.postMessage({ type: 'stop', id });
      runningTests.delete(id);
    }
    // A suite's after hooks run before root after; start the idle ceiling here.
    if (runningTests.size === 0) armFileExitWatchdog();
  });

  /** Bound cleanup between completed tests, cancelling the ceiling when another test starts. */
  function armFileExitWatchdog() {
    if (fileWatchdogArmed) return;
    fileWatchdogArmed = true;
    watchdog.postMessage({
      type: 'start-file', id: fileId, file,
      timeoutMs: fileTimeoutMs, pid: process.pid, handles: activeHandleSummary(),
    });
  }

  after(armFileExitWatchdog);
}

/** Quote a path for the private Git shim without interpreting shell metacharacters. */
function shellWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * Build a private environment that makes local tests fail for the same missing Git and CLI setup as CI.
 *
 * @param {string} sandbox
 * @returns {NodeJS.ProcessEnv}
 */
function testEnvironment(sandbox) {
  const home = join(sandbox, 'home');
  const shims = join(sandbox, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(shims, { recursive: true });
  const refusal = join(shims, 'pullboard');
  writeFileSync(refusal, '#!/bin/sh\nprintf "pullboard is not installed; current test: %s\\n" "${PULLBOARD_TEST_FILE:-unknown}" >&2\nexit 1\n');
  chmodSync(refusal, 0o755);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/u)[0];
  const git = join(shims, 'git');
  writeFileSync(git, `#!/bin/sh\nexec ${shellWord(realGit)} -c user.useConfigOnly=true "$@"\n`);
  chmodSync(git, 0o755);

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  // Model a plain user terminal; person-boundary tests inject agent markers explicitly.
  for (const key of AGENT_SHELL_MARKERS) delete env[key];
  for (const key of SSH_SHELL_MARKERS) delete env[key];
  env.HOME = home;
  env.USERPROFILE = home;
  env.PULLBOARD_HOME = home;
  env.PULLBOARD_MODEL = 'Test Model';
  env.PULLBOARD_MACHINE_HOME = join(sandbox, 'machine');
  env.TMPDIR = sandbox;
  env.TMP = sandbox;
  env.TEMP = sandbox;
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_COUNT = '3';
  env.GIT_CONFIG_KEY_0 = 'user.useConfigOnly';
  env.GIT_CONFIG_VALUE_0 = 'true';
  env.GIT_CONFIG_KEY_1 = 'gc.auto';
  env.GIT_CONFIG_VALUE_1 = '0';
  env.GIT_CONFIG_KEY_2 = 'maintenance.auto';
  env.GIT_CONFIG_VALUE_2 = 'false';
  env.PATH = [shims, process.env.PATH].filter(Boolean).join(delimiter);
  delete env.PULLBOARD_RELAY_TOKEN; // Fixtures must supply their own scoped credentials, never an agent’s live bearer.
  delete env.NODE_TEST_CONTEXT;
  delete env.PULLBOARD_TEST_FILE;
  return env;
}

/**
 * Start the Node test runner and return its result to the caller for faithful exit handling.
 *
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runTests(args, env) {
  const reporter = args.some((argument) => argument === '--test-reporter' || argument.startsWith('--test-reporter='));
  const nodeArgs = [
    '--disable-warning=ExperimentalWarning',
    '--test',
    ...(!reporter ? ['--test-reporter=tap'] : []),
    '--import',
    runner,
    ...args,
  ];
  return spawnSync(process.execPath, nodeArgs, { env, stdio: 'inherit' });
}

let nodeOptionsWithValues;

/** Read Node option arity from this runtime so supported option values cannot bypass the machine pool. */
function optionTakesValue(argument) {
  if (!nodeOptionsWithValues) {
    nodeOptionsWithValues = new Set();
    const help = execFileSync(process.execPath, ['--help'], { encoding: 'utf8' });
    for (const line of help.split(/\r?\n/u)) {
      const signature = line.match(/^  (-\S.*?)(?: {2,}|$)/u)?.[1];
      if (!signature || !signature.includes('=') || signature.includes('[=')) continue;
      for (const option of signature.matchAll(/--?[A-Za-z][A-Za-z0-9-]*/gu)) nodeOptionsWithValues.add(option[0]);
    }

  }
  return nodeOptionsWithValues.has(argument.replaceAll('_', '-'));
}

/** Distinguish file selection from option values so filtered discovery still takes a full-suite slot. */
function hasTestFiles(args) {
  let takesValue = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (takesValue) { takesValue = false; continue; }
    if (argument === '--') return index < args.length - 1;
    if (argument.startsWith('-')) {
      if (!argument.includes('=')) takesValue = optionTakesValue(argument);
      continue;
    }
    return true;
  }
  return false;
}

/** Match Node's default test-file patterns against a Git path for this runtime. */
function isDefaultTestFile(path, includeTypeScript) {
  const normalized = path.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (parts.some(part => part === 'node_modules' || part.startsWith('.'))) return false;
  const basename = parts.at(-1);
  const extension = includeTypeScript ? /\.(?:cjs|mjs|js|cts|mts|ts)$/u : /\.(?:cjs|mjs|js)$/u;
  if (!extension.test(basename)) return false;
  return parts.slice(0, -1).includes('test') ||
    /^test(?:-|\.)/u.test(basename) ||
    (includeTypeScript
      ? /(?:\.test|-test|_test)\.(?:cjs|mjs|js|cts|mts|ts)$/u
      : /(?:\.test|-test|_test)\.(?:cjs|mjs|js)$/u).test(basename);
}

/** Probe the effective TypeScript mode of the Node child that will execute tests. */
function typeScriptTestDiscovery(args, env) {
  const typeFlags = args.filter(argument => [
    '--experimental-strip-types', '--strip-types', '--experimental-transform-types',
    '--no-experimental-strip-types', '--no-strip-types',
  ].includes(argument));
  const result = spawnSync(process.execPath, [...typeFlags, '-p', 'String(process.features?.typescript ?? false)'], {
    cwd: process.cwd(), encoding: 'utf8', env, timeout: 5_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Node could not report TypeScript test discovery mode (status ${result.status}, signal ${result.signal ?? 'none'}): ${result.stderr.trim()}`);
  }
  return !['false', 'undefined', ''].includes(result.stdout.trim());
}

/** Preserve native discovery outside Git, but never hide a repository access failure. */
function isGitWorkTree(cwd, env) {
  const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd, env: { ...env, LC_ALL: 'C' }, encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status === 0) return result.stdout.trim() === 'true';
  if (result.status === 128 && /^fatal: not a git repository \(or any /u.test(result.stderr)) return false;
  throw new Error(result.stderr.trim() || `git rev-parse failed (status ${result.status})`);
}

/** List tracked files matching Node's runtime default patterns, excluding worktree copies. */
function trackedDefaultTestFiles(cwd, includeTypeScript, env) {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd, env, encoding: 'utf8' });
  return output.split('\0').filter(path => path && isDefaultTestFile(path, includeTypeScript)).sort()
    .map(path => `./${path}`);
}

/** Translate the runner's shard option to Node's native test-shard option, refusing malformed ranges. */
function shardArguments(args) {
  const forwarded = [];
  let shard;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') {
      forwarded.push(...args.slice(index));
      break;
    }
    if (argument === '--shard' || argument.startsWith('--shard=')) {
      if (shard !== undefined) return { error: `duplicate --shard; expected one <i>/<n> value` };
      shard = argument === '--shard' ? args[++index] : argument.slice('--shard='.length);
      if (shard === undefined) return { error: '--shard requires a value; expected <i>/<n> with 1 <= i <= n' };
      continue;
    }
    forwarded.push(argument);
  }
  if (shard === undefined) return { args: forwarded };
  const match = shard.match(/^([1-9][0-9]*)\/([1-9][0-9]*)$/u);
  const index = match ? Number(match[1]) : NaN;
  const total = match ? Number(match[2]) : NaN;
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index > total) {
    return { error: `invalid --shard value "${shard}"; expected <i>/<n> with 1 <= i <= n` };
  }
  return { args: [`--test-shard=${shard}`, ...forwarded] };
}

/** Run tests in the disposable environment, preserving a marker only when a parent holds the slot. */
function executeTests(args, sandbox, gateSlotHeld, fullSuite) {
  const env = testEnvironment(sandbox);
  if (gateSlotHeld) env.PULLBOARD_GATE_SLOT_HELD = '1';
  let selectedArgs = args;
  if (fullSuite) {
    let files;
    try {
      files = isGitWorkTree(process.cwd(), env)
        ? trackedDefaultTestFiles(process.cwd(), typeScriptTestDiscovery(args, env), env)
        : null;
    }
    catch (error) {
      process.stderr.write(`run-tests: could not list tracked test files: ${error.message}\n`);
      process.exitCode = 1;
      return { status: 1, signal: null };
    }
    if (files?.length === 0) {
      process.stderr.write('run-tests: no tracked Node test files found; refusing filesystem discovery\n');
      process.exitCode = 1;
      return { status: 1, signal: null };
    }
    if (files) selectedArgs = [...args, ...files];
  }
  const result = runTests(selectedArgs, env);
  if (result.error) throw result.error;
  return result;
}

/**
 * Launch Node's test runner in a disposable environment and remove it after the run ends.
 *
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function main(args) {
  try {
    testTimeoutMs();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const sharding = shardArguments(args);
  if (sharding.error) {
    process.stderr.write(`run-tests: ${sharding.error}\n`);
    process.exitCode = 1;
    return;
  }
  args = sharding.args;
  const fullSuite = !hasTestFiles(args);
  const inheritedSlot = process.env.PULLBOARD_GATE_SLOT_HELD === '1';
  let signal = null;
  /** Keep sandbox lifetime inside the held lease, including the complete child process. */
  const run = (gateSlotHeld) => {
    const sandbox = mkdtempSync(join(tmpdir(), 'pullboard-test-run-'));
    try {
      const result = executeTests(args, sandbox, gateSlotHeld, fullSuite);
      signal = result.signal;
      process.exitCode = result.status ?? 1;
    } finally { rmSync(sandbox, { recursive: true, force: true }); }
  };
  if (!fullSuite || inheritedSlot) run(inheritedSlot);
  else {
    // Focused and preload-only copies do not need the queue's repository dependencies.
    const [{ withGateSlot }, { loadMachineSettings }] = await Promise.all([
      import('../src/gate.js'), import('../src/settings.js'),
    ]);
    const capacity = loadMachineSettings().gateSlots;
    let announced = false;
    await withGateSlot(process.cwd(), () => run(true), {
      onWait: ({ holders }) => {
        if (announced) return;
        announced = true;
        process.stderr.write(`waiting for a gate slot: ${holders.length} of ${capacity} in use\n`);
      },
    });
  }
  if (signal) process.kill(process.pid, signal);
}

if (process.argv[1] && resolve(process.argv[1]) === runner) {
  await main(process.argv.slice(2));
} else if (process.argv[1]) {
  process.env.PULLBOARD_TEST_FILE = process.argv[1];
  installTestWatchdog();
}
