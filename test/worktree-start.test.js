/** A fresh main checkout uses its declared model for an agent worktree [I1,I2]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';
import { configProblems, defaults } from '../src/config.js';
import { installStep } from '../src/worktree.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project } = e2e;
const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');

test("the README's worktree command works in a fresh repo [I1,I2]", () => {
  const box = sandbox();
  const { repo } = project('true', box);
  box.env.CODEX_THREAD_ID = 'main-owner-session';
  box.env.PULLBOARD_MODEL = 'Coordinator Session Model';
  const coordinator = box.run(repo, 'join', 'coordinator', '--model', 'Coordinator Session Model');
  assert.equal(coordinator.code, 0, coordinator.err || coordinator.out);

  box.env.PULLBOARD_MODEL = 'Session Worktree Model';
  const made = box.run(repo, 'worktree', 'web', '--json');
  assert.equal(made.code, 0, made.err || made.out);
  const madeResult = JSON.parse(made.out);
  assert.equal(madeResult.model, 'Session Worktree Model',
    'worktree takes the model from PULLBOARD_MODEL');
  const joinedIdentity = box.run(madeResult.path, 'whoami', '--json');
  assert.equal(joinedIdentity.code, 0, joinedIdentity.err || joinedIdentity.out);
  const identity = JSON.parse(joinedIdentity.out);
  assert.equal(identity.lane, 'web');
  assert.equal(identity.model, 'Session Worktree Model', 'the created worktree is joined under its declared model');

  delete box.env.PULLBOARD_MODEL;
  const before = box.git(repo, 'worktree', 'list', '--porcelain');
  const missingWorktreeModel = runFixtureChild(process.execPath, [BIN, 'worktree', 'api'],
    { cwd: repo, env: box.env, encoding: 'utf8' });
  assert.equal(missingWorktreeModel.status, 1);
  assert.equal(missingWorktreeModel.stderr,
    'pullboard: [MODEL_REQUIRED] this session has not declared its model\nnext: run pullboard worktree api --model "<model name>"\n');
  assert.doesNotMatch(missingWorktreeModel.stderr, /pullboard help/u, 'no generic help footer follows the --model next step');
  const missingWorktreeJson = box.run(repo, 'worktree', 'api', '--json');
  assert.equal(missingWorktreeJson.code, 1);
  assert.equal(JSON.parse(missingWorktreeJson.out).error.next,
    'run pullboard worktree api --model "<model name>"');
  assert.equal(box.git(repo, 'worktree', 'list', '--porcelain'), before,
    'missing model guidance does not create a worktree');
  assert.equal(box.tryGit(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/api/1').status, 1,
    'missing model guidance does not create a branch');

  box.env.PULLBOARD_MODEL = 'Session Join Model';
  const envJoin = join(box.dir, 'env-join');
  box.git(repo, 'worktree', 'add', '-q', '--detach', envJoin, 'HEAD');
  const joined = box.run(envJoin, 'join', 'api');
  assert.equal(joined.code, 0, joined.err || joined.out);
  assert.match(joined.out, /joined as api-1 \(Session Join Model\)/,
    'join takes the model from PULLBOARD_MODEL');

  delete box.env.PULLBOARD_MODEL;
  const missingJoin = join(box.dir, 'join-without-model');
  box.git(repo, 'worktree', 'add', '-q', '--detach', missingJoin, 'HEAD');
  const missingJoinModel = runFixtureChild(process.execPath, [BIN, 'join', 'api'],
    { cwd: missingJoin, env: box.env, encoding: 'utf8' });
  assert.equal(missingJoinModel.status, 1);
  assert.equal(missingJoinModel.stderr,
    'pullboard: [MODEL_REQUIRED] this session has not declared its model\nnext: run pullboard join api --model "<model name>"\n');
  assert.doesNotMatch(missingJoinModel.stderr, /pullboard help/u, 'no generic help footer follows the --model next step');
  const missingJoinJson = box.run(missingJoin, 'join', 'api', '--json');
  assert.equal(missingJoinJson.code, 1);
  assert.equal(JSON.parse(missingJoinJson.out).error.next,
    'run pullboard join api --model "<model name>"');
});

test('a new worktree is created inside the repository [I1,I2]', () => {
  for (const mode of ['inside', 'beside', undefined]) {
    const box = sandbox();
    const { repo, web } = project('true', box);
    const configPath = join(repo, 'pullboard.json');
    const originalConfigText = readFileSync(configPath, 'utf8');
    const config = JSON.parse(originalConfigText);
    if (mode === undefined) delete config.worktrees;
    else config.worktrees = mode;
    const configText = `${JSON.stringify(config, null, 2)}\n`;
    if (configText !== originalConfigText) {
      writeFileSync(configPath, configText);
      box.git(repo, 'add', 'pullboard.json');
      box.git(repo, 'commit', '-q', '-m', 'chore: configure agent worktree location');
    }

    // Leave the sibling on its older config to prove placement follows the current main checkout.
    box.env.PULLBOARD_MODEL = 'Worktree Location Model';
    const made = box.run(web, 'worktree', 'api', '--json');
    assert.equal(made.code, 0, made.err || made.out);
    const result = JSON.parse(made.out);
    const expected = mode === 'inside'
      ? join(repo, '.claude', 'worktrees', 'api-1')
      : join(dirname(repo), `${basename(repo)}-api-1`);
    assert.equal(resolve(result.path), resolve(expected), `${mode ?? 'omitted'} keeps its specified location`);
    assert.equal(box.git(repo, 'status', '--porcelain'), '', 'the nested worktree stays ignored by the main checkout');
    assert.equal(box.run(web, 'whoami', '--json').code, 0, 'the existing sibling remains usable');
    const newIdentity = box.run(result.path, 'whoami', '--json');
    assert.equal(newIdentity.code, 0, newIdentity.err || newIdentity.out);
    assert.equal(JSON.parse(newIdentity.out).lane, 'api');
    assert.ok(existsSync(join(result.path, '.githooks', 'pre-commit')), 'the new worktree has its commit hook');
    const resumed = box.run(web, 'resume');
    assert.equal(resumed.code, 0, resumed.err);
    assert.match(resumed.out, mode === 'inside'
      ? /New agent worktrees: .*\.claude\/worktrees\/<lane>-N/u
      : /New agent worktrees: .*repo-<lane>-N/u);
    const resumedJson = box.run(web, 'resume', '--json');
    assert.equal(JSON.parse(resumedJson.out).newWorktreeLocation, mode === 'inside'
      ? join(repo, '.claude', 'worktrees', '<lane>-N')
      : join(dirname(repo), `${basename(repo)}-<lane>-N`));
    assert.match(box.run(web, 'help', 'worktree').out, mode === 'inside'
      ? /Active worktree location: .*\.claude\/worktrees\/<lane>-N/u
      : /Active worktree location: .*repo-<lane>-N/u);
  }

  assert.deepEqual(configProblems({ ...defaults(), worktrees: 'inside' }), []);
  assert.deepEqual(configProblems({ ...defaults(), worktrees: 'beside' }), []);
  assert.ok(configProblems({ ...defaults(), worktrees: 'somewhere' }).some(problem => problem.includes('"worktrees"')));

  const box = sandbox();
  const repo = join(box.dir, 'separate-main');
  const gitDir = join(box.dir, 'separate-git-dir');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main', '--separate-git-dir', gitDir);
  assert.equal(box.run(repo, 'init').code, 0);
  const configPath = join(repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.lanes = { web: { owns: ['web/'], specs: [] }, api: { owns: ['api/'], specs: [] } };
  config.worktrees = 'inside';
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: configure separate git dir fixture');
  box.env.PULLBOARD_MODEL = 'Separate Git Dir Model';
  const made = box.run(repo, 'worktree', 'web', '--json');
  assert.equal(made.code, 0, made.err || made.out);
  const linkedPath = JSON.parse(made.out).path;
  assert.equal(resolve(linkedPath), resolve(repo, '.claude', 'worktrees', 'web-1'));
  const nestedMade = box.run(linkedPath, 'worktree', 'api', '--json');
  assert.equal(nestedMade.code, 0, nestedMade.err || nestedMade.out);
  assert.equal(resolve(JSON.parse(nestedMade.out).path), resolve(repo, '.claude', 'worktrees', 'api-1'),
    'a linked checkout with a separate git dir resolves its registered main root');
  const registryPath = join(box.env.PULLBOARD_HOME, 'projects.json');
  const registryBytes = readFileSync(registryPath);
  const linkedResume = box.run(linkedPath, 'resume');
  assert.match(linkedResume.out, /New agent worktrees: .*\.claude\/worktrees\/<lane>-N/u);
  assert.deepEqual(readFileSync(registryPath), registryBytes, 'resume reads the registry without refreshing it');
  const linkedHelp = box.run(linkedPath, 'help', 'worktree');
  assert.match(linkedHelp.out, /Active worktree location: .*\.claude\/worktrees\/<lane>-N/u);
  assert.deepEqual(readFileSync(registryPath), registryBytes, 'help reads the registry without refreshing it');

  rmSync(registryPath);
  const missingRegistry = box.run(linkedPath, 'worktree', 'api', '--json');
  assert.notEqual(missingRegistry.code, 0);
  assert.equal(JSON.parse(missingRegistry.out).error.code, 'NO_POLICY', 'an unprovable primary root fails closed');
  assert.equal(existsSync(join(repo, '.claude', 'worktrees', 'api-2')), false, 'missing registry creates no worktree');
  assert.notEqual(box.tryGit(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/api/2').status, 0,
    'missing registry creates no branch');
  const missingResume = box.run(linkedPath, 'resume', '--json');
  assert.equal(missingResume.code, 0, missingResume.err || missingResume.out);
  assert.match(JSON.parse(missingResume.out).newWorktreeLocation, /^unavailable; run pullboard resume from the main checkout/u);
  assert.match(box.run(linkedPath, 'help', 'worktree').out,
    /Active worktree location: unavailable; run pullboard resume from the main checkout/u,
    'help remains usable when the primary root is unprovable');
  assert.equal(existsSync(registryPath), false, 'read-only help and resume do not recreate a missing registry');

  writeFileSync(registryPath, registryBytes);
  writeFileSync(registryPath, '{not valid JSON');
  const malformedRegistry = box.run(linkedPath, 'worktree', 'web', '--json');
  assert.notEqual(malformedRegistry.code, 0);
  assert.equal(JSON.parse(malformedRegistry.out).error.code, 'NO_POLICY', 'a malformed registry cannot authorize a guessed sibling');
  assert.equal(existsSync(join(repo, '.claude', 'worktrees', 'web-2')), false, 'malformed registry creates no worktree');
  assert.notEqual(box.tryGit(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/web/2').status, 0,
    'malformed registry creates no branch');
  const malformedBytes = readFileSync(registryPath);
  const malformedResume = box.run(linkedPath, 'resume', '--json');
  assert.equal(malformedResume.code, 0, malformedResume.err || malformedResume.out);
  assert.match(JSON.parse(malformedResume.out).newWorktreeLocation, /^unavailable; run pullboard resume from the main checkout/u);
  assert.match(box.run(linkedPath, 'help', 'worktree').out,
    /Active worktree location: unavailable; run pullboard resume from the main checkout/u,
    'help remains usable with a malformed registry');
  assert.deepEqual(readFileSync(registryPath), malformedBytes, 'read-only help and resume preserve malformed registry bytes');

  writeFileSync(registryPath, `${JSON.stringify({ projects: [] }, null, 2)}\n`);
  const emptyRegistry = box.run(linkedPath, 'worktree', 'api', '--json');
  assert.notEqual(emptyRegistry.code, 0);
  assert.equal(JSON.parse(emptyRegistry.out).error.code, 'NO_POLICY', 'a valid but unrelated registry is unprovable');
  assert.equal(existsSync(join(repo, '.claude', 'worktrees', 'api-2')), false, 'unrelated registry creates no worktree');
  assert.notEqual(box.tryGit(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/api/2').status, 0,
    'unrelated registry creates no branch');
  assert.equal(box.git(repo, 'status', '--porcelain'), '');
});

test('worktree suggests no install for a zero-dependency project [I1,L3]', () => {
  const box = sandbox();
  // Git selectors inherited from a hook would point the fixture's git at the outer repository.
  for (const key of Object.keys(box.env)) if (key.startsWith('GIT_') && !key.startsWith('GIT_CONFIG_') && !/^GIT_(?:AUTHOR|COMMITTER)_/u.test(key)) delete box.env[key];
  const { repo } = project('true', box);
  box.env.CODEX_THREAD_ID = 'main-owner-session';
  box.env.PULLBOARD_MODEL = 'Install Step Model';
  const coordinator = box.run(repo, 'join', 'coordinator');
  assert.equal(coordinator.code, 0, coordinator.err || coordinator.out);
  /** Commit files on main as the coordinator, then make a web worktree and return its output. */
  const worktreeAfter = (files) => {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(repo, name), text);
    box.git(repo, 'add', '-A');
    box.git(repo, 'commit', '-q', '-m', 'chore: change the package');
    const made = box.run(repo, 'worktree', 'web');
    assert.equal(made.code, 0, made.err || made.out);
    return made.out;
  };

  const none = worktreeAfter({ 'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'true' }, dependencies: {}, devDependencies: {} }) });
  assert.doesNotMatch(none, /\bnpm (?:install|ci)\b/u, 'a package.json without dependencies gets no install step');
  assert.match(none, /pullboard inbox\n/u, 'the other next steps still print');

  const locked = worktreeAfter({
    'package.json': JSON.stringify({ name: 'demo', devDependencies: { 'left-pad': '1.3.0' } }),
    'package-lock.json': JSON.stringify({ name: 'demo', lockfileVersion: 3, packages: {} }),
  });
  assert.match(locked, /\bnpm (?:install|ci)\b/u, 'devDependencies alone count as dependencies');
  assert.match(locked, /&& npm ci {4}\(its own install from the committed package-lock\.json, so its tests run its own code\)\n/u,
    'a committed lockfile gets npm ci');
  assert.doesNotMatch(locked, /\bnpm install\b/u, 'npm install would rewrite the committed lockfile');

  box.git(repo, 'rm', '-q', 'package-lock.json');
  const unlocked = worktreeAfter({ 'package.json': JSON.stringify({ name: 'demo', dependencies: { 'left-pad': '1.3.0' } }) });
  assert.match(unlocked, /&& npm install {4}\(its own install; it writes package-lock\.json, so commit that file or the first submit is refused UNTRACKED\)\n/u,
    'without a committed lockfile the step is npm install, with the lockfile it writes named for commit');
  assert.doesNotMatch(unlocked, /\bnpm ci\b/u, 'npm ci fails without a lockfile');

  // A lockfile on disk that git does not track is not committed; a tracked shrinkwrap is.
  const loose = join(box.dir, 'loose');
  mkdirSync(loose);
  box.git(loose, 'init', '-q', '-b', 'main');
  writeFileSync(join(loose, 'package.json'), JSON.stringify({ name: 'loose', dependencies: { 'left-pad': '1.3.0' } }));
  box.git(loose, 'add', 'package.json');
  box.git(loose, 'commit', '-q', '-m', 'chore: package');
  writeFileSync(join(loose, 'package-lock.json'), '{}');
  assert.equal(installStep(loose)?.command, 'npm install', 'an untracked package-lock.json does not count as committed');
  writeFileSync(join(loose, 'npm-shrinkwrap.json'), '{}');
  box.git(loose, 'add', 'npm-shrinkwrap.json');
  assert.deepEqual(installStep(loose), { command: 'npm ci', note: 'its own install from the committed npm-shrinkwrap.json, so its tests run its own code' },
    'a tracked npm-shrinkwrap.json is a committed lockfile');
});
