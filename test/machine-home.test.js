/** Real machine-storage permission refusals preserve the shared queue location [I1,C7,Q4]. */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';

const { sandbox, project, cleanup } = createE2eHelpers();
after(cleanup);

/** Check the named refusal, its actual blocked directory and both usable next steps. */
function refused(result, directory) {
  const output = result.out + result.err;
  assert.notEqual(result.code, 0, output);
  assert.match(output, /MACHINE_HOME_NOT_WRITABLE/u);
  assert.ok(output.includes(directory), output);
  assert.match(output, /write access to that directory/u);
  assert.match(output, /run the command outside the sandbox/u);
  assert.doesNotMatch(output, /unable to open database file/iu);
}

test('an unwritable machine home is refused by name [I1,C7,Q4]', async (t) => {
  await t.test('resume names a blocked project registry when refreshing its metadata', () => {
    const box = sandbox();
    box.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_HOME;
    const p = project(undefined, box);
    const home = p.env.PULLBOARD_MACHINE_HOME;
    const folder = join(home, 'relay-machine');
    mkdirSync(folder, { mode: 0o700 });
    writeFileSync(join(folder, 'state.json'), JSON.stringify({ v: 2, autoLink: true,
      owner: null, machine: 'machine-fixture', devices: [], excluded: [], pending: null,
      revocations: [], approvals: [] }), { mode: 0o600 });
    const config = join(p.repo, 'pullboard.json');
    writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), name: 'Renamed project' }));
    // A real metadata refresh must create its SQLite lock in the now-blocked directory.
    rmSync(join(home, 'projects.json.lock.sqlite'));
    chmodSync(home, 0o500);
    try {
      assert.throws(() => writeFileSync(join(home, 'permission-sentinel'), ''), { code: 'EACCES' });
      refused(p.run(p.repo, 'resume'), home);
    } finally { chmodSync(home, 0o700); }
  });
  await t.test('the pool override is independent of the writable project registry', () => {
    const p = project();
    const home = p.env.PULLBOARD_MACHINE_HOME;
    assert.notEqual(home, p.env.PULLBOARD_HOME);
    mkdirSync(home, { recursive: true });
    rmSync(join(home, 'resources.sqlite'), { force: true });
    chmodSync(home, 0o500);
    try {
      refused(p.run(p.repo, 'resources'), home);
      assert.equal(existsSync(join(home, 'resources.sqlite')), false);
    } finally { chmodSync(home, 0o700); }
    assert.equal(p.run(p.repo, 'resources').code, 0, 'restoring write access restores the real pool');
  });
  await t.test('a blocked parent names the requested missing machine home', () => {
    const p = project();
    const parent = join(p.dir, 'blocked-parent');
    mkdirSync(parent);
    p.env.PULLBOARD_MACHINE_HOME = join(parent, 'new-machine-home');
    chmodSync(parent, 0o500);
    try {
      refused(p.run(p.repo, 'resources'), p.env.PULLBOARD_MACHINE_HOME);
      assert.equal(existsSync(p.env.PULLBOARD_MACHINE_HOME), false);
    } finally { chmodSync(parent, 0o700); }
  });
});
