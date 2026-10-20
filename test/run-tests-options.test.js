/** Options the production runner cannot apply are refused by name, wherever they appear [C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runFixtureChild } from './fixture-child.js';

const runner = fileURLToPath(new URL('../bin/run-tests.js', import.meta.url));

test('an unknown option after the file is refused by name [C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-unknown-option-after-')); try {
    writeFileSync(join(root, 'option.test.mjs'), "import { test } from 'node:test';\ntest('a case runs', () => {});\n");
    const result = runFixtureChild(process.execPath, [runner, 'option.test.mjs', '--foo'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'an option the runner cannot apply must not exit green');
    assert.match(`${result.stdout}${result.stderr}`, /run-tests: unknown option --foo/u, 'the refusal names the option');
    assert.doesNotMatch(result.stdout, /a case runs/u, 'the file does not run silently');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--test-only after the file is refused by name [C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-test-only-after-')); try {
    writeFileSync(join(root, 'only.test.mjs'), "import { test } from 'node:test';\ntest('a case runs', () => {});\n");
    const result = runFixtureChild(process.execPath, [runner, 'only.test.mjs', '--test-only'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'an option the runner does not apply must not exit green');
    assert.match(`${result.stdout}${result.stderr}`, /run-tests: unknown option --test-only/u, 'the refusal names the option');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
