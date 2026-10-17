/** Two-home hosted journey through the real view, relay, browser client and item API [N40]. */
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createRelayBrowserHandler } from '../relay/browser-page.js';
import { relayClientFixture } from './relay-client-fixture.js';
import { relayWorkBudgetMs, findChromeExecutable } from './relay-browser-fixture.js';
import { startFixtureChild } from './fixture-child.js';
import { machine, project, startView, fetchLive, openSnapshotChrome, closeSnapshotChrome, press, pickProject } from './cockpit/fixture.js';

const JOURNEY_HOSTED = 'https://app.pullboard.dev';
const JOURNEY_LOCAL = 'http://127.0.0.1:4890';
const JOURNEY_BOARD_NAMES = ['fixture/repository', 'local-machine-b'];
const CLI = resolve(import.meta.dirname, '../bin/pullboard.js');

/** Wait for an owned fixture state transition without sleeping for a guessed duration. */
async function waitFor(read, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = read();
    if (value) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  } while (Date.now() < deadline);
  assert.fail(message);
}

/** Keep the real foreground --all child available for its actual phone-enrollment handoff. */
function startRelayAll(box) {
  const child = startFixtureChild(process.execPath, [CLI, 'relay', 'on', '--all', '--url', box.origin, '--json'], {
    cwd: box.root, env: box.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
  const done = new Promise((resolveDone, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      let document;
      try { document = JSON.parse(stdout); }
      catch { return reject(new Error(`relay on --all ended without JSON (status ${code}, signal ${signal ?? 'none'})`)); }
      resolveDone({ code, signal, document });
    });
  });
  void done.catch(() => {});
  return { child, done };
}

/** Ask the owned foreground setup to stop, then bound cleanup before its hard-stop fallback. */
async function stopRelayAll(run) {
  if (!run) return;
  if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGINT');
  let timer;
  const closed = await Promise.race([
    run.done.then(() => true, () => true),
    new Promise(resolveWait => { timer = setTimeout(() => resolveWait(false), 1_000); }),
  ]);
  clearTimeout(timer);
  if (!closed && run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL');
  await run.done.catch(() => {});
}

/** Normalize only resource identifiers in API paths before retaining bounded fixture diagnostics. */
function journeyApiPathKind(pathname) {
  const names = new Set(['api', 'v1', 'boards', 'state', 'events', 'moves', 'items', 'shouts', 'answers', 'devices', 'session', 'enrollments', 'approvals', 'requests', 'keys']);
  return pathname.split('/').map(part => !part || names.has(part) ? part : ':id').join('/');
}

/** Keep only the two fixture board names this journey owns; never report arbitrary client names. */
function journeyFixtureBoardNames(names) {
  const allowed = new Set(JOURNEY_BOARD_NAMES);
  return [...new Set((Array.isArray(names) ? names : []).filter(name => allowed.has(name)))].sort();
}

/** Keep rendered text only for the two boards this owned fixture created. */
function journeyFixtureRows(rows) {
  return [...new Set((Array.isArray(rows) ? rows : []).filter(row => row && JOURNEY_BOARD_NAMES.includes(row.label)
    && typeof row.text === 'string').map(row => row.text))].slice(0, 16);
}

/** Share the real hosted sidebar's all-expected-rows condition with its bounded failure regression. */
function journeySidebarReady(rows, expected = JOURNEY_BOARD_NAMES) {
  return expected.every(name => rows.some(row => row.includes(name)));
}

/** Select only a completed, successfully captured list answer that actually contains this fixture board. */
function journeyExpectedListAnswer(answers, source, boardName) {
  return answers.find(answer => answer?.source === source && answer.pathKind === '/api/v1/boards'
    && answer.status === 200 && answer.bodyCapture === 'captured' && answer.boardNames.includes(boardName)
    && Number.isFinite(answer.requestAtMs) && Number.isFinite(answer.responseAtMs) && Number.isFinite(answer.completedAtMs)
    && answer.responseAtMs >= answer.requestAtMs && answer.completedAtMs >= answer.responseAtMs) || null;
}

/** Bound a failure-only browser snapshot so a closed browser cannot extend the original row wait materially. */
async function boundedJourneyRead(read, budgetMs = 500) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), budgetMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Capture only safe page-visible facts after the hosted journey's real row wait fails. */
async function journeyFailureReport(readPage, readAnswers) {
  let page = null;
  let pageCaptureAvailable = false;
  try {
    const captured = JSON.parse(await readPage());
    if (captured && typeof captured === 'object') { page = captured; pageCaptureAvailable = true; }
  } catch { /* The original row failure remains the useful error. */ }
  let answers = [];
  let apiCaptureAvailable = false;
  try {
    const captured = await readAnswers();
    if (Array.isArray(captured)) { answers = captured; apiCaptureAvailable = true; }
  } catch { /* Missing observations never replace the row failure. */ }
  const projects = Array.isArray(page?.projects) ? page.projects : [];
  return {
    pageCaptureAvailable,
    apiCaptureAvailable,
    rows: pageCaptureAvailable ? journeyFixtureRows(page?.rows) : [],
    unknownRowsPresent: pageCaptureAvailable ? Boolean(page?.unknownRowsPresent) : null,
    projects: pageCaptureAvailable ? projects.filter(project => JOURNEY_BOARD_NAMES.includes(project?.name)).map(({ name, source, ok, errorPresent }) => ({
      name, source: source === 'relay' ? 'relay' : source === 'local' ? 'local' : 'other',
      ok: Boolean(ok), errorPresent: Boolean(errorPresent),
    })) : null,
    unknownProjectsPresent: pageCaptureAvailable ? Boolean(page?.unknownProjectsPresent) : null,
    pageFacts: {
      localSessionPresent: pageCaptureAvailable ? Boolean(page?.localSessionPresent) : null,
      localReadPresent: pageCaptureAvailable ? Boolean(page?.localReadPresent) : null,
      localOriginIsFixture: pageCaptureAvailable ? Boolean(page?.localOriginIsFixture) : null,
      transportPresent: pageCaptureAvailable ? Boolean(page?.transportPresent) : null,
      transportLoading: pageCaptureAvailable ? Boolean(page?.transportLoading) : null,
      transportLoadErrorPresent: pageCaptureAvailable ? Boolean(page?.transportLoadErrorPresent) : null,
      relaySessionPresent: pageCaptureAvailable ? Boolean(page?.relaySessionPresent) : null,
      localNoteState: !pageCaptureAvailable ? null : ['problem', 'blocked', 'asking', 'not-running', 'mismatch', 'local-failed', 'linked-failed', 'unpaired', 'no-linked', 'signed-out'].includes(page?.localNoteState)
        ? page.localNoteState : '',
      atHostedRoot: pageCaptureAvailable ? Boolean(page?.atHostedRoot) : null,
      pairedFragmentPresent: pageCaptureAvailable ? Boolean(page?.pairedFragmentPresent) : null,
    },
    apiAnswers: apiCaptureAvailable ? answers.slice(0, 128).map(answer => ({
      source: answer?.source === 'linked' ? 'linked' : 'local',
      pathKind: typeof answer?.pathKind === 'string'
        ? journeyApiPathKind(answer.pathKind.split(/[?#]/u, 1)[0]).replace(/\/$/u, '') || '/' : 'unknown',
      status: Number.isInteger(answer?.status) && answer.status >= 100 && answer.status <= 599 ? answer.status : null,
      boardNames: journeyFixtureBoardNames(answer?.boardNames),
      bodyCapture: ['pending', 'captured', 'unavailable', 'invalid'].includes(answer?.bodyCapture) ? answer.bodyCapture : null,
      requestAtMs: Number.isFinite(answer?.requestAtMs) && answer.requestAtMs >= 0 ? Math.round(answer.requestAtMs) : null,
      responseAtMs: Number.isFinite(answer?.responseAtMs) && answer.responseAtMs >= 0 ? Math.round(answer.responseAtMs) : null,
      completedAtMs: Number.isFinite(answer?.completedAtMs) && answer.completedAtMs >= 0 ? Math.round(answer.completedAtMs) : null,
      streamOpen: Boolean(answer?.streamOpen),
    })) : null,
  };
}

/** Share the real row wait and failure reporter with a bounded regression fixture. */
async function observeJourneyRows(wait, readPage, readAnswers) {
  try {
    await wait();
    return { ready: true };
  } catch (error) {
    let report = { pageCaptureAvailable: false, apiCaptureAvailable: false };
    try { report = await journeyFailureReport(readPage, readAnswers); } catch { /* Keep the original row failure if reporting itself fails. */ }
    return { ready: false, error, report };
  }
}

test('the hosted journey names what it saw when a board row never arrives [N40]', async () => {
  const seen = {
    rows: [
      { label: 'fixture/repository', text: 'fixture/repository · linked · 1 item' },
      { label: 'unlisted-board-sentinel', text: 'unlisted-board-sentinel · local · 1 item' },
    ],
    unknownRowsPresent: true,
    projects: [
      { name: 'fixture/repository', source: 'relay', ok: true, errorPresent: false },
      { name: 'local-machine-b', source: 'local', ok: true, errorPresent: false },
      { name: 'unlisted-board-sentinel', source: 'local', ok: false, errorPresent: true },
    ],
    unknownProjectsPresent: true,
    localSessionPresent: true,
    localReadPresent: true,
    localOriginIsFixture: true,
    transportPresent: true,
    transportLoading: false,
    transportLoadErrorPresent: false,
    relaySessionPresent: true,
    localNoteState: '',
    atHostedRoot: true,
    pairedFragmentPresent: false,
  };
  const pageAnswers = [
    { source: 'linked', pathKind: '/api/v1/boards', status: 200, boardNames: [], bodyCapture: 'captured', requestAtMs: 0, responseAtMs: 4, completedAtMs: 5 },
    { source: 'linked', pathKind: '/api/v1/boards', status: 200, boardNames: [], bodyCapture: 'unavailable', requestAtMs: 1, responseAtMs: 6, completedAtMs: 7 },
    { source: 'linked', pathKind: '/api/v1/boards', status: 200, boardNames: ['fixture/repository'], bodyCapture: 'captured', requestAtMs: 8, responseAtMs: 18, completedAtMs: 19 },
    { source: 'local', pathKind: '/api/v1/boards', status: 200, boardNames: ['local-machine-b'], bodyCapture: 'captured', requestAtMs: 2, responseAtMs: 7, completedAtMs: 8 },
    { source: 'linked', pathKind: '/api/v1/boards/opaque-id/events?query=query-sentinel#fragment-sentinel', status: 200, boardNames: ['fixture/repository'], bodyCapture: null, requestAtMs: 3, responseAtMs: 21, completedAtMs: null, streamOpen: true,
      headers: { authorization: 'header-sentinel' }, body: 'body-sentinel' },
  ];
  const observed = await observeJourneyRows(
    () => waitFor(() => journeySidebarReady(['fixture/repository']), 'Browser condition did not arrive', 25),
    async () => JSON.stringify(seen),
    async () => pageAnswers,
  );
  assert.equal(observed.ready, false);
  assert.equal(observed.error.message, 'Browser condition did not arrive', 'diagnostics retain the original bounded row-wait failure');
  assert.equal(observed.report.pageCaptureAvailable, true);
  assert.equal(observed.report.apiCaptureAvailable, true);
  assert.ok(observed.report, 'a failed row wait reports its visible rows and page-used API answers');
  assert.deepEqual(observed.report.rows, ['fixture/repository · linked · 1 item'], 'actual rendered text for the owned fixture row is preserved');
  assert.equal(observed.report.unknownRowsPresent, true);
  assert.deepEqual(observed.report.apiAnswers.map(({ source, pathKind, status, boardNames, bodyCapture, responseAtMs, streamOpen }) => ({ source, pathKind, status, boardNames, bodyCapture, responseAtMs, streamOpen })), [
    { source: 'linked', pathKind: '/api/v1/boards', status: 200, boardNames: [], bodyCapture: 'captured', responseAtMs: 4, streamOpen: false },
    { source: 'linked', pathKind: '/api/v1/boards', status: 200, boardNames: [], bodyCapture: 'unavailable', responseAtMs: 6, streamOpen: false },
    { source: 'linked', pathKind: '/api/v1/boards', status: 200, boardNames: ['fixture/repository'], bodyCapture: 'captured', responseAtMs: 18, streamOpen: false },
    { source: 'local', pathKind: '/api/v1/boards', status: 200, boardNames: ['local-machine-b'], bodyCapture: 'captured', responseAtMs: 7, streamOpen: false },
    { source: 'linked', pathKind: '/api/v1/boards/:id/events', status: 200, boardNames: ['fixture/repository'], bodyCapture: null, responseAtMs: 21, streamOpen: true },
  ]);
  assert.equal(journeyExpectedListAnswer(observed.report.apiAnswers, 'linked', 'fixture/repository')?.responseAtMs, 18,
    'a captured populated answer is selected after earlier empty and unavailable answers');
  assert.equal(journeyExpectedListAnswer(observed.report.apiAnswers.slice(0, 2), 'linked', 'fixture/repository'), null,
    'captured empty and unavailable answers never masquerade as the expected fixture response');
  assert.doesNotMatch(JSON.stringify(observed.report), /unlisted-board-sentinel|query-sentinel|fragment-sentinel|header-sentinel|body-sentinel/u, 'diagnostics never expose arbitrary row names, URL parts, headers or bodies');

  let pageRead = false;
  let answersRead = false;
  const passing = await observeJourneyRows(
    async () => true,
    async () => { pageRead = true; return ''; },
    async () => { answersRead = true; return []; },
  );
  assert.equal(passing.ready, true);
  assert.equal(pageRead || answersRead, false, 'a passing journey emits no additional diagnostic reads');

  const originalError = new Error('original row wait failure');
  const unavailable = await observeJourneyRows(
    async () => { throw originalError; },
    async () => { throw new Error('page capture unavailable'); },
    async () => { throw new Error('API trace unavailable'); },
  );
  assert.equal(unavailable.error, originalError, 'capture failure never replaces the original row wait error');
  assert.equal(unavailable.report.pageCaptureAvailable, false);
  assert.equal(unavailable.report.apiCaptureAvailable, false);
  assert.equal(unavailable.report.unknownRowsPresent, null, 'unavailable page facts are not presented as observed false values');
  assert.equal(unavailable.report.apiAnswers, null, 'unavailable trace data is not presented as an empty observed trace');
});

/** Capture page-used API answers and response arrival times without retaining identifiers or waiting for streams. */
function journeyPageAnswers(chrome, viewBase) {
  const answers = [];
  const pending = new Map();
  const boardIds = new Map();
  const snapshotWaiters = new Set();
  let generation = 0;
  let windowStartedAt = performance.now();
  let active = false;
  const clock = () => Math.max(0, performance.now() - windowStartedAt);
  const authority = origin => origin === JOURNEY_HOSTED ? 'linked'
    : origin === JOURNEY_LOCAL || origin === viewBase ? 'local' : null;
  const listBoardNames = (body, source) => {
    try {
      const value = JSON.parse(body);
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || (!Array.isArray(value.boards) && !Array.isArray(value.warnings))) return { bodyCapture: 'invalid', boardNames: [] };
      const boards = [...(Array.isArray(value?.boards) ? value.boards : []), ...(Array.isArray(value?.warnings) ? value.warnings : [])];
      const names = [];
      for (const board of boards) {
        const name = typeof board?.name === 'string' ? board.name : board?.repository;
        if (typeof board?.id !== 'string' || typeof name !== 'string') continue;
        boardIds.set(`${source}\0${board.id}`, name);
        if (JOURNEY_BOARD_NAMES.includes(name)) names.push(name);
      }
      return { bodyCapture: 'captured', boardNames: journeyFixtureBoardNames(names) };
    } catch { return { bodyCapture: 'invalid', boardNames: [] }; }
  };
  const hasPendingFiniteListBody = () => answers.some(answer => answer.pathKind === '/api/v1/boards' && answer.bodyCapture === 'pending')
    || [...pending.values()].some(entry => entry.pathKind === '/api/v1/boards');
  const notifySnapshotWaiters = () => { for (const wake of [...snapshotWaiters]) wake(); };
  const listener = ({ data }) => {
    let message;
    try { message = JSON.parse(String(data)); } catch { return; }
    if (!active) return;
    if (message.method === 'Network.requestWillBeSent') {
      const request = message.params.request;
      if (request.method !== 'GET') return;
      let address;
      try { address = new URL(request.url); } catch { return; }
      const source = authority(address.origin);
      if (!source || !address.pathname.startsWith('/api/')) return;
      if (pending.size >= 128) return;
      const segments = address.pathname.split('/').filter(Boolean);
      let boardId = null;
      try { if (segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'boards' && segments[3]) boardId = decodeURIComponent(segments[3]); }
      catch { boardId = null; }
      pending.set(message.params.requestId, {
        generation,
        source,
        pathKind: journeyApiPathKind(address.pathname),
        boardId,
        requestAtMs: clock(),
        record: null,
      });
      return;
    }
    if (message.method === 'Network.responseReceived') {
      const entry = pending.get(message.params.requestId);
      if (!entry || entry.generation !== generation || entry.record) return;
      const streamOpen = entry.pathKind.endsWith('/events');
      entry.record = {
        source: entry.source, pathKind: entry.pathKind,
        status: Number.isInteger(message.params.response.status) ? message.params.response.status : null,
        boardId: entry.boardId,
        boardNames: entry.boardId
          ? journeyFixtureBoardNames([boardIds.get(`${entry.source}\0${entry.boardId}`)]) : [],
        bodyCapture: entry.pathKind === '/api/v1/boards' ? 'pending' : null,
        requestAtMs: entry.requestAtMs, responseAtMs: clock(), completedAtMs: null, streamOpen,
      };
      if (answers.length < 128) answers.push(entry.record);
      return;
    }
    if (message.method === 'Network.loadingFinished') {
      const entry = pending.get(message.params.requestId);
      if (!entry || entry.generation !== generation) return;
      pending.delete(message.params.requestId);
      if (!entry.record) return;
      entry.record.completedAtMs = clock();
      entry.record.streamOpen = false;
      if (entry.pathKind !== '/api/v1/boards') { notifySnapshotWaiters(); return; }
      void chrome.send('Network.getResponseBody', { requestId: message.params.requestId }).then(result => {
        if (entry.generation !== generation) return;
        const body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
        Object.assign(entry.record, listBoardNames(body, entry.source));
      }).catch(() => {
        if (entry.generation === generation) entry.record.bodyCapture = 'unavailable';
      }).finally(() => notifySnapshotWaiters());
      return;
    }
    if (message.method === 'Network.loadingFailed') {
      const entry = pending.get(message.params.requestId);
      if (!entry || entry.generation !== generation) return;
      pending.delete(message.params.requestId);
      if (entry.record) {
        entry.record.completedAtMs = clock();
        entry.record.streamOpen = false;
        if (entry.pathKind === '/api/v1/boards') entry.record.bodyCapture = 'unavailable';
      }
      if (!entry.record && answers.length < 128) answers.push({ source: entry.source, pathKind: entry.pathKind, status: null,
        boardNames: entry.boardId ? journeyFixtureBoardNames([boardIds.get(`${entry.source}\0${entry.boardId}`)]) : [],
        bodyCapture: entry.pathKind === '/api/v1/boards' ? 'unavailable' : null,
        requestAtMs: entry.requestAtMs, responseAtMs: null, completedAtMs: clock(), streamOpen: false });
      notifySnapshotWaiters();
    }
  };
  chrome.socket.addEventListener('message', listener);
  return {
    begin() {
      generation += 1;
      pending.clear(); answers.length = 0; boardIds.clear();
      notifySnapshotWaiters();
      windowStartedAt = performance.now(); active = true;
    },
    async snapshot() {
      if (hasPendingFiniteListBody()) {
        let wake;
        let timer;
        const drained = new Promise(resolveWait => {
          wake = () => { if (!hasPendingFiniteListBody()) resolveWait(); };
          snapshotWaiters.add(wake);
          wake();
        });
        try { await Promise.race([drained, new Promise(resolveWait => { timer = setTimeout(resolveWait, 250); })]); }
        finally { clearTimeout(timer); snapshotWaiters.delete(wake); }
      }
      for (const answer of answers) {
        if (answer.pathKind !== '/api/v1/boards' && !answer.boardNames.length && answer.boardId) {
          answer.boardNames = journeyFixtureBoardNames([boardIds.get(`${answer.source}\0${answer.boardId}`)]);
        }
      }
      const unfinished = [...pending.values()].filter(entry => !entry.record).map(entry => ({ source: entry.source,
        pathKind: entry.pathKind, status: null,
        boardNames: entry.boardId ? journeyFixtureBoardNames([boardIds.get(`${entry.source}\0${entry.boardId}`)]) : [],
        bodyCapture: entry.pathKind === '/api/v1/boards' ? 'pending' : null,
        requestAtMs: entry.requestAtMs, responseAtMs: null, completedAtMs: null, streamOpen: false }));
      return [...answers, ...unfinished].map(({ source, pathKind, status, boardNames, bodyCapture, requestAtMs, responseAtMs, completedAtMs, streamOpen }) => ({
        source, pathKind, status, boardNames, bodyCapture, requestAtMs, responseAtMs, completedAtMs, streamOpen,
      })).sort((left, right) => (left.responseAtMs ?? left.requestAtMs) - (right.responseAtMs ?? right.requestAtMs));
    },
    close() { active = false; chrome.socket.removeEventListener('message', listener); },
  };
}

/** Serve the real relay shell and proxy every API byte, including long-lived event streams. */
async function journeyRelaySite(box, localOrigin) {
  const apiObservations = [];
  const browser = createRelayBrowserHandler({
    async authenticate(req) {
      const token = /(?:^|;\s*)pb_session=([^;]+)/u.exec(req.headers.cookie || '')?.[1];
      if (!token) return { kind: 'anonymous' };
      try { return await box.auth.authenticate(token); } catch { return { kind: 'anonymous' }; }
    },
  });
  const server = createServer((req, res) => {
    const address = new URL(req.url || '/', box.origin);
    const observation = address.pathname.startsWith('/api/') && apiObservations.length < 64
      ? { method: req.method, pathKind: journeyApiPathKind(address.pathname), personCookiePresent: /(?:^|;\s*)pb_session=[^;]+/u.test(req.headers.cookie || ''), statusOnFinish: null }
      : null;
    if (observation) {
      apiObservations.push(observation);
      res.once('finish', () => { observation.statusOnFinish = res.statusCode; });
    }
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = (status, headers, ...rest) => {
      if (headers && !Array.isArray(headers)) {
        const csp = Object.keys(headers).find((name) => name.toLowerCase() === 'content-security-policy');
        if (csp) headers[csp] = headers[csp].replace("connect-src 'self'", `connect-src 'self' ${localOrigin} http://localhost:4890`);
      }
      return originalWriteHead(status, headers, ...rest);
    };
    void (async () => {
      if (await browser(req, res)) return;
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': JOURNEY_HOSTED,
          'access-control-allow-credentials': 'true',
          'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'access-control-allow-headers': req.headers['access-control-request-headers'] || 'content-type',
          'access-control-allow-private-network': 'true',
          vary: 'Origin',
        });
        return res.end();
      }
      const headers = Object.fromEntries(Object.entries(req.headers)
        .filter(([name]) => !['host', 'connection', 'content-length'].includes(name.toLowerCase())));
      // The private upstream's configured public origin is the exact HTTPS origin in production.
      // Translate only that origin boundary; requests, cookies, payloads and streaming bytes stay real.
      headers.origin = box.origin;
      const upstream = request(new URL(req.url, box.origin), { method: req.method, headers, agent: false }, (reply) => {
        const responseHeaders = Object.fromEntries(Object.entries(reply.headers)
          .filter(([name]) => !['connection', 'transfer-encoding', 'keep-alive', 'access-control-allow-origin', 'access-control-allow-credentials'].includes(name.toLowerCase())));
        responseHeaders['access-control-allow-origin'] = JOURNEY_HOSTED;
        responseHeaders['access-control-allow-credentials'] = 'true';
        responseHeaders.vary = 'Origin';
        res.writeHead(reply.statusCode || 502, responseHeaders);
        reply.pipe(res);
      });
      res.once('close', () => upstream.destroy());
      upstream.once('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
    })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  return { server, base: 'http://127.0.0.1:' + server.address().port, apiObservations: () => apiObservations.map(value => ({ ...value })) };
}

/** Fulfill only the hosted document/assets; rewrite live API and local requests to owned HTTP servers. */
async function routeJourneyOrigins(chrome, site, view) {
  const failures = [];
  const tasks = [];
  const listener = ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.method !== 'Fetch.requestPaused') return;
    tasks.push((async () => {
      const { requestId, request: asked } = message.params;
      const address = new URL(asked.url);
      if (address.origin === JOURNEY_HOSTED && address.pathname.startsWith('/api/')) {
        const accept = Object.entries(asked.headers).find(([name]) => name.toLowerCase() === 'accept')?.[1] || '';
        const liveStream = address.pathname.endsWith('/events') || String(accept).includes('text/event-stream');
        if (liveStream) {
          const headers = Object.entries(asked.headers)
            .filter(([name]) => !['host', 'content-length'].includes(name.toLowerCase()))
            .map(([name, value]) => ({ name, value }));
          await chrome.send('Fetch.continueRequest', {
            requestId, url: site.base + address.pathname + address.search, headers,
          });
          return;
        }
        const headers = Object.fromEntries(Object.entries(asked.headers)
          .filter(([name]) => !['host', 'content-length'].includes(name.toLowerCase())));
        const response = await fetchLive(site.base + address.pathname + address.search, {
          method: asked.method, headers, redirect: 'manual',
          ...(asked.postData === undefined ? {} : { body: asked.postData }),
          signal: AbortSignal.timeout(10_000),
        });
        const body = Buffer.from(await response.arrayBuffer());
        await chrome.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: response.status,
          responseHeaders: [...response.headers]
            .filter(([name]) => !['content-length', 'connection', 'transfer-encoding', 'keep-alive', 'date'].includes(name.toLowerCase()))
            .map(([name, value]) => ({ name, value })),
          body: body.toString('base64'),
        });
        return;
      }
      if (address.origin === JOURNEY_LOCAL) {
        await chrome.send('Fetch.continueRequest', { requestId, url: view.base + address.pathname + address.search });
        return;
      }
      if (address.origin !== JOURNEY_HOSTED) throw new Error('unexpected fixture browser origin');
      const headers = Object.fromEntries(Object.entries(asked.headers)
        .filter(([name]) => !['host', 'content-length'].includes(name.toLowerCase())));
      const response = await fetchLive(site.base + address.pathname + address.search, {
        method: asked.method, headers, redirect: 'manual',
        ...(asked.postData === undefined ? {} : { body: asked.postData }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = Buffer.from(await response.arrayBuffer());
      await chrome.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: response.status,
        responseHeaders: [...response.headers]
          .filter(([name]) => !['content-length', 'connection', 'transfer-encoding', 'keep-alive', 'date'].includes(name.toLowerCase()))
          .map(([name, value]) => ({ name, value })),
        body: body.toString('base64'),
      });
    })().catch(async (error) => {
      failures.push(error.message);
      try { await chrome.send('Fetch.failRequest', { requestId: message.params.requestId, errorReason: 'Failed' }); } catch { /* Chrome may already have closed. */ }
    }));
  };
  chrome.socket.addEventListener('message', listener);
  await chrome.send('Fetch.enable', { patterns: [
    { urlPattern: JOURNEY_HOSTED + '/*', requestStage: 'Request' },
    { urlPattern: JOURNEY_LOCAL + '/*', requestStage: 'Request' },
  ] });
  return async () => {
    chrome.socket.removeEventListener('message', listener);
    await Promise.all(tasks);
    await chrome.send('Fetch.disable');
    assert.deepEqual(failures, [], 'owned hosted and loopback HTTP routes finish without cancelling event streams');
  };
}

test('pullboard.dev shows every board, linked and local [N40]', {
  timeout: relayWorkBudgetMs() * 5 + 180_000,
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async (t) => {
  const executable = findChromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME to run the two-home hosted journey.');

  const machineA = await relayClientFixture(t);
  // Keep current and #659 future machine-state lookup on one fixture-owned home path.
  machineA.env.PULLBOARD_MACHINE_HOME = machineA.env.PULLBOARD_HOME;
  const boardAId = machineA.before.tables.board_meta.find((row) => row.meta_key === 'board_id').meta_value;
  const titleA = 'linked machine A board';
  assert.equal((await machineA.cli('add', machineA.lane, titleA)).code, 0, 'A prepares a real item before its device link');

  const machineB = machine();
  machineB.env.HOME = machineB.env.PULLBOARD_HOME;
  machineB.env.PULLBOARD_MACHINE_HOME = machineB.env.PULLBOARD_HOME;
  mkdirSync(machineB.env.HOME, { recursive: true, mode: 0o700 });
  const projectB = project(machineB, 'local-machine-b');
  const linkBFile = join(projectB.repo, '.git/pullboard/relay.json');
  assert.equal(existsSync(linkBFile), false, 'B starts without a persisted relay link');
  const titlesB = Array.from({ length: 40 }, (_, index) => `local B item ${String(index + 1).padStart(2, '0')}`);
  for (const title of titlesB) machineB.run(projectB.repo, 'add', 'web', title);

  const profileA = join(machineA.root, 'journey-chrome-a');
  const profileB = join(machineB.dir, 'journey-chrome-b');
  let viewA;
  let viewB;
  let chromeA;
  let chromeB;
  let journeyTrace;
  let site;
  let stopRoutes;
  let setup;
  try {
    // A performs one real foreground CLI sign-in and leaves the command waiting at its actual phone enrollment.
    const machineFile = join(machineA.env.PULLBOARD_HOME, 'relay-machine/state.json');
    setup = startRelayAll(machineA);
    const enrollment = await waitFor(() => {
      if (setup.child.exitCode !== null || setup.child.signalCode !== null) return { exited: true };
      if (!existsSync(machineFile)) return null;
      const pending = JSON.parse(readFileSync(machineFile, 'utf8')).pending;
      return pending ? { pending } : null;
    }, 'A completes one sign-in and publishes a phone enrollment');
    if (enrollment.exited) {
      const result = await setup.done.catch(() => null);
      assert.fail(`relay on --all exited before phone enrollment (status ${result?.code ?? setup.child.exitCode ?? 'unknown'})`);
    }
    const waiting = await waitFor(() => {
      if (setup.child.exitCode !== null || setup.child.signalCode !== null) return { exited: true };
      return machineA.calls.some(call => call.method === 'GET' && call.path.startsWith('/api/v1/devices/enrollments/')) ? { waiting: true } : null;
    },
      'A is waiting for the actual phone enrollment after its single sign-in');
    if (waiting.exited) {
      const result = await setup.done.catch(() => null);
      assert.fail(`relay on --all exited before phone polling (status ${result?.code ?? setup.child.exitCode ?? 'unknown'})`);
    }
    const pending = enrollment.pending;
    assert.equal(machineA.calls.filter(call => call.method === 'POST' && call.path === '/auth/device/start').length, 1,
      'relay on --all starts exactly one fixture GitHub device flow');

    viewA = await startView({ dir: machineA.root, env: machineA.env });
    viewB = await startView(machineB);

    // A real foreground browser at the hosted relay completes the CLI's one-use device enrollment.
    site = await journeyRelaySite(machineA, viewB.base);
    chromeB = await openSnapshotChrome(executable, 'about:blank', profileB);
    journeyTrace = journeyPageAnswers(chromeB, viewB.base);
    stopRoutes = await routeJourneyOrigins(chromeB, site, viewB);
    const person = await machineA.phoneSession();
    assert.equal((await chromeB.send('Network.setCookie', {
      name: 'pb_session', value: person.token, url: JOURNEY_HOSTED, httpOnly: true, sameSite: 'Lax',
    })).success, true, 'the same fixture person signs in on B without exposing session data to the page');
    for (const permissions of [['loopbackNetwork', 'localNetwork', 'localNetworkAccess'], ['localNetworkAccess']]) {
      try { await chromeB.send('Browser.grantPermissions', { origin: JOURNEY_HOSTED, permissions }); break; }
      catch { /* Chrome versions expose different local-network permission names. */ }
    }
    await chromeB.send('Page.navigate', { url: JOURNEY_HOSTED + '/#device=' + pending.locator + '.' + pending.secret });
    try {
      await waitFor(() => setup.child.exitCode !== null || setup.child.signalCode !== null,
        'A completes the actual phone enrollment within its relay work allowance', relayWorkBudgetMs());
    } catch (error) {
      error.message += '; bounded fixture API observations: ' + JSON.stringify(site.apiObservations());
      throw error;
    }
    const linkedSetup = await setup.done;
    assert.equal(linkedSetup.code, 0, 'A completes the real relay on --all after phone pairing');
    assert.equal(linkedSetup.document.linked.length, 1, 'the one registered A board links through the CLI');
    assert.equal(linkedSetup.document.paired, true, 'the fixture phone completes the actual device enrollment');
    await chromeB.waitFor("location.hash === '' && document.querySelector('#chain')?.textContent.includes('linked machine A board')", 45_000); // budget: bounded setup wait within this journey test’s declared outer timeout (5x relay-work budget plus 180 seconds).
    await chromeB.send('Page.navigate', { url: 'about:blank' });
    journeyTrace.begin();
    await chromeB.send('Page.navigate', { url: JOURNEY_HOSTED + '/' });
    const rowPredicate = `(${journeySidebarReady.toString()})([...document.querySelectorAll('#proj-list .proj.repo .pname')].map(node => node.textContent.trim()), ${JSON.stringify(JOURNEY_BOARD_NAMES)})`;
    const rowObservation = await observeJourneyRows(
      () => chromeB.waitFor(rowPredicate, 45_000), // budget: bounded setup wait within this journey test’s declared outer timeout (5x relay-work budget plus 180 seconds).
      () => boundedJourneyRead(() => chromeB.stable(`JSON.stringify({
        rows: [...document.querySelectorAll('#proj-list .proj.repo')].map(row => ({ label: row.querySelector('.pname')?.textContent.trim() || '', text: row.textContent.trim() })),
        unknownRowsPresent: [...document.querySelectorAll('#proj-list .proj.repo .pname')].some(node => !${JSON.stringify(JOURNEY_BOARD_NAMES)}.includes(node.textContent.trim())),
        projects: (data?.projects || []).map(({name, source, ok, error}) => ({name, source, ok, errorPresent: Boolean(error)})),
        unknownProjectsPresent: (data?.projects || []).some(project => !${JSON.stringify(JOURNEY_BOARD_NAMES)}.includes(project.name)),
        localSessionPresent: Boolean(localSession), localReadPresent: Boolean(localReadBase),
        localOriginIsFixture: localSession?.origin === ${JSON.stringify(viewB.base)},
        transportPresent: Boolean(transport), transportLoading: Boolean(transportModule && !transport && !transportLoadError),
        transportLoadErrorPresent: Boolean(transportLoadError), relaySessionPresent: Boolean(hosted.relaySession),
        localNoteState: document.querySelector('#local-note')?.dataset.state || '',
        atHostedRoot: location.origin === ${JSON.stringify(JOURNEY_HOSTED)} && location.pathname === '/',
        pairedFragmentPresent: /(?:^|[&#])(?:device|pullboard-local|key)=/i.test(location.hash)
      })`)),
      () => journeyTrace.snapshot(),
    );
    if (!rowObservation.ready) {
      try { t.diagnostic(JSON.stringify(rowObservation.report)); } catch { /* The original row failure remains the test result. */ }
      throw rowObservation.error;
    }
    const pageAnswers = await journeyTrace.snapshot();
    try {
      for (const [source, boardName] of [['linked', 'fixture/repository'], ['local', 'local-machine-b']]) {
        const sourceAnswers = pageAnswers.filter(entry => entry.source === source && entry.pathKind === '/api/v1/boards');
        assert.ok(sourceAnswers.length > 0, `the page-used ${source} board-list answer was observed`);
        for (const answer of sourceAnswers) {
          assert.ok(answer.status === null || (Number.isInteger(answer.status) && answer.status >= 100 && answer.status <= 599),
            `the page-used ${source} answer has a valid status`);
          assert.ok(Number.isFinite(answer.requestAtMs) && answer.requestAtMs >= 0,
            `the page-used ${source} answer has a request time`);
          assert.ok(answer.responseAtMs === null || (Number.isFinite(answer.responseAtMs) && answer.responseAtMs >= answer.requestAtMs),
            `the page-used ${source} answer has a valid response time`);
          assert.ok(answer.completedAtMs === null || (Number.isFinite(answer.completedAtMs)
            && (answer.responseAtMs === null || answer.completedAtMs >= answer.responseAtMs)),
          `the page-used ${source} answer has a valid completion time`);
          assert.ok(['pending', 'captured', 'unavailable', 'invalid'].includes(answer.bodyCapture),
            `the page-used ${source} answer reports its body capture state`);
        }
        const answer = journeyExpectedListAnswer(sourceAnswers, source, boardName);
        assert.ok(answer, `a completed captured page-used ${source} answer names its fixture board`);
        assert.deepEqual(answer.boardNames, [boardName], `the page-used ${source} answer names its fixture board`);
      }
    } catch (error) {
      try { t.diagnostic(JSON.stringify({ pageAnswers })); } catch { /* Keep the original assertion failure. */ }
      throw error;
    }
    const localOrigin = await chromeB.stable('localSession?.origin || null');
    assert.ok(localOrigin === viewB.base, 'B discovers its own real view without a typed key, URL, tunnel or port');
    const shown = JSON.parse(await chromeB.stable(`JSON.stringify({ labels: [...document.querySelectorAll('#proj-list .proj.repo .pname')].map(node => node.textContent).sort(), secretInAddress: /key=|pullboard-local=|device=/.test(location.href), projects: data.projects.map(({id,name,source}) => ({id,name,source})) })`));
    assert.deepEqual(shown.labels, ['fixture/repository', 'local-machine-b'], 'B sees linked A beside its own unlinked local board');
    assert.equal(shown.secretInAddress, false, 'session and pairing fragments are removed from the hosted address');
    const idBResponse = await fetchLive(viewB.base + '/api/v1/boards', { headers: { 'x-pullboard-key': viewB.key } });
    const idB = (await idBResponse.json()).boards.find((board) => board.name === 'local-machine-b').id;
    const keyBFile = join(machineB.env.PULLBOARD_HOME, 'relay-keys', idB + '.key');
    assert.equal(existsSync(linkBFile), false, 'hosted discovery leaves B without a persisted relay link');
    assert.equal(existsSync(keyBFile), false, 'B needs no persisted relay board key');
    const remoteProject = shown.projects.find((entry) => entry.id === boardAId);
    assert.equal(remoteProject?.source, 'relay', 'A uses the real relay transport');
    assert.equal(shown.projects.find((entry) => entry.id === idB)?.source, 'local', 'B remains a local project');

    // A's real local view is kept open for the measured move; linking happened through the CLI above.
    chromeA = await openSnapshotChrome(executable, viewA.link.href, profileA);
    await chromeA.waitFor("document.querySelector('#chain')?.textContent.includes('linked machine A board')", 30_000); // budget: bounded local-view setup wait within this journey test’s declared outer timeout (5x relay-work budget plus 180 seconds).

    // A user action in A produces a real board move; B receives it through the live relay event stream.
    const remoteRow = "Array.from(document.querySelectorAll('#proj-list .proj.repo')).find(row => row.textContent.includes('fixture/repository'))";
    await pickProject(chromeB, remoteRow);
    await chromeB.waitFor("view.root === data.projects.find(row => row.id === " + JSON.stringify(boardAId) + ").root && document.querySelector('#chain')?.textContent.includes('linked machine A board')");
    const updatedTitle = 'A live move visible on B';
    await chromeB.stable(`(() => { const chain = document.querySelector('#chain'); window.__journeyUpdateAt = null; window.__journeyUpdateObserver = new MutationObserver(() => { if (chain.textContent.includes(${JSON.stringify(updatedTitle)})) { window.__journeyUpdateAt = performance.timeOrigin + performance.now(); window.__journeyUpdateObserver.disconnect(); } }); window.__journeyUpdateObserver.observe(chain, { childList: true, subtree: true, characterData: true }); return true; })()`);
    await chromeA.click("document.querySelector('#new-item')");
    await chromeA.stable(`document.querySelector('#add-title').value = ${JSON.stringify(updatedTitle)}; window.__journeyMoveStarted = null; document.addEventListener('pointerdown', event => { if (event.isTrusted && event.target.closest('#add-form button.go')) window.__journeyMoveStarted = performance.timeOrigin + performance.now(); }, { capture: true, once: true }); 'ready'`);
    await press(chromeA, "document.querySelector('#add-form button.go')");
    await chromeA.waitFor("Number.isFinite(window.__journeyMoveStarted)");
    await chromeB.waitFor('Number.isFinite(window.__journeyUpdateAt)', 5_000); // budget: declared frozen #676 requires cross-machine delivery within 2,000 ms; this wait observes that existing assertion.
    const updateAt = await chromeB.stable('window.__journeyUpdateAt');
    const moveStart = await chromeA.stable('window.__journeyMoveStarted');
    const elapsedMs = updateAt - moveStart;
    assert.ok(/* budget: declared frozen #676 requires delivery within 2,000 ms from trusted pointerdown; this assertion preserves that bar. */ Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= 2_000,
      `B renders A's move within 2,000 ms of A's trusted pointerdown (${Math.round(elapsedMs)} ms)`);
    assert.ok(machineA.calls.some((call) => call.method === 'GET' && call.path.startsWith('/api/v1/boards/' + boardAId + '/events')),
      'B follows A through the real relay event endpoint');

    // B's already-loaded 40-item local board opens one selected item's real detail under the 250ms bar.
    const localRow = "Array.from(document.querySelectorAll('#proj-list .proj.repo')).find(row => row.textContent.includes('local-machine-b'))";
    await pickProject(chromeB, localRow);
    await chromeB.waitFor("view.root === data.projects.find(row => row.name === 'local-machine-b')?.root && data.project.items.length === 40 && document.querySelector('#chain')?.textContent.includes('local B item 40')");
    const selectedItem = JSON.parse(await chromeB.stable(`JSON.stringify((() => { const first = document.querySelector('#chain [data-item]')?.dataset.item; const row = [...document.querySelectorAll('#chain [data-item]')].find(node => node.dataset.item !== String(view.item) && node.dataset.item !== first); const item = data.project.items.find(candidate => String(candidate.id) === row?.dataset.item); return row && item ? { id: row.dataset.item, title: item.title } : null; })())`));
    assert.ok(selectedItem?.id && selectedItem?.title, 'the 40-item board has an unopened item row');
    const { id: itemId, title: detailTitle } = selectedItem;
    await chromeB.stable(`(() => { const id = ${JSON.stringify(itemId)}; window.__detailLatency = null; window.__detailStarted = null; const detail = document.querySelector('#detail'); const target = [...document.querySelectorAll('#chain [data-item]')].find(node => node.dataset.item === id); if (!target) throw Error('the selected item row is absent'); window.__detailObserver = new MutationObserver(() => { if (window.__detailStarted !== null && document.querySelector('#detail h2')?.textContent.includes(${JSON.stringify(detailTitle)})) { window.__detailLatency = performance.now() - window.__detailStarted; window.__detailObserver.disconnect(); } }); window.__detailObserver.observe(detail, { childList: true, subtree: true }); document.addEventListener('click', event => { if (event.isTrusted && event.target.closest('[data-item]')?.dataset.item === id) window.__detailStarted = performance.now(); }, { capture: true, once: true }); return true; })()`);
    await press(chromeB, "[...document.querySelectorAll('#chain [data-item]')].find(node => node.dataset.item === " + JSON.stringify(itemId) + ")");
    await chromeB.waitFor('Number.isFinite(window.__detailLatency)', 1_000); // budget: declared frozen #676 requires detail opening within 250 ms; this 1,000 ms wait is only the observation ceiling.
    const detailMs = await chromeB.stable('window.__detailLatency');
    assert.ok(detailMs <= 250, `B opens one of 40 local items within 250 ms from trusted click dispatch (${Math.round(detailMs)} ms)`);
    assert.equal(existsSync(linkBFile), false, 'B stays unlinked after the complete hosted journey');
    assert.equal(existsSync(keyBFile), false, 'the complete journey creates no relay key for B');
    assert.deepEqual(chromeA.exceptions, [], 'A’s real view UI has no browser errors');
    assert.deepEqual(chromeB.exceptions, [], 'B’s hosted mixed-board page has no browser errors');
  } finally {
    try { await stopRelayAll(setup); }
    finally {
      try { if (journeyTrace) journeyTrace.close(); if (stopRoutes && chromeB) await stopRoutes(); }
      finally {
        try { if (chromeB) await closeSnapshotChrome(chromeB); }
        finally {
          try { if (chromeA) await closeSnapshotChrome(chromeA); }
          finally {
            try { if (viewB) await viewB.stop(); }
            finally {
              try { if (viewA) await viewA.stop(); }
              finally {
                if (site?.server) { site.server.closeAllConnections(); if (site.server.listening) await new Promise((done) => site.server.close(done)); }
              }
            }
          }
        }
      }
    }
  }
});
