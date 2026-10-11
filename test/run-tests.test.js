/** Exercise native test-file sharding through the production test runner [C7]. */
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runFixtureChild } from './fixture-child.js';

const runner = fileURLToPath(new URL('../bin/run-tests.js', import.meta.url));
const shardFileCount = 9;
const fixtureExitCeilingMs = '500';
const fixtureCleanupMs = '100';

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
  /** Remove the private runner tree after its child processes exit. */
  function cleanupFixture() {
    rmSync(root, { recursive: true, force: true });
  }
  t.after(cleanupFixture);
  return { root, capture, expected, runner: join(bin, 'run-tests.js') };
}

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
