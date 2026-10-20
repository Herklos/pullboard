/** @pullboard-test-input source-tree */
/** Native flake observations preserve the first red verdict and carry evidence into repair work [C7,D1,H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { runFixtureChild, runFixtureGit } from './fixture-child.js';
import { flakeSource, observeNativeFailure } from '../src/native-flakes.js';
import * as store from '../src/board.js';
import { land } from '../src/land.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const TITLE = 'a controlled intermittent assertion [C7]';

/** Initialize a real private board and Git history; all gate commands use only this synthetic project. */
function flakyProject(t, { rerun = true, reporter = 'tap', alwaysPass = false } = {}) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-native-flake-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'repo'); mkdirSync(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture Agent', GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture Agent', GIT_COMMITTER_EMAIL: 'fixture@example.com',
    PULLBOARD_HOME: join(scratch, 'home'), PULLBOARD_MACHINE_HOME: join(scratch, 'machine'), PULLBOARD_VIEW_BACKGROUND: '0' };
  delete env.PULLBOARD_RELAY_TOKEN; delete env.NODE_TEST_CONTEXT;
  /** Run Git only within this fixture with a private deterministic identity. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env });
  /** Exercise the real CLI, retaining only its structured receipt for assertions. */
  const cliAt = (cwd, ...args) => {
    const result = runFixtureChild(process.execPath, [BIN, ...args, '--json'], { cwd, env, encoding: 'utf8' });
    return { code: result.status, document: result.stdout?.trim() ? JSON.parse(result.stdout) : null, failure: result.failure };
  };
  /** Keep the coordinator's normal command path separate from its actual joined worktrees. */
  const cli = (...args) => cliAt(root, ...args);
  git('init', '-q', '-b', 'main');
  assert.equal(cli('init').code, 0);
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  symlinkSync(BIN, join(root, 'node_modules/.bin/pullboard'));
  appendFileSync(join(root, '.git/info/exclude'), '\nnode_modules/\n');
  const file = join(root, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.gate = `node --test --test-reporter=${reporter} test/alternating.test.mjs`;
  config.flakes = rerun === null ? undefined : { rerun };
  // These synthetic checks intentionally match the already-configured gate; a private warning policy permits the controlled failure to be armed after submission.
  config.checks = { ...config.checks, provesNothing: 'warn' };
  config.lanes = { build: { owns: ['src/', 'test/'], specs: [] } };
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  mkdirSync(join(root, 'test'));
  const counter = join(scratch, 'observed-target-runs');
  if (alwaysPass === 'controlled') writeFileSync(counter + '.mode', 'pass');
  writeTarget(root, counter, alwaysPass);
  git('add', '-A'); git('commit', '-q', '-m', 'chore: prepare private flake fixture');
  return { root, scratch, env, git, cli, cliAt, counter, lane: 'build' };
}

/** Keep the exact same test identity on main and a candidate, with independently controlled behavior. */
function writeTarget(root, counter, alwaysPass = false, mutate = false) {
  const assertion = "assert.equal(readFileSync(marker, 'utf8').trim().split('\\n').length % 2, 0);";
  writeFileSync(join(root, 'test/alternating.test.mjs'), `import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
/** Record real executions; the fixture controls whether the assertion is passing or intermittent. */
test(${JSON.stringify(TITLE)}, () => {
  const marker = ${JSON.stringify(counter)};
  appendFileSync(marker, 'run\\n');
  ${mutate ? (mutate === 'controlled' ? "if (readFileSync(marker + '.mode', 'utf8') !== 'pass') " : '') + 'appendFileSync(new URL(import.meta.url), ' + JSON.stringify('\n// fixture source changed\n') + ');' : ''}
  ${alwaysPass === 'controlled' ? "if (readFileSync(marker + '.mode', 'utf8') !== 'pass') " + assertion : alwaysPass ? 'assert.ok(true);' : assertion}
});\n`);
}

/** Count the target's actual executions independently of any agent's reported verdict. */
function targetRuns(box) { return readFileSync(box.counter, 'utf8').trim().split('\n').length; }

/** Verify the whole immutable evidence, including profiles, before the private fixture is removed. */
function assertReceipts(box, observation) {
  for (const value of [observation.original, observation.paired, observation.mainReceipt].filter(Boolean)) {
    const file = join(box.root, '.git/pullboard', value.artifact);
    const bytes = readFileSync(file);
    assert.equal(bytes.length, value.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), value.sha256);
    if (value.profileSha256 !== null) assert.equal(createHash('sha256').update(readFileSync(file.replace(/\.log$/u, '.profile.json'))).digest('hex'), value.profileSha256);
  }
}

/** Join through the actual CLI, using a separate session-bound worktree for a candidate. */
function privateBuilder(box) {
  const made = box.cli('worktree', box.lane);
  assert.equal(made.code, 0);
  const root = made.document.path;
  /** Run a candidate command without taking the coordinator's seat. */
  const cli = (...args) => box.cliAt(root, ...args);
  /** Commit only this private candidate's source. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env: box.env });
  return { root, cli, git };
}

/** Set an exact repo-gate check, which the normal baseline shortcut records without a background command. */
function checkedItem(box) {
  const check = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8')).gate;
  const added = box.cli('add', box.lane, 'Controlled Native check', '--criterion', 'The controlled target passes without accepting retries.',
    '--route', 'light', '--brief', 'Files: test/alternating.test.mjs\nTest: run its configured Node TAP check. Preserve the original failed verdict while retaining exact diagnostic receipts.', '--check', check, '--wait');
  assert.equal(added.code, 0, JSON.stringify(added.document));
  return added.document.item.item_id;
}

test('a red gate records one paired pass and drafts repair work on a second sighting [C7,D1,H16]', t => {
  const box = flakyProject(t);
  const head = box.git('rev-parse', 'HEAD').trim();
  const first = box.cli('gate');
  assert.equal(first.code, 1, 'a paired pass never turns the original red gate green');
  assert.equal(first.document.green, false);
  if (targetRuns(box) !== 2) {
    const diagnostic = box.cli('flakes').document;
    const observation = diagnostic?.unclassified?.[0]?.observations?.[0];
    console.log(JSON.stringify({ flakeDiagnostic: diagnostic, originalBody: observation
      ? readFileSync(join(box.root, '.git/pullboard', observation.original.artifact), 'utf8') : first.document.report }));
  }
  assert.equal(targetRuns(box), 2, 'the configured target executes once and gets exactly one paired rerun');
  const listed = box.cli('flakes');
  assert.equal(listed.code, 0);
  assert.equal(listed.document.flakes.length, 1);
  const row = listed.document.flakes[0];
  assert.equal(row.file, 'test/alternating.test.mjs');
  assert.equal(row.name, TITLE);
  assert.equal(row.count, 1);
  assert.equal(row.status, 'active');
  assert.equal(row.observations[0].head, head);
  assert.equal(row.observations[0].original.green, false);
  assert.equal(row.observations[0].paired.green, true);
  assertReceipts(box, row.observations[0]);
  assert.equal(row.item, null, 'one sighting records evidence without inventing a repair item');
  const second = box.cli('gate');
  assert.equal(second.code, 1);
  assert.equal(second.document.green, false);
  assert.equal(targetRuns(box), 4, 'a second red adds one new pair, no confidence loop');
  const repeated = box.cli('flakes').document.flakes[0];
  assert.equal(repeated.count, 2);
  assert.ok(repeated.firstSeen <= repeated.lastSeen);
  assert.ok(Number.isSafeInteger(repeated.item), 'Rigor drafts one ordinary fix item after the second confirmed sighting');
  const item = box.cli('show', String(repeated.item)).document;
  assert.equal(item.item_status, 'open');
  assert.match(item.item_title, /flaky test/iu);
  assert.match(item.item_brief, /original.*paired/isu, 'the repair work carries both observations as evidence');
  for (const observation of repeated.observations) assertReceipts(box, observation);
  const causes = box.cli('rigor').document.causes;
  assert.equal(causes.find(row => row.key === 'test:test/alternating.test.mjs::' + TITLE)?.occurrences, 2);
  assert.equal(box.git('status', '--porcelain').trim(), '', 'Rigor changes no source, spec or doctrine file');
  assert.equal(box.git('rev-parse', 'HEAD').trim(), head, 'diagnostics and drafting never move the source head');
});

test('the ledger records a red by default without running a second command [C7,H16]', t => {
  const box = flakyProject(t, { rerun: null });
  assert.equal(box.cli('gate').code, 1);
  assert.equal(targetRuns(box), 1);
  const report = box.cli('flakes').document;
  assert.equal(report.flakes.length, 0);
  assert.equal(report.unclassified.length, 1);
  const observation = report.unclassified[0].observations[0];
  assert.equal(observation.paired, null);
  assert.match(observation.reason, /off/iu);
  assertReceipts(box, observation);
});

test('an unsupported Node reporter stays unclassified rather than guessing a selector [C7,H16]', t => {
  const box = flakyProject(t, { reporter: 'spec' });
  assert.equal(box.cli('gate').code, 1);
  assert.equal(targetRuns(box), 1);
  const report = box.cli('flakes').document;
  assert.equal(report.flakes.length, 0);
  assert.equal(report.unclassified[0].observations[0].paired, null);
  assertReceipts(box, report.unclassified[0].observations[0]);
});

test('the pinned bundled runner selects one target and skips unrelated bodies [C7,H16]', t => {
  const box = flakyProject(t);
  const unrelated = join(box.scratch, 'bundled-unrelated-runs');
  mkdirSync(join(box.root, 'bin'));
  cpSync(resolve(import.meta.dirname, '../bin/run-tests.js'), join(box.root, 'bin/run-tests.js'));
  cpSync(resolve(import.meta.dirname, '../src'), join(box.root, 'src'), { recursive: true });
  writeFileSync(join(box.root, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(box.root, 'test/unrelated.test.mjs'), `import { test } from 'node:test';
import { appendFileSync } from 'node:fs';
test('unrelated bundled execution [C7]', () => appendFileSync(${JSON.stringify(unrelated)}, 'run\\n'));
`);
  const file = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.gate = 'node bin/run-tests.js test/alternating.test.mjs test/unrelated.test.mjs';
  config.affectedTests = 'node bin/run-tests.js';
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  box.git('add', '-A'); box.git('commit', '-q', '-m', 'chore: private bundled runner');
  assert.equal(box.cli('gate').code, 1);
  assert.equal(targetRuns(box), 2, 'the known pinned runner executes only its one exact-target pair');
  assert.equal(readFileSync(unrelated, 'utf8'), 'run\n', 'the unrelated body executes only in the original gate');
  const report = box.cli('flakes').document;
  assert.equal(report.flakes.length, 1);
  assert.equal(report.flakes[0].observations[0].paired.green, true);
  assertReceipts(box, report.flakes[0].observations[0]);
});

test('an unknown script named run-tests cannot rerun unrelated tests or confirm a flake [C7,H16]', t => {
  const box = flakyProject(t);
  const unrelated = join(box.scratch, 'observed-unrelated-runs');
  mkdirSync(join(box.root, 'bin'));
  writeFileSync(join(box.root, 'bin/run-tests.js'), `import { spawnSync } from 'node:child_process';
// This user's runner deliberately does not implement Node's test-name selector.
const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/alternating.test.mjs', 'test/unrelated.test.mjs'], { env: process.env, stdio: 'inherit' });
process.exitCode = run.status;
`);
  writeFileSync(join(box.root, 'test/unrelated.test.mjs'), `import { test } from 'node:test';
import { appendFileSync } from 'node:fs';
test('unrelated execution [C7]', () => appendFileSync(${JSON.stringify(unrelated)}, 'run\\n'));
`);
  const file = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.gate = 'node bin/run-tests.js';
  config.affectedTests = 'node bin/run-tests.js';
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  box.git('add', '-A'); box.git('commit', '-q', '-m', 'chore: private unknown runner');
  assert.equal(box.cli('gate').code, 1, 'the original assertion remains red');
  assert.equal(targetRuns(box), 1, 'a conventional script filename does not authorize a paired rerun');
  assert.equal(readFileSync(unrelated, 'utf8'), 'run\n', 'the unrelated test runs only in the original gate');
  const report = box.cli('flakes').document;
  assert.equal(report.flakes.length, 0);
  assert.equal(report.unclassified.length, 1);
  assert.equal(report.unclassified[0].observations[0].paired, null);
  assertReceipts(box, report.unclassified[0].observations[0]);
});

test('a green pinned main excludes a candidate that passes its paired rerun [C7,H16]', t => {
  const box = flakyProject(t, { alwaysPass: true });
  const main = box.git('rev-parse', 'HEAD').trim();
  const builder = privateBuilder(box);
  writeTarget(builder.root, box.counter);
  builder.git('add', '-A'); builder.git('commit', '-q', '-m', 'chore: prepare private candidate');
  const head = builder.git('rev-parse', 'HEAD').trim();
  const gate = builder.cli('gate');
  assert.equal(gate.code, 1);
  assert.equal(gate.document.green, false);
  assert.equal(targetRuns(box), 3, 'one original, one candidate pair and one independently pinned main comparison');
  const report = box.cli('flakes').document;
  assert.equal(report.flakes.length, 0);
  assert.equal(report.regressions.length, 1);
  assert.equal(report.regressions[0].item, null);
  const observation = report.regressions[0].observations[0];
  assert.equal(observation.head, head);
  assert.equal(observation.main, main);
  assert.equal(observation.paired.green, true);
  assert.equal(observation.mainReceipt.green, true);
  assertReceipts(box, observation);
});

test('a source change during the original run prevents a paired measurement [C7,H16]', t => {
  const box = flakyProject(t);
  writeTarget(box.root, box.counter, false, true);
  box.git('add', '-A'); box.git('commit', '-q', '-m', 'chore: prepare controlled source mutation');
  assert.equal(box.cli('gate').code, 1);
  assert.equal(targetRuns(box), 1);
  const report = box.cli('flakes').document;
  assert.equal(report.flakes.length, 0);
  assert.equal(report.unclassified[0].observations[0].paired, null);
  assert.match(report.unclassified[0].observations[0].reason, /changed/iu);
  assertReceipts(box, report.unclassified[0].observations[0]);
});

test('the actual check command retains its red and records one pair [C7,V2,H16]', t => {
  const box = flakyProject(t);
  const id = checkedItem(box);
  const result = box.cli('check', String(id), '--yes');
  assert.equal(result.code, 1);
  assert.equal(result.document.green, false);
  assert.equal(targetRuns(box), 2);
  const observation = box.cli('flakes').document.flakes[0].observations[0];
  assert.equal(observation.kind, 'check');
  assert.equal(observation.original.green, false);
  assert.equal(observation.paired.green, true);
  assertReceipts(box, observation);
});

test('a red submit records diagnostics without submitting the item [C7,V4,H16]', t => {
  const box = flakyProject(t);
  const id = checkedItem(box);
  const builder = privateBuilder(box);
  const claimed = builder.cli('claim', String(id));
  assert.equal(claimed.code, 0, JSON.stringify(claimed.document));
  builder.git('commit', '--allow-empty', '-q', '-m', 'chore: controlled submission candidate');
  const result = builder.cli('submit', String(id));
  assert.equal(result.code, 1);
  assert.equal(box.cli('show', String(id)).document.item_status, 'claimed');
  assert.equal(targetRuns(box), 3, 'one original and pair on candidate, plus one pinned main comparison');
  const observation = box.cli('flakes').document.flakes[0].observations[0];
  assert.equal(observation.kind, 'submit');
  assert.equal(observation.original.green, false);
  assert.equal(observation.paired.green, true);
  assertReceipts(box, observation);
});

for (const linkedTemp of [false, true]) test(linkedTemp
  ? 'a private verification pair uses physical paths through a symlinked temporary root [C7,V4,H16]'
  : 'an independent private verification check stays red after its one passing pair [C7,V4,H16]', t => {
  const box = flakyProject(t, { alwaysPass: 'controlled' });
  if (linkedTemp) {
    const alias = join(box.scratch, 'temporary-alias');
    symlinkSync(box.scratch, alias, 'dir');
    box.env.TMPDIR = alias;
  }
  const id = checkedItem(box);
  const builder = privateBuilder(box);
  const claimed = builder.cli('claim', String(id));
  assert.equal(claimed.code, 0, JSON.stringify(claimed.document));
  builder.git('commit', '--allow-empty', '-q', '-m', 'chore: controlled review candidate');
  const submitted = builder.cli('submit', String(id));
  assert.equal(submitted.code, 0, 'the fixture submits with a real green proof before its external failure is enabled');
  const head = box.cli('show', String(id)).document.item_commit;
  writeFileSync(box.counter, ''); writeFileSync(box.counter + '.mode', 'paired');
  const reviewer = privateBuilder(box);
  reviewer.git('checkout', '-q', '--detach', head);
  const result = reviewer.cli('verify', String(id), 'accept');
  assert.equal(result.code, 1);
  assert.equal(result.document.error.code, 'CHECK_RED');
  const item = box.cli('show', String(id)).document;
  assert.equal(item.item_status, 'submitted', 'a green diagnostic cannot authorize a verdict');
  assert.equal(item.item_verdict, null);
  assert.equal(targetRuns(box), 3, 'one private original, one private candidate pair and one pinned main control');
  const observation = box.cli('flakes').document.flakes[0].observations[0];
  assert.equal(observation.kind, 'verify');
  assert.equal(observation.head, head);
  assert.equal(observation.original.green, false);
  assert.equal(observation.paired.green, true);
  assertReceipts(box, observation);
});

test('a frozen private check that changes its source records no unchanged-source pair [C7,V4,H16]', t => {
  const box = flakyProject(t, { alwaysPass: 'controlled' });
  const id = checkedItem(box);
  const builder = privateBuilder(box);
  assert.equal(builder.cli('claim', String(id)).code, 0);
  writeTarget(builder.root, box.counter, 'controlled', 'controlled');
  builder.git('add', '-A'); builder.git('commit', '-q', '-m', 'chore: controlled private-check mutation');
  const submitted = builder.cli('submit', String(id));
  assert.equal(submitted.code, 0, JSON.stringify(submitted.document));
  const head = box.cli('show', String(id)).document.item_commit;
  writeFileSync(box.counter, ''); writeFileSync(box.counter + '.mode', 'paired');
  const reviewer = privateBuilder(box);
  reviewer.git('checkout', '-q', '--detach', head);
  const result = reviewer.cli('verify', String(id), 'accept');
  assert.equal(result.document.error?.code, 'CHECK_RED');
  assert.equal(targetRuns(box), 1, 'changing the private checked source prevents a diagnostic pair');
  const report = box.cli('flakes').document;
  assert.equal(report.flakes.length, 0);
  const observation = report.unclassified[0].observations[0];
  assert.equal(observation.paired, null);
  assert.match(observation.reason, /source.*changed/iu);
  assertReceipts(box, observation);
});

/** Prepare one genuinely submitted and accepted candidate with a private local bare destination. */
function readyLanding(t, rerun) {
  const box = flakyProject(t, { alwaysPass: 'controlled', rerun });
  const remote = join(box.scratch, 'private-origin.git');
  box.git('init', '-q', '--bare', remote);
  box.git('remote', 'add', 'origin', remote);
  box.git('push', '-q', '-u', 'origin', 'main');
  const base = box.git('rev-parse', 'HEAD').trim();
  const id = checkedItem(box);
  const builder = privateBuilder(box);
  const claimed = builder.cli('claim', String(id));
  assert.equal(claimed.code, 0, JSON.stringify(claimed.document));
  builder.git('commit', '--allow-empty', '-q', '-m', 'chore: prepare controlled landing candidate');
  const submitted = builder.cli('submit', String(id));
  assert.equal(submitted.code, 0, JSON.stringify(submitted.document));
  const head = box.cli('show', String(id)).document.item_commit;
  const reviewer = privateBuilder(box);
  reviewer.git('checkout', '-q', '--detach', head);
  const accepted = reviewer.cli('verify', String(id), 'accept', '--note', 'Private fixture: its exact controlled check passed before the external failure was armed.');
  assert.equal(accepted.code, 0, JSON.stringify(accepted.document));
  writeFileSync(box.counter, '');
  writeFileSync(box.counter + '.mode', 'paired');
  return { ...box, remote, base, id };
}

test('enabled landing retains its original red without a second diagnostic or first legacy defect [C7,H16]', t => {
  const box = readyLanding(t, true);
  const result = box.cli('land');
  assert.equal(result.code, 0, JSON.stringify(result.document));
  assert.equal(result.document.batch.state, 'blocked');
  assert.deepEqual(result.document.landed, []);
  assert.deepEqual(result.document.flakes, [], 'typed observations do not file a first-sighting legacy landing_flake');
  assert.equal(result.document.batch.gateResults[0].isGreen, false, 'the diagnostic pass never replaces the original red');
  assert.equal(targetRuns(box), 3, 'one original, one exact-target pair, one independently pinned main control; no legacy whole-file remeasurement');
  const report = box.cli('flakes').document;
  assert.equal(report.flakes.length, 1);
  assert.equal(report.flakes[0].count, 1);
  assert.equal(report.flakes[0].item, null, 'first sighting does not invent repair work');
  assert.equal(report.flakes[0].observations[0].kind, 'land');
  assertReceipts(box, report.flakes[0].observations[0]);
  assert.equal(box.git('rev-parse', 'HEAD').trim(), box.base);
  assert.equal(box.git('--git-dir=' + box.remote, 'rev-parse', 'main').trim(), box.base, 'the private destination received no landing');
  const refused = box.cli('land', '--adopt');
  assert.equal(refused.document.error?.code, 'LAND_ADOPT', 'a terminal blocked batch is not an interrupted landing');
  assert.equal(targetRuns(box), 3, 'a refused adoption adds no measurement');
  assert.equal(box.cli('flakes').document.flakes[0].count, 1);
});

/** Interrupt the dependency at its final blocked write after real diagnostics were durably recorded, then use normal CLI adoption. */
test('an interrupted landing consumes its saved diagnostic without inventing another measurement [C7,H16]', async t => {
  const box = readyLanding(t, true);
  // The direct public API call cannot inherit cliAt's private identity environment; set only this synthetic repo's identity.
  box.git('config', '--local', 'user.name', 'Fixture Agent');
  box.git('config', '--local', 'user.email', 'fixture@example.com');
  const board = store.openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  try {
    const config = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
    // A direct API call must not hand Node's outer test-worker protocol to its own configured Node test command.
    const context = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_CONTEXT;
    let completed;
    try {
      await assert.rejects(land({ root: box.root, board, config, owner: 'private-interrupted-owner', say: () => {},
        write: async (operation, args) => {
          if (operation === 'recordLandingBatch' && args[0].batch.state === 'blocked') throw new Error('controlled interruption after retained diagnostic');
          return store[operation](board, ...args);
        } }).then(result => { completed = result; return result; }), /controlled interruption after retained diagnostic/u);
    } catch (error) {
      const saved = store.landingBatches(board).at(-1);
      t.diagnostic(JSON.stringify({ unexpectedCompletion: completed?.batch?.state ?? null, targetRuns: targetRuns(box), savedState: saved?.state }));
      for (const gate of saved?.gateResults ?? []) if (gate.logPath) t.diagnostic(readFileSync(gate.logPath, 'utf8'));
      throw error;
    } finally {
      if (context === undefined) delete process.env.NODE_TEST_CONTEXT;
      else process.env.NODE_TEST_CONTEXT = context;
    }
    const saved = store.landingBatches(board).at(-1);
    assert.equal(saved.state, 'gating');
    assert.equal(saved.gateResults[0].isGreen, false);
    assert.equal(saved.gateResults[0].flakeDiagnostics.observations[0].recorded, true);
  } finally { store.closeBoard(board); }
  assert.equal(targetRuns(box), 3, 'the real interrupted landing completed only its original, pair and pinned-main comparison');
  const adopted = box.cli('land', '--adopt');
  assert.equal(adopted.code, 0, JSON.stringify(adopted.document));
  assert.equal(adopted.document.batch.state, 'blocked');
  assert.equal(targetRuns(box), 3, 'normal adoption consumes the retained original and pair, never a confidence rerun');
  assert.equal(box.cli('flakes').document.flakes[0].count, 1, 'adoption does not invent a second sighting');
  assert.equal(box.git('--git-dir=' + box.remote, 'rev-parse', 'main').trim(), box.base);
});

test('landing with reruns off preserves the released whole-file diagnosis and first legacy defect [C7,H16]', t => {
  const box = readyLanding(t, false);
  const result = box.cli('land');
  assert.equal(result.code, 0, JSON.stringify(result.document));
  assert.equal(result.document.batch.state, 'flaky');
  assert.deepEqual(result.document.landed, []);
  assert.equal(result.document.flakes.length, 1, 'the released first-sighting legacy defect remains');
  assert.equal(targetRuns(box), 2, 'the released original and whole-file diagnosis remain, with no new paired rerun');
  const report = box.cli('flakes').document;
  assert.equal(report.flakes.length, 0, 'a whole-file diagnosis is not relabeled as exact-target confirmation');
  assert.equal(report.unclassified.length, 1, 'the new ledger still retains the original red');
  assert.equal(report.unclassified[0].observations[0].paired, null);
  assertReceipts(box, report.unclassified[0].observations[0]);
  assert.equal(box.git('rev-parse', 'HEAD').trim(), box.base);
  assert.equal(box.git('--git-dir=' + box.remote, 'rev-parse', 'main').trim(), box.base);
});

test('a ledger recording failure cannot replace the original red or discard its evidence [C7,H16]', async t => {
  const box = flakyProject(t, { rerun: false });
  const config = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
  const pin = flakeSource(box.root);
  const result = runFixtureChild(process.execPath, ['--test', '--test-reporter=tap', 'test/alternating.test.mjs'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 1, 'the original assertion really failed before the forced recording error');
  const run = { isGreen: false, output: result.stdout + result.stderr };
  const notices = [];
  await observeNativeFailure({ root: box.root, config, pin, run, command: config.gate, kind: 'check',
    record: () => { throw Object.assign(new Error('private injected ledger failure'), { code: 'SYNTHETIC_LEDGER_UNAVAILABLE' }); },
    onError: notice => notices.push(notice),
  });
  assert.equal(run.isGreen, false);
  assert.equal(targetRuns(box), 1, 'a recording failure adds no execution');
  assert.equal(run.flakeDiagnostics.error, 'SYNTHETIC_LEDGER_UNAVAILABLE');
  assert.equal(run.flakeDiagnostics.observations[0].recorded, false, 'the result never claims the missing ledger entry was recorded');
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /original result stays red/u);
  const directory = join(box.root, '.git/pullboard/flake-evidence', run.flakeDiagnostics.observations[0].id);
  const retained = JSON.parse(readFileSync(join(directory, 'observation.json'), 'utf8'));
  assertReceipts(box, retained);
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  for (const [file, digest] of Object.entries(manifest)) assert.equal(createHash('sha256').update(readFileSync(join(directory, file))).digest('hex'), digest);
  assert.equal(Object.hasOwn(manifest, 'recording-error.addendum.json'), false, 'the original manifest remains immutable');
  assert.equal(JSON.parse(readFileSync(join(directory, 'recording-error.addendum.json'), 'utf8')).code, 'SYNTHETIC_LEDGER_UNAVAILABLE');
});
