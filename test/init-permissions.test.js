/** Init adds only the requested project-local agent loop permissions and can skip them [I1,I2]. */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { runFixtureChild, runFixtureGit } from './fixture-child.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');

/** Create a real private Git project with isolated board and machine homes. */
function initFixture(t, { existingSettings, existingCodexRules } = {}) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-init-permissions-')));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, 'repo');
  const bin = join(temp, 'bin');
  mkdirSync(root);
  mkdirSync(bin);
  const env = {
    ...process.env,
    HOME: join(temp, 'home'),
    PULLBOARD_HOME: join(temp, 'board-home'),
    PULLBOARD_MACHINE_HOME: join(temp, 'machine-home'),
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Init Permissions Fixture',
    GIT_AUTHOR_EMAIL: 'init-permissions@example.invalid',
    GIT_COMMITTER_NAME: 'Init Permissions Fixture',
    GIT_COMMITTER_EMAIL: 'init-permissions@example.invalid',
  };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'].includes(key)) delete env[key];
  for (const key of ['PULLBOARD_RELAY_TOKEN', 'PULLBOARD_AGENT', 'PULLBOARD_AGENT_ID']) delete env[key];
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'init-permissions-fixture', scripts: { test: 'node --test' } }));
  if (existingSettings !== undefined) {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), `${JSON.stringify(existingSettings, null, 2)}\n`);
  }
  if (existingCodexRules !== undefined) {
    mkdirSync(join(root, '.codex', 'rules'), { recursive: true });
    writeFileSync(join(root, '.codex', 'rules', 'pullboard.rules'), existingCodexRules);
  }
  /** Invoke the real init command in JSON mode and preserve its status/document. */
  function init(...args) {
    const child = runFixtureChild(process.execPath, [BIN, 'init', ...args, '--json'], { cwd: root, env, encoding: 'utf8' });
    return { code: child.status, document: child.stdout ? JSON.parse(child.stdout) : null, stderr: child.failure ?? child.stderr };
  }
  return { root, init };
}

/** Parse Codex argv-prefix rules without depending on JSON whitespace. */
function codexPrefixes(contents) {
  return contents.split(/\r?\n/u)
    .filter(line => line.startsWith('prefix_rule('))
    .map((line) => {
      const match = line.match(/^prefix_rule\(pattern=(\[[^\]]*\]), decision="allow"/u);
      assert.ok(match, `Codex rule has a parseable prefix: ${line}`);
      return JSON.parse(match[1]);
    });
}

test('init grants the agent the permissions the Pullboard loop needs [I1,I2]', t => {
  const fresh = initFixture(t);
  const freshInit = fresh.init();
  assert.equal(freshInit.code, 0, freshInit.stderr);
  const freshSettings = JSON.parse(readFileSync(join(fresh.root, '.claude', 'settings.json'), 'utf8'));
  assert.ok(freshSettings.permissions?.allow?.includes('Bash(pullboard:*)'), 'fresh projects receive Claude loop rules');
  const freshCodexRules = readFileSync(join(fresh.root, '.codex', 'rules', 'pullboard.rules'), 'utf8');
  assert.deepEqual(codexPrefixes(freshCodexRules), [['pullboard'], ['git', 'status'], ['git', 'diff'], ['git', 'log'], ['git', 'add'], ['git', 'commit'], ['git', 'merge'], ['git', 'rebase'], ['git', 'switch'], ['git', 'checkout'], ['git', 'worktree'], ['npm', 'test']], 'fresh projects receive only the required Codex command prefixes');

  const existing = {
    custom: { keep: true },
    hooks: { UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'existing-hook' }] }] },
    permissions: {
      allow: ['Bash(existing command *)'],
      ask: ['Bash(git push *)'],
      deny: ['Bash(rm -rf *)'],
    },
  };
  const box = initFixture(t, { existingSettings: existing, existingCodexRules: '# user rule stays\n' });
  const initialized = box.init();
  assert.equal(initialized.code, 0, initialized.stderr);

  const settingsPath = join(box.root, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(settings.custom, existing.custom, 'unrelated settings remain unchanged');
  assert.deepEqual(settings.hooks.UserPromptSubmit, existing.hooks.UserPromptSubmit, 'existing hooks remain unchanged');
  assert.ok(settings.hooks.SessionStart, 'the existing Pullboard resume hook remains installed');
  assert.deepEqual(settings.permissions.ask, existing.permissions.ask, 'existing ask rules remain unchanged');
  assert.deepEqual(settings.permissions.deny, existing.permissions.deny, 'existing deny rules remain unchanged');
  const claudeRules = settings.permissions.allow;
  for (const rule of [
    'Bash(pullboard:*)',
    'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git add:*)',
    'Bash(git commit:*)', 'Bash(git merge:*)', 'Bash(git rebase:*)', 'Bash(git switch:*)',
    'Bash(git checkout:*)', 'Bash(git worktree:*)', 'Bash(npm test)',
    'Edit(/**)',
  ]) assert.ok(claudeRules.includes(rule), `Claude project allow rules include ${rule}`);
  assert.equal(claudeRules.includes('Bash(*)'), false, 'all shell commands are never allowed');
  assert.equal(claudeRules.includes('Bash(git:*)'), false, 'all Git commands are never allowed');

  const codexPath = join(box.root, '.codex', 'rules', 'pullboard.rules');
  const codexRules = readFileSync(codexPath, 'utf8');
  assert.ok(codexRules.startsWith('# user rule stays\n'), 'existing project Codex rules are preserved');
  assert.deepEqual(codexPrefixes(codexRules), [['pullboard'], ['git', 'status'], ['git', 'diff'], ['git', 'log'], ['git', 'add'], ['git', 'commit'], ['git', 'merge'], ['git', 'rebase'], ['git', 'switch'], ['git', 'checkout'], ['git', 'worktree'], ['npm', 'test']], 'Codex rules stay scoped to the exact loop commands');
  assert.ok(initialized.document.notes.some(note => /Claude Code.*Pullboard loop/u.test(note)), 'init says what Claude rules it added');
  assert.ok(initialized.document.notes.some(note => /trusted-project Codex rules.*trust this project and restart the session/u.test(note)), 'init explains trust and session restart for Codex rules');

  const settingsBytes = readFileSync(settingsPath, 'utf8');
  const codexBytes = readFileSync(codexPath, 'utf8');
  const second = box.init();
  assert.equal(second.code, 0, second.stderr);
  assert.equal(readFileSync(settingsPath, 'utf8'), settingsBytes, 'repeat init does not duplicate or rewrite Claude rules');
  assert.equal(readFileSync(codexPath, 'utf8'), codexBytes, 'repeat init does not duplicate or rewrite Codex rules');

  const skipFresh = initFixture(t);
  const skipFreshResult = skipFresh.init('--no-permissions');
  assert.equal(skipFreshResult.code, 0, skipFreshResult.stderr);
  const skipFreshSettings = JSON.parse(readFileSync(join(skipFresh.root, '.claude', 'settings.json'), 'utf8'));
  assert.equal(skipFreshSettings.permissions, undefined, '--no-permissions leaves fresh Claude permissions unset');
  assert.equal(existsSync(join(skipFresh.root, '.codex', 'rules', 'pullboard.rules')), false, '--no-permissions creates no Codex rules file');
  assert.equal(skipFreshResult.document.notes.some(note => /permission rules|trusted-project Codex/u.test(note)), false, '--no-permissions does not claim it installed agent rules');

  const skipExisting = initFixture(t, { existingSettings: existing, existingCodexRules: '# user rule stays\n' });
  const skipSettingsPath = join(skipExisting.root, '.claude', 'settings.json');
  const skipCodexPath = join(skipExisting.root, '.codex', 'rules', 'pullboard.rules');
  const skipPermissions = JSON.parse(readFileSync(skipSettingsPath, 'utf8')).permissions;
  const skipCodexBytes = readFileSync(skipCodexPath, 'utf8');
  const skipExistingResult = skipExisting.init('--no-permissions');
  assert.equal(skipExistingResult.code, 0, skipExistingResult.stderr);
  assert.deepEqual(JSON.parse(readFileSync(skipSettingsPath, 'utf8')).permissions, skipPermissions, '--no-permissions preserves existing Claude permissions');
  assert.equal(readFileSync(skipCodexPath, 'utf8'), skipCodexBytes, '--no-permissions preserves existing Codex rules byte-for-byte');
});
