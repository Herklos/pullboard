/**
 * The gate's digest (V10): what an agent reads of a red run. And submit's own run of the gate (V16):
 * no stamp stands in for it, and the tree must hold still while it runs.
 */
import assert from 'node:assert/strict';
import { runFixtureExecFile as execFileSync, runFixtureChild as spawnSync, runFixtureChild, runFixtureGit } from './fixture-child.js';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { digestOf, testConcurrency } from '../src/gate.js';

const PRIVATE_WORKER = resolve(import.meta.dirname, '../src/private-check-worker.js');

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Read the real file bodies' start/finish records to measure overlap without sampling process names. */
function fileOverlap(file) {
  const active = new Map();
  const starts = [];
  let files = 0, browser = 0;
  for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
    const event = JSON.parse(line);
    if (event.start) {
      assert.equal(active.has(event.id), false, 'a file begins once');
      active.set(event.id, event.browser);
      starts.push(event.id);
      files = Math.max(files, active.size);
      browser = Math.max(browser, [...active.values()].filter(Boolean).length);
    } else {
      assert.equal(active.delete(event.id), true, 'every finish has a start');
    }
  }
  assert.equal(active.size, 0, 'every selected file finishes');
  return { files, browser, starts };
}

test('the landing gate bounds its own concurrency [C7]', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-file-caps-')));
  dirs.push(root);
  cpSync(resolve(import.meta.dirname, '../src'), join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'bin'));
  cpSync(resolve(import.meta.dirname, '../bin/run-tests.js'), join(root, 'bin/run-tests.js'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  const config = join(root, 'pullboard.json');
  assert.deepEqual(testConcurrency(root, 7), { files: 7, browser: 2 }, 'the default file budget is the detected core budget');
  const selected = [];
  for (let id = 0; id < 9; id += 1) {
    const browser = id < 4;
    const folder = join(root, 'test', browser ? 'cockpit' : 'ordinary');
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `overlap-${id}.test.js`);
    selected.push(file);
    writeFileSync(file, `import {appendFileSync} from 'node:fs';
import {test} from 'node:test';
/** Keep controlled work alive briefly so concurrent file bodies leave overlapping records. */
test('record real file ${id} [C7]', async () => {
  appendFileSync(process.env.PULLBOARD_CAP_CAPTURE, JSON.stringify({start:true,id:${id},browser:${browser}})+'\\n');
  await new Promise(resolve => setTimeout(resolve, 200)); // budget: controlled fixture work, not a readiness deadline or production wait.
  appendFileSync(process.env.PULLBOARD_CAP_CAPTURE, JSON.stringify({start:false,id:${id}})+'\\n');
});\n`);
  }
  for (const setting of [{ files: 3, browser: 2 }, { files: 2, browser: 1 }]) {
    writeFileSync(config, JSON.stringify({ testConcurrency: setting }));
    assert.deepEqual(testConcurrency(root, 7), setting, 'pullboard.json overrides the shared policy');
    const capture = join(root, `overlap-${setting.files}.jsonl`);
    const result = runFixtureChild(process.execPath, [join(root, 'bin/run-tests.js'), '--test-concurrency=9', ...selected], {
      cwd: root, env: { ...process.env, PULLBOARD_CAP_CAPTURE: capture,
        PULLBOARD_MACHINE_HOME: join(root, `machine-${setting.files}`) }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const peak = fileOverlap(capture);
    assert.ok(peak.files <= setting.files, `actual file-body overlap ${peak.files} exceeds ${setting.files}`);
    assert.ok(peak.browser <= setting.browser, `actual browser-file overlap ${peak.browser} exceeds ${setting.browser}`);
    assert.deepEqual(peak.starts.sort((a, b) => a - b), Array.from({ length: 9 }, (_, id) => id), 'every selected file runs once');
    assert.match(result.stdout, /# tests 9\b/);
    assert.match(result.stdout, /# fail 0\b/);
  }
  let isolationCase = 0;
  for (const flag of ['--test-isolation', '--test_isolation', '--experimental-test-isolation',
    '--experimental_test_isolation', '--experimental_test-isolation', '--experimental-test_isolation']) {
    for (const args of [[`${flag}=none`], [flag, 'none']]) {
      const capture = join(root, `isolation-${isolationCase++}.jsonl`);
      const result = runFixtureChild(process.execPath, [join(root, 'bin/run-tests.js'), ...args, selected.at(-1)], {
        cwd: root, env: { ...process.env, PULLBOARD_CAP_CAPTURE: capture,
          PULLBOARD_MACHINE_HOME: join(root, 'machine-isolation') }, encoding: 'utf8',
      });
      assert.notEqual(result.status, 0, `${args.join(' ')} must refuse non-isolated test files`);
      assert.match(result.stderr, /bounded browser test files require process isolation/u);
      assert.equal(existsSync(capture), false, 'a refused isolation mode never starts a test-file body');
    }
  }
  writeFileSync(config, JSON.stringify({ testConcurrency: { browser: 3 } }));
  assert.throws(() => testConcurrency(root, 7), /browser must be 1 or 2/);
});

/**
 * A repo whose coordinator holds item #1, with this gate. Every run of the gate first adds a line
 * to runs.log beside the repo, so a test can count the runs.
 *
 * @param {string} gate
 * @param {string} [check]
 */
function repoWithGate(gate, check = '') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-gate-')));
  dirs.push(dir);
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(dir, 'home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'home'),
  };
  const git = (...args) => runFixtureGit(args, { cwd: repo, env });
  const run = (...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd: repo, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: `echo run >> ../runs.log; ${gate}` }));
  writeFileSync(join(repo, 'SPEC.md'), '# Demo\n\n## G · Goals\n- G1 [approved, must] It works. | gate: test\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: a spec');
  const added = run('add', 'coordinator', 'Work', ...(check ? ['--check', check, '--wait'] : []));
  assert.equal(added.status, 0, `${added.stdout}${added.stderr}`);
  assert.equal(run('claim', '1').status, 0);
  const runs = () => {
    try {
      return readFileSync(join(dir, 'runs.log'), 'utf8').split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  return { dir, repo, env, git, run, runs };
}

test('gate before the first commit names the uncommitted config [I1,C7]', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-first-commit-')));
  dirs.push(dir);
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(dir, 'home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'home'),
  };
  const git = (...args) => runFixtureGit(args, { cwd: repo, env });
  const run = (...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd: repo, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  const initialized = run('init', '--model', 'Test Coordinator');
  assert.equal(initialized.status, 0, `${initialized.stdout}${initialized.stderr}`);
  assert.equal(existsSync(join(repo, 'pullboard.json')), true, 'init wrote the coordinator config');

  const firstGate = run('gate', '--json');
  assert.equal(firstGate.status, 1, 'the gate cannot read a policy before the initial commit');
  const firstRefusal = JSON.parse(firstGate.stdout).error;
  assert.equal(firstRefusal.code, 'NO_POLICY');
  assert.match(firstRefusal.message, /pullboard\.json is not committed/u);
  assert.match(firstRefusal.message, /git add pullboard\.json/u, 'the refusal gives the concrete staging command');

  const committed = repoWithGate('true');
  committed.git('switch', '--detach', 'HEAD');
  const missingCoordinator = committed.run('gate', '--json');
  assert.equal(missingCoordinator.status, 1);
  const missingRefusal = JSON.parse(missingCoordinator.stdout).error;
  assert.equal(missingRefusal.code, 'NO_POLICY');
  assert.match(missingRefusal.message, /coordinator checkout is detached for review/u,
    'other genuine NO_POLICY failures keep their specific message');
});

test('a digest keeps the failures and the end within its cap, however long one line is [V10]', () => {
  const digest = digestOf(`not ok 1 - ${'x'.repeat(3500)}\n${'ok\n'.repeat(50)}# fail 1\nsummary: 1 failed`);
  assert.ok(digest.length <= 3000, `${digest.length} characters`);
  assert.match(digest, /^not ok 1 - x+…\n/);
  assert.match(digest, /# fail 1\nsummary: 1 failed$/);
});

test('a digest of many failures stays within its cap and still ends with the summary [V10]', () => {
  const failures = Array.from({ length: 200 }, (_, n) => `not ok ${n} - ${'y'.repeat(250)}`).join('\n');
  const digest = digestOf(`${failures}\n# tests 200\n# fail 200`);
  assert.ok(digest.length <= 3000, `${digest.length} characters`);
  assert.match(digest, /^not ok 0 - /);
  assert.match(digest, /# tests 200\n# fail 200$/);
});

test('a digest keeps the lines that say why a test failed, and skips passing tests however named [V10]', () => {
  const tap = [
    '# Subtest: a lane cannot commit outside its folders',
    'ok 1 - a lane cannot commit outside its folders',
    '# Subtest: an error in the store is reported',
    'ok 2 - an error in the store is reported',
    '# Subtest: add returns the new number',
    'not ok 3 - add returns the new number',
    '  ---',
    "  location: '/repo/test/store.test.js:12:1'",
    "  failureType: 'testCodeFailure'",
    '  error: |-',
    '    Expected values to be strictly equal:',
    '    2 !== 1',
    '  expected: 1',
    '  actual: 2',
    '  ...',
    ...Array.from({ length: 30 }, (_, n) => `ok ${n + 4} - filler ${n}`),
    '# tests 33',
    '# pass 32',
    '# fail 1',
  ].join('\n');
  const digest = digestOf(tap);
  assert.doesNotMatch(digest, /cannot commit|error in the store/, 'passing tests are not failures');
  assert.match(digest, /^not ok 3 - add returns the new number\n/);
  assert.match(digest, /store\.test\.js:12:1/);
  assert.match(digest, / {4}2 !== 1\n {2}expected: 1\n {2}actual: 2/);
  assert.match(digest, /# fail 1$/);
});

test('submit runs the gate itself: a stamp written by hand never stands in for a red gate [V16]', () => {
  const box = repoWithGate('test ! -f RED');
  writeFileSync(join(box.repo, 'RED'), 'red\n');
  box.git('add', 'RED');
  box.git('commit', '-q', '-m', 'chore: turn the gate red');
  writeFileSync(join(box.repo, box.git('rev-parse', '--git-path', 'pullboard-gate-green')), `${box.git('rev-parse', 'HEAD^{tree}')}\n`);
  const refused = box.run('submit', '1');
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /GATE_RED/);
  assert.equal(box.runs(), 1, 'submit ran the gate instead of trusting the stamp');
});

test('submit runs the gate even on a tree an earlier run passed, which a plain gate run may skip [V16, C3]', () => {
  const box = repoWithGate('true');
  assert.equal(box.run('gate').status, 0);
  assert.equal(box.runs(), 1);
  assert.match(box.run('gate').stdout, /this tree already passed/);
  assert.equal(box.runs(), 1, 'outside submit, the stamp still saves a run');
  const submitted = box.run('submit', '1');
  assert.equal(submitted.status, 0, submitted.stderr);
  assert.match(submitted.stdout, /gate green in \d+s/);
  assert.equal(box.runs(), 2, 'submit ran the gate itself, stamp or no stamp');
});

test('submit refuses a tree its gate left changed: a new commit, or an edited tracked file [V16]', () => {
  for (const [moves, gate] of [
    ['a commit made during the gate', 'git commit -q --allow-empty -m "chore: moved under the gate"'],
    ['a tracked file edited during the gate', 'echo more >> SPEC.md'],
  ]) {
    const box = repoWithGate(gate);
    const head = box.git('rev-parse', 'HEAD');
    const refused = box.run('submit', '1');
    assert.equal(refused.status, 1, `${moves}: ${refused.stdout}`);
    assert.match(refused.stderr, /MOVED_DURING_GATE/, moves);
    assert.ok(refused.stderr.includes(head.slice(0, 12)), `${moves}: the refusal names the commit the gate was meant to check`);
    assert.equal(box.runs(), 1, moves);
  }
});


/** Quote a test executable or path as one shell word. */
function shellWord(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

/** Run the production private-check worker with a real shell and durable output file. */
function privateCheck(box, command) {
  const logPath = join(box.dir, 'private-command.log');
  const pidFile = logPath + '.pid';
  const run = runFixtureChild(process.execPath, [PRIVATE_WORKER], {
    cwd: box.repo, env: box.env, encoding: 'utf8',
    input: JSON.stringify({ command, timeout: 30_000, pidFile, logPath }),
  });
  rmSync(pidFile, { force: true });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  return JSON.parse(run.stdout);
}

test('a piped gate fails on any red stage without changing its existing shell [V16,C7]', () => {
  const supported = runFixtureChild('set -o pipefail', { shell: true }).status === 0;
  const failing = repoWithGate('sh -c "exit 7" | tail -1');
  const red = failing.run('gate', '--json');
  assert.equal(red.status, 1, 'a failing producer cannot leave the gate green');
  if (supported) assert.equal(JSON.parse(red.stdout).green, false);
  else {
    const error = JSON.parse(red.stdout).error;
    assert.equal(error.code, 'PIPEFAIL_UNAVAILABLE');
    assert.match(error.message, /rewrite the gate without a pipe/u);
    assert.equal(failing.runs(), 0, 'an unsupported gate never starts');
  }
  const plain = repoWithGate('sh -c "exit 7"');
  assert.equal(plain.run('gate').status, 1, 'plain failure remains red');
  const passing = repoWithGate("printf 'pipeline-ok\\n' | grep -q pipeline-ok");
  const green = passing.run('gate', '--json');
  if (supported) assert.equal(green.status, 0, `${green.stdout}${green.stderr}`);
  else assert.equal(JSON.parse(green.stdout).error.code, 'PIPEFAIL_UNAVAILABLE');
  const ordinary = repoWithGate('true');
  assert.equal(ordinary.run('gate').status, 0, 'a plain passing gate needs no pipefail capability');
});

test('a piped gate fails safely while named-test item checks keep last-stage semantics [V16,C7]', () => {
  const box = repoWithGate('true');
  const fixture = join(box.dir, 'named-output.test.js');
  writeFileSync(fixture, `import {test} from 'node:test';
import {setTimeout} from 'node:timers/promises';
test('passing named item check', () => {});
test('output after the match', async () => {
  await setTimeout(25);
  process.stdout.write('x'.repeat(1024 * 1024));
});
`);
  const runner = resolve(import.meta.dirname, '../bin/run-tests.js');
  const named = `${shellWord(process.execPath)} ${shellWord(runner)} ${shellWord(fixture)} 2>&1 | grep -Eq '^ok [0-9]+ - passing named item check'`;
  for (const command of [named, 'yes | grep -q y', 'sh -c "exit 7" | tail -1']) {
    const item = repoWithGate('true', command);
    const baseline = JSON.parse(item.run('show', '1', '--json').stdout).item_check_baseline;
    assert.equal(baseline.result, 'green', 'background baselines preserve last-stage semantics');
    const checked = item.run('check', '1', '--yes');
    assert.equal(checked.status, 0, `${checked.stdout}${checked.stderr}`);
    const submitted = item.run('submit', '1', '--json');
    assert.equal(submitted.status, 0, `${submitted.stdout}${submitted.stderr}`);
    assert.equal(JSON.parse(submitted.stdout).gate.check.green, true, 'submission uses the same check semantics');
    const verified = privateCheck(item, command);
    assert.equal(verified.status, 0, JSON.stringify(verified));
    assert.equal(verified.error, null, 'the private verifier keeps its original shell behavior');
  }
});
