/** Keep test timing judgments accountable to their actual work [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { wallClockViolations } from './wall-clock-budgets.js';

test('the clock-margin guard follows separately captured clock readings [C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-clock-readings-'));
  try {
    const file = join(root, 'readings.test.js');
    const source = 'const startedAt = Date.now();\nconst finishedAt = Date.now();\nassert.ok(finishedAt - startedAt < 30_000);\n';
    writeFileSync(file, source);
    assert.match(wallClockViolations(root).join('\n'), /readings\.test\.js:3: literal elapsed-time margin/u);
    writeFileSync(file, source.replace('< 30_000);', '< 30_000); // budget: declared observation window is 30000ms.'));
    assert.deepEqual(wallClockViolations(root), [], 'the asserted margin accepts its same-line reason');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the clock-margin guard follows a fixed wait result into a later assertion [C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-wait-result-'));
  try {
    const file = join(root, 'wait-result.test.js');
    const source = '/** Return false when the child-close deadline wins. */\nfunction childClosesWithin(child, timeoutMs) { return new Promise(resolve => { child.once("close", () => resolve(true)); setTimeout(() => resolve(false), timeoutMs); }); }\nconst closed = await childClosesWithin(child, 1500);\nassert.equal(closed, true);\n';
    writeFileSync(file, source);
    assert.match(wallClockViolations(root).join('\n'), /wait-result\.test\.js:4: literal wait result judged by an assertion/u);
    writeFileSync(file, source.replace('assert.equal(closed, true);', 'assert.equal(closed, true); // budget: hang ceiling for the child-close handshake.'));
    assert.deepEqual(wallClockViolations(root), [], 'the later judgment accepts its same-line reason');
    writeFileSync(file, source.replace('assert.equal(closed, true);', ''));
    assert.deepEqual(wallClockViolations(root), [], 'an unasserted cleanup result is not a timing judgment');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('no test judges work by a fixed wall-clock margin [C7]', () => {
  assert.deepEqual(wallClockViolations(fileURLToPath(new URL('..', import.meta.url))), []);
});

test('the clock-margin guard catches planted source and names its file and line [C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-wall-clock-'));
  try {
    mkdirSync(join(root, 'nested'));
    const file = join(root, 'nested', 'planted.test.mjs');
    const bare = 'const start = Date.now();\nassert.ok(Date.now() - start < 30_000);\n';
    writeFileSync(file, bare);
    assert.match(wallClockViolations(root).join('\n'), /nested\/planted\.test\.mjs:2: literal elapsed-time margin/u);
    assert.throws(() => assert.deepEqual(wallClockViolations(root), []), error =>
      error.code === 'ERR_ASSERTION' && /nested\/planted\.test\.mjs:2/u.test(error.message), 'a planted bare clock margin makes the real guard red');
    writeFileSync(file, bare.replace('< 30_000);', '< 30_000); // budget: hang ceiling only; no throughput claim.'));
    assert.deepEqual(wallClockViolations(root), []);
    writeFileSync(file, 'assert.ok(Date.now() - start > 10_000); // budget: the stand-in publishes DevToolsActivePort after 10,100 ms.\n');
    assert.deepEqual(wallClockViolations(root), [], 'a concrete fixture publication delay explains the budget without special vocabulary');
    writeFileSync(file, 'const spent = performance.now() - start;\nassert.ok(spent < 1500);\nawait assert.rejects(waitFor(child, 1500));\n');
    assert.deepEqual(wallClockViolations(root).map(line => Number(/:(\d+):/u.exec(line)[1])), [2, 3]);
    writeFileSync(file, 'await assert.doesNotReject(waitFor(child, 1500));\nawait chrome.waitFor(ready, 1500);\n');
    assert.deepEqual(wallClockViolations(root).map(line => Number(/:(\d+):/u.exec(line)[1])), [1, 2]);
    writeFileSync(file, 'const budgetMs = 1500;\nassert.ok(elapsed < budgetMs);\nawait assert.rejects(waitFor(child, budgetMs));\n');
    assert.deepEqual(wallClockViolations(root).map(line => Number(/:(\d+):/u.exec(line)[1])), [2, 3]);
    writeFileSync(file, 'const text = "assert.ok(Date.now() - start < 1)";\nassert.equal(response.status, 200);\nassert.ok(elapsed < measuredBaseline * 3);\n');
    assert.deepEqual(wallClockViolations(root), []);
    writeFileSync(file, 'if (!await childClosesWithin(child, 1500)) return null;\nsetTimeout(() => reject(new Error("late")), 1500);\nassert.ok(elapsed < 1500); // budget: because I said so\n');
    assert.deepEqual(wallClockViolations(root).map(line => Number(/:(\d+):/u.exec(line)[1])), [1, 2, 3]);
    writeFileSync(file, 'await assert.rejects(browser(), error => {\n  assert.ok(elapsed >= 30000); // budget: declared startup timeout.\n});\nassert.equal((await event(worker)).waiting, 1);\nassert.equal(durationMs("2h"), 7200000);\nconst matcher = /[\'"`]/u;\nassert.ok(Date.now() - start < 1500);\n');
    assert.deepEqual(wallClockViolations(root).map(line => Number(/:(\d+):/u.exec(line)[1])), [7]);
    writeFileSync(file, '');
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'test', 'helper.js'), bare);
    writeFileSync(join(root, 'test.js'), bare);
    assert.deepEqual(wallClockViolations(root).map(line => line.split(':')[0]).sort(), ['test.js', 'test/helper.js'],
      'plain test.js and every JavaScript file under test/ are part of native discovery');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
