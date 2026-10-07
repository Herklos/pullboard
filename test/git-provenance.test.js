/** Running source provenance ignores inherited Git hook repository overrides [A5,A6]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

/** Run Git in a disposable fixture without depending on user or system config. */
function git(cwd, args, env) {
  return spawnSync('git', args, { cwd, env, encoding: 'utf8' });
}

/** Ask a fresh Node process for source provenance under inherited Git directory variables. */
function probe(moduleURL, root, env) {
  const script = `import { codeIsFromMain } from ${JSON.stringify(moduleURL)}; process.stdout.write(String(codeIsFromMain(process.argv[1])));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, root], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout === 'true';
}

test('[A5,A6] code provenance strips inherited GIT_DIR in both worktree-to-main directions', (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'pullboard-git-provenance-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const main = join(fixture, 'main');
  const linked = join(fixture, 'linked');
  mkdirSync(main);
  const baseEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Provenance test',
    GIT_AUTHOR_EMAIL: 'provenance@example.test',
    GIT_COMMITTER_NAME: 'Provenance test',
    GIT_COMMITTER_EMAIL: 'provenance@example.test',
  };
  const init = git(main, ['init', '-q', '-b', 'main'], baseEnv);
  assert.equal(init.status, 0, init.stderr);
  writeFileSync(join(main, 'README.md'), 'fixture\n');
  for (const args of [['add', 'README.md'], ['commit', '-q', '-m', 'fixture']]) {
    const result = git(main, args, baseEnv);
    assert.equal(result.status, 0, result.stderr);
  }
  const worktree = git(main, ['worktree', 'add', '-q', '-b', 'feature', linked], baseEnv);
  assert.equal(worktree.status, 0, worktree.stderr);
  const mainGitDir = git(main, ['rev-parse', '--path-format=absolute', '--git-dir'], baseEnv).stdout.trim();
  const linkedGitDir = git(linked, ['rev-parse', '--path-format=absolute', '--git-dir'], baseEnv).stdout.trim();
  const commonGitDir = git(main, ['rev-parse', '--path-format=absolute', '--git-common-dir'], baseEnv).stdout.trim();
  const helperURL = pathToFileURL(resolve(import.meta.dirname, '../src/git.js')).href;

  const worktreeAsMain = probe(helperURL, linked, {
    ...baseEnv, GIT_DIR: mainGitDir, GIT_WORK_TREE: main, GIT_COMMON_DIR: mainGitDir,
  });
  assert.equal(worktreeAsMain, false, 'worktree source remains unmerged when its process inherits main checkout variables');

  const mainAsWorktree = probe(helperURL, main, {
    ...baseEnv, GIT_DIR: linkedGitDir, GIT_WORK_TREE: linked, GIT_COMMON_DIR: commonGitDir,
  });
  assert.equal(mainAsWorktree, true, 'main source can upgrade in a hook that inherits linked-worktree variables');
});
