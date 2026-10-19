/** Exercise actual remote parent-death custody, optionally forcing a real release write conflict [C7]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { takeResource } from '../src/resources.js';
import { runFixtureChild } from './fixture-child.js';
import { readRemoteGateHolders, waitForCondition } from './runner-fixture-state.js';

/** Keep the original custody assertions identical in ordinary and forced database ordering cases. */
export async function parentDeathDrainFixture(t, tools, { holdRelease = false } = {}) {
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
  let releaseLock;
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
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests, stderrLog: workerLog });
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
    { signal: t.signal, state: () => lastReleaseState, onTimeout: message => t.diagnostic(message) });
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
