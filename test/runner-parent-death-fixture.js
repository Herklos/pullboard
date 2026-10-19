/** Exercise actual remote parent-death custody, optionally forcing a real release write conflict [C7]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { takeResource } from '../src/resources.js';
import { runFixtureChild } from './fixture-child.js';
import { readRemoteGateHolders, waitForCondition } from './runner-fixture-state.js';

/**
 * Keep the original custody assertions identical in ordinary and forced ordering cases: `holdRelease` forces a real
 * release write conflict, `chatty` makes the command keep writing output, so some always arrives after the
 * transport drops (#888: a forwarded write then waited forever for a drain from a destroyed stdout), and `epermOnce`
 * makes the worker's repeat signal to one process group answer EPERM, as macOS did when the command group finished
 * exiting during the TERM grace loop (#888); the launcher lingers 300 ms after TERM so that repeat signal is sent.
 */
export async function parentDeathDrainFixture(t, tools, { holdRelease = false, chatty = false, epermOnce = false } = {}) {
  const { cli, git, installSshStandIn, observe, startQueueController, waitForMarker, processIsAlive, shellQuote, HOST } = tools;
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
  const workerLog = join(dir, 'worker-stderr.log');
  const epermAnswered = join(dir, 'eperm-answered');
  let releaseLock;
  /** The worker's own account of a stalled release: its runner status lines and any cleanup files in its private job (#888). */
  function workerCleanupReport() {
    const lines = existsSync(workerLog) ? readFileSync(workerLog, 'utf8').split('\n')
      .filter(line => /^PULLBOARD_RUNNER_(?!HEARTBEAT)[A-Z_]+ /u.test(line)).slice(-20) : [];
    const jobs = join(remoteHome, '.pullboard-runner', 'jobs');
    const files = {};
    for (const job of existsSync(jobs) ? readdirSync(jobs) : []) {
      for (const name of ['cleanup-timeout.json', 'release-pending.json']) {
        const file = join(jobs, job, name);
        if (existsSync(file)) files[job + '/' + name] = readFileSync(file, 'utf8').slice(0, 2_000);
      }
    }
    return { lines, files };
  }
  /** Release only this fixture's explicit write reservation. */
  function unlockRelease() {
    if (!releaseLock) return;
    releaseLock.exec('ROLLBACK');
    releaseLock.close();
    releaseLock = null;
  }
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
${chatty ? "setInterval(() => process.stdout.write('launcher output\\n'), 20);" : 'setInterval(() => {}, 1_000);'}
${epermOnce ? "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300));" : ''}
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
  let nodeOptions = '';
  if (epermOnce) {
    const preload = join(dir, 'eperm-once.mjs');
    writeFileSync(preload, `import { writeFileSync } from 'node:fs';
const kill = process.kill.bind(process);
const groups = new Map();
let answered = false;
process.kill = (pid, signal) => {
  if (pid < 0) groups.set(pid, (groups.get(pid) ?? 0) + 1);
  if (!answered && pid < 0 && groups.get(pid) === 2) {
    answered = true;
    writeFileSync(${JSON.stringify(epermAnswered)}, 'eperm\\n');
    throw Object.assign(new Error('kill EPERM'), { code: 'EPERM', errno: -1, syscall: 'kill' });
  }
  return kill(pid, signal);
};
`);
    nodeOptions = '--import=' + pathToFileURL(preload).href;
  }
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests, stderrLog: workerLog, nodeOptions });
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
    try { await waitForMarker(childReady); }
    catch (error) {
      // An early controller exit leaves the detached child unstarted; report why before cleanup erases it (#888 review).
      const ended = await Promise.race([remoteRun.closed, new Promise(done => { setTimeout(() => done(null), 5_000).unref(); })]); // budget: bounded wait for an already-failing controller to report its result.
      const tail = text => String(text ?? '').slice(-4_000);
      t.diagnostic('controller at readiness failure ' + JSON.stringify(ended
        ? { status: ended.status, signal: ended.signal, stdout: tail(ended.stdout), stderr: tail(ended.stderr) } : 'still running'));
      t.diagnostic('ssh stand-in calls ' + (existsSync(requests) ? tail(readFileSync(requests, 'utf8')) : 'none'));
      t.diagnostic('ssh stand-in phases ' + (existsSync(requests + '.phases') ? readFileSync(requests + '.phases', 'utf8').trim().split('\n').join(',') : 'none'));
      t.diagnostic('worker cleanup report ' + JSON.stringify(workerCleanupReport()));
      if (ended) remoteRun = null;
      throw error;
    }
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

    if (holdRelease) {
      releaseLock = new DatabaseSync(remoteDatabase);
      releaseLock.exec('PRAGMA busy_timeout = 10000');
      releaseLock.exec('BEGIN IMMEDIATE');
    }
    writeFileSync(releaseChild, 'release\n');
    await waitForMarker(childGone);
    await waitForCondition(() => !processIsAlive(detachedPid), 'the detached child PID exits');
    if (holdRelease) {
      await waitForCondition(() => {
        const jobs = join(remoteHome, '.pullboard-runner', 'jobs');
        const id = remoteAgent.slice('pullboard-ssh-'.length);
        for (const name of existsSync(jobs) ? readdirSync(jobs) : []) {
          if (!name.startsWith(id + '-')) continue;
          const pending = join(jobs, name, 'release-pending.json');
          if (!existsSync(pending)) continue;
          const diagnostic = JSON.parse(readFileSync(pending, 'utf8'));
          assert.equal(diagnostic.id, id);
          assert.equal(diagnostic.stage, 'lease release');
          assert.equal(diagnostic.pending, true);
          t.diagnostic('observed real failed holder deletion in private job: ' + JSON.stringify(diagnostic));
          return true;
        }
        assert.equal(processIsAlive(held[0].pid), true,
          'a failed raw release keeps its worker alive to retry instead of stranding a dead holder');
        return false;
      }, 'the actual remote release reaches the held database transaction',
      { signal: t.signal, state: () => ({ workerAlive: processIsAlive(held[0].pid),
        holders: readRemoteGateHolders(remoteDatabase).map(({ pid, agent, kind }) => ({ pid, agent, kind })) }),
        onTimeout: message => t.diagnostic(message) });
      assert.equal(readRemoteGateHolders(remoteDatabase).some(holder => holder.agent === remoteAgent), true,
        'the holder remains until its real deletion can commit');
      unlockRelease();
    }
    let lastReleaseState = 'not observed';
    await waitForCondition(() => {
      const holders = readRemoteGateHolders(remoteDatabase).filter(holder => holder.agent === remoteAgent);
      lastReleaseState = { observedAt: new Date().toISOString(), holders: holders.map(({ pid, agent, browser, item, kind }) =>
        ({ pid, agent, browser, item, kind, alive: processIsAlive(pid) })) };
      return holders.length === 0;
    }, 'the remote physical gate holder is released after child exit',
    { signal: t.signal, state: () => lastReleaseState, onTimeout: message => {
      t.diagnostic(message);
      t.diagnostic('worker cleanup report ' + JSON.stringify(workerCleanupReport()));
    } });
    if (epermOnce) assert.equal(existsSync(epermAnswered), true, 'a repeat group signal really answered EPERM before the release');
    const controller = await remoteRun.closed;
    remoteRun = null;
    assert.equal(controller.signal, 'SIGTERM', 'the owned API controller alone received SIGTERM');
  } finally {
    unlockRelease();
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
}
