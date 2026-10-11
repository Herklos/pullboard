/** Exercise native test-file sharding through the production test runner [C7]. */
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runFixtureChild } from './fixture-child.js';

const runner = fileURLToPath(new URL('../bin/run-tests.js', import.meta.url));
const shardFileCount = 9;

/** Build a private runner checkout whose tests record the files Node actually selects. */
function makeShardFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-test-shards-')));
  const bin = join(root, 'bin');
  const source = join(root, 'src');
  const tests = join(root, 'test');
  mkdirSync(bin);
  mkdirSync(source);
  mkdirSync(tests);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  copyFileSync(runner, join(bin, 'run-tests.js'));
  for (const name of ['person.js', 'refused.js']) {
    copyFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), join(source, name));
  }
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
