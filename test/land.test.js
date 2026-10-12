/** Exercise landing against real private Git worktrees, hooks, SQLite and bare remotes [B3,R3]. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { after, test } from 'node:test';
import * as store from '../src/board.js';
import { applyRelayMove, prepareEngineMove } from '../src/engine.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { landingFailures, landingSubject } from '../src/land.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { startFixtureChild, runFixtureChild } from './fixture-child.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile, waitFor, BIN } = e2e;
const FILES = [1, 2, 3, 4].map((n) => `web/land-${n}.test.js`);

/** Read a private board through public functions, never by mutating its database. */
function onBoard(box, action, clock) {
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), clock);
  try { return action(board); } finally { store.closeBoard(board); }
}

/** Return append-only public events for receipt and replay assertions. */
function events(box) { return onBoard(box, (board) => store.events(board)); }

/** Parse the gate's actual command arguments to distinguish full runs from single-file diagnoses. */
function calls(box) {
  return existsSync(box.calls) ? readFileSync(box.calls, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

/** Start a separate process holding an exclusive write transaction on the fixture board. */
function startExclusiveBoardWriter(box, boardFile, name) {
  const ready = join(box.dir, `${name}-ready`);
  const release = join(box.dir, `${name}-release`);
  const released = join(box.dir, `${name}-released`);
  const source = [
    "const fs = require('node:fs'); const { DatabaseSync } = require('node:sqlite');",
    'const [file, ready, release, released] = process.argv.slice(1);',
    'const db = new DatabaseSync(file);',
    "try { const journal = db.prepare('PRAGMA journal_mode = DELETE').get().journal_mode;",
    "const locking = db.prepare('PRAGMA locking_mode = EXCLUSIVE').get().locking_mode;",
    "if (journal !== 'delete' || locking !== 'exclusive') throw new Error('fixture did not acquire rollback-journal exclusive mode');",
    "db.exec('BEGIN EXCLUSIVE'); db.exec('CREATE TABLE IF NOT EXISTS fixture_write (value INTEGER)'); db.exec('INSERT INTO fixture_write (value) VALUES (1)');",
    'fs.writeFileSync(ready, JSON.stringify({ journal, locking })); const deadline = Date.now() + 20_000;',
    'while (!fs.existsSync(release) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);',
    "if (!fs.existsSync(release)) throw new Error('writer release was not received');",
    "db.exec('COMMIT'); db.close(); fs.writeFileSync(released, 'released');",
    "} catch (error) { try { db.close(); } catch {} process.stderr.write(error.stack + '\\n'); process.exitCode = 1; }",
  ].join('\n');
  const child = startFixtureChild(process.execPath, ['-e', source, boardFile, ready, release, released], {
    cwd: box.repo, env: box.env, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  return { child, closed: childOutcome(child), ready, release, released };
}

/** Resolve when an owned fixture child closes or fails to spawn. */
function childOutcome(child) {
  return new Promise((resolveOutcome) => {
    let spawnError = null;
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => resolveOutcome({ code, signal, error: spawnError }));
  });
}

/** Run the real pre-commit hook with a preload observing its agentAt SQLite read. */
function startHookRead(box, probe, marker) {
  const env = { ...box.env, HOOK_READ_ATTEMPT: marker };
  const child = startFixtureChild(process.execPath, ['--import', probe, BIN, 'hook', 'pre-commit'], {
    cwd: box.web, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.setEncoding('utf8').on('data', (part) => { child.stdoutText += part; });
  child.stderr.setEncoding('utf8').on('data', (part) => { child.stderrText += part; });
  child.closed = childOutcome(child);
  return child;
}

/** Emit real failing TAP and a separate single-file runner, recording every invocation. */
function gateFixture(box) {
  const gate = join(box.dir, 'land-gate.cjs');
  const checks = join(box.dir, 'land-check.cjs');
  const callPath = join(box.dir, 'land-gate-calls.jsonl');
  const hold = join(box.dir, 'hold');
  const entered = join(box.dir, 'entered');
  const release = join(box.dir, 'release');
  const trace = join(box.dir, 'gate-trace.jsonl');
  writeFileSync(gate, [
    "const fs = require('node:fs'); const path = require('node:path');",
    `const calls = ${JSON.stringify(callPath)}; const hold = ${JSON.stringify(hold)}; const entered = ${JSON.stringify(entered)}; const release = ${JSON.stringify(release)}; const trace = ${JSON.stringify(trace)};`,
    "const root = process.cwd(); const args = process.argv.slice(2); fs.appendFileSync(calls, JSON.stringify(args) + '\\n');",
    "const alone = args.includes('--alone'); const web = path.join(root, 'web'); const files = alone ? args.filter(a => a !== '--alone') : (fs.existsSync(web) ? fs.readdirSync(web).filter(n => /^land-\\d+\\.test\\.js$/.test(n)).map(n => 'web/' + n) : []);",
    "fs.appendFileSync(trace, JSON.stringify({ alone, files }) + '\\n'); const fullRuns = fs.readFileSync(trace, 'utf8').trim().split('\\n').map(line => JSON.parse(line)).filter(row => !row.alone).length;",
    "if (!alone && fs.existsSync(hold) && (fs.readFileSync(hold, 'utf8') === 'armed' || Number(fs.readFileSync(hold, 'utf8')) === fullRuns)) { fs.writeFileSync(entered, root); const end = Date.now() + 20000; while (!fs.existsSync(release) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); if (!fs.existsSync(release)) process.exit(24); }",
    "console.log('TAP version 13'); let failed = 0;",
    "files.forEach((file, i) => { const text = fs.readFileSync(path.resolve(root, file), 'utf8'); const red = process.env.LAND_SUPPRESS_RED !== '1' && (text.includes('RED') || !alone && text.includes('FLAKE')); console.log('# Subtest: ' + file + ' keeps the landed behavior'); console.log((red ? 'not ok ' : 'ok ') + (i + 1) + ' - ' + file + ' keeps the landed behavior'); if (red) { failed++; console.log('  ---'); console.log('  location: ' + path.resolve(root, file) + ':1:1'); console.log('  failureType: testCodeFailure'); console.log('  error: fixture behavior is red'); console.log('  ...'); } });",
    "console.log('1..' + files.length); console.log('# tests ' + files.length); console.log('# pass ' + (files.length - failed)); console.log('# fail ' + failed); process.exitCode = failed ? 1 : 0;",
  ].join('\n'));
  writeFileSync(checks, "const fs = require('node:fs'); const file = process.argv[2]; if (!fs.existsSync(file) || !fs.readFileSync(file, 'utf8').trim()) process.exit(1);\n");
  return { gate: `node ${JSON.stringify(gate)}`, affected: `node ${JSON.stringify(gate)} --alone`, checks, calls: callPath, hold, entered, release, trace };
}

/** Create a private initialized project with a real bare origin and active hooks. */
function landProject() {
  const box = sandbox();
  const commands = gateFixture(box);
  const fixture = project(commands.gate, box);
  const path = join(fixture.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.affectedTests = commands.affected;
  writeFileSync(path, JSON.stringify(config, null, 2));
  fixture.git(fixture.repo, 'add', 'pullboard.json');
  fixture.git(fixture.repo, 'commit', '-q', '-m', 'chore: configure landing');
  fixture.git(fixture.web, 'merge', '-q', '--ff-only', 'main');
  const remote = join(box.dir, 'origin.git');
  fixture.git(box.dir, 'init', '-q', '--bare', remote);
  fixture.git(fixture.repo, 'remote', 'add', 'origin', remote);
  const pushed = fixture.tryGit(fixture.repo, 'push', '-q', '-u', 'origin', 'main');
  assert.equal(pushed.status, 0, pushed.stderr);
  return { ...fixture, ...commands, remote };
}

test('a hook read waits for another process\'s lock [C7,B3]', { timeout: 40_000 }, // budget: hang-only ceiling covers the real writer, hook and fixture cleanup; no speed claim.
async (t) => {
  const box = landProject();
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const probe = join(box.dir, 'observe-hook-read.mjs');
  const marker = join(box.dir, 'hook-read-attempted');
  writeFileSync(probe, [
    "import { writeFileSync } from 'node:fs';",
    "import { DatabaseSync } from 'node:sqlite';",
    'const prepare = DatabaseSync.prototype.prepare;',
    'DatabaseSync.prototype.prepare = function (sql, ...args) {',
    "  if (String(sql) !== 'SELECT * FROM agent WHERE agent_path = ?') return Reflect.apply(prepare, this, [sql, ...args]);",
    "  writeFileSync(process.env.HOOK_READ_ATTEMPT, JSON.stringify({ phase: 'prepare-started' }));",
    '  try {',
    '    const statement = Reflect.apply(prepare, this, [sql, ...args]);',
    '    const get = statement.get;',
    '    statement.get = function (...values) {',
    "      writeFileSync(process.env.HOOK_READ_ATTEMPT, JSON.stringify({ phase: 'get-started' }));",
    '      try { return Reflect.apply(get, this, values); }',
    "      catch (error) { writeFileSync(process.env.HOOK_READ_ATTEMPT, JSON.stringify({ phase: 'error', code: error.code ?? null, errcode: error.errcode ?? null, message: error.message })); throw error; }",
    '    };',
    '    return statement;',
    "  } catch (error) { writeFileSync(process.env.HOOK_READ_ATTEMPT, JSON.stringify({ phase: 'error', code: error.code ?? null, errcode: error.errcode ?? null, message: error.message })); throw error; }",
    '};',
  ].join('\n'));
  const writers = [];
  const hooks = [];
  t.after(async () => {
    const settle = async (promise, timeoutMs) => {
      let timer;
      try { return await Promise.race([promise, new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(false), timeoutMs); })]); }
      finally { clearTimeout(timer); }
    };
    for (const writer of writers) {
      writeFileSync(writer.release, 'release');
      if (!await settle(writer.closed, 1_000) && writer.child.exitCode === null && writer.child.signalCode === null) {
        try { process.kill(-writer.child.pid, 'SIGTERM'); } catch {}
        if (!await settle(writer.closed, 1_000) && writer.child.exitCode === null && writer.child.signalCode === null) {
          try { process.kill(-writer.child.pid, 'SIGKILL'); } catch {}
          await writer.closed;
        }
      }
    }
    for (const hook of hooks) {
      if (!await settle(hook.closed, 1_000) && hook.exitCode === null && hook.signalCode === null) {
        hook.kill('SIGTERM');
        if (!await settle(hook.closed, 1_000) && hook.exitCode === null && hook.signalCode === null) {
          hook.kill('SIGKILL');
          await hook.closed;
        }
      }
    }
  });

  const writer = startExclusiveBoardWriter(box, boardFile, 'hook-read');
  writers.push(writer);
  await waitFor(() => existsSync(writer.ready), 'exclusive rollback-journal writer');
  assert.deepEqual(JSON.parse(readFileSync(writer.ready, 'utf8')), { journal: 'delete', locking: 'exclusive' });
  const hook = startHookRead(box, probe, marker);
  hooks.push(hook);
  await waitFor(() => existsSync(marker), 'hook agentAt query attempt');
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  const observation = JSON.parse(readFileSync(marker, 'utf8'));
  const sqliteBusy = observation.code === 'SQLITE_BUSY' || ((observation.errcode ?? 0) & 0xff) === 5;
  assert.equal(sqliteBusy, false, `hookRead must wait for the released lock, not return SQLITE_BUSY: ${JSON.stringify(observation)} ${hook.stderrText}`);
  assert.ok(['prepare-started', 'get-started'].includes(observation.phase), `hook reached its native SQLite read: ${JSON.stringify(observation)}`);
  assert.equal(hook.exitCode, null, `hook read remains pending during the real exclusive writer: ${hook.stderrText}`);
  writeFileSync(writer.release, 'release');
  const [writerResult, hookResult] = await Promise.all([writer.closed, hook.closed]);
  assert.equal(writerResult.error, null, `exclusive writer spawned: ${writerResult.error?.message ?? ''}`);
  assert.deepEqual({ code: writerResult.code, signal: writerResult.signal }, { code: 0, signal: null }, writer.child.fixtureFailure ?? 'exclusive writer commits and closes');
  assert.equal(hookResult.error, null, `hook child spawned: ${hookResult.error?.message ?? ''}`);
  assert.deepEqual({ code: hookResult.code, signal: hookResult.signal }, { code: 0, signal: null }, hook.stderrText);
  assert.ok(existsSync(writer.released), 'writer releases its lock after commit and close');
});

test('a staged approved-row hook read waits for another process\'s lock [C7,B3,S19]', { timeout: 40_000 }, // budget: hang-only ceiling covers native Git, the exclusive writer and fixture cleanup; no speed claim.
async (t) => {
  const box = landProject();
  const specPath = join(box.repo, 'SPEC.md');
  writeFileSync(specPath, readFileSync(specPath, 'utf8').replace('The page renders.', 'The changed page renders.'));
  box.git(box.repo, 'add', 'SPEC.md');
  const before = box.git(box.repo, 'rev-parse', 'HEAD');
  const staged = box.git(box.repo, 'write-tree');
  const control = box.tryGit(box.repo, 'commit', '-m', 'feat: change approved promise [G1]');
  assert.equal(control.status, 1, control.stderr);
  assert.match(control.stderr, /G1 changes approved text without the person's exact approval/);

  const marker = join(box.dir, 'approved-read-attempted');
  const probe = join(box.dir, 'observe-approved-read.mjs');
  const ready = join(box.dir, 'approved-read-ready');
  writeFileSync(probe, [
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import { DatabaseSync } from 'node:sqlite';",
    'const prepare = DatabaseSync.prototype.prepare;',
    'DatabaseSync.prototype.prepare = function (sql, ...args) {',
    "  if (String(sql) !== 'SELECT meta_value FROM board_meta WHERE meta_key=?') return Reflect.apply(prepare, this, [sql, ...args]);",
    "  writeFileSync(process.env.APPROVED_READ_MARKER, JSON.stringify({ phase: 'before-lock' }));",
    '  const deadline = Date.now() + 8000;',
    '  while (!existsSync(process.env.APPROVED_READ_READY) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);',
    "  if (!existsSync(process.env.APPROVED_READ_READY)) throw new Error('exclusive writer did not become ready');",
    "  writeFileSync(process.env.APPROVED_READ_MARKER, JSON.stringify({ phase: 'read-started' }));",
    '  try { return Reflect.apply(prepare, this, [sql, ...args]); }',
    "  catch (error) { writeFileSync(process.env.APPROVED_READ_MARKER, JSON.stringify({ phase: 'error', code: error.code ?? null, errcode: error.errcode ?? null, message: error.message })); throw error; }",
    '};',
  ].join('\n'));
  let writer;
  let hook;
  t.after(async () => {
    if (writer) {
      writeFileSync(writer.release, 'release');
      await writer.closed;
    }
    if (hook && hook.exitCode === null && hook.signalCode === null) {
      hook.kill('SIGKILL');
      await hook.closed;
    }
  });
  hook = startFixtureChild('git', ['commit', '-m', 'feat: change approved promise [G1]'], {
    cwd: box.repo, env: { ...box.env, NODE_OPTIONS: `--import=${probe}`, APPROVED_READ_MARKER: marker, APPROVED_READ_READY: ready },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hook.stderrText = '';
  hook.stdout.resume();
  hook.stderr.setEncoding('utf8').on('data', (part) => { hook.stderrText += part; });
  hook.closed = childOutcome(hook);
  await waitFor(() => existsSync(marker), 'native staged-approval hook query');
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).phase, 'before-lock');
  writer = startExclusiveBoardWriter(box, join(box.repo, '.git', 'pullboard', 'board.sqlite'), 'approved-read');
  await waitFor(() => existsSync(writer.ready), 'approved-row exclusive writer');
  await waitFor(() => JSON.parse(readFileSync(marker, 'utf8')).phase !== 'before-lock', 'approved-row read under the exclusive lock');
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  const observation = JSON.parse(readFileSync(marker, 'utf8'));
  const sqliteBusy = observation.code === 'SQLITE_BUSY' || ((observation.errcode ?? 0) & 0xff) === 5;
  assert.equal(sqliteBusy, false, `staged approval read must wait, not return SQLITE_BUSY: ${JSON.stringify(observation)} ${hook.stderrText}`);
  assert.equal(observation.phase, 'read-started');
  assert.equal(hook.exitCode, null, `native hook remains pending during the writer: ${hook.stderrText}`);
  writeFileSync(writer.release, 'release');
  const [writerResult, hookResult] = await Promise.all([writer.closed, hook.closed]);
  assert.deepEqual({ code: writerResult.code, signal: writerResult.signal }, { code: 0, signal: null }, writer.child.fixtureFailure);
  assert.deepEqual({ code: hookResult.code, signal: hookResult.signal }, { code: 1, signal: null }, hook.stderrText);
  assert.match(hook.stderrText, /G1 changes approved text without the person's exact approval/);
  assert.doesNotMatch(hook.stderrText, /database is locked|restore valid staged SSH trust files/);
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), before, 'normal approval refusal leaves the commit unchanged');
  assert.equal(box.git(box.repo, 'write-tree'), staged, 'the staged approved-row change remains available for person approval');
});

/** Give one private item a distinct canonical lane identity and an independent main base. */
function itemWorktree(box, number, file = FILES[number - 1], afterIds = []) {
  const path = join(box.dir, `land-${number}`);
  box.git(box.repo, 'worktree', 'add', '-q', '-b', `web/land-${number}`, path, 'main');
  assert.equal(box.run(path, 'join', 'web').code, 0);
  const added = box.run(box.repo, 'add', 'web', `Land fixture ${number}`, '--specs', 'G1', '--criterion', `land fixture ${number} remains valid`,
    '--check', `node ${JSON.stringify(box.checks)} ${JSON.stringify(file)}`, ...(afterIds.length ? ['--after', afterIds.join(',')] : []), '--json');
  assert.equal(added.code, 0, added.err);
  const item = JSON.parse(added.out).item.item_id;
  assert.equal(box.run(path, 'claim', String(item)).code, 0);
  return { path, item, file };
}

/** Build and submit a private fixture through its real hooks and item check. */
function submitItem(box, entry, contents = 'PASS\n') {
  const committed = commitFile(box, entry.path, entry.file, contents, `feat(web): build land fixture ${entry.item} [G1]`);
  assert.equal(committed.status, 0, committed.stderr);
  entry.commit = box.git(entry.path, 'rev-parse', 'HEAD');
  const submitted = box.run(entry.path, 'submit', String(entry.item));
  assert.equal(submitted.code, 0, submitted.err);
  return entry;
}

/** Verify only private fixture items at their actual submitted commits. */
function acceptItem(box, entry) {
  box.git(box.repo, 'switch', '-q', '--detach', entry.commit);
  try {
    const verdict = box.run(box.repo, 'verify', String(entry.item), 'accept', '--as', 'coordinator', '--note', 'private landing fixture check passed');
    assert.equal(verdict.code, 0, verdict.err);
  } finally { box.git(box.repo, 'switch', '-q', 'main'); }
}

/** Prepare four independent submitted items and accept them in a caller-selected verdict order. */
function verifiedFour(box, { red, flaky, order = [0, 1, 2, 3] } = {}) {
  box.env.LAND_SUPPRESS_RED = '1';
  const entries = FILES.map((file, index) => itemWorktree(box, index + 1, file));
  for (const [index, entry] of entries.entries()) submitItem(box, entry, index === red ? 'RED\n' : (Array.isArray(flaky) ? flaky.includes(index) : index === flaky) ? 'FLAKE\n' : 'PASS\n');
  for (const index of order) acceptItem(box, entries[index]);
  delete box.env.LAND_SUPPRESS_RED;
  return entries;
}

/**
 * Start a separate process holding a rollback-journal exclusive write on a private board.
 * @param {any} box
 * @param {string} boardFile
 * @param {string} name
 * @returns {{ child: any, closed: Promise<{code: number|null, signal: string|null, error: Error|null}>, ready: string, release: string, released: string }}
 */
function startExclusiveWriter(box, boardFile, name) {
  const ready = join(box.dir, `${name}-ready`);
  const release = join(box.dir, `${name}-release`);
  const released = join(box.dir, `${name}-released`);
  const source = [
    "const fs = require('node:fs'); const { DatabaseSync } = require('node:sqlite');",
    'const [file, ready, release, released] = process.argv.slice(1);',
    'const db = new DatabaseSync(file);',
    "try { const journal = db.prepare('PRAGMA journal_mode = DELETE').get().journal_mode;",
    "const locking = db.prepare('PRAGMA locking_mode = EXCLUSIVE').get().locking_mode;",
    "if (journal !== 'delete' || locking !== 'exclusive') throw new Error('fixture did not acquire rollback-journal exclusive mode');",
    "db.exec('BEGIN EXCLUSIVE'); db.exec('CREATE TABLE IF NOT EXISTS fixture_write (value INTEGER)'); db.exec('INSERT INTO fixture_write (value) VALUES (1)');",
    'fs.writeFileSync(ready, JSON.stringify({ journal, locking })); const deadline = Date.now() + 20_000;',
    'while (!fs.existsSync(release) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);',
    "if (!fs.existsSync(release)) throw new Error('writer release was not received');",
    "db.exec('COMMIT'); db.close(); fs.writeFileSync(released, 'released');",
    '} catch (error) { try { db.close(); } catch {} process.stderr.write(error.stack + \'\\n\'); process.exitCode = 1; }',
  ].join('\n');
  const child = startFixtureChild(process.execPath, ['-e', source, boardFile, ready, release, released], {
    cwd: box.repo, env: box.env, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  const closed = lockChildOutcome(child);
  return { child, closed, ready, release, released };
}

/** Resolve when an owned child closes or fails to spawn, whichever happens first. */
function lockChildOutcome(child) {
  return new Promise((resolveOutcome) => {
    let spawnError = null;
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => resolveOutcome({ code, signal, error: spawnError }));
  });
}

/**
 * Launch the real hook command with the read-attempt preload and collect its terminal output.
 * @param {any} box
 * @param {string} probe
 * @param {string} marker
 * @returns {any}
 */
function launchHookProbe(box, probe, marker) {
  const env = { ...box.env, HOOK_READ_ATTEMPT: marker };
  const child = startFixtureChild(process.execPath, ['--import', probe, BIN, 'hook', 'pre-commit'], {
    cwd: box.web, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.setEncoding('utf8').on('data', (part) => { child.stdoutText += part; });
  child.stderr.setEncoding('utf8').on('data', (part) => { child.stderrText += part; });
  child.closed = lockChildOutcome(child);
  return child;
}

/** Run a successful JSON command, retaining child context if any actual hook or check refuses. */
function json(box, cwd, ...args) {
  const result = box.run(cwd, ...args, '--json');
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/** Read the actual first-parent merge sequence at the published tip. */
function mergeSubjects(box, base, tip) {
  return box.git(box.repo, 'log', '--reverse', '--first-parent', '--format=%s', `${base}..${tip}`).split('\n').filter(Boolean);
}

test('land pushes one exact batch in verdict order and records each first-containing merge once [B3,R3]', () => {
  const box = landProject();
  const entries = verifiedFour(box, { order: [3, 1, 0, 2] });
  const base = box.git(box.repo, 'rev-parse', 'main');
  const start = calls(box).length;
  const result = json(box, box.repo, 'land', '--max', '4');
  const order = [3, 1, 0, 2].map((index) => entries[index].item);
  assert.deepEqual(result.landed, order);
  assert.deepEqual(mergeSubjects(box, base, result.batch.tip), [4, 2, 1, 3].map((n) => `chore(merge): land fixture ${n} [G1]`));
  assert.equal(result.batch.state, 'landed');
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), result.batch.tip);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), result.batch.tip, 'real pre-push accepted the gated tip');
  assert.ok(relative(join(box.repo, '.git', 'pullboard'), result.batch.root).startsWith('landings/'));
  assert.notEqual(result.batch.root, box.repo);
  assert.deepEqual(calls(box).slice(start), [[]], 'one full batch gate; pre-push reads its exact green tree stamp');
  const merges = box.git(box.repo, 'rev-list', '--reverse', '--first-parent', `${base}..${result.batch.tip}`).split('\n');
  for (const [index, id] of order.entries()) assert.equal(json(box, box.repo, 'show', String(id)).item_merged_commit, merges[index]);
  const receipt = events(box).filter((event) => event.event_kind === 'main-moved');
  assert.equal(receipt.length, 1);
  assert.equal(JSON.parse(receipt[0].event_detail).sha, result.batch.tip);
  assert.equal(json(box, box.repo, 'resume').landingBatches.at(-1).id, result.batch.id);
  const eventCount = events(box).length;
  assert.deepEqual(json(box, box.repo, 'land').landed, []);
  assert.equal(events(box).length, eventCount, 'second invocation writes no duplicate receipts');
  assert.deepEqual(calls(box).slice(start), [[]], 'second invocation runs no tests');
  const lane = box.run(entries[0].path, 'land', '--json');
  assert.equal(JSON.parse(lane.out).error?.code, 'COORDINATOR_ONLY');
});

test('land bisects a real red, skips named conflicts and refuses an unverified stack [B3,R3]', () => {
  const box = landProject();
  box.env.LAND_SUPPRESS_RED = '1';
  const entries = FILES.map((file, index) => itemWorktree(box, index + 1, file));
  for (const entry of entries.slice(0, 3)) submitItem(box, entry, entry === entries[2] ? 'RED\n' : 'PASS\n');
  const hidden = itemWorktree(box, 5, 'web/unverified.js');
  assert.equal(commitFile(box, hidden.path, hidden.file, 'unverified\n', 'feat(web): unverified ancestor [G1]').status, 0);
  const hiddenSha = box.git(hidden.path, 'rev-parse', 'HEAD');
  box.git(entries[3].path, 'merge', '--no-ff', hiddenSha, '-m', 'feat(web): include ancestor [G1]');
  submitItem(box, entries[3]);
  for (const entry of entries) acceptItem(box, entry);
  assert.equal(box.run(hidden.path, 'submit', String(hidden.item)).code, 0);
  delete box.env.LAND_SUPPRESS_RED;
  assert.equal(commitFile(box, box.repo, FILES[1], 'different main content\n', 'chore: create a merge conflict').status, 0);
  const base = box.git(box.repo, 'rev-parse', 'main');
  const beforeEvents = events(box).length;
  const beforeCalls = calls(box).length;
  const dry = json(box, box.repo, 'land', '--max', '4', '--dry-run');
  assert.deepEqual(dry.conflicts, [{ id: entries[1].item, files: [FILES[1]] }], JSON.stringify(dry));
  assert.deepEqual(dry.blocked, [{ id: entries[3].item, code: 'STACKED_UNVERIFIED', stacked: hidden.item }]);
  assert.equal(events(box).length, beforeEvents, 'dry run creates no board batch');
  assert.equal(calls(box).length, beforeCalls, 'dry run runs no gate');
  const result = json(box, box.repo, 'land', '--max', '4');
  assert.deepEqual(result.landed, [entries[0].item]);
  assert.deepEqual(result.conflicts, dry.conflicts);
  assert.deepEqual(result.blocked, dry.blocked);
  assert.deepEqual(result.culprits.map((entry) => entry.id), [entries[2].item]);
  assert.equal(result.culprits[0].tests[0].file, FILES[2]);
  assert.match(result.culprits[0].tests[0].name, /keeps the landed behavior/u);
  assert.ok(json(box, box.repo, 'show', String(entries[2].item)).thread.some((entry) => entry.type === 'fact' && entry.text.includes(FILES[2])));
  assert.deepEqual(calls(box).slice(beforeCalls), [[], ['--alone', FILES[2]], [], []], 'one red batch, one isolated diagnostic and two bisection gates; cached green tree is not retested');
  assert.equal(json(box, box.repo, 'show', String(entries[0].item)).item_merged_commit, result.batch.tip);
  for (const entry of entries.slice(1)) assert.equal(json(box, box.repo, 'show', String(entry.item)).item_merged_commit, null);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), result.batch.tip);
  assert.notEqual(result.batch.tip, base);
  const afterCalls = calls(box).length;
  const again = json(box, box.repo, 'land');
  assert.deepEqual(again.landed, []);
  assert.ok(again.blocked.some((entry) => entry.code === 'LAND_KNOWN_RED' && entry.id === entries[2].item));
  assert.equal(calls(box).length, afterCalls, 'known unchanged red is not retried');
});

test('land holds a flake without retries and person waivers cover every failure at the exact tree [B3,R3]', () => {
  const box = landProject();
  const entries = verifiedFour(box, { flaky: [0, 1] });
  const base = box.git(box.repo, 'rev-parse', 'HEAD');
  const start = calls(box).length;
  const held = json(box, box.repo, 'land');
  assert.deepEqual(held.landed, []);
  assert.equal(held.batch.state, 'flaky');
  assert.deepEqual(held.flakes.map((flake) => flake.test), FILES.slice(0, 2));
  assert.deepEqual(calls(box).slice(start), [[], ['--alone', FILES[0]], ['--alone', FILES[1]]]);
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), base);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), base);
  const refused = box.run(box.repo, 'land', '--json');
  assert.equal(JSON.parse(refused.out).error?.code, 'LAND_FLAKE');
  assert.deepEqual(calls(box).slice(start), [[], ['--alone', FILES[0]], ['--alone', FILES[1]]], 'nothing retries');
  assert.equal(events(box).filter((event) => event.event_kind === 'landing_flake').length, 2);
  const flakeItem = json(box, box.repo, 'show', String(held.flakes.find((flake) => flake.test === FILES[1]).item));
  assert.match(flakeItem.item_title, /Flaky test: web\/land-2/u);
  box.env.CODEX_THREAD_ID = 'private-agent-waiver-attempt';
  const agentAttempt = box.run(box.repo, 'land', '--waive', FILES[1], '--until', '2099-01-01', '--reason', 'private fixture exception', '--json');
  assert.equal(JSON.parse(agentAttempt.out).error?.code, 'B26_PERSON_CHANNEL');
  delete box.env.CODEX_THREAD_ID;
  const waiver = json(box, box.repo, 'land', '--waive', FILES[1], '--until', '2099-01-01', '--reason', 'private fixture exception').waiver;
  assert.equal(waiver.by, 'person');
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), base, 'recording a waiver does not land');
  const partial = box.run(box.repo, 'land', '--json');
  assert.equal(JSON.parse(partial.out).error?.code, 'LAND_FLAKE', 'one waiver cannot cover the other failing test');
  assert.deepEqual(calls(box).slice(start), [[], ['--alone', FILES[0]], ['--alone', FILES[1]]], 'partial waiver permits no retry');
  const waiverZero = json(box, box.repo, 'land', '--waive', FILES[0], '--until', '2099-01-01', '--reason', 'second private fixture exception').waiver;
  const landed = json(box, box.repo, 'land');
  assert.deepEqual(landed.landed, entries.map((entry) => entry.item));
  assert.deepEqual(calls(box).slice(start), [[], ['--alone', FILES[0]], ['--alone', FILES[1]]], 'waiver uses the recorded full gate at the same exact tree without retrying');
  assert.deepEqual(landed.batch.proof.failures.map((failure) => failure.waiver), [waiverZero.id, waiver.id]);
  assert.equal(landed.batch.proof.tree, box.git(landed.batch.root, 'rev-parse', 'HEAD^{tree}'));
  assert.ok(onBoard(box, (board) => store.waivedLandingProof(board, landed.batch.proof.tree)));
  assert.equal(onBoard(box, (board) => store.waivedLandingProof(board, 'f'.repeat(40))), null, 'proof cannot cover another tree');
  const stamp = box.git(landed.batch.root, 'rev-parse', '--git-path', 'pullboard-gate-green');
  assert.ok(!existsSync(stamp) || readFileSync(stamp, 'utf8').trim() !== landed.batch.proof.tree, 'red gate never writes an ordinary green stamp');
  const expired = { now: () => new Date('2099-01-02T00:00:00Z') };
  assert.equal(onBoard(box, (board) => store.waivedLandingProof(board, landed.batch.proof.tree), expired), null, 'every waiver must remain live');
  const event = events(box).find((entry) => entry.event_kind === 'landing_waiver');
  assert.equal(event.event_by, 'person');
  assert.equal(commitFile(box, box.repo, 'docs/after-land.md', 'new exact tree\n', 'chore: advance the private tree').status, 0);
  const laterTree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}');
  const beforeHook = calls(box).length;
  onBoard(box, (board) => {
    store.recordLandingWaiver(board, { agentId: 'person', channel: 'terminal', id: 'expired-hook-proof', test: FILES[1], until: '2000-01-02', reason: 'expired proof fixture' });
    store.recordLandingBatch(board, { agentId: 'coordinator', batch: { ...landed.batch, id: 'expired-hook-batch', state: 'ready',
      base: landed.batch.tip, tip: box.git(box.repo, 'rev-parse', 'HEAD'), revision: 0,
      proof: { tree: laterTree, failures: [{ file: FILES[0], name: FILES[0], waiver: waiverZero.id }, { file: FILES[1], name: FILES[1], waiver: 'expired-hook-proof' }] } } });
  }, { now: () => new Date('2000-01-01T00:00:00Z') });
  const hook = runFixtureChild(process.execPath, [BIN, 'hook', 'pre-push'], { cwd: box.repo, env: box.env, encoding: 'utf8',
    input: `refs/heads/main ${box.git(box.repo, 'rev-parse', 'HEAD')} refs/heads/main ${landed.batch.tip}\n` });
  assert.equal(hook.status, 1, hook.stdout);
  assert.match(hook.stderr, /expired or missing person waiver/u);
  assert.equal(calls(box).length, beforeHook, 'expired proof is refused without rerunning the red gate');
});

test('land stops again with an expired waiver, and a changed test on main releases the held batch [B3,R3]', () => {
  const box = landProject();
  box.env.LAND_SUPPRESS_RED = '1';
  assert.equal(commitFile(box, box.repo, FILES[0], 'FLAKE\n', 'chore: install a flaky fixture test').status, 0);
  const entry = itemWorktree(box, 1, 'web/feature.js');
  submitItem(box, entry);
  acceptItem(box, entry);
  delete box.env.LAND_SUPPRESS_RED;
  const held = json(box, box.repo, 'land');
  assert.equal(held.batch.state, 'flaky');
  const past = { now: () => new Date('2000-01-01T00:00:00Z') };
  onBoard(box, (board) => store.recordLandingWaiver(board, { agentId: 'person', channel: 'terminal', id: 'expired-example', test: FILES[0], until: '2000-01-02', reason: 'expired fixture approval' }), past);
  const start = calls(box).length;
  const refused = box.run(box.repo, 'land', '--json');
  assert.equal(JSON.parse(refused.out).error?.code, 'LAND_FLAKE');
  assert.equal(calls(box).length, start, 'expired waiver authorizes no retry');
  assert.equal(commitFile(box, box.repo, FILES[0], 'PASS\n', 'chore: correct the flaky test').status, 0);
  const landed = json(box, box.repo, 'land');
  assert.deepEqual(landed.landed, [entry.item]);
  assert.notEqual(landed.batch.id, held.batch.id);
  assert.equal(landed.batch.proof.failures.length, 0);
  assert.deepEqual(calls(box).slice(start), [[]], 'corrected test is gated afresh');
});

test('land adoption recovers an interrupted gate and keeps one receipt under a new coordinator [B3,R3]', async (t) => {
  const box = landProject();
  const entries = verifiedFour(box);
  writeFileSync(box.hold, 'armed');
  const child = startFixtureChild(process.execPath, [BIN, 'land', '--json'], { cwd: box.repo, env: box.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  const closed = new Promise((resolveClose) => child.once('close', (status, signal) => resolveClose({ status, signal })));
  t.after(() => {
    writeFileSync(box.release, 'release');
    if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  });
  await waitFor(() => existsSync(box.entered), 'landing gate entered');
  const card = json(box, box.repo, 'resume');
  const batch = card.landingBatches.at(-1);
  assert.equal(batch.state, 'gating');
  assert.match(batch.logPath, /batch-\d+\.log$/u);
  assert.equal(batch.items.length, 4);
  process.kill(-child.pid, 'SIGKILL');
  assert.equal((await closed).signal, 'SIGKILL');
  writeFileSync(box.release, 'release');
  const refused = box.run(box.repo, 'land', '--json');
  assert.equal(JSON.parse(refused.out).error?.code, 'LAND_ADOPT');
  box.env.CODEX_THREAD_ID = 'private-adopting-coordinator';
  const adopted = json(box, box.repo, 'land', '--adopt');
  delete box.env.CODEX_THREAD_ID;
  assert.equal(adopted.batch.id, batch.id);
  assert.notEqual(adopted.batch.owner, batch.owner);
  assert.deepEqual(adopted.landed, entries.map((entry) => entry.item));
  assert.equal(events(box).filter((event) => event.event_kind === 'main-moved').length, 1);
  assert.equal(json(box, box.repo, 'resume').landingBatches.at(-1).state, 'landed');
});

test('a hook read waits while land holds the board [C7,B3]', { timeout: 40_000 }, // budget: 40s hang ceiling covers two real lock phases, each with the unchanged 10s SQLite timeout.
async (t) => {
  const box = landProject();
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const probe = join(box.dir, 'observe-hook-read.mjs');
  const observedSql = join(box.dir, 'hook-read-attempted');
  writeFileSync(probe, [
    "import { writeFileSync } from 'node:fs';",
    "import { DatabaseSync } from 'node:sqlite';",
    'const prepare = DatabaseSync.prototype.prepare;',
    'DatabaseSync.prototype.prepare = function (sql, ...args) {',
    "  if (String(sql) !== 'SELECT * FROM agent WHERE agent_path = ?') return Reflect.apply(prepare, this, [sql, ...args]);",
    "  writeFileSync(process.env.HOOK_READ_ATTEMPT, JSON.stringify({ phase: 'prepare-started' }));",
    '  try {',
    '    const statement = Reflect.apply(prepare, this, [sql, ...args]);',
    '    const get = statement.get;',
    '    statement.get = function (...values) {',
    "      writeFileSync(process.env.HOOK_READ_ATTEMPT, JSON.stringify({ phase: 'get-started' }));",
    '      try { return Reflect.apply(get, this, values); }',
    '      catch (error) { writeFileSync(process.env.HOOK_READ_ATTEMPT, JSON.stringify({ phase: \'error\', code: error.code ?? null, errcode: error.errcode ?? null, message: error.message })); throw error; }',
    '    };',
    '    return statement;',
    '  } catch (error) { writeFileSync(process.env.HOOK_READ_ATTEMPT, JSON.stringify({ phase: \'error\', code: error.code ?? null, errcode: error.errcode ?? null, message: error.message })); throw error; }',
    '};',
  ].join('\n'));
  const writers = [];
  const hooks = [];
  t.after(async () => {
    const settle = async (promise, timeoutMs) => {
      let timer;
      try { return await Promise.race([promise, new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(false), timeoutMs); })]); }
      finally { clearTimeout(timer); }
    };
    for (const writer of writers) {
      writeFileSync(writer.release, 'release');
      if (!await settle(writer.closed, 1_000) && writer.child.exitCode === null && writer.child.signalCode === null) {
        try { process.kill(-writer.child.pid, 'SIGTERM'); } catch {}
        if (!await settle(writer.closed, 1_000) && writer.child.exitCode === null && writer.child.signalCode === null) {
          try { process.kill(-writer.child.pid, 'SIGKILL'); } catch {}
          await writer.closed;
        }
      }
    }
    for (const hook of hooks) {
      if (!await settle(hook.closed, 1_000) && hook.exitCode === null && hook.signalCode === null) {
        hook.kill('SIGTERM');
        if (!await settle(hook.closed, 1_000) && hook.exitCode === null && hook.signalCode === null) {
          hook.kill('SIGKILL');
          await hook.closed;
        }
      }
    }
  });
  /** Start both isolated processes and wait for the hook's exact agentAt query attempt. */
  const runHookWhileWriterHolds = async (name) => {
    const writer = startExclusiveWriter(box, boardFile, name);
    writers.push(writer);
    await waitFor(() => existsSync(writer.ready), `${name} exclusive writer`);
    const marker = `${observedSql}-${name}`;
    const hook = launchHookProbe(box, probe, marker);
    hooks.push(hook);
    await waitFor(() => existsSync(marker), `${name} hook agentAt query attempt`);
    return { writer, hook, marker };
  };

  const successful = await runHookWhileWriterHolds('successful-wait');
  // The preload marks the exact agentAt statement preparation; release follows a pending-read observation.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  const successObservation = JSON.parse(readFileSync(successful.marker, 'utf8'));
  assert.equal(successful.hook.exitCode, null, `the hook must remain pending at agentAt while SQLite is exclusively locked: ${JSON.stringify(successObservation)} ${successful.hook.stderrText}`);
  assert.ok(['prepare-started', 'get-started'].includes(successObservation.phase), `the hook reached native SQLite prepare or get before release: ${JSON.stringify(successObservation)}`);
  writeFileSync(successful.writer.release, 'release');
  const [writerSuccess, hookSuccess] = await Promise.all([successful.writer.closed, successful.hook.closed]);
  assert.equal(writerSuccess.error, null, `the exclusive writer spawned: ${writerSuccess.error?.message ?? ''}`);
  assert.deepEqual({ code: writerSuccess.code, signal: writerSuccess.signal }, { code: 0, signal: null }, successful.writer.child.fixtureFailure ?? 'the exclusive writer commits and closes');
  assert.equal(hookSuccess.error, null, `the hook child spawned: ${hookSuccess.error?.message ?? ''}`);
  assert.deepEqual({ code: hookSuccess.code, signal: hookSuccess.signal }, { code: 0, signal: null }, successful.hook.stderrText);
  assert.ok(existsSync(successful.writer.released), 'the writer releases its exclusive lock only after commit and close');

  const timeout = await runHookWhileWriterHolds('timeout-diagnostic');
  let timeoutTimer;
  const timeoutResult = await Promise.race([
    timeout.hook.closed,
    new Promise((_, reject) => { timeoutTimer = setTimeout(() => reject(new Error('hook read exceeded the stated 10s busy timeout')), 15_000); }), // budget: hang ceiling derived from the declared 10s SQLite wait plus 5s for child startup and scheduling.
  ]).finally(() => clearTimeout(timeoutTimer));
  assert.equal(timeoutResult.error, null, `the timeout hook child spawned: ${timeoutResult.error?.message ?? ''}`);
  assert.equal(timeoutResult.code, 1, timeout.hook.stderrText);
  assert.match(timeout.hook.stderrText, /BOARD_BUSY/u);
  assert.match(timeout.hook.stderrText, /board file .*board\.sqlite.*another process.*after \d+ms/u);
  assert.match(timeout.hook.stderrText, /after (?:9\d{3}|1\d{4})ms/u, 'diagnostics report the actual prolonged lock wait');
  assert.doesNotMatch(timeout.hook.stderrText, /database is locked/u, 'a timed-out read never emits only SQLite’s bare lock error');
  const timeoutObservation = JSON.parse(readFileSync(timeout.marker, 'utf8'));
  assert.equal(timeoutObservation.phase, 'error', 'the preload observed the actual SQLite refusal');
  assert.ok((timeoutObservation.errcode & 0xff) === 5 || timeoutObservation.code === 'SQLITE_BUSY', `the underlying failure is SQLITE_BUSY/5: ${JSON.stringify(timeoutObservation)}`);
  writeFileSync(timeout.writer.release, 'release');
  const writerTimeout = await timeout.writer.closed;
  assert.equal(writerTimeout.error, null, `the diagnostic writer spawned: ${writerTimeout.error?.message ?? ''}`);
  assert.deepEqual({ code: writerTimeout.code, signal: writerTimeout.signal }, { code: 0, signal: null }, timeout.writer.child.fixtureFailure ?? 'the diagnostic fixture writer closes cleanly');
  assert.ok(existsSync(timeout.writer.released), 'the diagnostic writer releases after the hook reports its timeout');
});

test('landing diagnostics retain unknown failures and merge subjects obey typed 72-character headers [B3,R3]', () => {
  const root = '/private/landing';
  const failures = landingFailures(`not ok 1 - located failure\n  location: ${root}/test/one.test.js:3:4\nnot ok 2 - unknown failure\n`, root);
  assert.deepEqual(failures, [{ name: 'located failure', file: 'test/one.test.js' }, { name: 'unknown failure', file: null }]);
  const subject = landingSubject({ item_id: 91, item_title: 'A VERY LONG TITLE '.repeat(10), item_spec_ids: 'B3,R3' });
  assert.equal(subject, 'chore(merge): a very long title a very long title a very long [B3,R3]');
  assert.ok(subject.length <= 72);
});

test('land bisect adoption retains completed gates, isolated diagnostics and original candidates [B3,R3]', async (t) => {
  const box = landProject();
  const entries = verifiedFour(box, { red: 2 });
  writeFileSync(box.trace, '');
  writeFileSync(box.hold, '3');
  const child = startFixtureChild(process.execPath, [BIN, 'land', '--json'], { cwd: box.repo, env: box.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  const closed = new Promise((resolveClose) => child.once('close', (status, signal) => resolveClose({ status, signal })));
  t.after(() => {
    writeFileSync(box.release, 'release');
    if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  });
  await waitFor(() => existsSync(box.entered), 'third full gate inside bisection', 20000); // budget: hang ceiling for the third private bisection gate entry handshake; no throughput claim.
  const interrupted = json(box, box.repo, 'resume').landingBatches.at(-1);
  assert.equal(interrupted.items.length, 2, 'the current half differs from the original four candidates');
  assert.equal(interrupted.gateResults.length, 2);
  assert.deepEqual(interrupted.diagnostics, [{ test: FILES[2], isGreen: false }]);
  process.kill(-child.pid, 'SIGKILL');
  assert.equal((await closed).signal, 'SIGKILL');
  writeFileSync(box.release, 'release');
  const result = json(box, box.repo, 'land', '--adopt');
  assert.deepEqual(result.landed, [entries[0].item, entries[1].item, entries[3].item]);
  const trace = readFileSync(box.trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(trace.filter((row) => !row.alone && row.files.length === 4).length, 1, 'completed initial red is not retried');
  assert.equal(trace.filter((row) => !row.alone && row.files.join(',') === FILES.slice(0, 2).join(',')).length, 1, 'completed green half is not retried');
  assert.equal(trace.filter((row) => row.alone && row.files[0] === FILES[2]).length, 1, 'the isolated red is not retried');
  assert.equal(json(box, box.repo, 'show', String(entries[2].item)).thread.filter((entry) => entry.type === 'fact').length, 1);
});

test('landing records replay identically with native sender and engine boundaries [B3,R3,H16]', (t) => {
  const box = landProject();
  const entry = itemWorktree(box, 1);
  submitItem(box, entry);
  acceptItem(box, entry);
  const document = onBoard(box, (board) => exportBoard(board));
  const boards = ['one', 'two'].map((name, index) => {
    const board = store.openBoard(join(box.dir, `${name}.sqlite`), { now: () => new Date(index ? '2030-01-01' : '2020-01-01') });
    importBoard(board, document);
    return board;
  });
  t.after(() => boards.forEach((board) => store.closeBoard(board)));
  const batch = { version: 1, id: 'replayed-batch', state: 'pushed', base: box.git(box.repo, 'rev-parse', 'HEAD'), tip: entry.commit,
    root: join(box.repo, '.git', 'pullboard', 'landings', 'replayed-batch', 'worktree'), branch: 'refs/heads/main', owner: 'coordinator-fixture',
    logPath: join(box.dir, 'replayed-gate.log'), items: [{ id: entry.item, commit: entry.commit, merge: entry.commit }] };
  const operations = [
    ['recordLandingBatch', [{ agentId: 'coordinator', batch }], 'coordinator'],
    ['recordLandingWaiver', [{ agentId: 'person', channel: 'terminal', id: 'replayed-waiver', test: FILES[0], until: '2099-01-01', reason: 'private replay exception' }], 'person'],
    ['recordLandingFlake', [{ agentId: 'coordinator', test: FILES[0], hash: 'd'.repeat(64), names: ['private failing test'], lane: 'web', batchId: batch.id }], 'coordinator'],
    ['finishLandingBatch', [{ agentId: 'coordinator', id: batch.id, tip: entry.commit }], 'coordinator'],
  ];
  for (const [index, [operation, args, actor]] of operations.entries()) {
    const move = prepareEngineMove(boards[0], operation, args, { id: `landing-replay-${index}`, actor });
    const options = { sequence: index + 1, at: '2026-10-10T17:30:00.000Z', kind: 'move',
      sender: actor === 'person' ? { kind: 'person', userId: 'fixture-person' } : { kind: 'agent', agent: actor, userId: 'fixture-person' } };
    const one = applyRelayMove(boards[0], move, options);
    const two = applyRelayMove(boards[1], move, options);
    assert.equal(one.error, undefined, JSON.stringify(one));
    assert.deepEqual(one, two);
    const before = store.events(boards[0]);
    assert.deepEqual(applyRelayMove(boards[0], move, options), one, 'replay of a receipt is idempotent');
    assert.deepEqual(store.events(boards[0]), before);
  }
  assert.deepEqual(store.events(boards[0]), store.events(boards[1]), 'different local clocks produce the same authoritative events');
  assert.equal(store.getItem(boards[0], entry.item).item_merged_commit, entry.commit);
  assert.equal(store.events(boards[0]).filter((event) => event.event_kind === 'main-moved').length, 1);
  const old = prepareEngineMove(boards[0], 'recordLandingBatch', [{ agentId: 'coordinator', batch: { ...batch, id: 'old-engine-batch' } }], { id: 'old-engine-landing', actor: 'coordinator' });
  assert.throws(() => applyRelayMove(boards[0], { ...old, engine: 7 }, { sequence: 5, at: '2026-10-10T17:31:00.000Z', kind: 'move', sender: { kind: 'agent', userId: 'fixture-person', agent: 'coordinator' } }), { code: 'RELAY_MOVE' });
  const forged = prepareEngineMove(boards[0], 'recordLandingWaiver', operations[1][1], { id: 'forged-landing-waiver', actor: 'person' });
  const spoof = applyRelayMove(boards[0], forged, { sequence: 5, at: '2026-10-10T17:32:00.000Z', kind: 'move', sender: { kind: 'agent', userId: 'fixture-person', agent: 'web-1' } });
  assert.equal(spoof.error?.code, 'RELAY_PERSON_ONLY');
});
