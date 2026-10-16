/** pullboard blueprint add: a blueprint lands on a board as drafts, once [S1,I1]. */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { runFixtureChild, runFixtureGit } from './fixture-child.js';
import { parseSpec } from '../src/spec.js';
import { createE2eHelpers } from './e2e-helpers.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const PUBLISHED = JSON.parse(readFileSync(resolve(import.meta.dirname, '../src/blueprints/web-app.json'), 'utf8'));
const MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'AI_AGENT', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI', 'CODEX_SHELL'];
const DIRS = [];

after(() => { for (const dir of DIRS) rmSync(dir, { recursive: true, force: true }); });

/** A freshly initialized repo with a private board, Pullboard home and Git identity. */
function freshBoard(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-blueprint-'));
  DIRS.push(dir);
  // The hooks init installs call pullboard by name, so this checkout's CLI is the one on PATH.
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${BIN.replaceAll("'", "'\\''")}' "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') || MARKERS.includes(key)) delete env[key];
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH}`,
    PULLBOARD_HOME: join(dir, 'home'), PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Blueprint fixture', GIT_AUTHOR_EMAIL: 'blueprint@example.invalid',
    GIT_COMMITTER_NAME: 'Blueprint fixture', GIT_COMMITTER_EMAIL: 'blueprint@example.invalid',
  });
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const git = (...args) => runFixtureGit(args, { cwd: repo, env });
  const run = (...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd: repo, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  const init = run('init');
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const file = join(repo, 'pullboard.json');
  writeFileSync(file, `${JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...config }, null, 2)}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: set up blueprint fixture');
  return { dir, repo, run, git };
}

/** Run one command with --json and return its document, failing with its output. */
function json(box, ...args) {
  const result = box.run(...args, '--json');
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('blueprint add files a blueprint as drafts [S1,I1]', () => {
  // A fresh board: one new section, rules as drafts with reasons, questions as pending rows with defaults.
  const box = freshBoard();
  const before = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const added = json(box, 'blueprint', 'add', 'web-app');
  assert.deepEqual(added.blueprint, { name: 'web-app', title: 'Web app', version: 1 });
  const source = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  assert.ok(source.startsWith(before.trimEnd()), 'the existing spec text is kept as it was');
  const spec = parseSpec(source);
  assert.deepEqual(spec.problems, []);
  const section = spec.sections.filter((entry) => entry.name.endsWith('· Web app'));
  assert.equal(section.length, 1, 'one section named after the blueprint');
  assert.equal(added.section, section[0].name);
  const rows = spec.rows.filter((row) => row.section === section[0].name);
  assert.equal(rows.length, 10, '6 rules and 4 questions');
  assert.equal(spec.rows.filter((row) => row.status === 'approved').length, 0, 'nothing is approved');
  const rules = rows.filter((row) => row.status === 'draft');
  assert.deepEqual(rules.map((row) => row.text), PUBLISHED.rules.map((rule) => `${rule.text} Why: ${rule.why}`));
  assert.equal(rules[0].text, 'Every change ships with a test that fails without it. Why: a test that passes either way proves nothing.');
  const questions = rows.filter((row) => row.status === 'pending');
  assert.deepEqual(questions.map((row) => row.text), [
    'The app is built with: Next.js. Choices: Next.js, SvelteKit, Rails, Something else.',
    'It deploys to: Vercel. Choices: Vercel, Netlify, Fly.io, My own server.',
    'People sign in with: Email links. Choices: Email links, Passwords, Google, No sign-in yet.',
    'A change is done when: It runs on a preview link. Choices: It runs on a preview link, Its tests pass, I have looked at it.',
  ]);
  const ids = Object.fromEntries(added.rows.map((row) => [row.key, row.id]));
  assert.deepEqual(added.rows.map((row) => row.id), rows.map((row) => row.id));
  const doctrine = parseSpec(readFileSync(join(box.repo, 'DOCTRINE.md'), 'utf8'));
  for (const row of rows) assert.ok(!doctrine.rows.some((entry) => entry.id === row.id), `${row.id} is unique across SPEC.md and DOCTRINE.md`);
  const check = box.run('spec', 'check');
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.doesNotMatch(check.stdout + check.stderr, /words; rows stay under/u, 'a reason or the choices do not count toward the row length');

  // Starter items: open, citing the new rows, the third waiting on the first.
  const items = json(box, 'list', '--all').items.sort((a, b) => a.item_id - b.item_id);
  assert.deepEqual(items.map((item) => [item.item_title, item.item_status, item.item_spec_ids, item.item_after]), [
    ['Set up the test runner with one passing test', 'open', `${ids.W1},${ids.W2}`, ''],
    ['The home page works at phone width', 'open', ids.W3, ''],
    ['Every change gets a preview link', 'open', `${ids.Q2},${ids.Q4}`, String(items[0].item_id)],
  ]);
  assert.equal(JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8')).gate, 'npm test', 'the gate is set when there was none');

  // A repeat adds nothing twice: no rows, no items, the same files.
  const specAfter = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const configAfter = readFileSync(join(box.repo, 'pullboard.json'), 'utf8');
  const repeat = json(box, 'blueprint', 'add', 'web-app');
  assert.deepEqual([repeat.rows, repeat.items, repeat.gate], [[], [], null]);
  assert.equal(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'), specAfter);
  assert.equal(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'), configAfter);
  assert.equal(json(box, 'list', '--all').items.length, 3);
  const text = box.run('blueprint', 'add', 'web-app');
  assert.match(text.stdout, /already on this board; nothing added/u);

  // A bad file is refused with its problems named, and changes nothing.
  writeFileSync(join(box.repo, 'bad.json'), `${JSON.stringify({ ...PUBLISHED, name: 'Bad Name', items: [{ key: '1', title: 'x', cites: ['Z9'] }] })}\n`);
  const bad = box.run('blueprint', 'add', 'bad.json', '--json');
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  const error = JSON.parse(bad.stdout).error;
  assert.equal(error.code, 'BAD_BLUEPRINT');
  assert.match(error.message, /name must be lowercase/u);
  assert.match(error.message, /items\[0\]\.cites names "Z9"/u);
  writeFileSync(join(box.repo, 'broken.json'), '{ "blueprint": 1,');
  const broken = box.run('blueprint', 'add', 'broken.json', '--json');
  assert.equal(broken.status, 1);
  assert.equal(JSON.parse(broken.stdout).error.code, 'BAD_BLUEPRINT');
  const missing = box.run('blueprint', 'add', 'no-such-blueprint', '--json');
  assert.equal(JSON.parse(missing.stdout).error.code, 'NO_BLUEPRINT');
  assert.equal(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'), specAfter, 'refusals leave the spec alone');
  assert.equal(json(box, 'list', '--all').items.length, 3, 'refusals add no items');

  // A board that already has a gate keeps it.
  const gated = freshBoard({ gate: 'node --test' });
  json(gated, 'blueprint', 'add', 'web-app');
  assert.equal(JSON.parse(readFileSync(join(gated.repo, 'pullboard.json'), 'utf8')).gate, 'node --test');
});

test('blueprint add files a blueprint as drafts even when approved rows say the same [S1,I1]', () => {
  // Rows elsewhere in the spec, approved, with a rule's exact text and a question's prompt: the
  // blueprint still files every rule as a draft and every question as a pending row of its own.
  const box = freshBoard();
  const file = join(box.repo, 'SPEC.md');
  const rule = `${PUBLISHED.rules[0].text} Why: ${PUBLISHED.rules[0].why}`;
  writeFileSync(file, readFileSync(file, 'utf8').replace('## G · Goals: what the client asked for\n',
    `## G · Goals: what the client asked for\n- G1 [approved, must] ${rule} | gate: review\n- G2 [approved, must] ${PUBLISHED.questions[0].ask}: Rails. Choices: Rails. | gate: review\n`));
  box.git('commit', '-q', '-am', 'chore: approve two rows first');
  const added = json(box, 'blueprint', 'add', 'web-app');
  assert.deepEqual(added.rows.map((row) => row.status), [...Array(6).fill('draft'), ...Array(4).fill('pending')]);
  const spec = parseSpec(readFileSync(file, 'utf8'));
  const own = spec.rows.filter((row) => row.section === added.section);
  assert.equal(own.length, 10, 'the blueprint section holds all its own rows');
  assert.deepEqual(spec.rows.filter((row) => row.status === 'approved').map((row) => row.id), ['G1', 'G2'], 'the approved rows are untouched');
  const items = json(box, 'list', '--all').items.sort((a, b) => a.item_id - b.item_id);
  assert.equal(items[0].item_spec_ids, `${added.rows[0].id},${added.rows[1].id}`, 'starter items cite the blueprint rows, not the approved ones');
});

test('blueprint add files a blueprint as drafts or nothing at all [S1,I1]', () => {
  const box = freshBoard();
  const spec = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const config = readFileSync(join(box.repo, 'pullboard.json'), 'utf8');
  /** Write a variant of the published blueprint and add it, returning the refusal. */
  const refused = (name, items) => {
    writeFileSync(join(box.repo, `${name}.json`), `${JSON.stringify({ ...PUBLISHED, name, items })}\n`);
    const result = box.run('blueprint', 'add', `${name}.json`, '--json');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'), spec, `${name}: nothing is written to the spec`);
    assert.equal(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'), config, `${name}: the gate is left alone`);
    assert.equal(json(box, 'list', '--all').items.length, 0, `${name}: no item is added`);
    return JSON.parse(result.stdout).error;
  };
  // A later starter the board refuses (here a brief over its limit) stops the add before any write.
  const late = refused('late-refusal', [{ key: '1', title: 'First starter', cites: ['W1'] }, { key: '2', title: 'Second starter', brief: 'x'.repeat(8001) }]);
  assert.equal(late.code, 'BRIEF_TOO_LONG');
  // Light and mid starters need a coordinator's check and a cold brief, so a blueprint refuses them.
  for (const route of ['light', 'mid']) {
    const error = refused(`${route}-route`, [{ key: '1', title: 'First starter', cites: ['W1'] }, { key: '2', title: 'Second starter', route }]);
    assert.equal(error.code, 'BAD_BLUEPRINT');
    assert.match(error.message, new RegExp(`items\\[1\\]\\.route must be strong`, 'u'));
  }
  // After the refusals, the same blueprint fixed adds everything at once.
  const added = json(box, 'blueprint', 'add', 'web-app');
  assert.equal(added.rows.length, 10);
  assert.equal(added.items.length, 3);
});

test('blueprint add files a blueprint as drafts beside approved rows in its own section [S1,I1]', () => {
  // The person already wrote the blueprint's section, with one rule approved in the same words: a
  // first add still files every rule as a draft and every question as a pending row.
  const box = freshBoard();
  const file = join(box.repo, 'SPEC.md');
  const rule = `${PUBLISHED.rules[0].text} Why: ${PUBLISHED.rules[0].why}`;
  writeFileSync(file, `${readFileSync(file, 'utf8').trimEnd()}\n\n## A · Web app\n\n- A1 [approved, must] ${rule} | gate: review\n- A2 [approved, must] ${PUBLISHED.questions[0].ask}: Rails. Choices: Rails, Next.js. | gate: review\n`);
  box.git('commit', '-q', '-am', 'chore: approve rows in the blueprint section');
  const added = json(box, 'blueprint', 'add', 'web-app');
  assert.equal(added.section, 'A · Web app', 'the rows go in the existing section');
  assert.deepEqual(added.rows.map((row) => [row.key, row.status]), [
    ...PUBLISHED.rules.map((entry) => [entry.key, 'draft']), ...PUBLISHED.questions.map((entry) => [entry.key, 'pending'])]);
  const spec = parseSpec(readFileSync(file, 'utf8'));
  assert.deepEqual(spec.rows.filter((row) => row.status === 'approved').map((row) => row.id), ['A1', 'A2']);
  assert.equal(spec.rows.filter((row) => row.section === 'A · Web app').length, 12);
});

test('blueprint add files a blueprint as drafts after an add stopped part way [S1,I1]', () => {
  // A finished add on one board gives the exact rows; a second board is left where an add stops
  // after its rows and first starter: the rows and the under-way marker written, item 1 added.
  const reference = freshBoard();
  const done = json(reference, 'blueprint', 'add', 'web-app');
  const ids = Object.fromEntries(done.rows.map((row) => [row.key, row.id]));
  const underWay = `<!-- pullboard-blueprint web-app 1 adding ${Object.entries(ids).map(([key, id]) => `${key}=${id}`).join(' ')} -->`;
  const finished = readFileSync(join(reference.repo, 'SPEC.md'), 'utf8');
  assert.ok(finished.includes('<!-- pullboard-blueprint web-app 1 -->'));
  const box = freshBoard();
  writeFileSync(join(box.repo, 'SPEC.md'), finished.replace('<!-- pullboard-blueprint web-app 1 -->', underWay));
  box.git('commit', '-q', '-am', 'chore: leave an add part way');
  const first = json(box, 'add', 'coordinator', PUBLISHED.items[0].title, '--specs', `${ids.W1},${ids.W2}`);
  const retried = json(box, 'blueprint', 'add', 'web-app');
  assert.deepEqual(retried.rows, [], 'no row is filed twice');
  assert.deepEqual(retried.items.map((item) => item.key), ['2', '3'], 'only the missing starters are added');
  assert.deepEqual(retried.items.find((item) => item.key === '3').after, [first.item.item_id], 'the third starter still waits on the first');
  assert.equal(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'), finished, 'the finished marker replaces the under-way one');
  assert.equal(json(box, 'blueprint', 'add', 'web-app').items.length, 0, 'and then a repeat adds nothing');

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('a saved board adds back as the same rows [S1]', () => {
  const box = e2e.project();
  const machine = hostname().split('.')[0];
  box.git(box.repo, 'config', 'user.name', 'Dana Whitlock');
  box.git(box.repo, 'config', 'user.email', 'dana.whitlock@example.org');
  const kept = [
    '- K1 [approved, must] Every change ships with a test that fails without it. Why: a test that passes either way proves nothing. | gate: web/page.test.js | signers: DW',
    '- K2 [approved, aim] Every page works at phone width. Why: a page that only works on a laptop is a bug nobody reports. | gate: review',
    '- K3 [approved, must] The app is built with: SvelteKit. Choices: Next.js, SvelteKit, Rails. | gate: review',
  ];
  const planted = [
    '- K4 [approved, must] Logs live in web/logs/app.js. Why: one place to look. | gate: review',
    '- K5 [approved, must] Escalations go to dana.whitlock@example.org first. Why: she owns releases. | gate: review',
    '- K6 [approved, must] Agent web-1 owns the header. Why: it wrote it. | gate: review',
    '- K7 [approved, must] Dana approves every release. Why: she carries the pager. | gate: review',
    `- K8 [approved, must] Builds run on ${machine} only. Why: it holds the signing key. | gate: review`,
    '- K9 [approved, must] The page renders without a reason. | gate: review',
    '- K10 [draft, must] A draft never leaves. Why: nobody decided it. | gate: review',
    '- K11 [pending, must] Deploys go to: Vercel. Choices: Vercel, Fly.io. | gate: review',
  ];
  writeFileSync(join(box.repo, 'SPEC.md'), `${readFileSync(join(box.repo, 'SPEC.md'), 'utf8')}\n## K · Kept\n\n<!-- pullboard-blueprint kept 1 -->\n<!-- pullboard-blueprint kept 2 adding K1=K1 K3=K3 -->\n${[...kept, ...planted].join('\n')}\n`);
  box.git(box.repo, 'add', 'SPEC.md');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: plant private rows');
  const item = box.run(box.repo, 'add', 'web', 'Private item title zebra', '--specs', 'G1', '--criterion', 'secret criterion walrus');
  assert.equal(item.code, 0, item.err);
  assert.equal(box.run(box.web, 'shout', 'all', 'private shout narwhal').code, 0);

  const saved = box.run(box.repo, 'blueprint', 'save', '--json');
  assert.equal(saved.code, 0, `${saved.err}\n${saved.out}`);
  assert.deepEqual(JSON.parse(saved.out).left.map((entry) => entry.id).sort(), ['G1', 'G2', 'K4', 'K5', 'K6', 'K7', 'K8', 'K9'], 'only clean, reasoned approved rows leave');
  const file = join(box.repo, 'repo.blueprint.json');
  const text = readFileSync(file, 'utf8');
  for (const secret of ['web/', '@', 'Dana', 'Whitlock', 'web-1', machine, 'zebra', 'walrus', 'narwhal', 'signers', 'DW', 'items', 'pullboard-blueprint', 'Logs live', 'draft never', 'Deploys go']) {
    assert.ok(!text.includes(secret), `the blueprint never carries ${JSON.stringify(secret)}`);
  }
  const blueprint = JSON.parse(text);
  assert.deepEqual(Object.keys(blueprint).sort(), ['blueprint', 'gate', 'name', 'questions', 'rules', 'title', 'version'], 'only allow-listed fields are written');
  assert.deepEqual(blueprint.rules.map((rule) => Object.keys(rule).sort()), [['gate', 'key', 'text', 'tier', 'why'], ['gate', 'key', 'text', 'tier', 'why']]);
  assert.deepEqual(blueprint.questions.map((question) => Object.keys(question).sort()), [['ask', 'choices', 'default', 'key']]);
  assert.equal(box.run(box.repo, 'blueprint', 'save', '--json').code, 1, 'an existing file is never overwritten');

  const fresh = e2e.project();
  const before = parseSpec(readFileSync(join(fresh.repo, 'SPEC.md'), 'utf8')).rows.map((row) => row.id);
  const added = fresh.run(fresh.repo, 'blueprint', 'add', file);
  assert.equal(added.code, 0, `${added.err}\n${added.out}`);
  const rows = parseSpec(readFileSync(join(fresh.repo, 'SPEC.md'), 'utf8')).rows.filter((row) => !before.includes(row.id));
  assert.deepEqual(rows.map((row) => [row.status, row.tier, row.text]), [
    ['draft', 'must', 'Every change ships with a test that fails without it. Why: a test that passes either way proves nothing.'],
    ['draft', 'aim', 'Every page works at phone width. Why: a page that only works on a laptop is a bug nobody reports.'],
    ['pending', 'must', 'The app is built with: SvelteKit. Choices: Next.js, SvelteKit, Rails.'],
  ], 'the approved rows come back as drafts, the answered question with its answer as the default');
  assert.deepEqual(JSON.parse(fresh.run(fresh.repo, 'list', '--json').out).items ?? [], [], 'a saved blueprint files no items');
});
