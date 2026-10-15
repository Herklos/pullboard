/** Browser admission follows current test dependencies without executing them [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { checkNeedsBrowser, testsNeedBrowser } from '../src/browser-admission.js';

const TEST_RUNNER = resolve(import.meta.dirname, '../bin/run-tests.js');

/** Create source files for a dependency graph whose modules must never execute during admission. */
function sourceFixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-browser-admission-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

/** Commit a private source fixture with a deterministic identity for immutable review coverage. */
function commitSourceFixture(root) {
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture']]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  assert.equal(head.status, 0, head.stderr);
  return head.stdout.trim();
}

test('ordinary focused tests need no browser and admission never executes their modules [C7]', async t => {
  const root = sourceFixture(t, {
    'test/plain.test.js': "import '../helper.js'; import assert from 'node:assert/strict';",
    'helper.js': "import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./executed', import.meta.url), 'bad');",
  });
  assert.equal(await testsNeedBrowser(root, ['./test/plain.test.js']), false);
  assert.equal(await testsNeedBrowser(root, [join(root, 'test/plain.test.js')]), false);
  assert.equal(existsSync(join(root, 'executed')), false);
});

test('a focused test acquires browser admission through its helper and current source edits [C7]', async t => {
  const root = sourceFixture(t, {
    'test/plain.test.js': "import '../helper.js';",
    'helper.js': "import assert from 'node:assert/strict';",
    'test/chrome-fixture.js': "throw new Error('admission must never launch or evaluate Chrome');",
  });
  assert.equal(await testsNeedBrowser(root, ['test/plain.test.js']), false);
  writeFileSync(join(root, 'helper.js'), "import './test/chrome-fixture.js';");
  assert.equal(await testsNeedBrowser(root, ['test/plain.test.js']), true,
    'admission reads the edited dependency, rather than a cached or committed graph');
});

test('full, cockpit and uncertain test selections reserve browser capacity [C7]', async t => {
  const root = sourceFixture(t, {
    'test/computed.test.js': "const module = './helper.js'; await import(module);",
    'test/broken.test.js': 'this is not valid javascript @',
  });
  for (const files of [undefined, [], ['test/cockpit/items.test.js'], ['test/missing.test.js'],
    ['test/computed.test.js'], ['test/broken.test.js'], [join(root, '../outside.test.js')]]) {
    assert.equal(await testsNeedBrowser(root, files), true);
  }
});

test('module launchers and dynamic builtins keep browser admission conservative [C7]', async t => {
  const root = sourceFixture(t, {
    'test/workers.test.js': "import { Worker } from 'node:worker_threads'; void Worker;",
    'test/cluster.test.js': "import cluster from 'node:cluster'; void cluster;",
    'test/vm.test.js': "import vm from 'node:vm'; void vm;",
    'test/builtin.test.js': "const builtin = process.getBuiltinModule('node:worker_threads'); void builtin;",
    'test/computed-builtin.test.js': "const builtin = process['getBuiltinModule']('node:cluster'); void builtin;",
    'test/computed-expression.test.js': "const builtin = process['get' + 'BuiltinModule']('node:worker_threads'); void builtin;",
    'test/escaped-builtin.test.js': "const builtin = process['getBuiltin\\u004dodule']('node:cluster'); void builtin;",
    'test/optional-builtin.test.js': "const builtin = process?.['getBuiltinModule']('node:cluster'); void builtin;",
    'test/destructured-builtin.test.js': "const { getBuiltinModule: load } = process; void load;",
    'test/computed-process-alias.test.js': "const proc = process; const builtin = proc[property]; void builtin;",
  });
  for (const file of ['workers', 'cluster', 'vm', 'builtin', 'computed-builtin', 'computed-expression',
    'escaped-builtin', 'optional-builtin', 'destructured-builtin', 'computed-process-alias']) {
    assert.equal(await testsNeedBrowser(root, [`test/${file}.test.js`]), true, file);
  }

  mkdirSync(join(root, 'src'), { recursive: true });
  copyFileSync(resolve(import.meta.dirname, '../src/module-imports.js'), join(root, 'src/module-imports.js'));
  writeFileSync(join(root, 'test/parser.test.js'), "import '../src/module-imports.js';\n");
  assert.equal(await testsNeedBrowser(root, ['test/parser.test.js']), false,
    'the reviewed V8 compile-only import parser may use node:vm without evaluating the test graph');
});

test('only actual CommonJS loader words trigger browser admission in JavaScript source [C7]', async t => {
  const root = sourceFixture(t, {
    'test/mentions.test.js': "// require('./chrome-fixture.js') and createRequire are only comments\nconst note = 'require createRequire';\nconst pattern = /require|createRequire/;",
    'test/require.test.js': 'const load = require;',
    'test/create-require.test.js': "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url);",
    'test/escaped-require.test.js': 'const load = requ\\u0069re;',
    'test/escaped-create-require.test.js': 'const load = createRequ\\u0069re;',
    'test/escaped-text.test.js': '// requ\\u0069re and createRequ\\u0069re are just comment text\nconst note = "requ\\u0069re createRequ\\u0069re";',
    'test/module-computed.test.js': "import * as runtime from 'node:module'; const load = runtime['create' + 'Require'];",
    'test/browser.test.cjs': "require('./chrome-fixture.js');",
  });
  assert.equal(await testsNeedBrowser(root, ['test/mentions.test.js']), false,
    'comments, strings, and regular-expression text do not represent CommonJS loading');
  assert.equal(await testsNeedBrowser(root, ['test/require.test.js']), true);
  assert.equal(await testsNeedBrowser(root, ['test/create-require.test.js']), true);
  assert.equal(await testsNeedBrowser(root, ['test/escaped-require.test.js']), true);
  assert.equal(await testsNeedBrowser(root, ['test/escaped-create-require.test.js']), true);
  assert.equal(await testsNeedBrowser(root, ['test/escaped-text.test.js']), false,
    'Unicode escape text in comments and strings does not represent an identifier');
  assert.equal(await testsNeedBrowser(root, ['test/module-computed.test.js']), true,
    'node:module can create a loader through aliases or computed properties');
  assert.equal(await testsNeedBrowser(root, ['test/browser.test.cjs']), true);
});

test('frozen checks classify only explicit source-backed test commands [C7]', async t => {
  const root = sourceFixture(t, {
    'test/plain.test.js': "import '../helper.js'; import assert from 'node:assert/strict';",
    'helper.js': "import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./executed', import.meta.url), 'bad');",
  });
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  cpSync(resolve(import.meta.dirname, '../src'), join(root, 'src'), { recursive: true });
  copyFileSync(TEST_RUNNER, join(root, 'bin/run-tests.js'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(root, 'test/resources.test.js'), "import { test } from 'node:test'; test('a non-browser check does not wait for the browser slot', () => {});\n");
  const command = 'out=$(node bin/run-tests.js --test-name-pattern "a non-browser check does not wait for the browser slot" test/resources.test.js 2>&1); printf "%s\\n" "$out"; printf "%s\\n" "$out" | grep -Eq "^[[:space:]]*ok [0-9]+ - .*a non-browser check does not wait for the browser slot" && printf "%s\\n" "$out" | grep -Eq "^# fail 0$"';
  const classifyEnv = { ...process.env, PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter) };
  assert.equal(await checkNeedsBrowser(root, command, { env: classifyEnv }), false);
  assert.equal(await checkNeedsBrowser(root, command, { env: classifyEnv }), false,
    'the supported captured runner form remains statically classifiable');

  const runnerPath = join(root, 'bin/run-tests.js');
  rmSync(runnerPath);
  symlinkSync('/bin/echo', runnerPath);
  const symlinkFallbacks = [];
  assert.equal(await checkNeedsBrowser(root, command, { env: classifyEnv, onFallback: decision => symlinkFallbacks.push(decision) }), true,
    'a symlinked runner outside the repository is browser-required');
  assert.equal(symlinkFallbacks[0].file, 'bin/run-tests.js');
  assert.match(symlinkFallbacks[0].reason, /regular in-repository file/u);
  rmSync(runnerPath);
  mkdirSync(runnerPath);
  assert.equal(await checkNeedsBrowser(root, command, { env: classifyEnv }), true, 'a directory runner fails closed');
  rmSync(runnerPath, { recursive: true, force: true });
  copyFileSync(TEST_RUNNER, runnerPath);
  for (const opaque of [
    'node bin/run-tests.js test/plain.test.js; touch side-effect',
    'node bin/run-tests.js test/*.test.js',
    'node bin/run-tests.js test/journeys.test.js',
    'node bin/run-tests.js test/cockpit/brief.test.js',
    'node --test-reporter spec bin/run-tests.js test/plain.test.js',
    'npm test',
  ]) assert.equal(await checkNeedsBrowser(root, opaque), true, opaque);

  copyFileSync(resolve(import.meta.dirname, './fixture-child.js'), join(root, 'test/fixture-child.js'));
  writeFileSync(join(root, 'test/known-fixture.test.js'), "import './fixture-child.js';\n");
  assert.equal(await testsNeedBrowser(root, ['test/known-fixture.test.js']), false,
    'the path-reviewed shared fixture child helper remains CPU-only');
  writeFileSync(join(root, 'test/fixture-child.js'), "import { spawn } from 'node:child_process'; spawn('git', ['status']);\n");
  assert.equal(await testsNeedBrowser(root, ['test/known-fixture.test.js']), false,
    'the reviewed path exception does not depend on a content hash');
  writeFileSync(join(root, 'test/fixture-child.js'), "import { spawn } from 'node:child_process'; spawn('google-chrome', []);\n");
  assert.equal(await testsNeedBrowser(root, ['test/known-fixture.test.js']), true,
    'a literal Chrome launcher still overrides the path exception');

  copyFileSync(resolve(import.meta.dirname, './fixture-child.js'), join(root, 'test/fixture-child.js'));
  writeFileSync(join(root, 'test/known-fixture.test.js'), "import { runFixtureGit as git } from './fixture-child.js';\n");
  assert.equal(await testsNeedBrowser(root, ['test/known-fixture.test.js']), false,
    'the narrowly reviewed fixed-Git helper remains CPU-only');

  for (const importer of [
    "import { runFixtureChild as child } from './fixture-child.js';\n",
    "import * as fixture from './fixture-child.js';\n",
    "import { runFixtureChild as child } from './fixture-child.js'; child(process.env.BROWSER_BIN, []);\n",
    "import * as fixture from './fixture-child.js'; fixture.runFixtureChild(process.env.BROWSER_BIN, []);\n",
    "export { runFixtureGit } from './fixture-child.js';\n",
    "const fixture = await import('./fixture-child.js');\n",
    "import fixture from './fixture-child.js';\n",
    "import './fixture-child.js';\nimport { runFixtureChild } from './fixture-child.js';\n",
    "import { runFixtureGit } from './fixture-child.js';\nimport { runFixtureChild } from './fixture-child.js';\n",
    "import { runFixtureGit } from './fixture-child.js';\nimport { runFixtureChild } from '.\\x2ffixture-child.js';\n",
  ]) {
    writeFileSync(join(root, 'test/known-fixture.test.js'), importer);
    const decisions = [];
    assert.equal(await testsNeedBrowser(root, ['test/known-fixture.test.js'], {
      onFallback: decision => decisions.push(decision),
    }), true, importer);
    assert.equal(decisions.length, 1, importer);
    assert.equal(decisions[0].file, 'test/known-fixture.test.js');
    assert.match(decisions[0].reason, /caller-selected process target/u);
  }

  writeFileSync(join(root, 'test/launcher.test.js'), "import { spawn } from 'node:child_process'; spawn('google-chrome', []);\n");
  const chromeFallbacks = [];
  assert.equal(await testsNeedBrowser(root, ['test/launcher.test.js'], { onFallback: decision => chromeFallbacks.push(decision) }), true,
    'a test source that names a Chrome launcher remains browser-required');
  assert.deepEqual(chromeFallbacks, [], 'known Chrome launchers reserve browser capacity without uncertainty diagnostics');
  writeFileSync(join(root, 'test/computed-launch.test.js'), "import { spawn } from 'node:child_process'; spawn(process.env.BROWSER, []);\n");
  const fallbackReasons = [];
  assert.equal(await testsNeedBrowser(root, ['test/computed-launch.test.js'], { onFallback: decision => fallbackReasons.push(decision) }), true,
    'an unknown computed child-process target remains browser-required');
  assert.equal(fallbackReasons.length, 1);
  assert.equal(fallbackReasons[0].file, 'test/computed-launch.test.js');
  assert.match(fallbackReasons[0].reason, /child_process/u);

  const commit = commitSourceFixture(root);
  assert.equal(await checkNeedsBrowser(root, command, { commit, env: classifyEnv }), false,
    'review admission reads test and runner blobs from the immutable commit');
  writeFileSync(join(root, 'helper.js'), "import './test/chrome-fixture.js';");
  assert.equal(await testsNeedBrowser(root, ['test/plain.test.js']), true, 'live checks follow the current checkout');
  assert.equal(await checkNeedsBrowser(root, command, { commit, env: classifyEnv }), false,
    'review checks follow the exact submitted commit rather than a later checkout edit');
});
