/**
 * The commit-message rules (C1, C2) and the pre-commit pattern checks on real staged changes.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runFixtureExecFile as execFileSync, runFixtureGit } from './fixture-child.js';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { defaults } from '../src/config.js';
import { addedLines, blockedPaths, commitCitationWarnings, commitMsgProblems, hookScript, matchesPattern, preCommitProblems, secretsIn, unwiredHookProblems } from '../src/hooks.js';
import { parseSpec } from '../src/spec.js';
import { Refused } from '../src/refused.js';
import { createE2eHelpers } from './e2e-helpers.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const SPEC = { ...parseSpec('## G\n- G1 [approved, must] One. | gate: t\n- G2 [retired] Gone.\n'), name: 'SPEC.md' };
const RULES = defaults().commits;

/** Make a private real repository for staged-diff hook tests, with cleanup tied to the test. */
function stagedRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-staged-diff-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  /** Run Git only in this fixture, without the maintainer's identity or configuration. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  return { root, git };
}

/** Run the same staged protections called by the installed pre-commit hook. */
function stagedProblems(root) {
  return preCommitProblems({ root, isMain: true, config: defaults(), agent: null });
}

/**
 * Problems with a message under the default rules, or the given ones.
 */
const check = (message, rules = RULES) => commitMsgProblems(message, { rules, spec: SPEC });

test('hook wiring checks the configured path and accepts pullboard delegation [L3]', (t) => {
  const box = stagedRepo(t);
  const hooks = join(box.root, '.husky');
  mkdirSync(hooks);
  box.git('config', 'core.hooksPath', '.husky');
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nnpx lint-staged\n');
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  assert.deepEqual(unwiredHookProblems(box.root), [{
    code: 'HOOK_UNWIRED',
    message: 'active Git hook .husky/pre-commit does not call pullboard hook pre-commit',
    next: 'add this line: pullboard hook pre-commit "$@"',
  }]);
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\n# pullboard hook pre-commit "$@"\nnot-pullboard hook pre-commit\n');
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  assert.equal(unwiredHookProblems(box.root).length, 1);
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\npullboard hook pre-commit "$@"\n');
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  assert.deepEqual(unwiredHookProblems(box.root), []);
  for (const source of [
    `#!/bin/sh\necho 'pullboard hook pre-commit'\n`,
    `#!/bin/sh\necho 'example; pullboard hook pre-commit'\n`,
    '#!/bin/sh\nbin=some-other-tool; "$bin" hook pre-commit\n',
  ]) {
    writeFileSync(join(hooks, 'pre-commit'), source);
    assert.equal(unwiredHookProblems(box.root).length, 1, source);
  }
  for (const source of [
    '#!/bin/sh\nexec "$root/node_modules/.bin/pullboard" hook pre-commit\n',
    '#!/bin/sh\nnode "./bin/pullboard.js" hook pre-commit\n',
  ]) {
    writeFileSync(join(hooks, 'pre-commit'), source);
    assert.deepEqual(unwiredHookProblems(box.root), [], source);
  }
  writeFileSync(join(hooks, 'pre-commit'), hookScript('pre-commit'));
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  assert.deepEqual(unwiredHookProblems(box.root), []);
});

test('a clean header citing a live id passes [C1, C2]', () => {
  assert.deepEqual(check('feat(web): add the page [G1]'), []);
  assert.deepEqual(check('docs: explain lanes'), []);
  assert.deepEqual(check('feat(web)!: drop the old page [G1]\n\nThe old page is gone.'), []);
});

test('feat and fix cite ids; cited ids exist and are not retired [C2]', () => {
  assert.match(check('feat(web): add the page')[0], /end the header with the spec rows this feat serves, like \[G1\]/);
  assert.match(check('fix: patch [G9]')[0], /G9 is not in SPEC.md/);
  assert.match(check('fix: patch [G2]')[0], /G2 is retired/);
});

test('doctrine citations are namespaced; a colliding bare id warns that it resolves to SPEC.md [A5]', () => {
  const doctrine = {
    name: 'DOCTRINE.md',
    repo: { rows: [{ id: 'G1', line: 4 }] },
    rows: [{ id: 'G1', status: 'approved' }, { id: 'PB1', status: 'approved' }],
  };
  assert.deepEqual(commitMsgProblems('feat(web): add the rule [doctrine:PB1]', { rules: RULES, spec: SPEC, doctrine }), []);
  assert.deepEqual(commitMsgProblems('feat(web): add the rule [doctrine:G1]', { rules: RULES, spec: SPEC, doctrine }), []);
  assert.match(commitMsgProblems('fix(web): add the rule [doctrine:missing]', { rules: RULES, spec: SPEC, doctrine })[0], /doctrine:missing is not in doctrine/u);
  assert.deepEqual(commitCitationWarnings('feat(web): patch the rule [G1]', { spec: SPEC, doctrine }), [
    'G1 is a known collision at SPEC.md:2 and DOCTRINE.md:4; bare ids cite SPEC.md, use doctrine:G1 for a doctrine row',
  ]);
});

test('header format, length, case and period [C1]', () => {
  assert.match(check('Added the page')[0], /type\(scope\): subject/);
  assert.match(check('Added the page')[0], /saw "Added the page"/, 'the refusal shows the header it saw (C4)');
  assert.match(check('feature: add the page [G1]')[0], /type\(scope\): subject/, 'a type outside the configured list is refused');
  assert.match(check(`docs: ${'x'.repeat(80)}`)[0], /shorten the header to 72 characters or fewer \(it has 86\)/);
  assert.deepEqual(check('docs: Explain lanes.'), [
    'start the subject with a lowercase letter (saw "Explain lanes.")',
    'remove the period at the end of the subject',
  ]);
  assert.match(check('feat: x [G K P D]')[0], /cite only rows that exist and are live, separated by commas \(/);
  assert.match(check('feat: x [G K P D]')[0], /like \[G1\]/, 'invalid-id guidance names only an approved row that exists');
  assert.deepEqual(check('docs: explain lanes\nsecond line'), ['leave a blank line after the header']);
});

test('comments are dropped; merges, reverts and fixups are exempt', () => {
  assert.deepEqual(check('docs: explain lanes\n# Please enter the commit message'), []);
  assert.deepEqual(check("Merge branch 'web/page'"), []);
  assert.deepEqual(check('fixup! feat(web): add the page [G1]'), []);
});

test('opt-in rules: filler words, emoji, co-author trailers', () => {
  const strict = { ...RULES, banned: ['basically', 'seamless'], noEmoji: true, noCoAuthor: true };
  const problems = check('docs: basically seamless lanes \u{1F680}\n\nCo-Authored-By: Bot <b@x>', strict);
  assert.deepEqual(problems, ['drop the filler word "basically"', 'drop the filler word "seamless"', 'remove the emoji', 'remove the Co-Authored-By trailer']);
  assert.deepEqual(check('docs: basically fine'), []);
});

test('blocked paths: env files by name, examples allowed, patterns with a slash match paths', () => {
  const protect = { ...defaults().protect, blocked: [...defaults().protect.blocked, 'data/*.csv'] };
  assert.deepEqual(
    blockedPaths(['.env', 'app/.env.local', 'prod.env', '.env.example', 'data/claims.csv', 'docs/data/x.csv', 'src/a.js'], protect),
    ['.env', 'app/.env.local', 'prod.env', 'data/claims.csv'],
  );
  assert.ok(matchesPattern('*.env', 'deep/dir/staging.env'));
  assert.ok(!matchesPattern('.env.*', 'environment.js'));
});

test('secrets are named by kind and place, never echoed', () => {
  // Built at run time, so this file never holds a string its own pre-commit scan would refuse.
  const fakeKey = ['sk', 'ant', 'abcdefghijklmnopqrstuvwxyz0123'].join('-');
  const diff = [
    '+++ b/config/settings.js',
    '@@ -0,0 +1,3 @@',
    '+const ok = 1;',
    `+const key = "${fakeKey}";`,
    '+export CLOUDFLARE_API_TOKEN=abcdefghijklmnopqrstuvwxyz012345',
  ].join('\n');
  const found = secretsIn(addedLines(diff));
  assert.deepEqual(found, ['Anthropic key at config/settings.js:2', 'env-style secret at config/settings.js:3']);
  assert.ok(found.every((entry) => !entry.includes('abcdefghij')));
});

test('the secret scan handles 2.4 MiB of binary images and finds an embedded key [P4]', (t) => {
  const box = stagedRepo(t);
  const secret = `sk-ant-${'A'.repeat(32)}`;
  for (let index = 0; index < 17; index += 1) {
    const image = Buffer.alloc(150_000);
    image.set([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]);
    if (index === 0) image.write(`${secret}\n`, 11, 'ascii');
    writeFileSync(join(box.root, `image-${index}.jpg`), image);
  }
  box.git('add', '--', '*.jpg');
  const problems = stagedProblems(box.root);
  assert.deepEqual(problems, ['possible secret: Anthropic key at image-0.jpg:1']);
  assert.ok(!problems.join(' ').includes(secret));
});

test('a staged diff beyond the safe output limit is a private coded refusal [P4]', (t) => {
  const box = stagedRepo(t);
  const marker = 'STAGED_CONTENT_MUST_NOT_BE_ECHOED';
  writeFileSync(join(box.root, 'large.txt'), `${marker}\n${'ordinary text\n'.repeat(700_000)}`);
  box.git('add', '--', 'large.txt');
  assert.throws(() => stagedProblems(box.root), (error) => {
    assert.ok(error instanceof Refused);
    assert.equal(error.code, 'DIFF_TOO_LARGE');
    assert.match(error.message, /split the change into smaller commits, then retry/);
    assert.ok(!error.message.includes(marker));
    return true;
  });
});

test('pre-commit still refuses and redacts a staged text secret [P4]', (t) => {
  const box = stagedRepo(t);
  const secret = `sk-ant-${'A'.repeat(32)}`;
  writeFileSync(join(box.root, 'settings.js'), `const token = \"${secret}\";\n`);
  box.git('add', '--', 'settings.js');
  const problems = stagedProblems(box.root);
  assert.deepEqual(problems, ['possible secret: Anthropic key at settings.js:1']);
  assert.ok(!problems.join(' ').includes(secret));
});

test('a refused merge message points to the message git writes, which is exempt [C4]', () => {
  assert.match(check('merge: include store date validation')[0], /For a merge, keep the message git writes, which is exempt: git merge --no-edit/);
  assert.deepEqual(check("Merge branch 'store/1'"), []);
});


test('a spec-less feature commit is told a path that works [S1,B26]', () => {
  const box = e2e.sandbox();
  const root = join(box.dir, 'newcomer');
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  const initialized = box.run(root, 'init');
  assert.equal(initialized.code, 0, initialized.err || initialized.out);
  const source = readFileSync(join(root, 'SPEC.md'), 'utf8');
  assert.match(source, /- G1 \[draft, must\]/u, 'the fresh spec visibly contains a fenced format example');
  const listed = box.run(root, 'spec', '--json');
  assert.equal(listed.code, 0, listed.err || listed.out);
  assert.deepEqual(JSON.parse(listed.out).rows.filter(row => row.file === 'SPEC.md'), [], 'the example is not a real row');
  assert.equal(box.run(root, 'lane', 'add', 'app', '--owns', 'app/').code, 0);
  mkdirSync(join(root, 'app'));
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', 'chore: set up the private board');
  const added = box.run(root, 'add', 'app', 'Build the first useful thing', '--criterion', 'The first useful thing works.', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  assert.equal(JSON.parse(added.out).item.item_spec_ids, '');
  writeFileSync(join(root, 'app/first.txt'), 'first useful thing\n');
  box.git(root, 'add', '--', 'app/first.txt');
  const missing = box.tryGit(root, 'commit', '-q', '-m', 'feat(app): build the first useful thing');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /pullboard spec draft "<text>"/u, 'the actual installed hook names a supported command');
  assert.match(missing.stderr, /person.*approv/iu, 'the next step honestly names the person approval');
  assert.doesNotMatch(missing.stderr, /like \[G1,G2\]|as a chore|use chore/iu, 'the hook neither invents ids nor mislabels the feature');
  const malformed = box.tryGit(root, 'commit', '-q', '-m', 'Added the first useful thing');
  assert.notEqual(malformed.status, 0);
  assert.doesNotMatch(malformed.stderr, /\[G7\]/u, 'format guidance also avoids an invented citation');
  const copiedExample = box.tryGit(root, 'commit', '-q', '-m', 'feat(app): build the first useful thing [G1]');
  assert.notEqual(copiedExample.status, 0);
  assert.match(copiedExample.stderr, /G1 is not in SPEC\.md/u);
  assert.match(copiedExample.stderr, /fenced.*example.*not.*rows/iu, 'the refusal explains why the visible format example is not a row');
  const drafted = box.run(root, 'spec', 'draft', 'The first useful thing works.', '--json');
  assert.equal(drafted.code, 0, drafted.err || drafted.out);
  const id = JSON.parse(drafted.out).id;
  for (const args of [['spec', 'approve', id], ['spec', 'apply']]) {
    const result = box.run(root, ...args);
    assert.equal(result.code, 0, result.err || result.out);
  }
  box.git(root, 'add', '-A');
  const committed = box.tryGit(root, 'commit', '-q', '-m', `feat(app): build the first useful thing [${id}]`);
  assert.equal(committed.status, 0, committed.failure || committed.stderr || committed.stdout);

  for (const [open, close] of [['```markdown', '```'], ['~~~markdown', '~~~'], ['   ````markdown', '   ````'], ['````markdown\n```', '````']]) {
    const fenced = parseSpec(`## G\n${open}\n- G1 [approved, must] Example only. | gate: true\n${close}\n- R9 [approved, must] Real requirement. | gate: true\n`);
    assert.deepEqual(fenced.rows.map(row => row.id), ['R9'], `only real rows are read around ${open}`);
    const advice = commitMsgProblems('feat(app): add a feature', { rules: RULES, spec: { ...fenced, name: 'SPEC.md' } });
    assert.match(advice.join('\n'), /\[R9\]/u, 'an approved board names an id that really exists');
    assert.doesNotMatch(advice.join('\n'), /\[G1(?:,G2)?\]/u, 'a fenced example is never suggested as a citation');
  }
});

test('a hook names a Pullboard version mismatch instead of running old rules [C1,I2]', (t) => {
  const box = stagedRepo(t);
  const hooks = join(box.root, '.githooks'), bin = join(box.root, '.fakebin'), local = join(box.root, 'node_modules', '.bin');
  mkdirSync(hooks); mkdirSync(bin);
  box.git('config', 'core.hooksPath', '.githooks');
  box.git('config', 'user.name', 'Fixture');
  box.git('config', 'user.email', 'fixture@example.com');
  writeFileSync(join(hooks, 'commit-msg'), hookScript('commit-msg', '0.9.0'));
  chmodSync(join(hooks, 'commit-msg'), 0o755);
  /** A pullboard that reports one version and says so if its rules ever run. */
  const fake = (dir, version) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pullboard'), `#!/bin/sh\nif [ "$1" = --version ]; then echo ${version}; exit 0; fi\necho "rules of ${version} ran" >&2\nexit 0\n`);
    chmodSync(join(dir, 'pullboard'), 0o755);
  };
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const commit = () => spawnSync('git', ['commit', '--allow-empty', '-q', '-m', 'chore: try a commit'], { cwd: box.root, env, encoding: 'utf8' });

  fake(bin, '0.8.4');
  let result = commit();
  assert.equal(result.status, 1, 'an older global pullboard is stopped');
  assert.match(result.stderr, /stopped before running any rule; these hooks were installed by Pullboard 0\.9\.0, but pullboard is Pullboard 0\.8\.4\. Run: npm i -g pullboard@0\.9\.0/u);
  assert.doesNotMatch(result.stderr, /rules of 0\.8\.4 ran/u, 'the old rules never run');

  fake(local, '0.8.4');
  result = commit();
  assert.equal(result.status, 1, 'an older project install is stopped');
  assert.match(result.stderr, /Pullboard 0\.8\.4\. Run: npm i -D pullboard@0\.9\.0/u, 'a project install is fixed in the project');
  rmSync(join(box.root, 'node_modules'), { recursive: true, force: true });

  fake(bin, '0.9.9');
  result = commit();
  assert.equal(result.status, 1, 'a newer pullboard under older hooks is stopped too');
  assert.match(result.stderr, /Pullboard 0\.9\.9\. Run: pullboard init/u, 'newer rules rewrite the hooks with init');

  fake(bin, '0.9.0');
  result = commit();
  assert.equal(result.status, 0, `the matching version runs: ${result.stderr}`);
  assert.match(result.stderr, /rules of 0\.9\.0 ran/u, 'the hook runs the version that installed it');
});
