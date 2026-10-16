/** `pullboard lane add` declares a lane, and init proposes lanes from the folder layout [I1,I2,L1]. */
import assert from 'node:assert/strict';
import { runFixtureChild, runFixtureGit } from './fixture-child.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');

/** A private repository with the given folders, each holding one file, and pullboard at hand. */
function project(t, folders) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-lane-add-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PULLBOARD_HOME: join(root, '.private-home') };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].includes(key)) delete env[key];
  for (const folder of folders) {
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, folder, 'index.js'), 'export {};\n');
  }
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env, encoding: 'utf8', stdio: 'pipe' });
  /** Run pullboard in this repository and keep its output as a person would see it. */
  const run = (...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd: root, env, encoding: 'utf8' });
  /** The lanes pullboard.json declares right now. */
  const lanes = () => JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8')).lanes;
  return { root, run, lanes };
}

test('lane add creates a lane and init proposes lanes from the layout [I1,I2,L1]', (t) => {
  // init proposes one lane per top-level package for a packages/* layout, and writes none of them.
  const box = project(t, ['packages/web/src', 'packages/api', 'docs']);
  const init = box.run('init');
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /^proposed lanes, not written until the person accepts: api owns packages\/api\/; web owns packages\/web\/$/mu);
  assert.match(init.stdout, /^ask the person; to accept, run: pullboard lane add api --owns packages\/api\/ && pullboard lane add web --owns packages\/web\/$/mu);
  assert.deepEqual(Object.keys(box.lanes()), ['review'], 'init writes no proposed lane before the person accepts');
  const rerun = box.run('init', '--json');
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.deepEqual(JSON.parse(rerun.stdout).proposedLanes, [
    { name: 'api', owns: ['packages/api/'] },
    { name: 'web', owns: ['packages/web/'] },
  ]);

  // lane add writes the lane to pullboard.json, keeping every other setting, and lanes lists it.
  const before = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
  const added = box.run('lane', 'add', 'web', '--owns', 'packages/web');
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /^added lane web: owns packages\/web\/$/mu);
  const both = box.run('lane', 'add', 'api', '--owns', 'packages/api/,docs/');
  assert.equal(both.status, 0, both.stderr);
  const after = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
  assert.deepEqual(after, { ...before, lanes: { ...before.lanes, web: { owns: ['packages/web/'] }, api: { owns: ['packages/api/', 'docs/'] } } });
  const listed = box.run('lanes');
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /^web\s+packages\/web\/$/mu);
  assert.match(listed.stdout, /^api\s+packages\/api\/ docs\/$/mu);

  // An owned path, exact or inside another lane's folder, is refused and names its owner.
  const config = readFileSync(join(box.root, 'pullboard.json'), 'utf8');
  const owned = box.run('lane', 'add', 'site', '--owns', 'packages/web/');
  assert.equal(owned.status, 1);
  assert.match(owned.stderr, /\[PATH_OWNED\] packages\/web\/ is already owned by lane "web"/u);
  const nested = box.run('lane', 'add', 'ui', '--owns', 'packages/web/src');
  assert.equal(nested.status, 1);
  assert.match(nested.stderr, /\[PATH_OWNED\] packages\/web\/src\/ is already owned by lane "web"/u);
  // A taken name is refused and names the lane that has it.
  const taken = box.run('lane', 'add', 'web', '--owns', 'site/');
  assert.equal(taken.status, 1);
  assert.match(taken.stderr, /\[LANE_TAKEN\] lane "web" already exists and owns packages\/web\//u);
  const coordinator = box.run('lane', 'add', 'coordinator', '--owns', 'site/');
  assert.equal(coordinator.status, 1);
  assert.match(coordinator.stderr, /\[LANE_TAKEN\] "coordinator" belongs to the coordinator/u);
  assert.equal(readFileSync(join(box.root, 'pullboard.json'), 'utf8'), config, 'a refusal leaves pullboard.json as it was');

  // Once a lane owns a folder, init proposes nothing more.
  const settled = box.run('init', '--json');
  assert.equal(settled.status, 0, settled.stderr);
  assert.deepEqual(JSON.parse(settled.stdout).proposedLanes, []);

  // An apps/* layout gets one lane per app.
  const apps = project(t, ['apps/mobile', 'apps/site']);
  const appsInit = apps.run('init');
  assert.equal(appsInit.status, 0, appsInit.stderr);
  assert.match(appsInit.stdout, /^proposed lanes, not written until the person accepts: mobile owns apps\/mobile\/; site owns apps\/site\/$/mu);
  assert.deepEqual(Object.keys(apps.lanes()), ['review']);

  // Any other layout gets one app lane.
  const plain = project(t, ['src', 'test']);
  const plainInit = plain.run('init');
  assert.equal(plainInit.status, 0, plainInit.stderr);
  assert.match(plainInit.stdout, /^proposed lanes, not written until the person accepts: app owns src\/ test\/$/mu);
  assert.match(plainInit.stdout, /^ask the person; to accept, run: pullboard lane add app --owns src\/,test\/$/mu);
  assert.deepEqual(Object.keys(plain.lanes()), ['review']);
  const accepted = plain.run('lane', 'add', 'app', '--owns', 'src/,test/');
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(plain.lanes().app, { owns: ['src/', 'test/'] });
});
