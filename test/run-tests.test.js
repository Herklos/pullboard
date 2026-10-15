/** Exercise native test-file sharding through the production test runner [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { startFixtureChild, runFixtureChild, runFixtureGit } from './fixture-child.js';
import { listResources } from '../src/resources.js';
import { selectAffectedTests } from '../src/affected-tests.js';

const runner = fileURLToPath(new URL('../bin/run-tests.js', import.meta.url));
const shardFileCount = 9;
const fixtureExitCeilingMs = '500';
const fixtureCleanupMs = '100';

/** Initialize a private fixture repository and stage exactly its intended tests. */
function stageFixtureTests(root, paths) {
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '--', ...paths], { cwd: root, stdio: 'ignore' });
}

/** Build a private runner checkout whose tests record the files Node actually selects. */
function makeShardFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-test-shards-')));
  const bin = join(root, 'bin');
  const source = join(root, 'src');
  const tests = join(root, 'test');
  mkdirSync(bin);
  mkdirSync(tests);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  copyFileSync(runner, join(bin, 'run-tests.js'));
  cpSync(fileURLToPath(new URL('../src', import.meta.url)), source, { recursive: true });
  const capture = join(root, 'selected-files.txt');
  const expected = [];
  for (let number = 1; number <= shardFileCount; number += 1) {
    const name = `shard-${String(number).padStart(2, '0')}.test.js`;
    expected.push(name);
    writeFileSync(join(tests, name), `import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
/** Record the actual file Node assigned to this shard. */
function recordSelectedFile() { appendFileSync(process.env.PULLBOARD_SHARD_CAPTURE, '${name}\\n'); }
test('record ${name} [C7]', recordSelectedFile);
`);
  }
  stageFixtureTests(root, expected.map(name => `test/${name}`));
  /** Remove the private runner tree after its child processes exit. */
  function cleanupFixture() {
    rmSync(root, { recursive: true, force: true });
  }
  t.after(cleanupFixture);
  return { root, capture, expected, runner: join(bin, 'run-tests.js') };
}

/** Build a copied production runner with tracked, ignored, and untracked test files. */
function makeTrackedSelectionFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-tracked-tests-')));
  const bin = join(root, 'bin');
  const source = join(root, 'src');
  const tests = join(root, 'test');
  const scratch = join(root, 'scratch');
  const expected = ['tracked', 'docs-esm'];
  mkdirSync(bin);
  mkdirSync(tests);
  mkdirSync(scratch);
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(root, '.gitignore'), 'scratch/\n');
  copyFileSync(runner, join(bin, 'run-tests.js'));
  cpSync(fileURLToPath(new URL('../src', import.meta.url)), source, { recursive: true });
  const capture = join(root, 'selected-files.txt');
  const trackedSources = new Map([
    ['test/tracked.test.js', trackedFixtureSource('tracked')],
    ['docs/guide.test.mjs', trackedFixtureSource('docs-esm')],
    ['prefix.test.js', trackedFixtureSource('dot-suffix')],
    ['prefix-test.cjs', trackedFixtureSource('dash-suffix')],
    ['prefix_test.mjs', trackedFixtureSource('underscore-suffix')],
    ['test-launch.js', trackedFixtureSource('test-prefix')],
    ['test.js', trackedFixtureSource('test-name')],
  ]);
  for (const [path, sourceText] of trackedSources) {
    writeFileSync(join(root, path), sourceText);
  }
  writeFileSync(join(root, 'tracked.spec.js'), `import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
/** Fail if a tracked but non-default filename is selected. */
function failIfNonDefaultRuns() { appendFileSync(process.env.PULLBOARD_TRACKED_CAPTURE, 'non-default\\n'); throw new Error('non-default test was executed'); }
test('tracked spec file must not run [C7]', failIfNonDefaultRuns);
`);
  writeFileSync(join(tests, 'untracked.test.js'), `import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
/** Fail if the runner discovers an untracked test from the worktree. */
function failIfUntrackedRuns() { appendFileSync(process.env.PULLBOARD_TRACKED_CAPTURE, 'untracked\\n'); throw new Error('untracked test was executed'); }
test('untracked test must not run [C7]', failIfUntrackedRuns);
`);
  writeFileSync(join(scratch, 'ignored.test.js'), `import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
/** Fail if the runner discovers an ignored test from scratch storage. */
function failIfIgnoredRuns() { appendFileSync(process.env.PULLBOARD_TRACKED_CAPTURE, 'ignored\\n'); throw new Error('ignored test was executed'); }
test('ignored test must not run [C7]', failIfIgnoredRuns);
`);
  stageFixtureTests(root, ['.gitignore', ...trackedSources.keys(), 'tracked.spec.js']);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, runner: join(bin, 'run-tests.js'), capture, expected };
}

/** Create a small ESM or CommonJS test that records its discovery-pattern label. */
function trackedFixtureSource(label) {
  if (label === 'dash-suffix') {
    return `const { appendFileSync } = require('node:fs');
const { test } = require('node:test');
/** Record one tracked default-pattern match. */
function recordTrackedMatch() { appendFileSync(process.env.PULLBOARD_TRACKED_CAPTURE, '${label}\\n'); }
test('tracked ${label} pattern ran [C7]', recordTrackedMatch);
`;
  }
  return `import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
/** Record one tracked default-pattern match. */
function recordTrackedMatch() { appendFileSync(process.env.PULLBOARD_TRACKED_CAPTURE, '${label}\\n'); }
test('tracked ${label} pattern ran [C7]', recordTrackedMatch);
`;
}

/** Ensure default discovery runs tracked tests but never filesystem-only copies. */
function trackedSelectionTest(t) {
  const fixture = makeTrackedSelectionFixture(t);
  assert.equal(execFileSync('git', ['check-ignore', '-q', 'scratch/ignored.test.js'], { cwd: fixture.root }).length, 0,
    'the failing scratch test is actually ignored by Git');
  const tracked = execFileSync('git', ['ls-files'], { cwd: fixture.root, encoding: 'utf8' }).trim().split(/\r?\n/u);
  assert.ok(tracked.includes('.gitignore') && tracked.includes('tracked.spec.js'), 'the non-default and ignore control files are tracked');
  assert.equal(tracked.length, 9, 'all pattern cases and non-default controls are tracked');
  const result = runFixtureChild(process.execPath, [fixture.runner], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, PULLBOARD_TRACKED_CAPTURE: fixture.capture },
  });
  assert.equal(result.status, 0,
    `${result.context}\nexecuted files: ${readFileSync(fixture.capture, 'utf8')}`);
  for (const label of fixture.expected) assert.match(result.stdout, new RegExp(`ok [0-9]+ - tracked .*${label}.* pattern ran \\[C7\\]`, 'u'));
  assert.doesNotMatch(`${result.stdout}\n${result.stderr ?? ''}`, /ignored test was executed|untracked test was executed|non-default test was executed/u);
  assert.deepEqual(readFileSync(fixture.capture, 'utf8').trim().split(/\r?\n/u).sort(),
    fixture.expected.toSorted(),
    'only repository test entry names run exactly once');

  writeFileSync(fixture.capture, '');
  const filtered = runFixtureChild(process.execPath, [fixture.runner, '--test-name-pattern', 'docs-esm'], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, PULLBOARD_TRACKED_CAPTURE: fixture.capture },
  });
  assert.equal(filtered.status, 0, filtered.context);
  assert.match(filtered.stdout, /ok [0-9]+ - tracked docs-esm pattern ran \[C7\]/u,
    'name filters still apply to the tracked default list');
  assert.equal(readFileSync(fixture.capture, 'utf8'), 'docs-esm\n');

  const explicit = runFixtureChild(process.execPath, [fixture.runner, 'test/untracked.test.js'], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, PULLBOARD_TRACKED_CAPTURE: fixture.capture },
  });
  assert.equal(explicit.status, 1, explicit.context);
  assert.match(explicit.stdout, /not ok [0-9]+ - untracked test must not run \[C7\]/u,
    'an explicitly named fixture remains runnable even though it is untracked');
}

test('the runner skips test files git does not track [C7]', trackedSelectionTest);

/** Keep perf-shaped helpers importable without launching their standalone entry points. */
function onlyTestEntriesTest(t) {
  const fixture = makeShardFixture(t);
  const env = { ...process.env, PULLBOARD_SHARD_CAPTURE: fixture.capture,
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };
  /** Write one tracked fixture input with its real repository-relative path. */
  const put = (path, body) => {
    mkdirSync(dirname(join(fixture.root, path)), { recursive: true });
    writeFileSync(join(fixture.root, path), body);
  };
  /** Commit the fixture graph so the selector reads immutable Git objects. */
  const commit = () => {
    runFixtureGit(['add', '-A'], { cwd: fixture.root, env });
    runFixtureGit(['commit', '-qm', 'chore: discovery fixture'], { cwd: fixture.root, env });
    return runFixtureGit(['rev-parse', 'HEAD'], { cwd: fixture.root, env }).trim();
  };
  const helpers = ['test/cockpit/perf/run.mjs', 'test/cockpit/perf/generate.mjs',
    'test/cockpit/fixture.js', 'test/view-link-fixture.js'];
  put('.gitignore', 'selected-files.txt\n');
  for (const path of helpers) put(path, `import { fileURLToPath } from 'node:url';
export const value = 42;
if (process.argv[1] === fileURLToPath(import.meta.url)) throw new Error('standalone helper: ${path}');
`);
  put('test/cockpit/perf.test.js', `import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
import { value as run } from './perf/run.mjs';
import { value as generate } from './perf/generate.mjs';
import { value as fixture } from './fixture.js';
import { value as link } from '../view-link-fixture.js';
/** Exercise every imported helper without its standalone workload. */
function importedHelpersWork() { assert.deepEqual([run, generate, fixture, link], [42,42,42,42]); appendFileSync(process.env.PULLBOARD_SHARD_CAPTURE, 'cockpit/perf.test.js\\n'); }
test('perf helpers remain importable [C7]', importedHelpersWork);
`);
  put('docs/guide.test.mjs', "import { test } from 'node:test';\nimport { appendFileSync } from 'node:fs';\n/** Exercise a named documentation test entry. */\nfunction guide() { appendFileSync(process.env.PULLBOARD_SHARD_CAPTURE, 'docs/guide.test.mjs\\n'); }\ntest('documentation test entry [C7]', guide);\n");
  put('test/tree-reader.test.js', "/** @pullboard-test-input test-tree */\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.PULLBOARD_SHARD_CAPTURE, 'tree-reader.test.js\\n');\n");
  put('test/cockpit/perf/README.md', '# Perf harness\n');
  const base = commit();
  const discovered = runFixtureChild(process.execPath, [fixture.runner], {
    cwd: fixture.root, encoding: 'utf8', env,
  });
  assert.equal(discovered.status, 0, `${discovered.context}\n${discovered.stdout}`);
  assert.doesNotMatch(discovered.stdout + discovered.stderr, /standalone helper:/u);
  assert.match(discovered.stdout, /ok [0-9]+ - perf helpers remain importable/u);
  assert.match(discovered.stdout, /ok [0-9]+ - documentation test entry/u);
  assert.deepEqual(readFileSync(fixture.capture, 'utf8').trim().split('\n').sort(),
    [...fixture.expected, 'cockpit/perf.test.js', 'docs/guide.test.mjs', 'tree-reader.test.js'].sort(),
    'each expected test entry executes once, including a file with only a tree-reader declaration');
  const entries = [...fixture.expected.map(name => `test/${name}`),
    'test/cockpit/perf.test.js', 'docs/guide.test.mjs', 'test/tree-reader.test.js'];
  const before = runFixtureChild(process.execPath, [fixture.runner, ...entries, ...helpers], {
    cwd: fixture.root, encoding: 'utf8', env,
  });
  assert.equal(before.status, 1, 'the old broad file list launches the standalone-only helper controls');
  assert.match(before.stdout, /standalone helper:/u);
  const expectedCases = [...fixture.expected.map(name => `record ${name} [C7]`),
    'perf helpers remain importable [C7]', 'documentation test entry [C7]'].sort();
  /** Separate declared case titles from Node's synthetic path-only test-file records. */
  const declaredCases = output => [...output.matchAll(/^# Subtest: (.+)$/gmu)].map(match => match[1])
    .filter(name => ![...entries, ...helpers].some(path => name === path || name.endsWith('/' + path))).sort();
  assert.deepEqual(declaredCases(before.stdout), expectedCases, 'the old broad list runs every declared case');
  assert.deepEqual(declaredCases(discovered.stdout), expectedCases, 'test-only discovery preserves every declared case');
  const beforeTotal = Number(before.stdout.match(/^# tests (\d+)$/mu)?.[1]);
  const afterTotal = Number(discovered.stdout.match(/^# tests (\d+)$/mu)?.[1]);
  assert.equal(beforeTotal, afterTotal + helpers.length,
    'only the standalone helper-file records disappear from the raw TAP total');
  process.stderr.write(`fixture declared cases: before=${expectedCases.length}, after=${expectedCases.length}; raw TAP: before=${beforeTotal}, after=${afterTotal}; helper records removed=${helpers.length}\n`);
  put('test/cockpit/perf/README.md', '# Updated harness instructions\n');
  const head = commit();
  const readme = selectAffectedTests(fixture.root, { base, commit: head });
  assert.equal(readme.full, false, 'an unread test README does not force the full gate');
  assert.deepEqual(readme.files, [], 'an unread README does not activate the test-tree scanner');
  assert.equal(selectAffectedTests(fixture.root, {
    base, commit: head, changed: ['test/cockpit/perf/unknown.json'],
  }).full, true, 'unknown test assets still require the full gate');
  put('test/cockpit/readme-helper.js', "import { readFileSync } from 'node:fs';\nexport const instructions = readFileSync(new URL('./perf/README.md', import.meta.url), 'utf8');\n");
  put('test/cockpit/readme-reader.test.js', "import './readme-helper.js';\n");
  put('test/cockpit/joined-helper.js', "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nexport const instructions = readFileSync(join('test', 'cockpit', 'perf', 'README.md'), 'utf8');\n");
  put('test/cockpit/escaped-helper.js', "import { readFileSync } from 'node:fs';\nexport const instructions = readFileSync(new URL('./perf/REA\\x44ME.md', import.meta.url), 'utf8');\n");
  for (const name of ['joined', 'escaped']) {
    put(`test/cockpit/${name}-reader.test.js`, `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { instructions } from './${name}-helper.js';
/** Read and assert the actual fixture README through the helper. */
function readInstructions() { assert.match(instructions, /Updated harness instructions/u); }
test('${name} README reader [C7]', readInstructions);
`);
  }
  const readerBase = commit();
  const readerRun = runFixtureChild(process.execPath, [fixture.runner,
    'test/cockpit/joined-reader.test.js', 'test/cockpit/escaped-reader.test.js'], {
    cwd: fixture.root, encoding: 'utf8', env,
  });
  assert.equal(readerRun.status, 0, `${readerRun.context}\n${readerRun.stdout}`);
  assert.match(readerRun.stdout, /^# tests 2$/mu, 'both literal readers actually execute their filesystem reads');
  put('test/cockpit/readme-helper.js', "export const instructions = 'reader removed';\n");
  put('test/cockpit/perf/README.md', '# Instructions after reader removal\n');
  const readerHead = commit();
  const readers = selectAffectedTests(fixture.root, {
    base: readerBase, commit: readerHead, changed: ['test/cockpit/perf/README.md'],
  });
  assert.equal(readers.full, false);
  assert.deepEqual(readers.files, ['test/cockpit/escaped-reader.test.js', 'test/cockpit/joined-reader.test.js', 'test/cockpit/readme-reader.test.js'],
    'real literal readers and the removed helper edge remain selected, without test-tree-wide widening');
}

test('the suite runs only test files, not helpers or the perf harness [C7]', onlyTestEntriesTest);

/** Run the copied production runner and return the test filenames it actually executed. */
function runShardFixture(fixture, shard) {
  writeFileSync(fixture.capture, '');
  const args = [fixture.runner, ...(shard ? ['--shard', shard] : [])];
  const env = { ...process.env, PULLBOARD_SHARD_CAPTURE: fixture.capture };
  delete env.NODE_TEST_CONTEXT;
  delete env.PULLBOARD_GATE_SLOT_HELD;
  assert.equal(env.PULLBOARD_GATE_SLOT_HELD, undefined, 'the private default-run probe does not inherit an outer gate lease');
  const result = runFixtureChild(process.execPath, args, {
    cwd: fixture.root,
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 0, result.context);
  return readFileSync(fixture.capture, 'utf8').trim().split('\n').filter(Boolean);
}

/** Prove the default run stays whole and all native shard selections partition files once. */
function shardsSplitTest(t) {
  const fixture = makeShardFixture(t);
  const unsharded = runShardFixture(fixture, null);
  assert.deepEqual([...unsharded].sort(), fixture.expected, 'without --shard every discovered file still runs');
  const shards = [];
  for (let index = 1; index <= 3; index += 1) {
    const selected = runShardFixture(fixture, `${index}/3`);
    assert.ok(selected.length > 0, `shard ${index}/3 runs fixture files`);
    shards.push(selected);
  }
  const allSelected = shards.flat();
  assert.deepEqual([...allSelected].sort(), fixture.expected, 'three native shards cover every discovered file');
  assert.equal(new Set(allSelected).size, fixture.expected.length, 'no test file appears in more than one shard');
}

test('shards split the test files with none twice and none missing [C7]', shardsSplitTest);

/** Keep plain temporary projects runnable without requiring a Git index. */
function outsideGitDiscoveryTest(t) {
  const fixture = makeShardFixture(t);
  rmSync(join(fixture.root, '.git'), { recursive: true, force: true });
  const selected = runShardFixture(fixture, null);
  assert.deepEqual([...selected].sort(), fixture.expected,
    'without a Git work tree Node still discovers and executes every fixture test');

  writeFileSync(fixture.capture, '');
  writeFileSync(join(fixture.root, '.git'), 'gitdir: missing-git-directory\n');
  const broken = runFixtureChild(process.execPath, [fixture.runner], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, PULLBOARD_SHARD_CAPTURE: fixture.capture },
  });
  assert.equal(broken.status, 1, broken.context);
  assert.match(broken.stderr, /could not list tracked test files/u,
    'a damaged checkout is refused rather than mistaken for an ordinary non-Git folder');
  assert.equal(readFileSync(fixture.capture, 'utf8'), '', 'no filesystem tests run after Git metadata fails');
}

test('the runner keeps native discovery outside a Git work tree [C7]', outsideGitDiscoveryTest);

/** Assert the production runner names malformed shard ranges and their expected form. */
function badShardTest() {
  const badValues = ['0/3', '4/3', '2', 'a/b'];
  for (const value of badValues) {
    const result = runFixtureChild(process.execPath, [runner, '--shard', value], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.context);
    assert.match(result.stderr, new RegExp(`invalid --shard value "${value}"`));
    assert.match(result.stderr, /expected <i>\/<n> with 1 <= i <= n/u);
  }
}

test('a bad shard is refused by name [C7]', badShardTest);

/** Build an isolated production-runner fixture with the source imports it needs. */
function makeFileExitFixture(t, source) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-test-file-exit-')));
  const bin = join(root, 'bin');
  const tests = join(root, 'test');
  mkdirSync(bin);
  mkdirSync(tests);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  copyFileSync(runner, join(bin, 'run-tests.js'));
  cpSync(fileURLToPath(new URL('../src', import.meta.url)), join(root, 'src'), { recursive: true });
  const testFile = join(tests, 'file-exit.test.js');
  writeFileSync(testFile, source);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root, runner: join(bin, 'run-tests.js'), testFile,
    cleanupFile: join(root, 'cleanup.txt'), portFile: join(root, 'port.txt'),
  };
}

/** Run one fixture file with a bounded ceiling and clean up its process group if it hangs. */
function runFileExitFixture(fixture) {
  const result = runFixtureChild(process.execPath, [fixture.runner, fixture.testFile], {
    cwd: fixture.root,
    detached: true,
    encoding: 'utf8',
    env: {
      ...process.env,
      PULLBOARD_TEST_FILE_TIMEOUT_MS: fixtureExitCeilingMs,
      PULLBOARD_FILE_EXIT_CLEANUP: fixture.cleanupFile,
      PULLBOARD_FILE_EXIT_PORT: fixture.portFile,
    },
    timeout: 6_000,
  });
  if (result.error?.code === 'ETIMEDOUT' && result.pid) {
    try { process.kill(-result.pid, 'SIGKILL'); } catch { /* The owned fixture process group already exited. */ }
  }
  return result;
}

/** Combine native test output and the production runner's file-exit diagnostic. */
function outputOf(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

test('a test file that won\'t exit fails by name [C7]', (t) => {
  const fixture = makeFileExitFixture(t, `import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { after, test } from 'node:test';
const server = createServer((_request, response) => response.end('ok'));
test('leave cleanup active [C7]', () => {});
/** Open the listener only after watchdog arming, then leave the root cleanup hook stuck. */
after(async () => {
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  writeFileSync(process.env.PULLBOARD_FILE_EXIT_PORT, String(server.address().port));
  await new Promise(() => {});
});
`);
  const result = runFileExitFixture(fixture);
  const output = outputOf(result);
  const port = readFileSync(fixture.portFile, 'utf8').trim();
  assert.equal(result.status, 1, result.context);
  assert.ok(result.elapsedMs >= Number(fixtureExitCeilingMs), `the process remains through its ${fixtureExitCeilingMs}ms file ceiling: ${result.elapsedMs}ms`);
  assert.ok(result.elapsedMs < 5_000, `the runner terminates the stuck cleanup within the 5-second bound: ${result.elapsedMs}ms`); // budget: 500ms file ceiling plus Node startup and CI scheduling allowance.
  assert.match(output, /test file ".*file-exit\.test\.js" failed: its process did not exit within 500ms file-exit timeout/u);
  assert.match(output, /live-handle snapshot age: [0-9]+ms \((?:latest responsive snapshot|fallback; main thread did not answer)\)/u);
  assert.ok(output.includes(`127.0.0.1:${port}`), `the diagnostic names its listening port ${port}: ${output}`);
  assert.match(output, /live handles:.*Server/u);
  assert.match(output, /leave cleanup active \[C7\]/u);
});

test('a file that exits cleanly is not touched [C7]', (t) => {
  const fixture = makeFileExitFixture(t, `import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { after, test } from 'node:test';
const server = createServer((_request, response) => response.end('ok'));
test('clean test file exits [C7]', () => {});
after(async () => {
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  writeFileSync(process.env.PULLBOARD_FILE_EXIT_PORT, String(server.address().port));
  await new Promise((ready, reject) => server.close((error) => error ? reject(error) : ready()));
  await new Promise((ready) => setTimeout(ready, ${fixtureCleanupMs}));
  writeFileSync(process.env.PULLBOARD_FILE_EXIT_CLEANUP, 'done');
});
`);
  const result = runFileExitFixture(fixture);
  const output = outputOf(result);
  assert.equal(result.status, 0, result.context);
  assert.equal(result.signal, null, 'a clean test file is never killed by the watchdog');
  assert.equal(readFileSync(fixture.cleanupFile, 'utf8'), 'done', 'asynchronous cleanup within the ceiling completes normally');
  assert.ok(readFileSync(fixture.portFile, 'utf8').trim(), 'the cleanup listener was opened after watchdog arming');
  assert.doesNotMatch(output, /file-exit timeout/u);
});

test('a nested suite cleanup cannot hold a completed file open [C7]', (t) => {
  const fixture = makeFileExitFixture(t, `import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { after, describe, test } from 'node:test';
describe('outer suite [C7]', () => {
  describe('inner suite [C7]', () => {
    test('last nested leaf finished [C7]', () => {
      writeFileSync(process.env.PULLBOARD_FILE_EXIT_CLEANUP, 'leaf finished');
    });
    after(async () => {
      const server = createServer((_request, response) => response.end('ok'));
      await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
      writeFileSync(process.env.PULLBOARD_FILE_EXIT_PORT, String(server.address().port));
      await new Promise(() => {});
    });
  });
});
`);
  const result = runFileExitFixture(fixture);
  const output = outputOf(result);
  const port = readFileSync(fixture.portFile, 'utf8').trim();
  assert.equal(readFileSync(fixture.cleanupFile, 'utf8'), 'leaf finished');
  assert.equal(result.status, 1, result.context);
  assert.ok(result.elapsedMs >= Number(fixtureExitCeilingMs), `nested cleanup reaches the ${fixtureExitCeilingMs}ms ceiling: ${result.elapsedMs}ms`);
  assert.ok(result.elapsedMs < 5_000, `nested cleanup is terminated before the independent fixture bound: ${result.elapsedMs}ms`); // budget: 500ms ceiling plus Node startup and CI scheduling allowance.
  assert.match(output, /test file ".*file-exit\.test\.js" failed: its process did not exit within 500ms file-exit timeout/u);
  assert.ok(output.includes(`127.0.0.1:${port}`), `nested cleanup diagnostic names the actual listening port ${port}: ${output}`);
  assert.match(output, /live handles:.*Server/u);
  assert.match(output, /ok [0-9]+ - last nested leaf finished \[C7\]/u);
});

test('clean nested cleanup and a later active test keep their own time [C7]', (t) => {
  const fixture = makeFileExitFixture(t, `import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { after, describe, test } from 'node:test';
describe('clean suite [C7]', () => {
  test('first nested leaf finished [C7]', () => {});
  after(async () => {
    const server = createServer((_request, response) => response.end('ok'));
    await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
    writeFileSync(process.env.PULLBOARD_FILE_EXIT_PORT, String(server.address().port));
    await new Promise((ready, reject) => server.close((error) => error ? reject(error) : ready()));
    await new Promise((ready) => setTimeout(ready, ${fixtureCleanupMs}));
    writeFileSync(process.env.PULLBOARD_FILE_EXIT_CLEANUP, 'done');
  });
});

test('later active body uses its per-test ceiling [C7]', async () => {
  await new Promise((ready) => setTimeout(ready, 650)); // budget: exceed the 500ms file-exit ceiling while a real test body is active.
});
`);
  const result = runFileExitFixture(fixture);
  const output = outputOf(result);
  assert.equal(result.status, 0, result.context);
  assert.equal(result.signal, null, 'normal nested cleanup and the next body are never killed');
  assert.equal(readFileSync(fixture.cleanupFile, 'utf8'), 'done', 'nested cleanup completes normally within its ceiling');
  assert.ok(readFileSync(fixture.portFile, 'utf8').trim(), 'the nested cleanup opens a real listener');
  assert.match(output, /ok [0-9]+ - later active body uses its per-test ceiling \[C7\]/u);
  assert.doesNotMatch(output, /file-exit timeout/u);
});

/** Wait for an observable fixture state; the bound is a hang ceiling, not a timing claim. */
async function waitForFocusedPoolState(predicate, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${description} [C7 hang ceiling ${timeoutMs}ms]`);
}

/** Create fixture files that exercise direct and nested focused runner processes. */
function makeFocusedPoolFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-focused-pool-')));
  const bin = join(root, 'bin');
  const tests = join(root, 'test');
  const machine = join(root, 'machine');
  mkdirSync(bin);
  mkdirSync(tests);
  mkdirSync(machine);
  writeFileSync(join(machine, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  copyFileSync(runner, join(bin, 'run-tests.js'));
  cpSync(fileURLToPath(new URL('../src', import.meta.url)), join(root, 'src'), { recursive: true });
  const ready = join(root, 'first-ready');
  const nestedDone = join(root, 'nested-done');
  const release = join(root, 'release-first');
  const firstDone = join(root, 'first-done');
  const secondStarted = join(root, 'second-started');
  writeFileSync(join(tests, 'nested.test.js'), `import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
test('nested focused run inherits the held slot [C7]', () => {
  if (process.env.PULLBOARD_GATE_SLOT_HELD !== '1') throw new Error('nested run lost its held-slot marker');
  writeFileSync(process.env.PULLBOARD_C7_NESTED_DONE, 'nested completed');
});
`);
  writeFileSync(join(tests, 'hold.test.js'), `import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
test('focused holder remains live through nested run [C7]', async () => {
  writeFileSync(process.env.PULLBOARD_C7_FIRST_READY, 'ready');
  const env = { ...process.env, PULLBOARD_MACHINE_HOME: process.env.PULLBOARD_C7_POOL };
  const nested = spawnSync(process.execPath, [process.env.PULLBOARD_C7_RUNNER, 'test/nested.test.js'], {
    cwd: process.env.PULLBOARD_C7_ROOT, env, encoding: 'utf8', timeout: 10000,
  });
  if (nested.error || nested.status !== 0) throw new Error('nested focused runner failed: ' + (nested.error?.message ?? nested.stderr));
  if (!existsSync(process.env.PULLBOARD_C7_NESTED_DONE)) throw new Error('nested run produced no completion marker');
  while (!existsSync(process.env.PULLBOARD_C7_RELEASE)) await new Promise(resolve => setTimeout(resolve, 10));
  writeFileSync(process.env.PULLBOARD_C7_FIRST_DONE, 'first completed');
});
`);
  writeFileSync(join(tests, 'second.test.js'), `import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
test('second focused run starts after the slot is released [C7]', () => {
  writeFileSync(process.env.PULLBOARD_C7_SECOND_STARTED, 'second started');
});
`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, runner: join(bin, 'run-tests.js'), machine, ready, nestedDone, release, firstDone, secondStarted };
}

/** Launch one direct fixture runner with an explicit, cleared inherited-slot marker. */
function launchFocusedPoolRunner(fixture, testFile, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv, PULLBOARD_MACHINE_HOME: fixture.machine };
  delete env.PULLBOARD_GATE_SLOT_HELD;
  delete env.PULLBOARD_AGENT;
  const child = startFixtureChild(process.execPath, [fixture.runner, testFile], {
    cwd: fixture.root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout?.setEncoding('utf8').on('data', (part) => { child.stdoutText += part; });
  child.stderr?.setEncoding('utf8').on('data', (part) => { child.stderrText += part; });
  child.closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  return child;
}

test('a legacy held marker alone cannot bypass focused test admission [C7]', t => {
  const fixture = makeFocusedPoolFixture(t);
  const env = {
    ...process.env,
    PULLBOARD_MACHINE_HOME: fixture.machine,
    PULLBOARD_GATE_SLOT_HELD: '1',
    PULLBOARD_C7_SECOND_STARTED: fixture.secondStarted,
  };
  for (const key of ['PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  const result = runFixtureChild(process.execPath, [fixture.runner, 'test/second.test.js'], {
    cwd: fixture.root, env, encoding: 'utf8',
  });
  assert.equal(result.status, 1, 'a self-declared legacy marker does not prove a live reservation');
  assert.match(result.stderr, /live machine gate lease/u);
  assert.equal(existsSync(fixture.secondStarted), false, 'the unadmitted test never starts');
});

/** Read the real machine queue from the fixture pool while preserving this test process's environment. */
function focusedPoolSnapshot(machine) {
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = machine;
  try { return listResources({ scope: 'machine' }).find((resource) => resource.name === 'gate'); }
  finally {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
  }
}

/** Stop only children owned by this test, releasing the held test before signaling its process group. */
async function stopFocusedPoolChild(child, fixture) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    try { writeFileSync(fixture.release, 'release'); } catch { /* The fixture may already be removed during teardown. */ }
    try { process.kill(-child.pid, 'SIGTERM'); }
    catch {
      try { child.kill('SIGTERM'); } catch { /* The owned process already exited. */ }
    }
    const deadline = Date.now() + 1000; // [C7] cleanup ceiling for an owned fixture process group.
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch {
        try { child.kill('SIGKILL'); } catch { /* The owned process already exited. */ }
      }
    }
  }
  await focusedPoolCloseWithin(child, 'owned fixture process cleanup', 2000);
}

/** Bound completion waits and always clear the watchdog timer. */
async function focusedPoolCloseWithin(child, label, timeoutMs = 30_000) {
  let timer;
  try {
    return await Promise.race([
      child.closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not close [C7 hang ceiling ${timeoutMs}ms]`)), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

test('a focused test run holds a gate slot [C7]', async (t) => {
  const fixture = makeFocusedPoolFixture(t);
  const commonEnv = {
    PULLBOARD_C7_POOL: fixture.machine,
    PULLBOARD_C7_ROOT: fixture.root,
    PULLBOARD_C7_RUNNER: fixture.runner,
    PULLBOARD_C7_FIRST_READY: fixture.ready,
    PULLBOARD_C7_NESTED_DONE: fixture.nestedDone,
    PULLBOARD_C7_RELEASE: fixture.release,
    PULLBOARD_C7_FIRST_DONE: fixture.firstDone,
    PULLBOARD_C7_SECOND_STARTED: fixture.secondStarted,
  };
  let first;
  let second;
  let testFailure;
  try {
    first = launchFocusedPoolRunner(fixture, 'test/hold.test.js', commonEnv);
    await waitForFocusedPoolState(() => existsSync(fixture.ready), 'the first focused test readiness marker');
    const firstPool = focusedPoolSnapshot(fixture.machine);
    assert.ok(firstPool, 'the focused run creates the machine gate resource');
    assert.equal(firstPool.capacity, 1);
    assert.deepEqual(firstPool.holders.map(({ agent }) => agent), [`pid-${first.pid}`],
      'the direct focused-runner process is the actual gate holder');
    await waitForFocusedPoolState(() => existsSync(fixture.nestedDone), 'the nested held-slot focused run');
    assert.equal(first.exitCode, null, 'the first focused run still owns its slot after nested completion');
    assert.deepEqual(focusedPoolSnapshot(fixture.machine).holders.map(({ agent }) => agent), [`pid-${first.pid}`],
      'the nested run did not acquire a second lease or displace its parent');

    second = launchFocusedPoolRunner(fixture, 'test/second.test.js', commonEnv);
    const observed = await waitForFocusedPoolState(() => {
      const pool = focusedPoolSnapshot(fixture.machine);
      const waiter = pool?.line.find(({ agent }) => agent === `pid-${second.pid}`);
      return waiter || existsSync(fixture.secondStarted);
    }, 'the second runner to enter the queue or expose an unexpected execution marker');
    assert.equal(typeof observed, 'object', 'a second direct focused run must become an actual queue waiter');
    assert.equal(existsSync(fixture.secondStarted), false, 'the queued second test has not executed while the first holds the slot');
    await waitForFocusedPoolState(() => second.stderrText.includes('waiting for a gate slot: 1 of 1 in use'),
      'the second runner wait announcement');
    assert.match(second.stderrText, /waiting for a gate slot: 1 of 1 in use/u,
      'the focused runner reports its actual slot wait');
    assert.deepEqual(focusedPoolSnapshot(fixture.machine).holders.map(({ agent }) => agent), [`pid-${first.pid}`]);

    writeFileSync(fixture.release, 'release');
    const firstResult = await focusedPoolCloseWithin(first, 'first focused run');
    const secondResult = await focusedPoolCloseWithin(second, 'second focused run');
    assert.equal(firstResult.code, 0, `${first.stderrText}${first.stdoutText}`);
    assert.equal(firstResult.signal, null);
    assert.equal(secondResult.code, 0, `${second.stderrText}${second.stdoutText}`);
    assert.equal(secondResult.signal, null);
    assert.equal(readFileSync(fixture.firstDone, 'utf8'), 'first completed');
    assert.equal(readFileSync(fixture.secondStarted, 'utf8'), 'second started');
  } catch (error) {
    testFailure = error;
  }
  let cleanupFailure;
  for (const child of [first, second]) {
    try { await stopFocusedPoolChild(child, fixture); }
    catch (error) { cleanupFailure ??= error; }
  }
  if (testFailure) throw testFailure;
  if (cleanupFailure) throw cleanupFailure;
});
