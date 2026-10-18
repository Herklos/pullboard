/** Check that init only resolves the detected gate executable and never runs it [I1, I2]. */
import assert from 'node:assert/strict';
import { accessSync, chmodSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Create a fresh git repository whose detected gate is pytest. */
function pythonRepo(box, name) {
  const root = join(box.dir, name);
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "gate-check-fixture"\n');
  return root;
}

/** Keep git available while excluding unrelated host commands from this init process's PATH. */
function isolatedPath(box, name = 'isolated-path') {
  const source = (process.env.PATH ?? '').split(delimiter).map((directory) => join(directory, process.platform === 'win32' ? 'git.exe' : 'git'))
    .find((file) => {
      try {
        const info = statSync(file);
        if (!info.isFile()) return false;
        accessSync(file, fsConstants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  assert.ok(source, 'the test runner has git available on its PATH');
  const path = join(box.dir, name);
  mkdirSync(path);
  symlinkSync(source, join(path, process.platform === 'win32' ? 'git.exe' : 'git'));
  box.env.PATH = path;
  return path;
}

/** Write a harmless executable sentinel so the test can detect an accidental gate invocation. */
function writeGateSentinel(file, marker) {
  const quotedMarker = `'${marker.replaceAll("'", "'\\''")}'`;
  writeFileSync(file, `#!/bin/sh\nprintf invoked > ${quotedMarker}\n`);
  chmodSync(file, 0o755);
}

test('init says when its gate command cannot run [I1, I2]', () => {
  const box = e2e.sandbox();
  for (const name of ['UV_PROJECT_ENVIRONMENT', 'POETRY_ACTIVE', 'POETRY_VIRTUALENVS_PATH', 'VIRTUAL_ENV']) delete box.env[name];
  const path = isolatedPath(box);

  const missingRoot = pythonRepo(box, 'missing-gate');
  const missing = box.run(missingRoot, 'init');
  assert.equal(missing.code, 0, missing.err || missing.out);
  const warnings = missing.out.split(/\r?\n/u).filter((line) => line.includes('gate command "pytest" is not available'));
  assert.equal(warnings.length, 1, 'a missing gate gets one actionable line');
  assert.match(warnings[0], /install pytest or activate the project `\.venv`/u);

  const pathRoot = pythonRepo(box, 'path-gate');
  const pathMarker = join(box.dir, 'path-gate-ran');
  writeGateSentinel(join(path, process.platform === 'win32' ? 'pytest.cmd' : 'pytest'), pathMarker);
  const onPath = box.run(pathRoot, 'init');
  assert.equal(onPath.code, 0, onPath.err || onPath.out);
  assert.doesNotMatch(onPath.out, /gate command "pytest" is not available/u);
  assert.equal(existsSync(pathMarker), false, 'init checks the executable without running the gate');
  rmSync(join(path, process.platform === 'win32' ? 'pytest.cmd' : 'pytest'));

  const environmentRoot = pythonRepo(box, 'venv-gate');
  const environmentMarker = join(box.dir, 'venv-gate-ran');
  const environmentBin = join(environmentRoot, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
  mkdirSync(environmentBin, { recursive: true });
  writeGateSentinel(join(environmentBin, process.platform === 'win32' ? 'pytest.cmd' : 'pytest'), environmentMarker);
  const inEnvironment = box.run(environmentRoot, 'init');
  assert.equal(inEnvironment.code, 0, inEnvironment.err || inEnvironment.out);
  assert.doesNotMatch(inEnvironment.out, /gate command "pytest" is not available/u);
  assert.equal(existsSync(environmentMarker), false, 'init does not execute a gate found in .venv');

  const uvRoot = pythonRepo(box, 'uv-gate');
  const uvMarker = join(box.dir, 'uv-gate-ran');
  const uvEnvironment = join(box.dir, 'uv-environment');
  mkdirSync(join(uvEnvironment, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true });
  writeGateSentinel(join(uvEnvironment, process.platform === 'win32' ? 'Scripts/pytest.cmd' : 'bin/pytest'), uvMarker);
  box.env.UV_PROJECT_ENVIRONMENT = uvEnvironment;
  const inUvEnvironment = box.run(uvRoot, 'init');
  assert.equal(inUvEnvironment.code, 0, inUvEnvironment.err || inUvEnvironment.out);
  assert.doesNotMatch(inUvEnvironment.out, /gate command "pytest" is not available/u);
  assert.equal(existsSync(uvMarker), false, 'init does not execute a gate found in the configured uv environment');
  delete box.env.UV_PROJECT_ENVIRONMENT;

  const poetryRoot = pythonRepo(box, 'poetry-gate');
  writeFileSync(join(poetryRoot, 'poetry.lock'), '');
  const poetryMarker = join(box.dir, 'poetry-gate-ran');
  const poetryCache = join(box.dir, 'poetry-environments');
  const decoyEnvironment = join(poetryCache, 'gate-check-fixture-a1b2-py3.12');
  mkdirSync(join(decoyEnvironment, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true });
  writeGateSentinel(join(decoyEnvironment, process.platform === 'win32' ? 'Scripts/pytest.cmd' : 'bin/pytest'), poetryMarker);
  box.env.POETRY_VIRTUALENVS_PATH = poetryCache;
  const decoy = box.run(poetryRoot, 'init');
  assert.equal(decoy.code, 0, decoy.err || decoy.out);
  assert.match(decoy.out, /gate command "pytest" is not available on PATH, project `\.venv`/u,
    'a same-name Poetry cache entry is not assumed to belong to this repo');
  assert.match(decoy.out, /run `poetry install` and activate that environment/u);
  assert.equal(existsSync(poetryMarker), false, 'init does not execute a same-name Poetry cache entry');

  delete box.env.POETRY_VIRTUALENVS_PATH;
  const activePoetry = join(box.dir, 'active-poetry-environment');
  mkdirSync(join(activePoetry, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true });
  writeGateSentinel(join(activePoetry, process.platform === 'win32' ? 'Scripts/pytest.cmd' : 'bin/pytest'), poetryMarker);
  box.env.POETRY_ACTIVE = '1';
  box.env.VIRTUAL_ENV = activePoetry;
  const inPoetryEnvironment = box.run(poetryRoot, 'init');
  assert.equal(inPoetryEnvironment.code, 0, inPoetryEnvironment.err || inPoetryEnvironment.out);
  assert.doesNotMatch(inPoetryEnvironment.out, /gate command "pytest" is not available/u,
    'an explicitly active Poetry environment is checked');
  assert.equal(existsSync(poetryMarker), false, 'init does not execute a gate found in the active Poetry environment');
});

test('a repo without package.json is told a gate that fits it [C7,B26]', () => {
  const box = e2e.sandbox();
  const root = join(box.dir, 'no-package');
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, 'app'));
  const marker = join(box.dir, 'project-gate-ran');
  writeFileSync(join(root, 'app', 'project-check.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'tested\\n');\n`);

  const initialized = box.run(root, 'init');
  assert.equal(initialized.code, 0, initialized.err || initialized.out);
  assert.equal(existsSync(join(root, 'package.json')), false, 'the newcomer repo has no package manifest');
  assert.equal(existsSync(marker), false, 'init does not execute a project command it has not detected');
  assert.match(initialized.out, /ask the person which command tests this project/u);
  const initializedGate = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8')).gate;
  const pending = box.run(root, 'resume', '--json');
  assert.equal(pending.code, 0, pending.err || pending.out);
  assert.equal(JSON.parse(pending.out).setup.steps.find(step => step.number === 3).done, false,
    'an unknown project keeps its gate choice unanswered');

  // Keep a legacy empty-gate board to exercise the real NO_GATE refusal after init.
  const config = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8'));
  config.gate = '';
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify(config, null, 2));
  const lane = box.run(root, 'lane', 'add', 'app', '--owns', 'app/');
  assert.equal(lane.code, 0, lane.err || lane.out);
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', 'chore: set up the no-manifest board');

  const added = box.run(root, 'add', 'app', 'No-manifest newcomer change',
    '--criterion', 'the result file is present', '--check', 'test -f app/result.txt', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  const id = String(JSON.parse(added.out).item.item_id);
  const worktree = join(box.dir, 'app-agent');
  box.git(root, 'worktree', 'add', '-q', '-b', 'app/one', worktree);
  const joined = box.run(worktree, 'join', 'app');
  assert.equal(joined.code, 0, joined.err || joined.out);
  const claimed = box.run(worktree, 'claim', id, '--json');
  assert.equal(claimed.code, 0, claimed.err || claimed.out);
  mkdirSync(join(worktree, 'app'), { recursive: true });
  writeFileSync(join(worktree, 'app', 'result.txt'), 'done\n');
  box.git(worktree, 'add', 'app/result.txt');
  box.git(worktree, 'commit', '-q', '-m', 'chore: finish the newcomer change');

  const submitted = box.run(worktree, 'submit', id, '--json');
  assert.equal(submitted.code, 1, submitted.err || submitted.out);
  const refusal = JSON.parse(submitted.out).error;
  assert.equal(refusal.code, 'NO_GATE', submitted.out);
  assert.deepEqual({
    initializedGate,
    refusalCode: refusal.code,
    nextNamesInitCommand: /pullboard spec check/u.test(refusal.next),
    nextNamesUnavailableNpm: /\bnpm test\b/u.test(refusal.next),
  }, {
    initializedGate: '',
    refusalCode: 'NO_GATE',
    nextNamesInitCommand: true,
    nextNamesUnavailableNpm: false,
  });

  const chosenConfig = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8'));
  chosenConfig.gate = 'node app/project-check.mjs';
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify(chosenConfig, null, 2));
  box.git(root, 'add', 'pullboard.json');
  box.git(root, 'commit', '-q', '-m', 'chore: choose the project test command');
  const chosen = box.run(root, 'resume', '--json');
  assert.equal(chosen.code, 0, chosen.err || chosen.out);
  assert.equal(JSON.parse(chosen.out).setup.steps.find(step => step.number === 3).done, true,
    'the person choosing an actual project command completes the gate step');
  assert.equal(existsSync(marker), false, 'choosing a gate does not run it');
  const released = box.run(worktree, 'release', id, '--json');
  assert.equal(released.code, 0, released.err || released.out);
  const configuredWorktree = join(box.dir, 'configured-app-agent');
  box.git(root, 'worktree', 'add', '-q', '-b', 'app/chosen', configuredWorktree, 'main');
  const configuredJoin = box.run(configuredWorktree, 'join', 'app');
  assert.equal(configuredJoin.code, 0, configuredJoin.err || configuredJoin.out);
  const configuredClaim = box.run(configuredWorktree, 'claim', id, '--json');
  assert.equal(configuredClaim.code, 0, configuredClaim.err || configuredClaim.out);
  writeFileSync(join(configuredWorktree, 'app', 'result.txt'), 'done\n');
  box.git(configuredWorktree, 'add', 'app/result.txt');
  box.git(configuredWorktree, 'commit', '-q', '-m', 'chore: finish with the chosen project test');
  const completed = box.run(configuredWorktree, 'submit', id, '--json');
  assert.equal(completed.code, 0, completed.err || completed.out);
  assert.equal(readFileSync(marker, 'utf8'), 'tested\n', 'submit runs the chosen project test');
});
