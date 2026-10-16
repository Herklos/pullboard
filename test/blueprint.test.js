/** pullboard blueprint add: a blueprint lands on a board as drafts, once [S1,I1]. */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { runFixtureChild, runFixtureGit } from './fixture-child.js';
import { bundledBlueprints, readBlueprint } from '../src/blueprints.js';
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
  // A light or mid starter without what pullboard add requires is refused with add's own refusal.
  for (const route of ['light', 'mid']) {
    const error = refused(`${route}-route`, [{ key: '1', title: 'First starter', cites: ['W1'] }, { key: '2', title: 'Second starter', route }]);
    assert.equal(error.code, 'NO_BRIEF');
    assert.match(error.message, new RegExp(`an item routed ${route} must be buildable cold`, 'u'));
  }
  // After the refusals, the same blueprint fixed adds everything at once.
  const added = json(box, 'blueprint', 'add', 'web-app');
  assert.equal(added.rows.length, 10);
  assert.equal(added.items.length, 3);
});

/** Each pullboard.dev/blueprints card's title and rules, word for word, and how many things it asks the person. */
const GALLERY = {
  pullboard: { title: 'Pullboard, built on Pullboard', rules: ['A builder never verifies their own work.', "Every item's check fails before the change and passes after it.", 'Main only moves when the whole test suite passes.'], asks: 0 },
  website: { title: 'Website', rules: ['Every page reads in full with JavaScript turned off.', 'No change leaves a link pointing at a missing page.'], asks: 2 },
  'web-app': { title: 'Web app', rules: ['Every change ships with a test that fails without it.', 'Every page works at phone width before it ships.'], asks: 3 },
  library: { title: 'Open-source library', rules: ['A breaking change bumps the major version.', 'Every public function has a working example in the docs.'], asks: 2 },
  'ios-app': { title: 'iOS app', rules: ['Every screen has a light and a dark screenshot test.', 'No change removes a VoiceOver label from a screen.'], asks: 2 },
  serverless: { title: 'Serverless', rules: ['Every function has an alarm before it ships.', "No function runs past its platform's time limit."], asks: 3 },
  'data-pipeline': { title: 'Data pipeline', rules: ['A schema change ships with its migration.', 'A failed job names the rows and the reason.'], asks: 2 },
  'test-reliability': { title: 'Test reliability', rules: ['No test waits on the wall clock or a fixed sleep.', 'A flake is pinned on a change only after a run without it.'], asks: 1 },
  research: { title: 'Research board', rules: ['Every claim in a finding links to its source.', 'A finding counts only after a second agent rechecks its source.'], asks: 2 },
  writing: { title: 'Writing and blog', rules: ['Every fact in a post links to where it came from.', 'A post publishes only after you approve it.'], asks: 2 },
};

test('every gallery blueprint is bundled and valid [S1]', () => {
  assert.deepEqual(bundledBlueprints(), Object.keys(GALLERY).sort(), 'the bundled blueprints are exactly the gallery cards');
  for (const [name, card] of Object.entries(GALLERY)) {
    const blueprint = readBlueprint(name, process.cwd());
    assert.equal(blueprint.name, name);
    assert.equal(blueprint.title, card.title, `${name} carries its card's title`);
    assert.equal(blueprint.by, 'Pullboard', `${name} is made by Pullboard, not a client or private project`);
    const texts = blueprint.rules.map((rule) => rule.text);
    for (const rule of card.rules) assert.ok(texts.includes(rule), `${name} holds its card's rule word for word: ${rule}`);
    for (const rule of blueprint.rules) assert.ok(rule.why.trim().length > 10, `${name} ${rule.key} gives a reason`);
    assert.ok(blueprint.questions.length >= card.asks, `${name} asks at least what its card says it asks`);
  }
});

test('blueprint add files a blueprint as drafts with light and mid starters add accepts [S1,I1]', () => {
  // A light or mid starter carrying its brief, criterion and check is filed on that route, with
  // all three passed to the item unchanged; a strong starter needs none of them.
  const box = freshBoard({ gate: 'true' });
  const brief = 'Files:\n- web/index.html\nTest:\n- test/home.test.js asserts the page fits 375 pixels';
  const items = [
    { key: '1', title: 'Light starter', cites: ['W3'], route: 'light', brief, criterion: 'The home page fits 375 pixels.', check: 'true' },
    { key: '2', title: 'Mid starter', cites: ['W1'], route: 'mid', brief, criterion: 'A test fails without the change.', check: 'true', after: ['1'] },
    { key: '3', title: 'Strong starter', cites: ['W2'] },
  ];
  writeFileSync(join(box.repo, 'routes.json'), `${JSON.stringify({ ...PUBLISHED, name: 'routes', items })}\n`);
  const added = json(box, 'blueprint', 'add', 'routes.json');
  assert.equal(added.items.length, 3);
  const filed = json(box, 'list', '--all').items.sort((a, b) => a.item_id - b.item_id);
  assert.deepEqual(filed.map((item) => [item.item_title, item.item_route, item.item_check, item.item_criterion, item.item_brief]), [
    ['Light starter', 'light', 'true', items[0].criterion, brief],
    ['Mid starter', 'mid', 'true', items[1].criterion, brief],
    ['Strong starter', 'strong', '', '', ''],
  ]);
  assert.equal(filed[1].item_after, String(filed[0].item_id));
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
});

/** A Git repository with history but no Pullboard yet, using the same private homes as freshBoard. */
function emptyRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-blueprint-init-'));
  DIRS.push(dir);
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
  const runIn = (cwd, ...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  const run = (...args) => runIn(repo, ...args);
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: repo, env });
  return { dir, repo, run, runIn };
}

test('init --blueprint starts a board from a blueprint [I1,S1]', () => {
  const waiting = PUBLISHED.rules.length + PUBLISHED.questions.length;

  // A known name: init as usual, then the blueprint, in one command, with one summary line.
  const known = emptyRepo();
  const started = known.run('init', '--blueprint', 'web-app');
  assert.equal(started.status, 0, started.stdout + started.stderr);
  const summary = started.stdout.split('\n').filter((line) => line.startsWith(`added the ${PUBLISHED.title} blueprint:`));
  assert.equal(summary.length, 1, started.stdout);
  assert.match(summary[0], new RegExp(`: ${waiting} rows wait for your approval in SPEC\\.md \\(.*${PUBLISHED.title}\\), ${PUBLISHED.items.length} starter items filed`, 'u'));
  const spec = parseSpec(readFileSync(join(known.repo, 'SPEC.md'), 'utf8'));
  const section = spec.sections.find((entry) => entry.name.includes(PUBLISHED.title));
  assert.ok(section, 'the blueprint has its own SPEC.md section');
  const rows = spec.rows.filter((row) => row.section === section.name);
  assert.equal(rows.length, waiting);
  assert.ok(rows.every((row) => row.status !== 'approved'), 'nothing is approved');
  const items = JSON.parse(known.run('list', '--json').stdout).items ?? [];
  assert.equal(items.length, PUBLISHED.items.length, 'each starter item is filed once');
  assert.ok(existsSync(join(known.repo, 'pullboard.json')) && existsSync(join(known.repo, 'DOCTRINE.md')), 'init set the repository up as usual');

  // An unknown name: refused before anything is written, naming the bundled blueprints.
  const unknown = emptyRepo();
  const refused = unknown.run('init', '--blueprint', 'no-such-blueprint', '--json');
  assert.notEqual(refused.status, 0);
  const refusal = JSON.parse(refused.stdout).error;
  assert.equal(refusal.code, 'NO_BLUEPRINT');
  assert.match(refusal.message, /web-app/u, 'the refusal lists the bundled blueprints');
  assert.deepEqual(readdirSync(unknown.repo).filter((name) => name !== '.git'), [], 'nothing is written');
  assert.equal(existsSync(join(unknown.repo, '.git', 'pullboard')), false, 'no board is created');

  // A URL is refused unfetched and leaves the repository untouched. A starter that carries a check
  // is filed with that check stored, exactly as pullboard blueprint add files it.
  const remote = emptyRepo();
  const fetched = remote.run('init', '--blueprint', 'https://example.invalid/web-app.json', '--json');
  assert.notEqual(fetched.status, 0);
  assert.equal(JSON.parse(fetched.stdout).error.code, 'BLUEPRINT_URL');
  assert.deepEqual(readdirSync(remote.repo).filter((name) => name !== '.git'), [], 'a URL writes nothing');
  assert.equal(existsSync(join(remote.repo, '.git', 'pullboard')), false, 'a URL creates no board');
  const outside = mkdtempSync(join(tmpdir(), 'pullboard-blueprint-check-'));
  const withCheck = join(outside, 'checked.blueprint.json');
  writeFileSync(withCheck, JSON.stringify({ ...PUBLISHED, items: PUBLISHED.items.map((item, index) => (index === 0 ? { ...item, check: 'true' } : item)) }));
  const checkedRepo = emptyRepo();
  const checked = checkedRepo.run('init', '--blueprint', withCheck);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /checks stored, not run: #\d+; no check baseline ran/u, 'the summary says the check was not run');
  const filed = JSON.parse(checkedRepo.run('list', '--json').stdout).items ?? [];
  assert.equal(filed.length, PUBLISHED.items.length, 'every starter is filed, the checked one included');
  const starter = filed.find((item) => item.item_title === PUBLISHED.items[0].title);
  assert.ok(starter, 'the checked starter is on the board');
  assert.equal(starter.item_check, 'true', 'its check is stored as written');
  assert.equal(starter.item_check_baseline ?? null, null, 'no check baseline was started');
  rmSync(outside, { recursive: true, force: true });

  // Run from a subdirectory, a relative path names a file there: init reads it once, before
  // writing anything, and adds that very blueprint.
  const nested = emptyRepo();
  mkdirSync(join(nested.repo, 'plans'));
  writeFileSync(join(nested.repo, 'plans', 'local.json'), JSON.stringify({ ...PUBLISHED, name: 'local', title: 'Local plan' }));
  const fromSub = nested.runIn(join(nested.repo, 'plans'), 'init', '--blueprint', 'local.json');
  assert.equal(fromSub.status, 0, fromSub.stdout + fromSub.stderr);
  assert.match(fromSub.stdout, /added the Local plan blueprint:/u, 'the file next to the caller is the one added');
  assert.equal((JSON.parse(nested.run('list', '--json').stdout).items ?? []).length, PUBLISHED.items.length);

  // Plain init is unchanged: no blueprint section, no items, no summary line.
  const plain = emptyRepo();
  const initialized = plain.run('init');
  assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr);
  assert.doesNotMatch(initialized.stdout, /blueprint/u);
  assert.doesNotMatch(readFileSync(join(plain.repo, 'SPEC.md'), 'utf8'), /pullboard-blueprint/u);
  assert.deepEqual(JSON.parse(plain.run('list', '--json').stdout).items ?? [], []);
});

test('blueprint add files a blueprint as drafts and runs nothing it supplies [S1,I1]', () => {
  // A starter's check is stored on the item, but no check baseline starts: add executes nothing
  // from a blueprint, and says so. A blueprint is never read from a URL.
  const box = freshBoard({ gate: 'true' });
  const marker = join(box.dir, 'check-ran');
  const brief = 'Files:\n- web/index.html\nTest:\n- test/home.test.js asserts the page loads';
  const check = `touch '${marker}'`;
  writeFileSync(join(box.repo, 'checked.json'), `${JSON.stringify({ ...PUBLISHED, name: 'checked',
    items: [{ key: '1', title: 'Checked starter', cites: ['W1'], route: 'light', brief, criterion: 'The page loads.', check }] })}\n`);
  const added = json(box, 'blueprint', 'add', 'checked.json');
  const id = added.items[0].id;
  const item = json(box, 'show', String(id));
  assert.equal(item.item_check, check, 'the check is stored unchanged');
  assert.equal(item.item_check_baseline ?? null, null, 'no check baseline was started');
  assert.equal(existsSync(marker), false, 'the check command never ran');
  assert.deepEqual(added.checksNotRun, [id], 'the summary names the checks that were not run');
  const text = box.run('blueprint', 'add', 'checked.json');
  assert.match(text.stdout, /already on this board/u);
  for (const url of ['https://pullboard.dev/blueprints/web-app.json', 'file:///tmp/web-app.json']) {
    const refused = box.run('blueprint', 'add', url, '--json');
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.equal(JSON.parse(refused.stdout).error.code, 'BLUEPRINT_URL');
  }
});

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
    '- K12 [approved, must] Deploy: where it goes: Fly.io. Choices: Vercel, Fly.io. | gate: review',
    '- K13 [approved, must] People sign in with: Email, then a link. Choices: Email, then a link, Passwords. | gate: review',
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
    '- K14 [approved, must] Pick one: x. Choices: x, y, z, w. | gate: review',
    '- K15 [approved, must] Pick a host: Rails. Choices: Vercel, Fly.io. | gate: review',
    '- K16 [approved, must] A rule. Why: one. Why: two. | gate: review',
  ];
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...config, name: 'Dana Whitlock board' }, null, 2));
  writeFileSync(join(box.repo, 'SPEC.md'), `${readFileSync(join(box.repo, 'SPEC.md'), 'utf8')}\n## K · Kept\n\n<!-- pullboard-blueprint kept 1 -->\n<!-- pullboard-blueprint kept 2 adding K1=K1 K3=K3 -->\n${[...kept, ...planted].join('\n')}\n`);
  box.git(box.repo, 'add', 'SPEC.md', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: plant private rows');
  const item = box.run(box.repo, 'add', 'web', 'Private item title zebra', '--specs', 'G1', '--criterion', 'secret criterion walrus');
  assert.equal(item.code, 0, item.err);
  assert.equal(box.run(box.web, 'shout', 'all', 'private shout narwhal').code, 0);

  const saved = box.run(box.repo, 'blueprint', 'save', '--json');
  assert.equal(saved.code, 0, `${saved.err}\n${saved.out}`);
  assert.deepEqual(JSON.parse(saved.out).left.map((entry) => entry.id).sort(), ['G1', 'G2', 'K14', 'K15', 'K16', 'K4', 'K5', 'K6', 'K7', 'K8', 'K9'], 'only clean, exactly readable approved rows leave');
  const file = join(box.repo, 'Dana Whitlock board.blueprint.json');
  const text = readFileSync(file, 'utf8');
  for (const secret of ['web/', '@', 'Dana', 'Whitlock', 'web-1', machine, 'zebra', 'walrus', 'narwhal', 'signers', 'DW', 'items', 'pullboard-blueprint', 'Logs live', 'draft never', 'Deploys go']) {
    assert.ok(!text.includes(secret), `the blueprint never carries ${JSON.stringify(secret)}`);
  }
  const blueprint = JSON.parse(text);
  assert.deepEqual([blueprint.name, blueprint.title], ['my-blueprint', 'My blueprint'], 'the project name never goes in; a neutral default does');
  const named = box.run(box.repo, 'blueprint', 'save', 'named.json', '--name', 'dana-whitlock', '--json');
  assert.equal(JSON.parse(named.out).error?.code, 'PRIVATE_BLUEPRINT', 'a chosen name that names someone is refused');
  assert.deepEqual(Object.keys(blueprint).sort(), ['blueprint', 'gate', 'name', 'questions', 'rules', 'title', 'version'], 'only allow-listed fields are written');
  assert.deepEqual(blueprint.rules.map((rule) => Object.keys(rule).sort()), [['gate', 'key', 'text', 'tier', 'why'], ['gate', 'key', 'text', 'tier', 'why']]);
  assert.deepEqual(blueprint.questions.map((question) => Object.keys(question).sort()), Array(3).fill(['ask', 'choices', 'default', 'key']));
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
    ['pending', 'must', 'Deploy: where it goes: Fly.io. Choices: Vercel, Fly.io.'],
    ['pending', 'must', 'People sign in with: Email, then a link. Choices: Email, then a link, Passwords.'],
  ], 'the approved rows come back as drafts, each answered question exactly, its answer the default');
  assert.deepEqual(JSON.parse(fresh.run(fresh.repo, 'list', '--json').out).items ?? [], [], 'a saved blueprint files no items');
});
