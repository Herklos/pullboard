/** Browser admission follows current test dependencies without executing them [C7]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { testsNeedBrowser } from '../src/browser-admission.js';

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
