/** Real Git, SQLite and HTTP settings inventory proof [O5,O6]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalApiHandler } from '../src/api.js';
import { defaults } from '../src/config.js';
import * as store from '../src/board.js';
import { runFixtureGit } from './fixture-child.js';

/** Hash durable fixture files, including the registry, settings, credentials and SQLite bytes. */
function snapshot(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    // SQLite read locks use transient WAL/shared-memory sidecars, not durable settings.
    if (/\.sqlite-(?:shm|wal)$/u.test(entry.name)) return [];
    return entry.isDirectory() ? snapshot(path) : [[path, createHash('sha256').update(readFileSync(path)).digest('hex')]];
  }).sort(([left], [right]) => left.localeCompare(right));
}

/** Exercise the real authenticated local endpoint without accessing the person's storage. */
export async function proveSettingsApi() {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-settings-api-'));
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  const previous = Object.fromEntries(['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME', 'PULLBOARD_RELAY_KEY', 'PULLBOARD_RELAY_TOKEN', 'PULLBOARD_VIEW_PORT'].map(key => [key, process.env[key]]));
  delete process.env.PULLBOARD_RELAY_KEY;
  delete process.env.PULLBOARD_RELAY_TOKEN;
  delete process.env.PULLBOARD_VIEW_PORT;
  process.env.PULLBOARD_HOME = home;
  process.env.PULLBOARD_MACHINE_HOME = home;
  let server;
  let handler;
  try {
    mkdirSync(home);
    mkdirSync(repo);
    runFixtureGit(['init', '-q', '-b', 'main'], { cwd: repo, encoding: 'utf8' });
    const privateDir = join(repo, '.git', 'pullboard');
    mkdirSync(privateDir);
    const board = store.openBoard(join(privateDir, 'board.sqlite'));
    const id = store.boardId(board);
    const events = board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n;
    store.closeBoard(board);
    const canary = ['fixture', 'credential', 'never-return-this'].join('-');
    const config = { ...defaults(), gate: 'node --test', health: { sentinel: false }, testConcurrency: { files: 3, browser: 1 }, claim: { reopenFirstRefusalMinutes: 30 }, lanes: { app: { owns: ['app/'], specs: ['O5'], ignoredSecret: canary } } };
    writeFileSync(join(repo, 'pullboard.json'), JSON.stringify(config));
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ gateSlots: 3, browserSlots: 2, gate: { queue: { reviewsFirst: true }, shortSlots: 1 }, relay: { offerAtInit: false }, unknown: { token: canary } }));
    writeFileSync(join(home, 'projects.json'), JSON.stringify({ fixture: canary }));
    mkdirSync(join(home, 'relay-machine'));
    writeFileSync(join(home, 'relay-machine', 'state.json'), JSON.stringify({ v: 1, autoLink: true, session: { token: canary, account: 'fixture', url: 'https://relay.example.invalid' }, approvals: [{ sealed: canary }], devices: [], excluded: [] }));
    writeFileSync(join(privateDir, 'relay.json'), JSON.stringify({ version: 1, board: id, url: 'https://relay.example.invalid', token: canary, agentTokens: { fixture: { token: canary } }, snapshot: canary }));
    const resources = new DatabaseSync(join(home, 'resources.sqlite'));
    resources.exec('CREATE TABLE resource(name TEXT PRIMARY KEY, capacity INTEGER NOT NULL)');
    resources.prepare('INSERT INTO resource VALUES (?, ?)').run('custom', 4);
    resources.close();
    const legacy = join(root, 'legacy');
    const missing = join(root, 'missing');
    const legacyId = 'a'.repeat(32);
    for (const folder of [legacy, missing]) {
      mkdirSync(folder);
      runFixtureGit(['init', '-q', '-b', 'main'], { cwd: folder, encoding: 'utf8' });
      writeFileSync(join(folder, 'pullboard.json'), JSON.stringify(defaults()));
    }
    mkdirSync(join(legacy, '.git', 'pullboard'));
    const oldBoard = new DatabaseSync(join(legacy, '.git', 'pullboard', 'board.sqlite'));
    oldBoard.exec('CREATE TABLE board_meta(meta_key TEXT PRIMARY KEY, meta_value TEXT)');
    oldBoard.prepare('INSERT INTO board_meta VALUES (?, ?)').run('board_id', legacyId);
    oldBoard.close();
    let port;
    handler = createLocalApiHandler({ secret: 'api-fixture', getPort: () => port, runCommand: async () => 0,
      projects: () => [repo, legacy, missing].map(root => ({ root, name: 'fixture', project: '', added: '2026-01-01' })) });
    server = createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    const address = `http://127.0.0.1:${port}/api/v1/settings`;
    const before = snapshot(root);
    const response = await fetch(address, { headers: { 'x-pullboard-key': 'api-fixture' } });
    assert.equal(response.status, 200, 'the settings API exists');
    const text = await response.text();
    assert.ok(!text.includes(canary), 'no unknown, nested, legacy-session or relay credential escapes');
    const result = JSON.parse(text);
    assert.equal(result.version, 1);
    assert.equal(result.warnings[0].root, missing);
    const rows = result.settings;
    const find = (scope, key) => rows.find(row => row.scope === scope && row.key === key);
    for (const row of rows) {
      assert.ok(['machine', 'repo', 'board'].includes(row.scope));
      assert.ok(Object.hasOwn(row, 'value') && Object.hasOwn(row, 'default'));
      assert.equal(typeof row.source, 'string');
      if (row.scope !== 'machine') assert.ok([id, legacyId].includes(row.board));
    }
    assert.equal(find('machine', 'gateSlots').value, 3);
    assert.equal(find('machine', 'gateSlots').default, 2);
    assert.equal(find('machine', 'gateSlots').source, join(home, 'settings.json'));
    assert.equal(find('machine', 'gate.queue.reviewsFirst').value, true);
    assert.equal(find('machine', 'gate.queue.agingMinutes').value, 30);
    assert.equal(find('machine', 'resources.custom.capacity').value, 4);
    assert.equal(find('repo', 'claim.reopenFirstRefusalMinutes').value, 30);
    assert.equal(find('repo', 'health.sentinel').value, false);
    assert.equal(find('repo', 'testConcurrency.files').value, 3);
    for (const key of ['checks.provesNothing', 'verify.unrelatedTrunkMoves', 'flakes.rerun', 'flakes.quarantine', 'rigor.budget', 'relay.outbox', 'submitGate', 'landingShards', 'landing.publish', 'positiveControl', 'affectedTests']) assert.ok(find('repo', key), key);
    assert.equal(find('board', 'relay.token').value, 'set');
    assert.equal(find('machine', 'relay.session.token').value, 'set');
    assert.deepEqual(find('repo', 'lanes').value, { app: { owns: ['app/'], specs: ['O5'] } });
    const selected = await fetch(address + '?board=' + id, { headers: { 'x-pullboard-key': 'api-fixture' } });
    assert.equal(selected.status, 200);
    assert.deepEqual((await selected.json()).settings, rows.filter(row => row.scope === 'machine' || row.board === id));
    const unknown = await fetch(address + '?board=missing', { headers: { 'x-pullboard-key': 'api-fixture' } });
    assert.equal(unknown.status, 404);
    assert.equal((await fetch(address)).status, 401);
    assert.equal((await fetch(address, { method: 'POST', headers: { 'x-pullboard-key': 'api-fixture' } })).status, 400);
    assert.deepEqual(snapshot(root), before, 'GET neither migrates credentials nor changes settings, registry, resources or board bytes');
    // Supported fields containing nested canary objects must refuse safely, not become raw JSON.
    for (const invalid of [
      { ...config, products: { app: [{ token: canary }] } },
      { ...config, lanes: { app: { owns: ['app/'], starts: { token: canary } } } },
    ]) {
      writeFileSync(join(repo, 'pullboard.json'), JSON.stringify(invalid));
      const saved = snapshot(root);
      const refused = await fetch(address + '?board=' + id, { headers: { 'x-pullboard-key': 'api-fixture' } });
      assert.equal(refused.status, 400);
      assert.ok(!(await refused.text()).includes(canary));
      assert.deepEqual(snapshot(root), saved);
    }
    writeFileSync(join(repo, 'pullboard.json'), JSON.stringify(config));
    const machineFile = join(home, 'settings.json');
    const machineSaved = readFileSync(machineFile);
    writeFileSync(machineFile, JSON.stringify({ gateSlots: { token: canary } }));
    const invalidMachine = snapshot(root);
    const refusedMachine = await fetch(address, { headers: { 'x-pullboard-key': 'api-fixture' } });
    assert.equal(refusedMachine.status, 400);
    assert.ok(!(await refusedMachine.text()).includes(canary));
    assert.deepEqual(snapshot(root), invalidMachine);
    writeFileSync(machineFile, machineSaved);
    process.env.PULLBOARD_RELAY_KEY = canary;
    process.env.PULLBOARD_RELAY_TOKEN = canary;
    const environment = await (await fetch(address + '?board=' + id, { headers: { 'x-pullboard-key': 'api-fixture' } })).json();
    for (const key of ['relay.key', 'relay.token']) {
      const row = environment.settings.find(row => row.scope === 'board' && row.key === key);
      assert.equal(row.value, 'set');
      assert.equal(row.source, 'environment:' + (key === 'relay.key' ? 'PULLBOARD_RELAY_KEY' : 'PULLBOARD_RELAY_TOKEN'));
    }
    assert.ok(!JSON.stringify(environment).includes(canary));
    const legacyRead = new DatabaseSync(join(legacy, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
    assert.equal(legacyRead.prepare('PRAGMA user_version').get().user_version, 0);
    assert.deepEqual(legacyRead.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name), ['board_meta']);
    legacyRead.close();
    const read = new DatabaseSync(join(privateDir, 'board.sqlite'), { readOnly: true });
    assert.equal(read.prepare('SELECT COUNT(*) AS n FROM event').get().n, events);
    read.close();
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    handler?.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
}
