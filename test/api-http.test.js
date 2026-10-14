/** Real HTTP calls against an isolated Git repo and the actual board engine (A2). */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runFixtureChild, runFixtureGit, startFixtureChild } from './fixture-child.js';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { serveApi } from '../src/api.js';
import { serveView } from '../src/serve.js';
import { main } from '../src/cli.js';
import { createApiHandler } from '../src/api-http.js';
import { registryFile, registerProject } from '../src/projects.js';
import { Refused } from '../src/refused.js';
import * as store from '../src/board.js';
import { preparePersonRequest } from '../src/person-request.js';
import { receivePersonRequest } from '../src/relay-requests.js';
import { fetchFresh } from './http-fixture.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');

/** Quote an executable path literally for the fixture's source-bin hook shim. */
function shellWord(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Create a private, committed project, with an exact-build hook shim and no personal Git config. */
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-http-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  const bin = join(dir, 'bin');
  mkdirSync(root);
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = {
    ...process.env, HOME: join(dir, 'home'), PULLBOARD_HOME: join(dir, 'home'),
    PATH: bin + ':' + process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'HTTP Agent', GIT_AUTHOR_EMAIL: 'agent@example.invalid',
    GIT_COMMITTER_NAME: 'HTTP Agent', GIT_COMMITTER_EMAIL: 'agent@example.invalid',
  };
  mkdirSync(env.HOME);
  /** Run Git only inside the private fixture. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env, stdio: 'pipe', encoding: 'utf8' });
  /** Exercise this worktree's real CLI with a private environment. */
  const run = (cwd, ...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  /** Decode one successful versioned CLI invocation without printing session links. */
  function cli(cwd, ...args) {
    const result = run(cwd, ...args, '--json');
    let reason = result.stderr;
    if (result.status !== 0 && result.stdout) {
      try {
        const response = JSON.parse(result.stdout);
        const error = response?.error;
        if (error && typeof error === 'object') {
          reason = [result.stderr, error.code, error.message].filter(Boolean).join('\n');
        }
      } catch { /* Keep the existing stderr-only diagnostic for non-JSON failures. */ }
    }
    assert.equal(result.status, 0, reason);
    return JSON.parse(result.stdout);
  }
  git('init', '-q', '-b', 'main');
  cli(root, 'init');
  const config = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8'));
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ ...config, gate: 'true', lanes: { app: { owns: ['app/'] }, review: { owns: [] } } }));
  writeFileSync(join(root, 'SPEC.md'), '# HTTP fixture\n\n## Goals\n- G1 [approved, must] Keep the board. | gate: true\n');
  writeFileSync(join(root, 'DOCTRINE.md'), '');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: private HTTP fixture');
  return { root, dir, env, cli, run, commit: git('rev-parse', 'HEAD').trim() };
}

/** Serve this fixture's explicit project, avoiding any registry outside its private home. */
async function httpBox(t, { includeMissing = false, onStateBuild, additionalProjects = [] } = {}) {
  const box = fixture(t);
  const api = await serveApi({ runCommand: main, onStateBuild, projects: () => [...(includeMissing ? [{ root: join(box.dir, 'gone'), name: 'Missing fixture' }] : []), { root: box.root, name: 'HTTP fixture' }, ...additionalProjects] });
  t.after(() => api.close());
  const url = new URL(api.url);
  const key = url.searchParams.get('k');
  const origin = url.origin;
  /** Make a real HTTP call and decode its single versioned response. */
  async function call(path, value, headers = {}) {
    const response = await fetchFresh(origin + path, {
      method: value === undefined ? 'GET' : 'POST',
      headers: { 'x-pullboard-key': key, ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    const document = await response.json();
    assert.equal(document.version, 1);
    return { status: response.status, document };
  }
  const listed = await call('/api/v1/boards');
  assert.equal(listed.status, 200);
  assert.equal(listed.document.boards.length, 1 + additionalProjects.length);
  const id = listed.document.boards.find((entry) => resolve(entry.root) === resolve(box.root)).id;
  assert.match(id, /^[0-9a-f]{32}$/);
  return { ...box, api, origin, key, id, call, path: '/api/v1/boards/' + id };
}

/** Serve one registered private fixture through the actual person's view adapter. */
async function viewHttpBox(t, existing = null) {
  const box = existing ?? fixture(t);
  const previousHome = process.env.PULLBOARD_HOME;
  let view;
  t.after(async () => {
    try { await view?.close(); }
    finally {
      if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
      else process.env.PULLBOARD_HOME = previousHome;
    }
  });
  process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
  registerProject(box.root);
  view = await serveView({ port: 0 });
  const url = new URL(view.url);
  const key = url.searchParams.get('k');
  const origin = url.origin;
  /** Make a real HTTP call to this fixture's person-owned view and decode its versioned response. */
  async function call(path, value, headers = {}) {
    const response = await fetchFresh(origin + path, {
      method: value === undefined ? 'GET' : 'POST',
      headers: { 'x-pullboard-key': key, ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    const document = await response.json();
    assert.equal(document.version, 1);
    return { status: response.status, document };
  }
  const listed = await call('/api/v1/boards');
  assert.equal(listed.status, 200);
  assert.equal(listed.document.boards.length, 1);
  const id = listed.document.boards[0].id;
  return { ...box, api: view, origin, key, id, call, path: '/api/v1/boards/' + id };
}

test('[A2] a stale registered folder does not hide another readable board', async (t) => {
  const box = await httpBox(t, { includeMissing: true });
  const listed = await box.call('/api/v1/boards');
  assert.equal(listed.document.boards.length, 1);
  assert.equal(listed.document.warnings.length, 1);
  assert.equal(listed.document.warnings[0].name, 'Missing fixture');
  assert.equal(listed.document.warnings[0].error.version, 1);
  assert.equal(listed.document.warnings[0].error.error.code, 'BOARD_UNAVAILABLE');
  assert.match(listed.document.warnings[0].error.error.next, /pullboard forget/);
  const state = await box.call(box.path + '/state');
  assert.equal(state.status, 200);
  assert.equal(state.document.state.board, box.id);
});

/** Prove the authenticated HTTP state reuses a complete snapshot until one of its inputs changes. */
async function cachedHttpStateTest(t) {
  let builds = 0;
  const box = await httpBox(t, { onStateBuild: () => { builds += 1; } });
  const agent = box.cli(box.root, 'worktree', 'app', '--model', 'fixture-agent');
  const hostileShout = 'cache baseline "quoted" \\ path\nline\n", "proofStats": {"flow":"forged"}';
  box.cli(box.root, 'shout', 'app', hostileShout);

  const first = await box.call(box.path + '/state');
  assert.equal(first.status, 200);
  assert.equal(builds, 1);
  assert.ok(first.document.state.shouts.some((shout) => shout.shout_text === hostileShout));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const unchanged = await box.call(box.path + '/state');
  assert.equal(builds, 1, 'an identical refresh reuses the complete board state');
  assert.ok(unchanged.document.state.shouts.some((shout) => shout.shout_text === hostileShout));
  assert.notEqual(unchanged.document.state.proofStats.flow.asOf, first.document.state.proofStats.flow.asOf);

  const latestShout = first.document.state.shouts.at(-1).shout_id;
  const unread = await box.call(box.path + '/state?seen=0');
  assert.equal(unread.document.state.unseen.since, 0);
  assert.ok(unread.document.state.unseen.count > 0);
  const read = await box.call(box.path + '/state?seen=' + latestShout);
  assert.deepEqual(read.document.state.unseen, { since: latestShout, count: 0 });
  assert.equal(builds, 1, 'the request-specific seen cursor does not rebuild or mutate the shared state');

  box.cli(box.root, 'add', 'app', 'cache invalidation item', '--criterion', 'visible after the next refresh', '--specs', 'G1');
  const moved = await box.call(box.path + '/state');
  assert.equal(builds, 2);
  assert.ok(moved.document.state.items.some((item) => item.title === 'cache invalidation item'));

  writeFileSync(join(box.root, 'SPEC.md'), '# HTTP fixture\n\n## Goals\n- G1 [approved, must] Keep the board. | gate: true\n- G2 [approved, must] Keep the cache fresh. | gate: true\n');
  const spec = await box.call(box.path + '/state');
  assert.equal(builds, 3);
  assert.ok(spec.document.state.spec.some((row) => row.id === 'G2'));

  const configFile = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, lease: '1m', lanes: { ...config.lanes, ops: { owns: [] } } }));
  const configured = await box.call(box.path + '/state');
  assert.equal(builds, 4);
  assert.ok(configured.document.state.lanes.includes('ops'));

  writeFileSync(join(box.root, 'DOCTRINE.md'), '# Local rules\n\n## Team Rules\n\n- LOCAL1 [approved, must] Keep the local board readable. | gate: true\n');
  const doctrine = await box.call(box.path + '/state');
  assert.equal(builds, 5);
  assert.ok(doctrine.document.state.practice.some((row) => row.id === 'LOCAL1'));

  writeFileSync(join(box.root, 'cache-head.txt'), 'advance HEAD without a board event\n');
  runFixtureGit(['add', 'cache-head.txt'], { cwd: box.root, env: box.env, stdio: 'pipe' });
  runFixtureGit(['commit', '-q', '-m', 'chore: advance fixture head'], { cwd: box.root, env: box.env, stdio: 'pipe' });
  const headed = await box.call(box.path + '/state');
  assert.equal(builds, 6);
  const head = runFixtureGit(['rev-parse', 'HEAD'], { cwd: box.root, env: box.env, stdio: 'pipe' });
  assert.equal(headed.document.state.rowAgesAt['SPEC.md'], head);

  box.cli(box.root, 'shout', 'app', 'agent inbox cursor');
  const beforeInbox = await box.call(box.path + '/state');
  const agentBeforeInbox = beforeInbox.document.state.agents.find((entry) => entry.agent_id === agent.agent);
  const boardBeforeInbox = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try {
    store.inbox(boardBeforeInbox, agent.agent);
  } finally {
    store.closeBoard(boardBeforeInbox);
  }
  const afterInbox = await box.call(box.path + '/state');
  const agentAfterInbox = afterInbox.document.state.agents.find((entry) => entry.agent_id === agent.agent);
  assert.equal(agentAfterInbox.agent_last_shout_id, Math.max(...beforeInbox.document.state.shouts.map((shout) => shout.shout_id)));
  assert.notEqual(agentAfterInbox.agent_last_shout_id, agentBeforeInbox.agent_last_shout_id);
  assert.equal(builds, 8, 'an inbox cursor change without an event invalidates the agent projection');

  const added = await box.call(box.path + '/moves', { verb: 'add', args: { lane: 'app', title: 'Lease cache item', criterion: 'remain current', specs: 'G1' } });
  assert.equal(added.status, 200);
  const itemId = added.document.result.item.item_id;
  const claimed = await box.call(box.path + '/moves', { verb: 'claim', item: itemId, agent: agent.agent });
  assert.equal(claimed.status, 200);
  const active = await box.call(box.path + '/state');
  assert.equal(active.document.state.items.find((item) => item.id === itemId).status, 'claimed');
  const lastEvent = active.document.state.events[0].event_id;
  const leaseBoard = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  let leaseUntil;
  try {
    leaseUntil = leaseBoard.db.prepare('SELECT item_lease_until FROM item WHERE item_id = ?').get(itemId).item_lease_until;
  } finally {
    store.closeBoard(leaseBoard);
  }
  assert.ok(Number.isFinite(Date.parse(leaseUntil)));
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  t.mock.timers.tick(Math.max(1, Date.parse(leaseUntil) - now + 1));
  const expired = await box.call(box.path + '/state');
  assert.equal(expired.document.state.items.find((item) => item.id === itemId).status, 'open');
  assert.equal(expired.document.state.items.find((item) => item.id === itemId).owner, null);
  assert.equal(expired.document.state.events[0].event_id, lastEvent, 'lease expiry changed no board event');
  assert.equal(builds, 10, 'clock-only lease expiry invalidates the cached state');
}

test('[A2, N26] an unchanged board state is reused and a move rebuilds it', cachedHttpStateTest);

test('[A2, N26] local milestone item status refreshes after an item event', async (t) => {
  let builds = 0;
  const box = await httpBox(t, { onStateBuild: () => { builds += 1; } });
  const agent = box.cli(box.root, 'worktree', 'app', '--model', 'fixture-agent');
  const added = await box.call(box.path + '/moves', {
    verb: 'add', args: { lane: 'app', title: 'Roadmap item', criterion: 'refresh local status', specs: 'G1' },
  });
  assert.equal(added.status, 200);
  const itemId = added.document.result.item.item_id;
  box.cli(box.root, 'milestone', 'add', 'Delivery', '--items', String(itemId));

  const before = await box.call(box.path + '/state');
  assert.equal(builds, 1);
  assert.deepEqual(before.document.state.milestones[0].items[0], {
    id: itemId, title: 'Roadmap item', status: 'open',
  });

  const unchanged = await box.call(box.path + '/state');
  assert.equal(builds, 1, 'an unchanged local roadmap state reuses its cached snapshot');
  assert.deepEqual(unchanged.document.state.milestones, before.document.state.milestones);

  const claimed = await box.call(box.path + '/moves', { verb: 'claim', item: itemId, agent: agent.agent });
  assert.equal(claimed.status, 200);
  const after = await box.call(box.path + '/state');
  assert.equal(builds, 2, 'a real item event rebuilds the cached local roadmap');
  assert.deepEqual(after.document.state.milestones[0].items[0], {
    id: itemId, title: 'Roadmap item', status: 'claimed',
  });
});

test('[A2, N26] a person request receipt refreshes cached state without an event', async (t) => {
  let builds = 0;
  const box = await httpBox(t, { onStateBuild: () => { builds += 1; } });
  const first = await box.call(box.path + '/state');
  assert.equal(first.status, 200);
  assert.equal(builds, 1);

  const board = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  let eventCountBefore;
  let eventCountAfter;
  try {
    eventCountBefore = board.db.prepare('SELECT COUNT(*) AS count FROM event').get().count;
    const document = preparePersonRequest({ verb: 'add', args: { lane: 'app', title: 'Private receipt fixture' } }, 'cache-receipt-1');
    assert.equal(receivePersonRequest(board, document, {
      sequence: 1, at: new Date().toISOString(), sender: { kind: 'person', userId: 'private-fixture-person' },
    }).status, 'waiting');
    eventCountAfter = board.db.prepare('SELECT COUNT(*) AS count FROM event').get().count;
  } finally { store.closeBoard(board); }
  assert.equal(eventCountAfter, eventCountBefore, 'ordinary person request receipt intake writes no board event');

  const refreshed = await box.call(box.path + '/state');
  assert.ok(refreshed.document.state.personRequests.some((request) => request.id === 'cache-receipt-1'),
    'the next state response includes the receipt received after the previous cache fill');
  assert.equal(builds, 2, 'request-receipt metadata invalidates the state snapshot');
});

test('[A2] local HTTP state accepts a safe seen cursor and committed code previews', async (t) => {
  const box = await httpBox(t);
  box.cli(box.root, 'shout', 'app', 'state cursor baseline');
  const before = await box.call(box.path + '/state');
  const seen = before.document.state.shouts.at(-1).shout_id;
  box.cli(box.root, 'shout', 'app', 'state cursor event');
  const state = await box.call(box.path + '/state?seen=' + seen);
  assert.equal(state.document.state.unseen.since, seen);
  assert.equal(state.document.state.unseen.count, 1);
  const missing = await box.call(box.path + '/state');
  assert.equal(missing.document.state.unseen, null);
  for (const cursor of ['', '-1', '1.5', '9007199254740992']) {
    const invalid = await box.call(box.path + '/state?seen=' + cursor);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.document.error.code, 'BAD_CURSOR');
  }

  writeFileSync(join(box.root, 'SPEC.md'), '# changed working tree\n');
  const preview = await box.call(box.path + '/code?ref=' + encodeURIComponent('SPEC.md:1-4@' + box.commit) + '&before=' + encodeURIComponent('Please inspect '));
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.document.code.lines, ['# HTTP fixture', '', '## Goals', '- G1 [approved, must] Keep the board. | gate: true']);
  assert.equal(preview.document.code.path, 'SPEC.md');
  assert.equal(preview.document.code.from, 1);
  assert.equal(preview.document.code.to, 4);
  for (const ref of ['../outside:1@' + box.commit, 'SPEC.md:0@' + box.commit, 'SPEC.md:1@HEAD']) {
    const invalid = await box.call(box.path + '/code?ref=' + encodeURIComponent(ref));
    assert.equal(invalid.status, 400);
    assert.ok(['BAD_REF', 'NO_COMMIT'].includes(invalid.document.error.code));
  }
});

test('[A2, N33, N35] API listing refreshes live labels and preserves unreadable-entry warnings', async (t) => {
  const box = fixture(t);
  const priorHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
  t.after(() => { if (priorHome === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = priorHome; });
  const second = join(box.dir, 'second-repo');
  mkdirSync(second);
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: second, env: box.env, stdio: 'pipe' });
  box.cli(second, 'init');
  const secondConfigFile = join(second, 'pullboard.json');
  const secondConfig = JSON.parse(readFileSync(secondConfigFile, 'utf8'));
  writeFileSync(secondConfigFile, JSON.stringify({ ...secondConfig, name: 'Saved second', project: 'Saved group' }));
  registerProject(second, new Date('2026-02-03T04:05:06.000Z'));

  const api = await serveApi({ runCommand: main });
  t.after(() => api.close());
  const url = new URL(api.url);
  const key = url.searchParams.get('k');
  /** Fetch the authenticated board catalog through the real local HTTP server. */
  async function listing() {
    const response = await fetchFresh(url.origin + '/api/v1/boards', { headers: { 'x-pullboard-key': key } });
    assert.equal(response.status, 200);
    return response.json();
  }

  const initial = await listing();
  assert.deepEqual(initial.boards.map((entry) => entry.root), [box.root, second]);
  assert.deepEqual(initial.warnings, []);
  const firstId = initial.boards[0].id;
  const firstAdded = initial.boards[0].added;
  const secondId = initial.boards[1].id;
  const secondAdded = initial.boards[1].added;
  const configFile = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, name: 'Fresh first', project: 'Fresh group' }));

  const refreshedBoth = await listing();
  assert.deepEqual(refreshedBoth.boards.map(({ root }) => root), [box.root, second]);
  assert.deepEqual(refreshedBoth.boards.map(({ id }) => id), [firstId, secondId]);
  assert.deepEqual(refreshedBoth.boards.map(({ added }) => added), [firstAdded, secondAdded]);
  assert.deepEqual(refreshedBoth.boards.map(({ name, project }) => ({ name, project })), [
    { name: 'Fresh first', project: 'Fresh group' },
    { name: 'Saved second', project: 'Saved group' },
  ]);
  rmSync(join(second, '.git'), { recursive: true, force: true });

  const refreshed = await listing();
  assert.deepEqual(refreshed.boards.map(({ root, name, project }) => ({ root, name, project })), [
    { root: box.root, name: 'Fresh first', project: 'Fresh group' },
  ]);
  assert.equal(refreshed.boards[0].id, firstId);
  assert.equal(refreshed.boards[0].added, firstAdded);
  assert.equal(refreshed.warnings.length, 1);
  assert.equal(refreshed.warnings[0].root, second);
  assert.equal(refreshed.warnings[0].name, 'Saved second');
  assert.equal(refreshed.warnings[0].project, 'Saved group');
  assert.equal(refreshed.warnings[0].added, secondAdded);
  assert.equal(refreshed.warnings[0].error.version, 1);
  assert.equal(refreshed.warnings[0].error.error.code, 'BOARD_UNAVAILABLE');
  assert.match(refreshed.warnings[0].error.error.next, /pullboard forget/);
  assert.deepEqual(JSON.parse(readFileSync(registryFile(), 'utf8')).projects.map(({ root }) => root), [box.root, second]);

  const forgotten = box.cli(box.root, 'forget', box.root);
  assert.equal(forgotten.root, box.root);
  assert.deepEqual(JSON.parse(readFileSync(registryFile(), 'utf8')).projects.map(({ root }) => root), [second]);
  const afterForget = await listing();
  assert.deepEqual(afterForget.boards, []);
  assert.deepEqual(afterForget.warnings.map(({ root }) => root), [second]);
});

test('[A2] real HTTP state, moves and refusals use the CLI and exact committed events', async (t) => {
  const box = await httpBox(t);
  const one = box.cli(box.root, 'worktree', 'app');
  const two = box.cli(box.root, 'worktree', 'app');
  const added = await box.call(box.path + '/moves', { verb: 'add', args: { lane: 'app', title: 'HTTP item', criterion: 'complete', specs: 'G1' } });
  assert.equal(added.status, 200);
  assert.equal(added.document.event.event_kind, 'add');
  const id = added.document.result.item.item_id;
  const claimed = await box.call(box.path + '/moves', { verb: 'claim', item: id, agent: one.agent });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.document.event.event_by, one.agent);
  assert.equal(claimed.document.event.event_kind, 'claim');
  const refused = await box.call(box.path + '/moves', { verb: 'claim', item: id, agent: two.agent });
  const terminal = box.run(two.path, 'claim', String(id), '--json');
  assert.equal(refused.status, 409);
  assert.equal(terminal.status, 1);
  assert.equal(refused.document.error.code, JSON.parse(terminal.stdout).error.code);
  assert.deepEqual(refused.document.error, JSON.parse(terminal.stdout).error, 'the original CLI refusal keeps its message and next step');
  const state = await box.call(box.path + '/state');
  assert.equal(state.document.state.board, box.id);
  assert.equal(state.document.state.items.find((item) => item.id === id).owner, one.agent);
  const events = await box.call(box.path + '/events?after=' + added.document.event.event_id);
  assert.deepEqual(events.document.events, [claimed.document.event]);
  const badAgent = await box.call(box.path + '/moves', { verb: 'release', item: id, agent: 'absent-agent' });
  assert.equal(badAgent.status, 409);
  assert.equal(badAgent.document.error.code, 'NO_AGENT');
  const submitted = await box.call(box.path + '/moves', { verb: 'submit', item: id, agent: one.agent });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.document));
  const review = await box.call(box.path + '/moves', { verb: 'next', agent: two.agent, args: { verify: true } });
  assert.equal(review.status, 200, JSON.stringify(review.document));
  assert.equal(review.document.result.item.item_id, id);
  const missingNote = await box.call(box.path + '/moves', { verb: 'release', item: id, agent: two.agent });
  assert.equal(missingNote.status, 409);
  assert.equal(missingNote.document.error.code, 'NOTE_REQUIRED');
  const release = await box.call(box.path + '/moves', { verb: 'release', item: id, agent: two.agent, args: { note: 'reviewed the wrong tree' } });
  assert.equal(release.status, 200, JSON.stringify(release.document));
  assert.deepEqual(JSON.parse(release.document.event.event_detail), { review: true, reason: 'reviewed the wrong tree', model: 'Test Model' });
});

test('[A2,V2,H16] board-state JSON retains pending and red baselines and removes cleared observations', async (t) => {
  const box = await httpBox(t);
  const pending = { command: 'true', main: box.commit, result: 'pending', request: randomUUID() };
  const board = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  let id;
  try {
    id = store.addItem(board, { by: 'coordinator', lane: 'app', title: 'Captured API observation',
      check: pending.command, checkBaseline: pending });
  } finally { store.closeBoard(board); }
  const initial = await box.call(box.path + '/state');
  assert.deepEqual(initial.document.state.items.find((item) => item.id === id).checkBaseline, pending,
    'a pending captured request reaches the public state endpoint before completion');
  const completed = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try {
    store.completeCheckBaseline(completed, id, { agentId: 'coordinator', expected: pending,
      baseline: { command: pending.command, main: pending.main, result: 'red', seconds: 1 } });
  } finally { store.closeBoard(completed); }
  const redState = await box.call(box.path + '/state');
  const red = redState.document.state.items.find((item) => item.id === id).checkBaseline;
  assert.deepEqual(red, { command: pending.command, main: pending.main, result: 'red', seconds: 1, request: pending.request });
  assert.equal(Object.hasOwn(red, 'warning'), false, 'a failing baseline has no proves-nothing warning');
  const cleared = await box.call(box.path + '/moves', { verb: 'edit', item: id, args: { check: '' } });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.document));
  const clearedState = await box.call(box.path + '/state');
  const clearedItem = clearedState.document.state.items.find((item) => item.id === id);
  assert.equal(clearedItem.check, '');
  assert.equal(Object.hasOwn(clearedItem, 'checkBaseline'), false, 'clearing the check removes its old observation from API state');
});

test('[A2,V2] HTTP add and edit preserve explicit blocking baseline requests', async (t) => {
  const box = await httpBox(t);
  /** Build a finite check whose completion can be observed independently of the HTTP response. */
  function completedCheck(marker) {
    const script = `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'finished')`;
    return `${shellWord(process.execPath)} -e ${shellWord(script)}`;
  }
  const firstMarker = join(box.dir, 'add-finished');
  const check = completedCheck(firstMarker);
  const added = await box.call(box.path + '/moves', { verb: 'add', args: {
    lane: 'app', title: 'Blocking API check', check, wait: true,
  } });
  assert.equal(added.status, 200, JSON.stringify(added.document));
  const item = added.document.result.item;
  assert.equal(item.item_check_baseline.result, 'green', '--wait returns a terminal observation in the add response');
  assert.equal(item.item_check_baseline.warning, 'CRITERION_PROVES_NOTHING');
  assert.equal(readFileSync(firstMarker, 'utf8'), 'finished');
  const addedState = await box.call(box.path + '/state');
  const projected = addedState.document.state.items.find((row) => row.id === item.item_id);
  assert.equal(projected.check, check);
  assert.deepEqual(projected.checkBaseline, item.item_check_baseline, 'board-state item JSON carries the same complete observation and warning');
  const secondMarker = join(box.dir, 'edit-finished');
  const editedCheck = completedCheck(secondMarker);
  const edited = await box.call(box.path + '/moves', { verb: 'edit', item: item.item_id, args: {
    check: editedCheck, wait: true,
  } });
  assert.equal(edited.status, 200, JSON.stringify(edited.document));
  assert.equal(edited.document.result.item.item_check_baseline.command, editedCheck);
  assert.equal(edited.document.result.item.item_check_baseline.result, 'green', '--wait also blocks edit until its new check finishes');
  assert.equal(readFileSync(secondMarker, 'utf8'), 'finished');
  const editedState = await box.call(box.path + '/state');
  const editedItem = edited.document.result.item;
  assert.deepEqual(editedState.document.state.items.find((row) => row.id === item.item_id).checkBaseline,
    editedItem.item_check_baseline, 'board-state JSON replaces the observation when the check changes');
});

test('[A2, H12, R2] requests and shouts append events and requests stay outside decisions', async (t) => {
  const box = await viewHttpBox(t);
  const requested = await box.call(box.path + '/requests', { text: 'Please approve the fixture row.' });
  assert.equal(requested.status, 200);
  assert.equal(requested.document.result.request, true);


  assert.equal(requested.document.event.event_kind, 'shout');
  const shout = await box.call(box.path + '/moves', { verb: 'shout', args: { to: 'app', text: 'new work' } });
  assert.equal(shout.document.event.event_kind, 'shout');
  const state = await box.call(box.path + '/state');
  assert.equal(state.document.state.requests.length, 1);
  assert.equal(state.document.state.decisions.length, 0);
  const premature = await box.call(box.path + '/moves', { verb: 'answer', item: requested.document.result.id, args: { text: 'I am working on it' } });
  assert.equal(premature.status, 409);
  assert.equal(premature.document.error.code, 'REQUEST_OUTCOME');
  assert.equal((await box.call(box.path + '/state')).document.state.requests.length, 1);
  const answer = await box.call(box.path + '/moves', { verb: 'answer', item: requested.document.result.id, args: { text: 'done checked and recorded' } });
  assert.equal(answer.status, 200);
  assert.equal(answer.document.event.event_kind, 'answer');
  assert.equal((await box.call(box.path + '/state')).document.state.requests.length, 0);
});

test('[A2] a live HTTP stream follows CLI writes and reconnects after Last-Event-ID', async (t) => {
  const box = await httpBox(t);
  const initial = await box.call(box.path + '/events');
  const after = initial.document.events.at(-1).event_id;
  const controller = new AbortController();
  const response = await fetchFresh(box.origin + box.path + '/events?after=' + after, { headers: { 'x-pullboard-key': box.key, accept: 'text/event-stream' }, signal: controller.signal });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  let buffered = '';
  /** Read a complete live event with a bounded timeout. */
  async function frame() {
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      while (!/\ndata: .+\n\n/.test(buffered)) {
        const { value, done } = await reader.read();
        assert.equal(done, false, 'stream stays open until its event arrives');
        buffered += new TextDecoder().decode(value);
      }
      const match = /id: (\d+)\ndata: (.+)\n\n/.exec(buffered);
      assert.ok(match);
      buffered = buffered.slice(match.index + match[0].length);
      return { id: Number(match[1]), document: JSON.parse(match[2]) };
    } finally { clearTimeout(timeout); }
  }
  const added = box.cli(box.root, 'add', 'app', 'Terminal event', '--criterion', 'done', '--specs', 'G1');
  const live = await frame();
  assert.equal(live.document.version, 1);
  assert.equal(live.document.event.event_kind, 'add');
  assert.equal(live.document.event.item_id, added.item.item_id);
  assert.equal(live.id, live.document.event.event_id);
  await reader.cancel();
  controller.abort();
  const replay = await fetchFresh(box.origin + box.path + '/events?after=0', { headers: { 'x-pullboard-key': box.key, 'last-event-id': String(live.id) } });
  assert.deepEqual((await replay.json()).events, []);
  const invalid = await box.call(box.path + '/events?after=1.5');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.document.error.code, 'BAD_CURSOR');
});

test('[A2, N26] the event stream says when the board changes without a move', async (t) => {
  const external = fixture(t);
  const externalConfigPath = join(external.root, 'pullboard.json');
  writeFileSync(externalConfigPath, JSON.stringify({ ...JSON.parse(readFileSync(externalConfigPath, 'utf8')), name: 'Roadmap fixture' }));
  runFixtureGit(['commit', '-q', '-m', 'chore: name the roadmap fixture', '--', 'pullboard.json'], { cwd: external.root, env: external.env, stdio: 'pipe' });
  const externalAdded = external.cli(external.root, 'add', 'app', 'Roadmap item', '--criterion', 'remain open', '--specs', 'G1');
  const externalAgent = external.cli(external.root, 'worktree', 'app', '--model', 'fixture-agent');
  const box = await httpBox(t, { additionalProjects: [{ root: external.root, name: 'Roadmap fixture' }] });
  // The roadmap resolves other repos through this machine's registry, as an export does.
  const priorHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
  t.after(() => { if (priorHome === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = priorHome; });
  registerProject(external.root);
  const boardListing = await box.call('/api/v1/boards');
  const externalId = boardListing.document.boards.find((entry) => resolve(entry.root) === resolve(external.root)).id;
  const configPath = join(box.root, 'pullboard.json');
  const specPath = join(box.root, 'SPEC.md');
  const doctrinePath = join(box.root, 'DOCTRINE.md');
  box.cli(box.root, 'milestone', 'add', 'External work', '--items', `Roadmap fixture#${externalAdded.item.item_id}`);
  box.cli(box.root, 'shout', 'all', 'mark this after the stream starts');
  const agent = box.cli(box.root, 'worktree', 'app', '--model', 'fixture-agent');
  const leaseItem = box.cli(box.root, 'add', 'app', 'Expiring stream claim', '--criterion', 'becomes open', '--specs', 'G1').item;
  const localClaim = await box.call(box.path + '/moves', { verb: 'claim', item: leaseItem.item_id, agent: agent.agent });
  assert.equal(localClaim.status, 200);
  const leaseUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const db = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try {
    db.db.prepare('UPDATE item SET item_lease_until = ? WHERE item_id = ?')
      .run(leaseUntil, leaseItem.item_id);
  } finally { store.closeBoard(db); }
  const initial = await box.call(box.path + '/events');
  const after = initial.document.events.at(-1).event_id;
  const controller = new AbortController();
  const response = await fetchFresh(box.origin + box.path + '/events?after=' + after, {
    headers: { 'x-pullboard-key': box.key, accept: 'text/event-stream' },
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  let buffered = '';
  let pendingFrame;
  let closing = false;
  let streamClosed = false;
  /** Stop the live response and settle any pending frame read on both pass and failure paths. */
  async function closeStream() {
    if (streamClosed) return;
    streamClosed = true;
    closing = true;
    controller.abort();
    await reader.cancel().catch(() => {});
    await pendingFrame?.catch(() => {});
  }
  t.after(closeStream);
  /** Read and parse the next complete server-sent-event frame. */
  async function readFrame() {
    while (true) {
      const boundary = buffered.indexOf('\n\n');
      if (boundary >= 0) {
        const raw = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        if (raw.startsWith(':')) continue;
        const event = /^event: (.+)$/m.exec(raw)?.[1] ?? 'message';
        const id = /^id: (\d+)$/m.exec(raw)?.[1];
        const data = /^data: (.+)$/m.exec(raw)?.[1];
        if (data !== undefined) return { event, id: id === undefined ? null : Number(id), data: JSON.parse(data) };
        continue;
      }
      const { value, done } = await reader.read();
      if (done && closing) return { event: 'closed', id: null, data: null };
      assert.equal(done, false, 'the live stream remains open while the board is served');
      buffered += new TextDecoder().decode(value);
    }
  }
  /** Share a pending frame read across timeouts so a quiet-period check cannot consume a later frame. */
  function nextFrame() {
    if (!pendingFrame) pendingFrame = readFrame().finally(() => { pendingFrame = null; });
    return pendingFrame;
  }
  /** Require an unchanged view to remain silent for longer than one server poll. */
  async function quietPeriod() {
    const extra = await Promise.race([nextFrame().then((value) => ({ value })), new Promise((resolve) => setTimeout(() => resolve(null), 350))]);
    assert.equal(extra, null, 'a quiet interval produces no duplicate or unrelated frame');
  }
  /** Require exactly one changed notification for the most recent input change. */
  async function changedOnce(label) {
    const frame = await Promise.race([
      nextFrame(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`changed event did not arrive within two seconds (${label})`)), 2000)), // budget: #554's criterion bounds a changed event at two seconds.
    ]);
    assert.equal(frame.event, 'changed');
    assert.equal(frame.id, null, 'a state notification does not advance the append-only event cursor');
    assert.deepEqual(frame.data, { version: 1, event: { event_kind: 'changed' } });
    await quietPeriod();
  }

  await quietPeriod();

  writeFileSync(specPath, readFileSync(specPath, 'utf8') + '\nThe served board follows this file.\n');
  await changedOnce('SPEC.md');

  writeFileSync(doctrinePath, '# Doctrine\n\nKeep the board honest.\n');
  await changedOnce('DOCTRINE.md');

  writeFileSync(configPath, JSON.stringify(JSON.parse(readFileSync(configPath, 'utf8')), null, 2) + '\n');
  await changedOnce('pullboard.json');

  // Committing the edited files moves HEAD alone: their bytes and stats are already seen.
  runFixtureGit(['commit', '-q', '-m', 'chore(test): move fixture head', '--', 'SPEC.md', 'DOCTRINE.md', 'pullboard.json'], { cwd: box.root, env: box.env, stdio: 'pipe' });
  await changedOnce('head');

  const externalClaim = await box.call('/api/v1/boards/' + externalId + '/moves', { verb: 'claim', item: externalAdded.item.item_id, agent: externalAgent.agent });
  assert.equal(externalClaim.status, 200);
  await changedOnce('external-claim');

  const unavailableRoot = external.root + '.temporarily-unavailable';
  renameSync(external.root, unavailableRoot);
  await changedOnce('external-unavailable');
  renameSync(unavailableRoot, external.root);
  await changedOnce('external-restored');

  const localBoardPath = join(box.root, '.git', 'pullboard', 'board.sqlite');
  const cursorBefore = store.openBoard(localBoardPath);
  let beforeSeen;
  let beforeEvent;
  try {
    beforeSeen = store.listAgents(cursorBefore).find((entry) => entry.agent_id === agent.agent).agent_last_shout_id;
    beforeEvent = cursorBefore.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id;
  } finally { store.closeBoard(cursorBefore); }
  box.cli(agent.path, 'inbox');
  const cursorAfter = store.openBoard(localBoardPath);
  try {
    const afterSeen = store.listAgents(cursorAfter).find((entry) => entry.agent_id === agent.agent).agent_last_shout_id;
    const afterEvent = cursorAfter.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id;
    assert.ok(afterSeen > beforeSeen, 'the joined agent inbox advances its shout cursor');
    assert.equal(afterEvent, beforeEvent, 'reading the inbox changes no append-only board event');
  } finally { store.closeBoard(cursorAfter); }
  await changedOnce('seen-cursor');

  const clockNow = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: clockNow });
  t.mock.timers.tick(Date.parse(leaseUntil) - clockNow + 1);
  await changedOnce('lease-expiry');

  const evented = box.cli(box.root, 'add', 'app', 'Event plus state notification', '--criterion', 'both frames arrive', '--specs', 'G1');
  const eventFrame = await nextFrame();
  assert.equal(eventFrame.event, 'message');
  assert.equal(eventFrame.data.event.event_kind, 'add');
  assert.equal(eventFrame.data.event.item_id, evented.item.item_id);
  await changedOnce('ordinary-event-state');

  await closeStream();
});

test('[A2] local auth, origin, unknown board and malformed calls refuse without moving', async (t) => {
  const box = await httpBox(t);
  const unauthenticated = await fetchFresh(box.origin + '/api/v1/boards');
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json()).error.code, 'AUTH_REQUIRED');
  const badSecret = await box.call('/api/v1/boards', undefined, { 'x-pullboard-key': 'incorrect-private-fixture-key' });
  assert.equal(badSecret.status, 401);
  const badOrigin = await box.call(box.path + '/requests', { text: 'blocked' }, { origin: 'https://different.invalid' });
  assert.equal(badOrigin.status, 403);
  const unknown = await box.call('/api/v1/boards/' + '0'.repeat(32) + '/state');
  assert.equal(unknown.status, 404);
  const unknownStream = await box.call('/api/v1/boards/' + '0'.repeat(32) + '/events', undefined, { accept: 'text/event-stream' });
  assert.equal(unknownStream.status, 404);
  const malformed = await fetchFresh(box.origin + box.path + '/moves', { method: 'POST', headers: { 'x-pullboard-key': box.key, 'content-type': 'application/json' }, body: '{broken' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'BAD_REQUEST');
  const unsupported = await box.call(box.path + '/moves', { verb: 'run', args: { agent: 'unsafe' } });
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.document.error.code, 'BAD_REQUEST');
  const state = await box.call(box.path + '/state');
  assert.deepEqual(state.document.state.items, []);
  assert.deepEqual(state.document.state.requests, []);
});

test('[A2] move text stays literal and invalid bodies cannot produce a partial event', async (t) => {
  const box = await httpBox(t);
  const literal = await box.call(box.path + '/moves', { verb: 'shout', args: { to: 'app', text: '--help' } });
  assert.equal(literal.status, 200);
  assert.equal(literal.document.event.event_kind, 'shout');
  const state = await box.call(box.path + '/state');
  assert.equal(state.document.state.shouts.at(-1).shout_text, '--help');
  const oversized = await box.call(box.path + '/requests', { text: 'x'.repeat(110_000) });
  assert.equal(oversized.status, 400);
  assert.equal(oversized.document.error.code, 'BAD_REQUEST');
  const wrongType = await box.call(box.path + '/requests', { text: 'refused' }, { 'content-type': 'text/plain' });
  assert.equal(wrongType.status, 400);
  const wrongHost = await new Promise((done, reject) => {
    const request = httpRequest(box.origin + '/api/v1/boards', { headers: { host: 'foreign.invalid', 'x-pullboard-key': box.key } }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => done({ status: response.statusCode, document: JSON.parse(text) }));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(wrongHost.status, 401);
  assert.equal(wrongHost.document.error.code, 'AUTH_REQUIRED');
  const after = await box.call(box.path + '/state');
  assert.deepEqual(after.document.state.events, state.document.state.events);
  assert.deepEqual(after.document.state.requests, []);
});

test('[A2] shared transport stops a live stream when its caller loses access', async (t) => {
  const box = fixture(t);
  const file = join(box.root, '.git', 'pullboard', 'board.sqlite');
  let authorized = true;
  let checks = 0;
  /** Read this fixture's real event records and always close its connection. */
  function records(after = 0) {
    const board = store.openBoard(file);
    try { return store.events(board).filter((event) => event.event_id > after); }
    finally { store.closeBoard(board); }
  }
  const board = store.openBoard(file);
  const id = store.boardId(board);
  store.closeBoard(board);
  const handler = createApiHandler({
    authenticate: () => {
      checks += 1;
      if (!authorized) throw new Refused('AUTH_REQUIRED', 'the fixture session was revoked; sign in again');
      return { user: 'fixture-user' };
    },
    board: () => ({ id }),
    events: (known, after) => records(after),
  }, { pollMs: 20 });
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { handler.close(); server.close(done); server.closeIdleConnections(); }));
  const controller = new AbortController();
  t.after(() => controller.abort());
  const timeout = setTimeout(() => controller.abort(), 10_000);
  t.after(() => clearTimeout(timeout));
  const response = await fetchFresh('http://127.0.0.1:' + server.address().port + '/api/v1/boards/' + id + '/events?after=' + records().at(-1).event_id, { headers: { accept: 'text/event-stream' }, signal: controller.signal });
  const reader = response.body.getReader();
  await reader.read();
  authorized = false;
  box.cli(box.root, 'add', 'app', 'Hidden after revocation', '--criterion', 'complete', '--specs', 'G1');
  let text = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  assert.match(text, /event: error/);
  assert.match(text, /"version":1/);
  assert.match(text, /"code":"AUTH_REQUIRED"/);
  assert.doesNotMatch(text, /"event_kind":"add"/);
  assert.ok(checks >= 3, 'access is checked at entry and on live polls');
});

test('[A2] adapters without a committed-code capability return a versioned refusal', async (t) => {
  const handler = createApiHandler({
    authenticate: () => ({ user: 'fixture-user' }),
    boards: () => [],
    board: (id) => ({ id }),
    state: () => ({}),
    events: () => [],
  });
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { handler.close(); server.close(done); }));
  const id = 'fixture-board';
  const response = await fetchFresh('http://127.0.0.1:' + server.address().port + '/api/v1/boards/' + id + '/code?ref=secret.txt%3A1%40abcdef0');
  const document = await response.json();
  assert.equal(response.status, 400);
  assert.equal(document.version, 1);
  assert.equal(document.error.code, 'CODE_NOT_AVAILABLE');
  assert.match(document.error.next, /local view|local API/);
});

test('[A2, N26] state JSON fragments preserve the API envelope and legacy adapter fallback', async (t) => {
  const state = { board: 'fixture', label: 'a ",\\"injected\\":true', unseen: null };
  const handler = createApiHandler({
    authenticate: () => ({ user: 'fixture-user' }),
    board: (id) => ({ id }),
    stateJson: (_board, _who, seen) => seen === 1 ? state : JSON.stringify(state),
    eventLogVersion: () => 'v1',
  });
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { handler.close(); server.close(done); server.closeIdleConnections(); }));
  const response = await fetchFresh('http://127.0.0.1:' + server.address().port + '/api/v1/boards/fixture/state');
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(text), { version: 1, state, eventLogVersion: 'v1' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('etag'), null);
  const invalidSerializer = await fetchFresh('http://127.0.0.1:' + server.address().port + '/api/v1/boards/fixture/state?seen=1');
  assert.equal(invalidSerializer.status, 500);
  assert.equal((await invalidSerializer.json()).error.code, 'SERVICE_ERROR');

  const legacy = createApiHandler({
    authenticate: () => ({ user: 'fixture-user' }),
    board: (id) => ({ id }),
    state: () => state,
  });
  const legacyServer = createServer(legacy);
  await new Promise((done) => legacyServer.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { legacy.close(); legacyServer.close(done); legacyServer.closeIdleConnections(); }));
  const legacyResponse = await fetchFresh('http://127.0.0.1:' + legacyServer.address().port + '/api/v1/boards/fixture/state');
  assert.deepEqual(await legacyResponse.json(), { version: 1, state });
  assert.equal(legacyResponse.headers.get('cache-control'), 'no-store');
  assert.equal(legacyResponse.headers.get('etag'), null);
});


test("an agent-shell serve cannot record a person's move [P6,B26]", { timeout: 60_000 }, // budget: hang ceiling for private CLI/API startup and person-channel checks, not a throughput claim.
async (t) => {
  const box = fixture(t);
  const spec = join(box.root, 'SPEC.md');
  writeFileSync(spec, readFileSync(spec, 'utf8') + '\n- G2 [pending, must] Person approval only. | gate: true\n- G3 [pending, must] Person decline only. | gate: true\n');
  runFixtureGit(['add', 'SPEC.md'], { cwd: box.root, env: box.env });
  runFixtureGit(['commit', '-qm', 'chore(test): prepare person-only rows'], { cwd: box.root, env: box.env });
  const item = box.cli(box.root, 'add', 'app', 'Private channel item', '--specs', 'G1', '--criterion', 'No person bypass').item.item_id;
  const decision = box.cli(box.root, 'shout', 'person', 'Choose the private fixture decision', '--decision').id;
  const child = startFixtureChild(process.execPath, [BIN, 'serve', '--port', '0', '--json'], {
    cwd: box.root, env: { ...box.env, CLAUDECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise(resolveClosed => child.once('close', resolveClosed));
  let stopped = false;
  /** Stop only the private server and await its terminal close before deleting its fixture. */
  async function stopServer() {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    let timer;
    try {
      const ended = await Promise.race([closed.then(() => true), new Promise(resolveWait => { timer = setTimeout(() => resolveWait(false), 2000); })]);
      if (!ended) { child.kill('SIGKILL'); await closed; }
    } finally { clearTimeout(timer); }
  }
  t.after(stopServer);
  const served = await new Promise((resolveAddress, rejectAddress) => {
    let output = '';
    const timer = setTimeout(() => rejectAddress(new Error('private agent serve did not announce its address')), 20_000);
    child.once('exit', () => { clearTimeout(timer); rejectAddress(new Error('private agent serve exited before its address')); });
    child.stdout.on('data', chunk => {
      output += chunk;
      try {
        const document = JSON.parse(output);
        if (typeof document.url === 'string') { clearTimeout(timer); resolveAddress(new URL(document.url)); }
      } catch { /* Wait for the complete private JSON announcement, never print its key. */ }
    });
  });
  const headers = { 'x-pullboard-key': served.searchParams.get('k'), 'content-type': 'application/json' };
  const listing = await (await fetchFresh(served.origin + '/api/v1/boards', { headers })).json();
  const id = listing.boards.find(board => resolve(board.root) === resolve(box.root)).id;
  const path = '/api/v1/boards/' + id;
  const before = box.cli(box.root, 'log').events.length;
  const attempts = [
    { verb: 'spec-approve', args: { ids: 'G2' } },
    { verb: 'spec-decline', args: { ids: 'G3', reason: 'Not approved by a person' } },
    { verb: 'answer', item: decision, args: { text: 'Forged person answer', as: 'person' } },
    { verb: 'verify', item, args: { decision: 'accept', as: 'person', note: 'Forged person verification' } },
    { verb: 'next', args: { as: 'person' } },
  ];
  for (const move of attempts) {
    const response = await fetchFresh(served.origin + path + '/moves', { method: 'POST', headers, body: JSON.stringify(move) });
    const document = await response.json();
    assert.equal(document.error?.code, 'B26_PERSON_CHANNEL', move.verb + ' never receives person authority from an API key');
    assert.notEqual(response.status, 200);
    assert.equal(box.cli(box.root, 'log').events.length, before, move.verb + ' records no event');
  }
  const tokenResponse = await fetchFresh(served.origin + path + '/tokens', { method: 'POST', headers, body: JSON.stringify({ id: randomUUID() }) });
  assert.equal((await tokenResponse.json()).error?.code, 'B26_PERSON_CHANNEL', 'API token management has no person authority either');
  assert.equal(box.cli(box.root, 'log').events.length, before);
  await stopServer();
  // Denial belongs to the interface, even when the server has no agent-shell marker.
  const plain = await serveApi({ port: 0, runCommand: main, projects: () => [{ root: box.root, name: 'Plain API fixture' }] });
  t.after(() => plain.close());
  const plainAddress = new URL(plain.url);
  const plainReply = await fetchFresh(plainAddress.origin + path + '/moves', {
    method: 'POST', headers: { 'x-pullboard-key': plainAddress.searchParams.get('k'), 'content-type': 'application/json' },
    body: JSON.stringify({ verb: 'spec-approve', args: { ids: 'G2' } }),
  });
  assert.equal((await plainReply.json()).error?.code, 'B26_PERSON_CHANNEL', 'an ordinary-shell API has no person authority');
  assert.equal(box.cli(box.root, 'log').events.length, before);
  registerProject(box.root);
  const view = await serveView({ port: 0 });
  t.after(() => view.close());
  const viewAddress = new URL(view.url);
  const response = await fetchFresh(viewAddress.origin + path + '/moves', {
    method: 'POST', headers: { 'x-pullboard-key': viewAddress.searchParams.get('k'), 'content-type': 'application/json' },
    body: JSON.stringify({ verb: 'spec-approve', args: { ids: 'G2' } }),
  });
  assert.equal(response.status, 200, 'the actual view keeps the person channel');
  const approved = (await response.json()).event;
  assert.equal(approved.event_by, 'person');
  assert.equal(box.cli(box.root, 'log').events.length, before + 1);
});

test("a request through serve is never the person's [P6,B26,A2]", { timeout: 60_000 }, // budget: private CLI/API startup and request-channel checks, not a throughput claim.
async (t) => {
  const box = fixture(t);
  const child = startFixtureChild(process.execPath, [BIN, 'serve', '--port', '0', '--json'], {
    cwd: box.root, env: { ...box.env, CLAUDECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise(resolveClosed => child.once('close', resolveClosed));
  let stopped = false;
  /** Stop only the private server and await its terminal close before deleting its fixture. */
  async function stopServer() {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    let timer;
    try {
      const ended = await Promise.race([closed.then(() => true), new Promise(resolveWait => { timer = setTimeout(() => resolveWait(false), 2000); })]); // budget: owned fixture server TERM grace before its bounded KILL fallback.
      if (!ended) { child.kill('SIGKILL'); await closed; }
    } finally { clearTimeout(timer); }
  }
  t.after(stopServer);
  const served = await new Promise((resolveAddress, rejectAddress) => {
    let output = '';
    const timer = setTimeout(() => rejectAddress(new Error('private agent serve did not announce its address')), 20_000); // budget: private CLI address startup ceiling.
    child.once('exit', () => { clearTimeout(timer); rejectAddress(new Error('private agent serve exited before its address')); });
    child.stdout.on('data', chunk => {
      output += chunk;
      try {
        const document = JSON.parse(output);
        if (typeof document.url === 'string') { clearTimeout(timer); resolveAddress(new URL(document.url)); }
      } catch { /* Wait for the complete private JSON announcement, never print its key. */ }
    });
  });
  const headers = { 'x-pullboard-key': served.searchParams.get('k'), 'content-type': 'application/json' };
  const listing = await (await fetchFresh(served.origin + '/api/v1/boards', { headers })).json();
  const id = listing.boards.find(board => resolve(board.root) === resolve(box.root)).id;
  const path = '/api/v1/boards/' + id;
  const before = box.cli(box.root, 'log').events.length;
  const refused = await fetchFresh(served.origin + path + '/requests', {
    method: 'POST', headers, body: JSON.stringify({ text: 'Please review this private fixture.' }),
  });
  assert.equal((await refused.json()).error?.code, 'B26_PERSON_CHANNEL');
  assert.notEqual(refused.status, 200);
  assert.equal(box.cli(box.root, 'log').events.length, before, 'a standalone serve request adds no event');
  await stopServer();
  const view = await viewHttpBox(t, box);
  const requested = await view.call(view.path + '/requests', { text: 'Please review this from the actual view.' });
  assert.equal(requested.status, 200, "the actual view keeps the person's request channel");
  assert.equal(requested.document.event.event_by, 'person');
  assert.equal(box.cli(box.root, 'log').events.length, before + 1);
});
