/** A fresh main checkout uses its declared model for an agent worktree [I1,I2]. */
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';

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
