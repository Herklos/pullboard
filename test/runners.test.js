/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
import assert from 'node:assert/strict';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { takeResource } from '../src/resources.js';
import { runFixtureChild, startFixtureChild } from './fixture-child.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const TEMP = [];
const SECRET = ['fixture', 'runner', 'secret', 'must', 'stay', 'local'].join('-');
const HOST = 'fixture-host';

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

/** Spawn the exact checked-in CLI from a fixture checkout. */
function cli(repo, env, ...args) {
  return runFixtureChild(process.execPath, [BIN, ...args], { cwd: repo, env, encoding: 'utf8' });
}

/** Make a local ssh stand-in that executes the actual worker command in a second private machine. */
function installSshStandIn({ bin, worker, home, machineHome, requests, nodeCommand = 'node', dropFirst = false, dropAfterMarker }) {
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
${dropFirst ? `if (host.endsWith('-drop') && call === 1) {
  process.stdin.resume(); process.stdin.on('end', () => {
    record({ dropped: true, stdinBytes, stdinSha256: stdinHash.digest('hex') }); process.exit(255);
  });
} else` : ''} {
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR,
    PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
  // Replace the marker-driven shell so the injected HUP reaches the actual worker process.
  const child = spawn('/bin/sh', ['-c', dropAfterMarker ? 'exec ' + remoteCommand : remoteCommand], { cwd: worker, env,
    stdio: ['pipe', 'inherit', 'inherit'] });
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
function writeProbe(repo, { remoteStateRoot, remoteMachineHome, sourceHome, sourceMachineHome, callerPool, callerToken }) {
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
  assert.equal(shallow, 'true');
  assert.equal(count, '1', 'the worker has the selected commit without history');
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
    gateToken: process.env.PULLBOARD_GATE_SLOT_TOKEN, browser: process.env.PULLBOARD_BROWSER_SLOT_HELD }));
});
`;
  writeFileSync(join(repo, 'runner-probe.test.js'), probe);
}

/** Build a committed probe for the cache copy of one local workspace dependency. */
function writeCacheProbe(repo, { remoteStateRoot, nodePath }) {
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
  const committed = execFileSync('git', ['show', 'HEAD:packages/runner-fixture-dep/witness.txt'], { encoding: 'utf8' });
  assert.equal(readFileSync('node_modules/.runner-cache-witness', 'utf8'), committed);
  const link = readlinkSync('node_modules/runner-fixture-dep');
  assert.equal(isAbsolute(link), false, 'the cached workspace symlink stays relative');
  const target = realpathSync(join(root, 'node_modules/runner-fixture-dep'));
  assert.equal(target, join(root, 'packages/runner-fixture-dep'));
  const targetRelative = relative(root, target);
  assert.ok(targetRelative && !targetRelative.startsWith('..' + sep) && targetRelative !== '..');
  console.log('RUNNER_CACHE_FACT ' + JSON.stringify({ root, link, target, commit, tree }));
});
`;
  writeFileSync(join(repo, 'runner-cache-probe.test.js'), probe);
}

/** Run a gate command through its real lease and return the profile/result emitted by the API child. */
function runThroughGate(repo, env, command, { browser = true, item = '663', kind = 'check' } = {}) {
  const gateUrl = new URL('../src/gate.js', import.meta.url).href;
  const script = `const { runProfiledShell, withGateSlot } = await import(${JSON.stringify(gateUrl)});
const result = await withGateSlot(${JSON.stringify(repo)}, lease => runProfiledShell(${JSON.stringify(repo)}, ${JSON.stringify(command)}, { gateLease: lease }),
  { browser: ${browser}, item: ${JSON.stringify(item)}, kind: ${JSON.stringify(kind)}, agent: 'runner-fixture' });
process.stdout.write(result.output);
process.stdout.write('PULLBOARD_RUN_RESULT ' + JSON.stringify({ isGreen: result.isGreen, runner: result.profile.executionRunner, profile: result.profile }) + '\\n');
process.exitCode = result.isGreen ? 0 : 1;
`;
  return runFixtureChild(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repo, env, encoding: 'utf8',
  });
}

/** Parse the bounded final API line without rewriting the command's raw TAP output. */
function gateResult(stdout) {
  const line = stdout.split(/\r?\n/u).findLast(value => value.startsWith('PULLBOARD_RUN_RESULT '));
  assert.ok(line, stdout);
  return JSON.parse(line.slice('PULLBOARD_RUN_RESULT '.length));
}

/** Read the remote machine's live gate holders without changing its shared admission state. */
function readRemoteGateHolders(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
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

/** Wait for the stand-in to record a particular invocation count, not for elapsed time. */
async function waitForRequestCount(path, count) {
  if (existsSync(path) && readFileSync(path, 'utf8').trim().split('\n').length >= count) return;
  const watcher = watch(dirname(path), { persistent: false });
  let timer;
  try {
    const hasCount = () => existsSync(path) && readFileSync(path, 'utf8').trim().split('\n').length >= count;
    const changed = new Promise((resolve, reject) => {
      const check = (_event, filename) => {
        if ((filename === null || String(filename) === basename(path)) && hasCount()) resolve();
      };
      watcher.on('change', check);
      watcher.once('error', reject);
      check('change', basename(path));
    });
    if (hasCount()) return;
    await Promise.race([changed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`runner request ${count} did not arrive`)), 20_000); // budget: hang ceiling for the fake SSH request handshake.
    })]);
  } finally { clearTimeout(timer); watcher.close(); }
}

/** Start an API child that requeues only an incomplete runner transport on its original ticket. */
function startQueueController(repo, env, command, { item, queueMarker, firstItem = 'retry-first', remote = true } = {}) {
  const gateUrl = new URL('../src/gate.js', import.meta.url).href;
  const script = `import { writeFileSync } from 'node:fs';
const { runProfiledShell, withGateSlot } = await import(${JSON.stringify(gateUrl)});
const root = ${JSON.stringify(repo)};
const command = ${JSON.stringify(command)};
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
  return startFixtureChild(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Observe a running fixture child without hiding stdout, stderr, or its exit status. */
function observe(child) {
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', part => { stdout += part; });
  child.stderr.setEncoding('utf8').on('data', part => { stderr += part; });
  const closed = once(child, 'close').then(([status, signal]) => ({ status, signal, stdout, stderr }));
  return { child, closed };
}

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
  writeFileSync(join(repo, '.gitignore'), '.env\n');
  git(repo, env, 'add', '.gitignore', 'pullboard.json', 'tracked.txt');
  git(repo, env, 'commit', '-q', '-m', 'test: prepare registered runner fixture');
  writeFileSync(join(repo, '.env'), SECRET);
  const commit = git(repo, env, 'rev-parse', 'HEAD');
  const tree = git(repo, env, 'rev-parse', 'HEAD^{tree}');
  assert.equal(git(repo, env, 'status', '--porcelain'), '', 'the ignored secret is not a dirty tracked change');

  const ssh = installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests });
  assert.ok(existsSync(ssh));
  writeProbe(repo, { remoteStateRoot, remoteMachineHome, sourceHome: home, sourceMachineHome: machineHome,
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
    const successful = runThroughGate(repo, env, 'node --test runner-probe.test.js');
  assert.equal(successful.status, 0, successful.context);
  assert.match(successful.stdout, /TAP version 13/);
  assert.match(successful.stdout, /RUNNER_FACT /);
  const fact = JSON.parse(/RUNNER_FACT (\{[^\n]+\})/u.exec(successful.stdout)?.[1] ?? 'null');
  assert.equal(fact.commit, selectedCommit);
  assert.equal(fact.tree, selectedTree);
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

  const red = runThroughGate(repo, env, "node -e 'process.stdout.write(\"RUNNER_EXIT_7\\n\"); process.exit(7)'");
  assert.equal(red.status, 1, red.context);
  assert.match(red.stdout, /RUNNER_EXIT_7/);
  const redResult = gateResult(red.stdout);
  assert.equal(redResult.isGreen, false);
  assert.equal(redResult.runner, HOST);
  const callsAfterExit7 = readFileSync(requests, 'utf8').trim().split('\n').length;
  assert.equal(callsAfterExit7, 2, 'a complete exit-7 receipt is a test failure, not a dropped-run retry');

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
    await waitForRequestCount(requests, 1);
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

test('a queued run executes on a registered runner and its result comes back [C7] (cached workspace dependencies stay linked to fresh checkouts)', async (t) => {
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
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(repo, 'package.json'), JSON.stringify({
    name: 'runner-cache-fixture', version: '1.0.0', private: true, type: 'module',
    workspaces: ['packages/runner-fixture-dep'], dependencies: { 'runner-fixture-dep': '1.0.0' },
  }, null, 2) + '\n');
  writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({
    name: 'runner-fixture-dep', version: '1.0.0', type: 'module', scripts: { postinstall: 'node postinstall.js' },
  }, null, 2) + '\n');
  writeFileSync(join(packageDirectory, 'witness.txt'), 'committed workspace witness\n');
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
  git(repo, env, 'add', '.gitignore', 'pullboard.json', 'package.json', 'package-lock.json', 'packages/runner-fixture-dep');
  git(repo, env, 'commit', '-q', '-m', 'test: prepare cached local workspace dependency');
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
    const command = 'node --test runner-cache-probe.test.js';
    writeCacheProbe(repo, { remoteStateRoot, nodePath: process.execPath });
    git(repo, env, 'add', 'runner-cache-probe.test.js');
    git(repo, env, 'commit', '-q', '-m', 'test: assert cache symlink stays job-local');
    const cacheCommit = git(repo, env, 'rev-parse', 'HEAD');
    const cacheTree = git(repo, env, 'rev-parse', 'HEAD^{tree}');
    const first = runThroughGate(repo, env, command, { item: 'cache-first' });
    assert.equal(first.status, 0, first.context);
    const firstFact = JSON.parse(/RUNNER_CACHE_FACT (\{[^\n]+\})/u.exec(first.stdout)?.[1] ?? 'null');
    assert.equal(firstFact.commit, cacheCommit);
    assert.equal(firstFact.tree, cacheTree);
    assert.equal(firstFact.root, firstFact.target.slice(0, firstFact.target.indexOf('/packages/runner-fixture-dep')));
    assert.equal(gateResult(first.stdout).runner, HOST);
    assert.equal(readFileSync(installWitnesses, 'utf8'), 'postinstall\n', 'the first exact-tree run installs the committed workspace dependency');

    const second = runThroughGate(repo, env, command, { item: 'cache-second' });
    assert.equal(second.status, 0, second.context);
    const secondFact = JSON.parse(/RUNNER_CACHE_FACT (\{[^\n]+\})/u.exec(second.stdout)?.[1] ?? 'null');
    assert.equal(secondFact.commit, cacheCommit);
    assert.equal(secondFact.tree, cacheTree);
    assert.equal(gateResult(second.stdout).runner, HOST);
    assert.equal(secondFact.root, secondFact.target.slice(0, secondFact.target.indexOf('/packages/runner-fixture-dep')));
    assert.notEqual(firstFact.root, secondFact.root, 'each run unpacks a fresh checkout');
    assert.equal(git(repo, env, 'rev-parse', 'HEAD'), cacheCommit);
    assert.equal(git(repo, env, 'rev-parse', 'HEAD^{tree}'), cacheTree);
    assert.equal(readFileSync(installWitnesses, 'utf8'), 'postinstall\n', 'the second run reuses the dependency cache without a second install witness');
    const requestsSeen = readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(requestsSeen.length, 2);
    assert.ok(requestsSeen.every(request => request.remoteStartsWithConfiguredNode), 'both remote workers use the configured absolute Node path');
  } finally {
    if (held) held.release();
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
});
