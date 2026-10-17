/** @pullboard-test-input test-tree */
/** @pullboard-test-input source-tree */
/**
 * Pullboard's first Rigor checks (D1, C7): bin/checks/ holds four scripts a doctrine row's
 * `gate: check` can count. Each prints one `path:line: text` line per problem, sorted, and exits 0
 * with none or 1 with some. The census is pinned to the main commit this item merged, so it never
 * goes stale as main moves; the live checkout is held to the format, the timing and, for file size,
 * an independent recount. Fixtures prove each check adds exactly one line for one new problem.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
// Imported so the affected-test selection sees an edge to every check; importing runs nothing.
import { fileSizeProblems } from '../bin/checks/file-size.js';
import { testNameProblems } from '../bin/checks/test-names.js';
import { emptyCatchProblems } from '../bin/checks/empty-catch.js';
import { testInputProblems } from '../bin/checks/test-inputs.js';

const ROOT = resolve(import.meta.dirname, '..');
const CHECKS = ['file-size', 'test-names', 'empty-catch', 'test-inputs'];
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-rigor-')));
after(() => rmSync(dir, { recursive: true, force: true }));

/** The main commit whose census this item counted; moved forward when the item merges main. */
const PINNED = '59a6e2b286ee852add0d68a659f1a1e6b3257c44';

/** Today's over-cap files on the pinned main, with their line counts. */
const PINNED_SIZES = { 'src/board.js': 2796, 'src/cli.js': 3794, 'src/cockpit.js': 3332, 'test/api-http.test.js': 1991,
  'test/api.test.js': 1958, 'test/cockpit/demo.test.js': 1719, 'test/run-tests.test.js': 1672 };

const NO_ID = 'test name has no spec row id: ';
const BARE = 'empty catch names no reason: handle the error or say in a comment why it is ignored';
const UNDECLARED = 'reads source files without /** @pullboard-test-input source-tree */ at the top';

/** Today's problems on the pinned main for the three checks that are not about size. */
const PINNED_PROBLEMS = {
  'test-names': [
    ['test/board.test.js', 139, 'agents are numbered per lane; one coordinator; a worktree joins once'],
    ['test/board.test.js', 168, 'the coordinator follows the main checkout when the repo moves'],
    ['test/board.test.js', 286, 'submit needs your claim and finished children'],
    ['test/board.test.js', 353, 'under verify: coordinator, lane work is the coordinator\'s to verify'],
    ['test/board.test.js', 535, 'merged and withdraw are the coordinator\'s, and only for the right states'],
    ['test/hooks.test.js', 116, 'comments are dropped; merges, reverts and fixups are exempt'],
    ['test/hooks.test.js', 122, 'opt-in rules: filler words, emoji, co-author trailers'],
    ['test/hooks.test.js', 129, 'blocked paths: env files by name, examples allowed, patterns with a slash mat...'],
    ['test/hooks.test.js', 139, 'secrets are named by kind and place, never echoed'],
    ['test/lanes.test.js', 29, 'a lane may change its own paths and shared ones; the coordinator may change a...'],
    ['test/lanes.test.js', 55, 'config merges nested groups over the defaults, and leases read as durations'],
    ['test/spec.test.js', 226, 'rows inside code fences are examples, not rows'],
    ['test/spec.test.js', 251, 'bad status, bad tier and unknown fields are errors; long rows warn'],
    ['test/spec.test.js', 262, 'cited ids must exist and must not be retired'],
    ['test/view.test.js', 200, 'row text is escaped, so a row cannot inject markup'],
  ].map(([path, line, name]) => `${path}:${line}: ${NO_ID}${name}`),
  'empty-catch': [
    ['src/api.js', 214], ['src/api.js', 222], ['src/board.js', 166], ['src/board.js', 224], ['src/runner-worker.js', 1190],
    ['test/cockpit/items.test.js', 1159], ['test/land.test.js', 170], ['test/land.test.js', 172], ['test/land.test.js', 673],
    ['test/land.test.js', 760], ['test/land.test.js', 762], ['test/land.test.js', 906], ['test/runners.test.js', 1250],
  ].map(([path, line]) => `${path}:${line}: ${BARE}`),
  'test-inputs': [
    ['test/api-http.test.js', 428], ['test/blueprint.test.js', 13], ['test/cockpit/layout.test.js', 146],
    ['test/cockpit/relay.test.js', 131], ['test/doctrine.test.js', 28], ['test/e2e-private-checks.test.js', 113],
    ['test/gate-profile.test.js', 16], ['test/gate.test.js', 13], ['test/help.test.js', 33], ['test/resources.test.js', 131],
    ['test/resume-flow.test.js', 27], ['test/run-tests.test.js', 119], ['test/seal.test.js', 90], ['test/settings.test.js', 11],
    ['test/test-resources.test.js', 86], ['test/test-runner.test.js', 108],
  ].map(([path, line]) => `${path}:${line}: ${UNDECLARED}`),
};

/** Git for the test, without any GIT_* the suite inherited. */
function git(args, options = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const result = spawnSync('git', ['-C', ROOT, ...args], { env, maxBuffer: 512 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

/**
 * Run one check as a doctrine row runs it, from `cwd` (or on `root` when given), timed.
 *
 * @returns {{ status: number|null, lines: string[], stderr: string, ms: number }}
 */
function runCheck(name, { cwd = ROOT, root } = {}) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [join(ROOT, 'bin/checks', `${name}.js`), ...(root ? [root] : [])], { cwd, encoding: 'utf8' });
  const ms = performance.now() - started;
  return { status: result.status, lines: result.stdout.split('\n').filter(Boolean), stderr: result.stderr, ms };
}

/** The problem lines the size rule expects for files of these lengths. */
function sizeLines(sizes) {
  const lines = [];
  for (const [path, count] of Object.entries(sizes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    for (let first = 1501; first <= count; first += 100) lines.push(`${path}:${first}: lines ${first}-${first + 99} are over the 1500-line cap`);
  }
  return lines;
}

/** Sort problem lines as the checks promise: path, then line number, then text. */
function sortedProblems(lines) {
  const parts = (line) => /^(.*?):(\d+): (.*)$/su.exec(line);
  return [...lines].sort((a, b) => {
    const [, pathA, lineA, textA] = parts(a);
    const [, pathB, lineB, textB] = parts(b);
    return (pathA < pathB ? -1 : pathA > pathB ? 1 : 0) || Number(lineA) - Number(lineB) || (textA < textB ? -1 : textA > textB ? 1 : 0);
  });
}

/** Write a fixture file under a fixture root, making its folders. */
function put(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** A fixture tree with no problems for any check yet. */
function fixture(name) {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  return root;
}

test('Pullboard\'s four checks count what main has [D1, C7]', async (t) => {
  assert.equal(typeof fileSizeProblems, 'function', 'the size check imports without running');
  assert.equal([testNameProblems, emptyCatchProblems, testInputProblems].every((find) => typeof find === 'function'), true);

  await t.test('on the pinned main each check prints exactly its census and exits 1, in under 10s [D1, C7]', () => {
    const pinned = join(dir, 'pinned');
    mkdirSync(pinned);
    const archive = git(['archive', '--format=tar', PINNED]);
    const unpacked = spawnSync('tar', ['-x', '-C', pinned], { input: archive });
    assert.equal(unpacked.status, 0, `tar: ${unpacked.stderr}`);
    const expected = { 'file-size': sizeLines(PINNED_SIZES), ...PINNED_PROBLEMS };
    assert.equal(Object.keys(PINNED_SIZES).length, 7, 'seven files are over the cap');
    assert.equal(Math.max(...Object.values(PINNED_SIZES)), PINNED_SIZES['src/cli.js'], 'the largest is src/cli.js');
    for (const name of CHECKS) {
      const run = runCheck(name, { cwd: pinned });
      assert.deepEqual(run.lines, expected[name], `${name} counts the pinned main's problems exactly`);
      assert.equal(run.status, 1, `${name} exits 1 with problems`);
      assert.equal(run.stderr, '', `${name} writes nothing else`);
      assert.ok(run.ms < 10_000, `${name} took ${Math.round(run.ms)}ms on the pinned main`); // budget: the bar's 10s ceiling per check run; each takes well under 1s.
      assert.deepEqual(runCheck(name, { cwd: dir, root: pinned }).lines, expected[name], `${name} scans its argument the same`);
    }
    assert.deepEqual(Object.fromEntries(CHECKS.map((name) => [name, expected[name].length])),
      { 'file-size': 70, 'test-names': 15, 'empty-catch': 13, 'test-inputs': 16 }, 'today\'s counts');
  });

  await t.test('on this checkout each check prints sorted path:line: text lines, exits 0 or 1, in under 10s [D1, C7]', () => {
    const tracked = git(['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
    const sizes = {};
    for (const path of tracked.filter((name) => /\.(?:[cm]?js|css)$/u.test(name))) {
      const bytes = readFileSync(join(ROOT, path));
      let count = bytes.filter((byte) => byte === 10).length;
      if (bytes.length && bytes[bytes.length - 1] !== 10) count += 1;
      if (count > 1500) sizes[path] = count;
    }
    const trackedSet = new Set(tracked);
    for (const name of CHECKS) {
      const run = runCheck(name);
      assert.ok(run.status === 0 || run.status === 1, `${name} exits 0 or 1, not ${run.status}`);
      assert.equal(run.status, run.lines.length ? 1 : 0, `${name} exits 1 exactly when it prints problems`);
      assert.equal(run.stderr, '', `${name} writes nothing else`);
      assert.ok(run.ms < 10_000, `${name} took ${Math.round(run.ms)}ms`); // budget: the bar's 10s ceiling per check run; each takes well under 1s.
      for (const line of run.lines) assert.match(line, /^[^\s:/][^:]*:[1-9]\d*: \S/u, `${name} prints path:line: text`);
      assert.deepEqual(run.lines, sortedProblems(run.lines), `${name} sorts its output`);
      assert.equal(new Set(run.lines).size, run.lines.length, `${name} prints each problem once`);
      assert.equal(run.lines.some((line) => line.startsWith('test/rigor-checks.test.js:') || line.startsWith('bin/checks/')), false,
        `${name} finds nothing in this item's own files`);
      if (name === 'file-size') {
        const ours = run.lines.filter((line) => trackedSet.has(line.slice(0, line.indexOf(':'))));
        assert.deepEqual(ours, sizeLines(sizes), 'the size check agrees with an independent recount of every tracked file');
      }
    }
  });

  await t.test('adding 100 lines to an over-cap file adds exactly one line [D1, C7]', () => {
    const root = fixture('size');
    const lines = (count) => Array.from({ length: count }, (_, index) => `export const value${index} = ${index};\n`).join('');
    put(root, 'src/at-cap.js', lines(1500));
    put(root, 'src/view.css', 'a { color: red; }\n'.repeat(1500));
    put(root, 'work/scratch.js', lines(4000));
    put(root, 'node_modules/dep/index.js', lines(4000));
    put(root, '.git/hooks/huge.js', lines(4000));
    put(root, 'docs/page.html', '<p>\n'.repeat(4000));
    const clean = runCheck('file-size', { root });
    assert.deepEqual([clean.status, clean.lines], [0, []], 'a file at the cap, and skipped folders, print nothing and exit 0');
    put(root, 'src/big.js', lines(1650));
    const before = runCheck('file-size', { root });
    assert.deepEqual(before.lines, ['src/big.js:1501: lines 1501-1600 are over the 1500-line cap', 'src/big.js:1601: lines 1601-1700 are over the 1500-line cap']);
    assert.equal(before.status, 1);
    put(root, 'src/big.js', lines(1750));
    const grown = runCheck('file-size', { root });
    assert.equal(grown.lines.length, before.lines.length + 1, 'one more line for 100 more lines');
    assert.deepEqual(grown.lines.filter((line) => !before.lines.includes(line)), ['src/big.js:1701: lines 1701-1800 are over the 1500-line cap']);
    put(root, 'src/one-over.js', `${lines(1500)}last line without a newline`);
    assert.deepEqual(runCheck('file-size', { root }).lines.filter((line) => line.startsWith('src/one-over.js')),
      ['src/one-over.js:1501: lines 1501-1600 are over the 1500-line cap'], 'one line over the cap is one problem');
  });

  await t.test('adding a bare empty catch adds exactly one line [D1, C7]', () => {
    const root = fixture('catch');
    const reasoned = [
      'export function close(db) {',
      '  try { db.close(); } catch { /* already closed: closing twice is harmless */ }',
      '  try { db.close(); } catch (error) {} // a second close is harmless',
      '  try { db.close(); } catch (error) { console.error(error); }',
      '  db.ready.catch(() => {});',
      "  const text = 'try { x(); } catch {}';",
      '  const template = `${text} catch (error) {}`;',
      '  // try { x(); } catch {}',
      '  return /catch {}/u.test(template);',
      '}',
      '',
    ].join('\n');
    put(root, 'src/close.js', reasoned);
    put(root, 'work/scratch.js', 'try { x(); } catch {}\n');
    const clean = runCheck('empty-catch', { root });
    assert.deepEqual([clean.status, clean.lines], [0, []], 'catches that say why, handle the error or are not code print nothing');
    put(root, 'src/close.js', `${reasoned}export function quiet(db) {\n  try { db.close(); } catch (error) {\n  }\n}\n`);
    const bare = runCheck('empty-catch', { root });
    assert.deepEqual(bare.lines, [`src/close.js:12: ${BARE}`], 'one bare empty catch is one line, at its catch');
    assert.equal(bare.status, 1);
  });

  await t.test('adding a test name without a spec row id adds exactly one line [D1, C7]', () => {
    const root = fixture('names');
    const named = [
      "import { test } from 'node:test';",
      "test('a name with an id [G1.2]', async (t) => {",
      "  await t.test('a subtest nests under its parent', () => {});",
      "  const fixture = \"test('a fixture test written out', () => {});\";",
      '});',
      "describe.skip('a suite with ids [V4, C7]', () => it(`a template name [A1]`, () => {}));",
      'test(nameFromSomewhere, () => {});',
      '',
    ].join('\n');
    put(root, 'test/named.test.js', named);
    put(root, 'src/helper.js', "test('not a test file', () => {});\n");
    const clean = runCheck('test-names', { root });
    assert.deepEqual([clean.status, clean.lines], [0, []], 'named tests, subtests, fixtures and non-test files print nothing');
    put(root, 'test/named.test.js', `${named}test('a [note] without an id', () => {});\n`);
    const unnamed = runCheck('test-names', { root });
    assert.deepEqual(unnamed.lines, [`test/named.test.js:8: ${NO_ID}a [note] without an id`], 'one name without an id is one line');
    assert.equal(unnamed.status, 1);
  });

  await t.test('adding an undeclared source reader adds exactly one line [D1, C7]', () => {
    const root = fixture('inputs');
    const reader = [
      "import { readFileSync } from 'node:fs';",
      "import { test } from 'node:test';",
      "test('reads the seal source [S1]', () => readFileSync(new URL('../src/seal.js', import.meta.url), 'utf8'));",
      '',
    ].join('\n');
    const splitVariable = [
      "import { readFileSync } from 'node:fs';",
      "const source = new URL('../src/x.js', import.meta.url);",
      'export const text = readFileSync(source, \'utf8\');',
      '',
    ].join('\n');
    const queuedWalk = [
      "import { readFileSync } from 'node:fs';",
      "import { resolve } from 'node:path';",
      "const ROOT = resolve(import.meta.dirname, '..');",
      "const pending = [[resolve(ROOT, 'src/help.js')]];",
      'for (const file of pending.pop()) readFileSync(file, \'utf8\');',
      '',
    ].join('\n');
    put(root, 'test/declared.test.js', `/** @pullboard-test-input test-tree */\n/** @pullboard-test-input source-tree */\n${reader}`);
    put(root, 'test/fixture-copy.test.js', "import { readFileSync } from 'node:fs';\nconst copy = (lane) => readFileSync(join(lane, 'src/board.js'), 'utf8');\n");
    put(root, 'test/imports.test.js', "import { seal } from '../src/seal.js';\nconst note = \"readFileSync(new URL('../src/a.js', import.meta.url))\";\n");
    put(root, 'test/module-url.test.js', [
      "import { readFileSync } from 'node:fs';",
      "const board = new URL('../src/board.js', import.meta.url).href;",
      "const cli = pathToFileURL(resolve(import.meta.dirname, '../src/cli.js')).href;",
      "const api = await import(new URL('../src/api.js', import.meta.url));",
      "export const config = readFileSync('pullboard.json', 'utf8');",
      '',
    ].join('\n'));
    put(root, 'test/no-read.test.js', "export const worker = resolve(import.meta.dirname, '../src/worker.js');\n");
    const clean = runCheck('test-inputs', { root });
    assert.deepEqual([clean.status, clean.lines], [0, []], 'a declared reader, a fixture copy, an import, module URLs and a path never read print nothing');
    put(root, 'test/undeclared.test.js', reader);
    const undeclared = runCheck('test-inputs', { root });
    assert.deepEqual(undeclared.lines, [`test/undeclared.test.js:3: ${UNDECLARED}`], 'one undeclared reader is one line');
    assert.equal(undeclared.status, 1);
    rmSync(join(root, 'test/undeclared.test.js'));
    put(root, 'test/split-variable.test.js', splitVariable);
    assert.deepEqual(runCheck('test-inputs', { root }).lines, [`test/split-variable.test.js:2: ${UNDECLARED}`],
      'a source path built on one line and read on the next is one line');
    rmSync(join(root, 'test/split-variable.test.js'));
    put(root, 'test/queued-walk.test.js', queuedWalk);
    assert.deepEqual(runCheck('test-inputs', { root }).lines, [`test/queued-walk.test.js:4: ${UNDECLARED}`],
      'a ROOT-anchored path queued and read later, as help.test.js does, is one line');
    put(root, 'test/late.test.js', `import { readFileSync } from 'node:fs';\n/** @pullboard-test-input source-tree */\n${reader.split('\n').slice(1).join('\n')}`);
    assert.deepEqual(runCheck('test-inputs', { root }).lines.map((line) => line.slice(0, line.indexOf(':'))),
      ['test/late.test.js', 'test/queued-walk.test.js'], 'a declaration below the first code line is not read, as the selection reads it');
  });
});
