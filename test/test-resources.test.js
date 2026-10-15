/** Browser admission follows current test dependencies without executing them [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    'the hash-pinned shared fixture child helper remains CPU-only');
  writeFileSync(join(root, 'test/fixture-child.js'), "import { spawn } from 'node:child_process'; spawn('google-chrome', []);\n");
  assert.equal(await testsNeedBrowser(root, ['test/known-fixture.test.js']), true,
    'changing an allowlisted helper invalidates its source hash and detects the Chrome launcher');

  writeFileSync(join(root, 'test/launcher.test.js'), "import { spawn } from 'node:child_process'; spawn('google-chrome', []);\n");
  assert.equal(await testsNeedBrowser(root, ['test/launcher.test.js']), true,
    'a test source that names a Chrome launcher remains browser-required');
  writeFileSync(join(root, 'test/computed-launch.test.js'), "import { spawn } from 'node:child_process'; spawn(process.env.BROWSER, []);\n");
  assert.equal(await testsNeedBrowser(root, ['test/computed-launch.test.js']), true,
    'an unknown computed child-process target remains browser-required');

  const commit = commitSourceFixture(root);
  assert.equal(await checkNeedsBrowser(root, command, { commit, env: classifyEnv }), false,
    'review admission reads test and runner blobs from the immutable commit');
  writeFileSync(join(root, 'helper.js'), "import './test/chrome-fixture.js';");
  assert.equal(await testsNeedBrowser(root, ['test/plain.test.js']), true, 'live checks follow the current checkout');
  assert.equal(await checkNeedsBrowser(root, command, { commit, env: classifyEnv }), false,
    'review checks follow the exact submitted commit rather than a later checkout edit');
});
