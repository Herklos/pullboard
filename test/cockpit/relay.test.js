/** Cockpit relay checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join, relative, resolve, sep } from 'node:path';
import { after, test } from 'node:test';
import { press, stableChrome } from './stable.js';
import { cockpitPage } from '../../src/cockpit.js';
import { relayClientFixture } from '../relay-client-fixture.js';
import { findChromeExecutable, relayWorkBudgetMs, startChrome } from '../relay-browser-fixture.js';
import { BIN, scratch, SPEC, machine, project, fetchLive, startView, target, chromeExecutable, browserPause, openSnapshotChrome, stopOwnedChrome, closeSnapshotChrome } from './fixture.js';

test('a paired relay reference explains that committed source is available only in the local project view [B33]', {
  // Its relay work is the fixture's setup moves, the browser's pairing and the reference's request: three budgets,
  // derived from the work as main's relay tests are, so it holds under load.
  timeout: relayWorkBudgetMs() * 3,
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const sentinel = 'RELAY_SOURCE_MUST_STAY_LOCAL_251';
  const oldItem = String(box.before.tables.item[0].item_id);
  assert.equal((await box.cli('withdraw', oldItem, 'replace the fixture item with a source lane')).code, 0,
    'the private setup item is withdrawn before coordinator setup is committed');
  const configPath = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.lanes.app = { owns: ['src/'], specs: ['G'] };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  const fixtureBin = box.env.PATH.split(delimiter)[0];
  const wrapper = join(fixtureBin, 'pullboard');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`, { mode: 0o700 });
  chmodSync(wrapper, 0o700);
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: box.root, env: box.env }).status, 0,
    'the coordinator stages the private repository setup');
  const setupCommit = spawnSync('git', ['commit', '-q', '-m', 'chore: set up paired relay source fixture'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(setupCommit.status, 0, `the fixture config is committed through normal hooks: ${setupCommit.stderr.trim()}`);
  const sourceWorktree = join(box.root, '..', 'source-worktree');
  const worktree = spawnSync('git', ['worktree', 'add', '-b', 'app/relay-source', sourceWorktree], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(worktree.status, 0, `the fixture creates a lane-owned source checkout: ${worktree.stderr.trim()}`);
  const sourceCli = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: sourceWorktree, env: box.env, encoding: 'utf8' });
  const joined = sourceCli('join', 'app');
  assert.equal(joined.status, 0, `the source checkout joins its lane: ${joined.stderr.trim()}`);
  const itemTitle = 'private cleanup fixture item 251';
  const addedItem = await box.cli('add', 'app', itemTitle);
  assert.equal(addedItem.code, 0, `the coordinator adds a fixture item after the setup commit: ${JSON.stringify(addedItem.document.error ?? addedItem.document)}`);
  const latest = await box.cli('export');
  assert.equal(latest.code, 0);
  const fixtureItem = String(latest.document.tables.item.find(row => row.item_title === itemTitle).item_id);
  const claimed = sourceCli('claim', fixtureItem);
  assert.equal(claimed.status, 0, `the source checkout claims the fixture item: ${claimed.stderr.trim()}`);
  const sourceFile = join(sourceWorktree, 'src', 'local-only.js');
  mkdirSync(resolve(sourceFile, '..'), { recursive: true });
  writeFileSync(sourceFile, `export const localOnly = '${sentinel}';\n`);
  assert.equal(spawnSync('git', ['add', '--', relative(sourceWorktree, sourceFile)], { cwd: sourceWorktree, env: box.env }).status, 0);
  const subject = 'chore(app): add local-only source';
  const committed = spawnSync('git', ['commit', '-q', '-m', subject], { cwd: sourceWorktree, env: box.env, encoding: 'utf8' });
  assert.equal(committed.status, 0, `the reference names a real committed source file: ${committed.stderr.trim()}`);
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceWorktree, env: box.env, encoding: 'utf8' }).trim();
  const sourceRef = relative(sourceWorktree, sourceFile).split(sep).join('/');
  const ref = `${sourceRef}:1@${sha}`;
  assert.equal((await box.cli('shout', 'all', `source: ${ref}`)).code, 0);
  await box.link();
  assert.equal((await box.cli('status')).code, 0, 'the linked board publishes its reference');

  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const encoded = readFileSync(box.keyFile, 'utf8').trim();
  const chrome = await stableChrome(await startChrome());
  t.after(() => chrome.close());
  // Since person power stays on the paired phone, the browser reads the board with the phone's session, not the link's.
  assert.equal((await chrome.send('Network.setCookie', {
    name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  })).success, true, 'the private browser receives the paired phone’s authenticated session');
  await chrome.navigate(box.origin + '/#board=' + link.board + '&key=' + encoded);
  await chrome.waitFor(`document.querySelector('#chain')?.textContent.includes(${JSON.stringify(itemTitle)})`);
  await chrome.click(`document.querySelector('[data-tab="shouts"]')`);
  await chrome.waitFor(`document.querySelector('#feed button[data-code^="${sourceRef}:1@"]')`);
  const beforeOpen = box.calls.length;
  for (const width of [375, 1280]) {
    await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor(`innerWidth === ${width}`);
    const button = `document.querySelector('#feed button[data-code^="${sourceRef}:1@"]')`;
    if (!await chrome.stable(`${button}.getAttribute('aria-expanded') === 'true'`)) await chrome.click(`${button}`);
    await chrome.waitFor(`${button}.nextElementSibling?.querySelector('.code')?.textContent.includes('local project view')`);
    assert.equal(await chrome.stable(`document.body.textContent.includes(${JSON.stringify(sentinel)})`), false,
      'the paired relay browser never receives committed source text');
    assert.equal(await chrome.stable(`JSON.stringify(data).includes(${JSON.stringify(sentinel)})`), false,
      'the decoded relay presentation contains only the reference, not source bytes');
    assert.equal(await chrome.stable(`${button}.nextElementSibling.querySelector('.code').textContent`),
      'Source code is unavailable in a relay view; open this reference in the local project view.');
    assert.equal(await chrome.stable(`document.querySelector('#feed button[data-code-all]') === null`), true,
      'a relay reference exposes no control that could request more source');
    assert.equal(await chrome.stable('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true,
      `${width}px relay reference stays within the viewport`);
  }
  assert.equal(box.calls.slice(beforeOpen).some(call => /\/code(?:\?|$)/.test(call.path)), false,
    'opening the reference never asks the relay for source');
});


test('served connection reaches an authenticated API on another origin and path in Chrome [H5,N26]', { timeout: 60_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the connection proof.');
  const box = machine();
  const alpha = project(box, 'remote phone demo');
  box.run(alpha.repo, 'add', 'web', 'Remote original');
  const view = await startView(box);
  const credential = 'test-only-bearer';
  const seen = [];
  const apiServer = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization,content-type');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    seen.push({ path: req.url, method: req.method, authorization: req.headers.authorization, localKey: req.headers['x-pullboard-key'] });
    if (req.headers.authorization !== `Bearer ${credential}` || !req.url.startsWith('/mirror/api/v1/')) return res.writeHead(401).end(JSON.stringify({ error: 'bad supplied connection' }));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      const upstream = await fetchLive(view.base + req.url.slice('/mirror'.length), {
        method: req.method, headers: { 'x-pullboard-key': view.key, ...(req.method === 'POST' ? { 'content-type': 'application/json' } : {}) },
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}), signal: AbortSignal.timeout(10_000),
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' }).end(await upstream.text());
    } catch (error) { res.writeHead(500).end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  const apiBase = `http://127.0.0.1:${apiServer.address().port}/mirror`;
  const pageServer = createServer((req, res) => {
    if (req.url === '/phone/index.html') return res.writeHead(200, { 'content-type': 'text/html' }).end(cockpitPage('', { apiBase, apiHeaders: { authorization: `Bearer ${credential}` }, stylesheet: 'view.css' }));
    if (req.url === '/phone/view.css') return res.writeHead(200, { 'content-type': 'text/css' }).end(readFileSync(resolve(import.meta.dirname, '../../src/view.css')));
    res.writeHead(404).end();
  });
  await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', resolve));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, `http://127.0.0.1:${pageServer.address().port}/phone/index.html`, join(box.dir, 'remote-phone-chrome'));
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('typeof data === "object" && !!data?.project');
    assert.equal(await chrome.stable('data.project.items[0].title'), 'Remote original');
    await chrome.click(`document.querySelector('#new-item')`); await chrome.stable(`document.querySelector('#add-title').value = 'Remote added'`); await chrome.stable(`document.querySelector('#add-form').requestSubmit()`);
    await chrome.waitFor('data.project.items.some(item => item.title === "Remote added")');
    assert.ok(seen.some((entry) => entry.method === 'POST' && entry.path.endsWith('/moves')), 'a real browser action reaches the configured API');
    assert.ok(seen.every((entry) => entry.authorization === `Bearer ${credential}` && entry.localKey === undefined && entry.path.startsWith('/mirror/api/v1/')), 'only the supplied credential and API base reach the stand-in');
    assert.ok(await chrome.stable('document.documentElement.scrollWidth <= document.documentElement.clientWidth'),
      'the remote phone page fits the viewport content area');
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await new Promise((resolve) => pageServer.close(resolve));
    await new Promise((resolve) => apiServer.close(resolve));
    await view.stop();
  }
});

test('relay person requests stay explicit, read-only and visible [H12,H5]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME to run the person-request transport proof.');

  const box = machine();
  const requestRows = Array.from({ length: 12 }, (_, index) => `- P${index + 1} [draft, must] Keep the reading position measurable. | gate: test`).join('\n');
  const requestSpec = `# Person request fixture\n\n## G · Goals\n- G1 [approved, must] Existing item remains readable. | gate: test\n${requestRows}\n- G2 [draft, must] The person can approve this row. | gate: test\n`;
  const app = project(box, 'person requests', requestSpec);
  box.run(app.repo, 'add', 'web', 'Existing private item', '--specs', 'G1', '--criterion', 'remains readable');
  box.run(app.repo, 'shout', 'person', 'Should this item ship?', '--decision');
  const live = await startView(box);
  const intents = [];
  const records = [];
  const requestTimeline = [];
  let chrome;
  let diagnosticEmitted = false;
  /** Build the opted-in page or a refusal control with the same read-only transport. */
  const page = (options = {}) => cockpitPage('', {
    readOnly: true, requests: true, transportModule: '/transport.js', stylesheet: '/view.css', ...options,
  });
  const transportModule = `/** Provide the permitted stand-in transport while leaving real board reads untouched. */
  export async function createTransport({ onUpdate }) {
    window.__transportCalls = [];
    window.__setPersonRequest = async (id, status, error) => {
      await fetch('/request-status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, status, error }) });
      await onUpdate();
    };
    window.__holdNextIntent = false;
    window.__releaseHeldIntent = null;
    window.__pendingEarlierTransportCalls = 0;
    window.__lateEarlierTransportError = null;
    window.__releaseEarlierTransportCall = null;
    const transport = { async request(path, body) {
      window.__transportCalls.push({ path, body: body ?? null });
      if (body) {
        if (window.__holdNextIntent) {
          window.__holdNextIntent = false;
          await new Promise(resolve => { window.__releaseHeldIntent = resolve; });
        }
        const response = await fetch('/intent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const document = await response.json();
        if (!response.ok) throw new Error(document.error?.message || String(response.status));
        return document;
      }
      const response = await fetch('/fixture' + path);
      const document = await response.json();
      if (!response.ok) throw new Error(document.error?.message || String(response.status));
      if (new URL(path, location.origin).pathname.endsWith('/state')) document.state.personRequests = await (await fetch('/request-state')).json();
      return document;
    } };
    /** Hold a genuine earlier read so the test can release it after taking a stale count. */
    window.__queueEarlierTransportCall = (path) => {
      window.__pendingEarlierTransportCalls += 1;
      window.__releaseEarlierTransportCall = () => {
        window.__releaseEarlierTransportCall = null;
        void transport.request(path).catch(error => { window.__lateEarlierTransportError = error.message; })
          .finally(() => { window.__pendingEarlierTransportCalls -= 1; });
      };
    };
    return transport;
  }`;
  /** Serve controlled request receipts and proxy reads to the actual private Git/SQLite board. */
  async function fixtureRequest(request, response) {
    const url = new URL(request.url, 'http://127.0.0.1');
    const receivedAt = Date.now();
    if (url.pathname === '/request-state' && request.method === 'GET') {
      return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(records));
    }
    if (url.pathname === '/request-status' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const update = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const row = records.find(entry => entry.id === update.id);
      row.status = update.status;
      if (update.error) row.error = update.error;
      return response.writeHead(200).end();
    }
    if (url.pathname === '/intent' && request.method === 'POST') {
      requestTimeline.push({ clock: 'fixture-Date.now', type: 'intent-received', at: receivedAt });
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const move = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const allowed = ['add', 'shout', 'answer', 'hold', 'spec-approve', 'spec-decline'].includes(move.verb)
        && Object.keys(move).every(key => ['verb', 'item', 'args'].includes(key));
      if (!allowed) return response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Only literal person requests are allowed.' } }));
      intents.push(structuredClone(move));
      const row = { id: 'request-' + intents.length, sequence: intents.length, at: '2026-10-08T00:00:00.000Z', by: 'person', move, status: 'waiting' };
      records.push(row);
      requestTimeline.push({ clock: 'fixture-Date.now', type: 'intent-accepted', at: Date.now(), id: row.id, verb: move.verb });
      response.once('finish', () => requestTimeline.push({ clock: 'fixture-Date.now', type: 'intent-response-finished', at: Date.now(), id: row.id, status: response.statusCode }));
      return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version: 1, event: { event_id: row.sequence, kind: 'request' }, result: { request: row } }));
    }
    if (url.pathname.startsWith('/fixture/')) {
      if (request.method !== 'GET') return response.writeHead(405, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'The read-only fixture accepts GET only.' } }));
      const isState = url.pathname.endsWith('/state');
      if (isState) requestTimeline.push({ clock: 'fixture-Date.now', type: 'state-read-start', at: receivedAt });
      const upstream = await fetchLive(live.base + url.pathname.slice('/fixture'.length) + url.search, { headers: { 'x-pullboard-key': live.key } });
      const text = await upstream.text();
      if (isState) requestTimeline.push({ clock: 'fixture-Date.now', type: 'state-read-response', at: Date.now(), status: upstream.status });
      if (isState) response.once('finish', () => requestTimeline.push({ clock: 'fixture-Date.now', type: 'state-read-finished', at: Date.now(), status: response.statusCode }));
      return response.writeHead(upstream.status, { 'content-type': 'application/json' }).end(text);
    }
    response.writeHead(404).end();
  }
  /** Serve each capability control and the same-origin stand-in request protocol. */
  const pageServer = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === '/without-capability' || url.pathname === '/snapshot') {
      const body = url.pathname === '/'
        ? page({})
        : url.pathname === '/snapshot'
          ? cockpitPage('', { snapshot: true, requests: true, stylesheet: '/view.css' })
          : cockpitPage('', { readOnly: true, transportModule: '/transport.js', stylesheet: '/view.css' });
      return response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
    }
    if (url.pathname.startsWith('/api/v1/') && url.pathname.endsWith('.json')) {
      const target = url.pathname.slice(0, -'.json'.length) + url.search;
      const upstream = await fetchLive(live.base + target, { headers: { 'x-pullboard-key': live.key } });
      return response.writeHead(upstream.status, { 'content-type': 'application/json' }).end(await upstream.text());
    }
    if (url.pathname === '/transport.js') return response.writeHead(200, { 'content-type': 'text/javascript' }).end(transportModule);
    if (url.pathname === '/view.css') return response.writeHead(200, { 'content-type': 'text/css' }).end(readFileSync(resolve(import.meta.dirname, '../../src/view.css')));
    return fixtureRequest(request, response);
  });
  await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', resolve));
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-person-request-chrome-'));
  scratch.push(profile);
  try {
    chrome = await openSnapshotChrome(executable, `http://127.0.0.1:${pageServer.address().port}/`, profile);
    await chrome.waitFor("typeof data === 'object' && !!data?.project && typeof window.__setPersonRequest === 'function'");
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    assert.equal(await chrome.stable('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, 'the request view fits a phone viewport');
    assert.equal(await chrome.stable("document.body.classList.contains('requests') && getComputedStyle(document.querySelector('#new-item')).display !== 'none' && document.querySelector('#new-item').getBoundingClientRect().height >= 44"), true, 'the explicit capability exposes usable person controls');
    await chrome.click("document.querySelector('[data-tab=\"shouts\"]')"); await chrome.stable("document.querySelector('#shout-to').value = 'coordinator'"); await chrome.stable("document.querySelector('#shout-text').value = 'Please review this item.'"); await chrome.stable("document.querySelector('#shout-form').requestSubmit()");
    await chrome.waitFor("data?.project?.personRequests?.length === 1");
    assert.deepEqual(intents.at(-1), { verb: 'shout', args: { to: 'coordinator', text: 'Please review this item.' } });
    await chrome.click("document.querySelector('[data-tab=\"spec\"]')");
    await chrome.waitFor("document.querySelector('#spec-list [data-row=\"spec:G2\"]')");
    await chrome.stable("document.querySelector('#spec-list [data-row=\"spec:G2\"]').scrollIntoView({ block: 'center' })");
    await chrome.waitFor('window.scrollY > 0');
    await chrome.click("document.querySelector('#spec-list [data-row=\"spec:G2\"]')");
    await chrome.waitFor("view.row.spec === 'G2'");
    const reading = JSON.parse(await chrome.stable(`JSON.stringify({ root: view.root, boardRoot: data.project.root, row: view.row.spec, scroll: window.scrollY,
      requestPanel: (() => { const node = document.querySelector('#person-requests'), rect = node.getBoundingClientRect(); return { hidden: node.hidden, top: rect.top, height: rect.height, documentTop: rect.top + scrollY, count: node.querySelectorAll('[data-person-request]').length }; })(),
      rowBox: (() => { const node = document.querySelector('#spec-list [data-row="spec:G2"]'), rect = node.getBoundingClientRect(); return { connected: node.isConnected, top: rect.top, height: rect.height, documentTop: rect.top + scrollY }; })(), pageHeight: document.documentElement.scrollHeight })`));
    assert.equal(reading.root, reading.boardRoot, 'the selected spec row belongs to the displayed board');
    assert.equal(reading.row, 'G2', 'G2 is the selected reading row before approval');
    await chrome.waitFor("document.querySelector('#spec-detail button[data-row-decision=\"approve\"]')");
    assert.equal(await chrome.stable(`(() => {
      const usable = document.querySelector('#spec-detail button[data-row-decision="approve"]').getBoundingClientRect().height >= 44;
      const trace = window.__personRequestReadingTrace = { armedAt: performance.now(), events: [], mutationBatches: 0, scrollEvents: 0 };
      const box = selector => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { connected: node.isConnected, hidden: Boolean(node.closest('[hidden]')), top: rect.top, bottom: rect.bottom,
          height: rect.height, documentTop: rect.top + scrollY, text: node.textContent.trim().slice(0, 100) };
      };
      const capture = (type, detail = {}) => {
        trace.events.push({ type, at: performance.now(), scrollY, pageHeight: document.documentElement.scrollHeight,
          panel: box('#person-requests'), row: box('#spec-list [data-row="spec:G2"]'),
          requestCount: document.querySelectorAll('#person-requests [data-person-request]').length,
          active: document.activeElement?.id || null, selectedRow: view.row.spec, tab: view.tab, ...detail });
        if (trace.events.length > 80) trace.events.splice(0, trace.events.length - 80);
      };
      trace.capture = capture;
      trace.serialize = () => ({ armedAt: trace.armedAt, mutationBatches: trace.mutationBatches, scrollEvents: trace.scrollEvents, events: trace.events });
      trace.observer = new MutationObserver(changes => {
        const relevant = changes.some(change => {
          const target = change.target.nodeType === 1 ? change.target : change.target.parentElement;
          return target?.closest?.('#person-requests, #spec-list') || [...change.addedNodes, ...change.removedNodes].some(node =>
            node.nodeType === 1 && (node.matches?.('#person-requests, #spec-list') || node.querySelector?.('#person-requests, #spec-list')));
        });
        if (!relevant) return;
        trace.mutationBatches += 1;
        capture('dom-mutation', { records: changes.length });
      });
      trace.observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true,
        attributeFilter: ['hidden', 'class', 'style'] });
      trace.resize = new ResizeObserver(entries => capture('resize', { resized: entries.map(entry => entry.target.id || entry.target.dataset.row || entry.target.className).slice(0, 8) }));
      for (const node of [document.querySelector('#person-requests'), document.querySelector('#spec-list [data-row="spec:G2"]')]) if (node) trace.resize.observe(node);
      trace.onScroll = () => { trace.scrollEvents += 1; capture('scroll'); };
      window.addEventListener('scroll', trace.onScroll, { passive: true });
      trace.dispose = () => { trace.observer.disconnect(); trace.resize.disconnect(); window.removeEventListener('scroll', trace.onScroll); };
      capture('before-person-request');
      return usable;
    })()`), true, 'the real G2 approval control is usable at 375px');
    await chrome.stable('window.__holdNextIntent = true');
    await chrome.click("document.querySelector('#spec-detail button[data-row-decision=\"approve\"]')");
    await chrome.waitFor("typeof window.__releaseHeldIntent === 'function' || document.querySelector('#spec-detail .spec-feedback.no')");
    assert.equal(await chrome.stable("typeof window.__releaseHeldIntent"), 'function', 'the row decision reaches the sealed request transport instead of the refused generic API');
    await chrome.waitFor("document.querySelector('#spec-detail .spec-feedback')?.textContent.trim() === 'Recording decision…'");
    await chrome.stable('window.__releaseHeldIntent()');
    await chrome.waitFor("document.querySelector('#spec-detail .spec-feedback') && document.querySelector('#spec-detail .spec-feedback').textContent.trim() !== 'Recording decision…'");
    assert.deepEqual(intents.at(-1), { verb: 'spec-approve', args: { ids: 'G2' } }, 'the detail click creates the exact second literal intent');
    await chrome.waitFor("data?.project?.personRequests?.length === 2 && document.querySelector('[data-person-request=\"request-2\"] .request-status')?.textContent === 'Waiting'");
    assert.match(await chrome.stable("document.querySelector('#spec-detail .spec-feedback')?.textContent.trim() || ''"), /G2/);
    const afterApproval = JSON.parse(await chrome.stable(`JSON.stringify({ root: view.root, row: view.row.spec, scroll: window.scrollY, selected: document.querySelector('#spec-list [data-row=\"spec:G2\"]')?.classList.contains('on'), visible: (() => { const row = document.querySelector('#spec-list [data-row=\"spec:G2\"]')?.getBoundingClientRect(); return !!row && row.top >= 0 && row.bottom <= innerHeight; })(), browserTrace: window.__personRequestReadingTrace?.serialize() ?? null })`));
    t.diagnostic(`person-request reading capture: ${JSON.stringify({ clocks: { browser: 'performance.now()', fixture: 'Date.now()' }, reading, afterApproval, requestTimeline })}`);
    diagnosticEmitted = true;
    assert.deepEqual([afterApproval.root, afterApproval.row, afterApproval.selected], [reading.root, 'G2', true], 'the request keeps the selected board and G2 row');
    assert.ok(Math.abs(afterApproval.scroll - reading.scroll) <= 1, 'the request keeps the page at the same reading position');
    assert.equal(afterApproval.visible, true, 'G2 remains visible beside its inline feedback');
    assert.deepEqual(intents.at(-1), { verb: 'spec-approve', args: { ids: 'G2' } });
    assert.equal(await chrome.stable("data.project.spec.find(row => row.id === 'G2').decision === undefined"), true, 'waiting for a request never approves the row optimistically');
    await chrome.stable("window.__setPersonRequest('request-2', 'done')");
    assert.match(await chrome.stable("document.querySelector('#spec-detail .spec-feedback')?.textContent || ''"), /^Done/, 'the same row feedback follows a matched done receipt');
    await chrome.stable("window.__setPersonRequest('request-2', 'refused', { code: 'REQUEST_DECLINED', message: 'Keep the row draft.', next: 'Ask the coordinator for the next step.' })");
    assert.match(await chrome.stable("document.querySelector('#spec-detail .spec-feedback.no')?.textContent || ''"), /Refused[\s\S]*REQUEST_DECLINED[\s\S]*Keep the row draft\.[\s\S]*Ask the coordinator/, 'the same row retains the original refusal and next step');
    await chrome.stable("window.__setPersonRequest('request-2', 'waiting')");

    const ids = JSON.parse(await chrome.stable('JSON.stringify(data.project.personRequests.map(row => row.id))'));
    assert.deepEqual(ids, ['request-1', 'request-2']);
    assert.ok(await chrome.stable("[...document.querySelectorAll('[data-person-request]')].length === 2 && [...document.querySelectorAll('[data-person-request]')].every(node => node.querySelector('.request-status').textContent === 'Waiting')"), 'waiting receipts render from API state');

    await t.test('a late earlier transport call is not counted as a refused write [H12]', { timeout: 30_000 }, async () => {
      /** Keep only calls with a write shape; unrelated earlier reads must not enter this count. */
      const writes = async () => JSON.parse(await chrome.stable(`JSON.stringify(window.__transportCalls.filter(call => call.body !== null || call.path.split('?')[0].endsWith('/moves')))`));
      const earlierPath = await chrome.stable(`boardPath(view.root) + '/state?lateEarlier=406'`);
      const beforeAllCalls = JSON.parse(await chrome.stable('JSON.stringify(window.__transportCalls)'));
      const beforeWrites = await writes();
      await chrome.stable(`window.__queueEarlierTransportCall(${JSON.stringify(earlierPath)})`);
      assert.equal(await chrome.stable('window.__pendingEarlierTransportCalls'), 1, 'the earlier read is held before it reaches the transport');
      assert.equal(await chrome.stable('window.__releaseEarlierTransportCall()'), undefined, 'the earlier read is released after the stale count');
      await chrome.waitFor(`(async () => {
        if (window.__pendingEarlierTransportCalls !== 0) return false;
        const count = window.__transportCalls.length;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return window.__pendingEarlierTransportCalls === 0 && count === window.__transportCalls.length;
      })()`);
      assert.equal(await chrome.stable('window.__lateEarlierTransportError'), null, 'the earlier read completed successfully');
      const afterEarlierCalls = JSON.parse(await chrome.stable('JSON.stringify(window.__transportCalls)'));
      assert.equal(beforeAllCalls.some(call => call.path === earlierPath), false, 'the delayed call was not in the earlier snapshot');
      assert.equal(afterEarlierCalls.filter(call => call.path === earlierPath && call.body === null).length, 1, 'the deliberately delayed earlier read reaches the transport once');
      const afterEarlierWrites = await writes();
      assert.deepEqual(afterEarlierWrites, beforeWrites, `the late read does not change the write-shaped transport calls: ${JSON.stringify(afterEarlierWrites)}`);

      // A generic write and an unknown action are refused before they reach the stand-in transport.
      const beforeRefused = intents.length;
      const beforeTransport = beforeWrites.length;
      const apiRefusal = await chrome.stable(`(async () => { try { await api(boardPath(view.root) + '/moves', { verb: 'shout', args: { to: 'coordinator', text: 'direct writes stay refused' } }); return 'unexpected'; } catch (error) { return error.message; } })()`);
      const execRefusal = await chrome.stable(`(async () => act('exec', { command: 'true' }))()`);
      const afterRefused = await writes();
      assert.equal(afterRefused.length, beforeTransport, `refused writes never reach the browser transport; extra call shapes: ${JSON.stringify(afterRefused.slice(beforeTransport))}`);
      assert.equal(intents.length, beforeRefused, 'refused shapes never reach the request server');
      assert.match(apiRefusal, /read-only view/i);
      assert.equal(execRefusal, false);
    });

    const longTitle = 'Requested item ' + 'abcdefghij'.repeat(24);
    const otherActions = [
      ['add', { lane: 'web', title: longTitle, criterion: 'visible', specs: 'G1', brief: 'requested work' }, { verb: 'add', args: { lane: 'web', title: longTitle, criterion: 'visible', specs: 'G1', brief: 'requested work' } }],
      ['answer', { id: 1, text: 'Ship it' }, { verb: 'answer', item: 1, args: { text: 'Ship it', as: 'person' } }],
      ['hold', { lane: 'web', reason: 'Wait for the decision' }, { verb: 'hold', args: { lane: 'web', reason: 'Wait for the decision' } }],
      ['release', { lane: 'web' }, { verb: 'hold', args: { lane: 'web', off: true } }],
      ['spec-decline', { ids: 'G2', reason: 'Keep the present behavior' }, { verb: 'spec-decline', args: { ids: 'G2', reason: 'Keep the present behavior' } }],
    ];
    for (const [action, args, expected] of otherActions) {
      assert.equal(await chrome.stable(`act(${JSON.stringify(action)}, ${JSON.stringify(args)})`), true, `${action} is a permitted person request`);
      assert.deepEqual(intents.at(-1), expected, `${action} retains literal public CLI intent`);
    }
    const allActions = [['shout', { to: 'coordinator', text: 'must not send' }], ['spec-approve', { ids: 'G2' }], ...otherActions.map(([action, args]) => [action, args])];

    // The no-capability read-only page and static snapshot cannot send person requests either.
    await chrome.send('Page.navigate', { url: `http://127.0.0.1:${pageServer.address().port}/without-capability` });
    await chrome.waitFor("typeof data === 'object' && !!data?.project && document.body?.classList.contains('read-only')");
    const beforeDisabled = intents.length;
    await chrome.click("document.querySelector('[data-tab=\"spec\"]')"); await chrome.click("document.querySelector('#spec-list [data-row=\"spec:G2\"]')");
    await chrome.waitFor("view.row.spec === 'G2'");
    assert.equal(await chrome.stable(`(async () => decideRow('spec', 'spec-approve', { ids: 'G2' }, document.querySelector('#spec-list [data-row=\"spec:G2\"]')))()`), false, 'the decision handler itself refuses without request capability');
    assert.equal(await chrome.stable('!view.specFeedback'), true, 'a disabled decision refuses before creating decision feedback');
    assert.equal(intents.length, beforeDisabled, 'a direct no-capability decision never reaches the request transport');
    for (const [action, args] of allActions) assert.equal(await chrome.stable(`act(${JSON.stringify(action)}, ${JSON.stringify(args)})`), false, `${action} stays refused without the capability`);
    assert.equal(intents.length, beforeDisabled, 'read-only without the explicit request capability refuses every action');
    await chrome.send('Page.navigate', { url: `http://127.0.0.1:${pageServer.address().port}/snapshot` });
    await chrome.waitFor("typeof data === 'object' && !!data?.project && document.body?.classList.contains('snapshot')");
    assert.equal(await chrome.stable(`(async () => decideRow('spec', 'spec-approve', { ids: 'G2' }, null))()`), false, 'the decision handler itself refuses in a snapshot');
    for (const [action, args] of allActions) assert.equal(await chrome.stable(`act(${JSON.stringify(action)}, ${JSON.stringify(args)})`), false, `${action} stays refused in a snapshot`);
    assert.match(await chrome.stable(`(async () => { try { await api('/api/v1/boards/demo/moves', { verb: 'shout' }); return 'unexpected'; } catch (error) { return error.message; } })()`), /read-only snapshot/i);
    assert.equal(intents.length, beforeDisabled, 'snapshot mode cannot use the explicit request capability');

    // A later actual API read may update status; refusal text is safe text and preserves CLI guidance.
    await chrome.send('Page.navigate', { url: `http://127.0.0.1:${pageServer.address().port}/` });
    await chrome.waitFor("typeof window.__setPersonRequest === 'function' && !!data?.project");
    await chrome.stable(`window.__setPersonRequest('request-1', 'done')`);
    await chrome.waitFor("document.querySelector('[data-person-request=\"request-1\"]')?.querySelector('.request-status')?.textContent === 'Done'");
    const refusal = '<img src=x onerror=globalThis.requestInjection=true> UNKNOWN_SPEC; run pullboard spec check';
    await chrome.stable(`window.__setPersonRequest('request-2', 'refused', { code: 'UNKNOWN_SPEC', message: ${JSON.stringify(refusal)}, next: 'run pullboard spec check' })`);
    await chrome.waitFor("document.querySelector('[data-person-request=\"request-2\"]')?.textContent.includes('UNKNOWN_SPEC')");
    assert.equal(await chrome.stable("document.querySelector('[data-person-request=\"request-2\"] img') === null"), true, 'refusal guidance is escaped, not interpreted as markup');
    assert.equal(await chrome.stable("document.querySelector('[data-person-request=\"request-2\"] .request-error')?.textContent"), 'UNKNOWN_SPEC ' + refusal, 'the original CLI refusal message stays intact');
    assert.equal(await chrome.stable('globalThis.requestInjection === undefined'), true, 'refusal content cannot execute in the page');
    assert.equal(await chrome.stable("document.querySelector('[data-person-request=\"request-2\"]')?.textContent.includes('run pullboard spec check')"), true);
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      assert.equal(await chrome.stable('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, `${width}px refusal view has no horizontal overflow`);
      const layout = JSON.parse(await chrome.stable(`JSON.stringify({
        statuses: [...document.querySelectorAll('.request-status')].map(node => node.textContent),
        listFits: document.querySelector('.request-list').scrollWidth <= document.querySelector('.request-list').clientWidth,
        readable: [...document.querySelectorAll('.request-label, .request-status, .request-error, .request-next')].every(node => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth && parseFloat(getComputedStyle(node).fontSize) >= 12;
        })
      })`));
      for (const status of ['Waiting', 'Done', 'Refused']) assert.ok(layout.statuses.includes(status), `${width}px renders ${status} from documented request status`);
      assert.equal(layout.listFits, true, `${width}px keeps the request list inside its panel`);
      assert.equal(layout.readable, true, `${width}px keeps request labels and refusal guidance readable`);
    }
    assert.deepEqual(intents, [
      { verb: 'shout', args: { to: 'coordinator', text: 'Please review this item.' } },
      { verb: 'spec-approve', args: { ids: 'G2' } },
      ...otherActions.map(([, , expected]) => expected),
    ]);
    const privatePath = await chrome.stable('boardPath(view.root)');
    const privateState = await (await fetchLive(live.base + privatePath + '/state', { headers: { 'x-pullboard-key': live.key } })).json();
    assert.equal(privateState.state.items.length, 1, 'the stand-in request transport never executes an item move on the real board');
    assert.equal(privateState.state.holds.length, 0, 'the request transport never changes a real lane hold');
    assert.equal(privateState.state.shouts.length, 1, 'the request transport never posts a direct shout');
  } finally {
    if (chrome) {
      if (!diagnosticEmitted) {
        try {
          const browserTrace = await chrome.stable('window.__personRequestReadingTrace?.serialize() ?? null');
          t.diagnostic(`person-request reading capture on original outcome: ${JSON.stringify({ clocks: { browser: 'performance.now()', fixture: 'Date.now()' }, requestTimeline, browserTrace })}`);
        } catch (error) {
          t.diagnostic(`person-request reading capture unavailable: ${error.name}: ${error.message}; fixture timeline: ${JSON.stringify(requestTimeline)}`);
        }
      }
      await chrome.stable('window.__personRequestReadingTrace?.dispose(); delete window.__personRequestReadingTrace').catch(() => undefined);
      chrome.socket.close();
      await stopOwnedChrome(chrome.child, chrome.stopped);
    }
    await new Promise((resolve) => pageServer.close(resolve));
    await live.stop();
  }
});

test('a person request never moves the reading position under a 6× CPU throttle [N26]', { timeout: 120_000 }, async t => { // budget: hang-only ceiling for real Chrome startup, private board setup and the sixfold request journey.
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the native sixfold person-request regression');

  const box = machine();
  const requestRows = Array.from({ length: 12 }, (_, index) => `- P${index + 1} [draft, must] Keep the reading position measurable. | gate: test`).join('\n');
  const spec = `# Person request fixture\n\n## G · Goals\n- G1 [approved, must] Existing item remains readable. | gate: test\n${requestRows}\n- G2 [draft, must] The person can approve this row. | gate: test\n`;
  const app = project(box, 'person request growth at sixfold CPU', spec);
  box.run(app.repo, 'add', 'web', 'Existing private item', '--specs', 'G1', '--criterion', 'remains readable');
  const live = await startView(box);
  const intents = [];
  const records = [];
  const requestTimeline = [];
  let chrome;
  let server;
  let traceArmed = false;
  /** Provide only the sealed person-request intent and actual private board reads. */
  const transportModule = `export async function createTransport() {
    return { async request(path, body) {
      if (body) {
        const response = await fetch('/intent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const document = await response.json();
        if (!response.ok) throw new Error(document.error?.message || String(response.status));
        return document;
      }
      const response = await fetch('/fixture' + path);
      const document = await response.json();
      if (!response.ok) throw new Error(document.error?.message || String(response.status));
      return document;
    } };
  }`;
  /** Serve the request receipts while proxying each board read to the real private view. */
  server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/') return response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(cockpitPage('', { readOnly: true, requests: true, transportModule: '/transport.js', stylesheet: '/view.css' }));
    if (url.pathname === '/transport.js') return response.writeHead(200, { 'content-type': 'text/javascript' }).end(transportModule);
    if (url.pathname === '/view.css') return response.writeHead(200, { 'content-type': 'text/css' })
      .end(readFileSync(resolve(import.meta.dirname, '../../src/view.css')));
    if (url.pathname === '/intent' && request.method === 'POST') {
      const receivedAt = Date.now();
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const move = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      intents.push(move);
      const row = { id: `request-${intents.length}`, sequence: intents.length, at: new Date(receivedAt).toISOString(), by: 'person', move, status: 'waiting' };
      records.push(row);
      requestTimeline.push({ clock: 'fixture-Date.now', type: 'intent-accepted', at: receivedAt, id: row.id, verb: move.verb });
      response.once('finish', () => requestTimeline.push({ clock: 'fixture-Date.now', type: 'intent-response-finished', at: Date.now(), id: row.id, status: response.statusCode }));
      return response.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ version: 1, event: { event_id: row.sequence, kind: 'request' }, result: { request: row } }));
    }
    if (url.pathname.startsWith('/fixture/')) {
      const receivedAt = Date.now();
      const upstream = await fetchLive(live.base + url.pathname.slice('/fixture'.length) + url.search, { headers: { 'x-pullboard-key': live.key } });
      const body = await upstream.json();
      if (url.pathname.endsWith('/state')) {
        requestTimeline.push({ clock: 'fixture-Date.now', type: 'state-read-start', at: receivedAt });
        body.state.personRequests = structuredClone(records);
        requestTimeline.push({ clock: 'fixture-Date.now', type: 'state-read-response', at: Date.now(), status: upstream.status });
      }
      return response.writeHead(upstream.status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    }
    return response.writeHead(404).end();
  });
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  try {
    chrome = await openSnapshotChrome(executable, `http://127.0.0.1:${server.address().port}/`, join(box.dir, 'person-request-growth-chrome'));
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor("typeof data === 'object' && !!data?.project");
    assert.equal(await chrome.stable('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true,
      'the 375px person-request view fits the viewport');
    await press(chrome, "document.querySelector('[data-tab=\"shouts\"]')");
    await chrome.stable("document.querySelector('#shout-to').value = 'person'");
    await chrome.stable("document.querySelector('#shout-text').value = 'Should this item ship?'");
    await chrome.stable("document.querySelector('#shout-form').requestSubmit()");
    await chrome.waitFor('data?.project?.personRequests?.length === 1');
    assert.deepEqual(intents[0], { verb: 'shout', args: { to: 'person', text: 'Should this item ship?' } },
      'the initial request is an actual literal person intent');

    await press(chrome, "document.querySelector('[data-tab=\"spec\"]')");
    await chrome.waitFor("document.querySelector('#spec-list [data-row=\"spec:G2\"]')");
    await chrome.stable("document.querySelector('#spec-list [data-row=\"spec:G2\"]').scrollIntoView({ block: 'center', behavior: 'instant' })");
    await chrome.waitFor('window.scrollY > 0');
    await press(chrome, "document.querySelector('#spec-list [data-row=\"spec:G2\"]')");
    await chrome.waitFor("view.row.spec === 'G2' && document.querySelector('#spec-detail button[data-row-decision=\"approve\"]')");
    const throttleResponse = await chrome.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    const throttle = { requestedRate: 6, commandResolved: true, protocolResponse: throttleResponse ?? null,
      computed: JSON.parse(await chrome.stable(`JSON.stringify({ viewport:{ width:innerWidth, height:innerHeight }, dpr:devicePixelRatio,
      body:{ fontSize:getComputedStyle(document.body).fontSize, lineHeight:getComputedStyle(document.body).lineHeight } })`)),
    };
    assert.equal(throttle.requestedRate, 6, 'the real Chrome throttle command requests sixfold CPU slowdown');
    assert.equal(throttle.commandResolved, true, 'the CPU-throttle command is acknowledged before the measured action');
    assert.deepEqual(throttle.computed.viewport, { width: 375, height: 900 }, 'the mutation-time capture uses the required phone viewport');
    const before = JSON.parse(await chrome.stable(`JSON.stringify({ scrollY, requestCount:document.querySelectorAll('#person-requests [data-person-request]').length,
      panel:(()=>{const n=document.querySelector('#person-requests'),r=n.getBoundingClientRect();return{height:r.height,documentTop:r.top+scrollY,overflowAnchor:getComputedStyle(n).overflowAnchor}})(),
      row:(()=>{const n=document.querySelector('#spec-list [data-row=\"spec:G2\"]'),r=n.getBoundingClientRect();return{connected:n.isConnected,top:r.top,documentTop:r.top+scrollY,height:r.height}})(),
      approveHeight:document.querySelector('#spec-detail button[data-row-decision=\"approve\"]').getBoundingClientRect().height })`));
    assert.equal(before.requestCount, 1, 'the person panel begins with one existing request');
    assert.ok(before.approveHeight >= 44, 'the actual approval target remains usable');
    assert.ok(before.scrollY > 0 && before.row.connected, 'the selected G2 row starts at a real scrolled reading position');
    await chrome.stable(`(() => {
      const box = () => {
        const panel=document.querySelector('#person-requests'), row=document.querySelector('#spec-list [data-row="spec:G2"]');
        const rect=node=>{if(!node)return null;const r=node.getBoundingClientRect();return{connected:node.isConnected,top:r.top,bottom:r.bottom,documentTop:r.top+scrollY,height:r.height}};
      return { at:performance.now(), scrollY, pageHeight:document.documentElement.scrollHeight,
          requestCount:panel.querySelectorAll('[data-person-request]').length, panel:rect(panel), row:rect(row),
          pageOverflowAnchor:getComputedStyle(document.documentElement).overflowAnchor, selected:view.row.spec };
      };
      const nativeScrollTo=window.scrollTo;
      const trace=window.__personRequestGrowthTrace={ initial:box(), events:[], mutationBatches:0, growth:null, scrollToCalls:[], preRestore:null, disposed:false };
      window.scrollTo=function(...args){
        const before=box();
        const growingPanel=before.requestCount===2 && before.panel.height>trace.initial.panel.height;
        if(growingPanel && !trace.preRestore)trace.preRestore={args,before};
        const result=nativeScrollTo.apply(window,args);
        const after=box();
        if(trace.scrollToCalls.length<12)trace.scrollToCalls.push({args,before,after});
        if(growingPanel && trace.preRestore && !trace.preRestore.after)trace.preRestore.after=after;
        return result;
      };
      trace.observer=new MutationObserver(changes=>{
        if(trace.disposed)return;
        const relevant=changes.some(change=>{
          const target=change.target.nodeType===1?change.target:change.target.parentElement;
          return target?.closest?.('#person-requests, #spec-list') || [...change.addedNodes,...change.removedNodes].some(node=>
            node.nodeType===1 && (node.matches?.('#person-requests, #spec-list') || node.querySelector?.('#person-requests, #spec-list')));
        });
        if(!relevant)return;
        trace.mutationBatches+=1;
        const sample=box();
        if(trace.events.length<40)trace.events.push(sample);
        if(sample.requestCount===2 && !trace.growth)trace.growth=sample;
      });
      trace.observer.observe(document.body,{childList:true,subtree:true,attributes:true,characterData:true,attributeFilter:['hidden','class','style']});
      trace.dispose=()=>{trace.disposed=true;trace.observer.disconnect();window.scrollTo=nativeScrollTo;};
    })()`);
    traceArmed = true;
    await press(chrome, "document.querySelector('#spec-detail button[data-row-decision=\"approve\"]')");
    await chrome.waitFor("data?.project?.personRequests?.length === 2 && document.querySelector('[data-person-request=\"request-2\"] .request-status')?.textContent === 'Waiting'");
    const capture = JSON.parse(await chrome.stable('JSON.stringify(window.__personRequestGrowthTrace ?? null)'));
    assert.ok(capture?.growth, 'the actual second-request DOM mutation captures the panel-growth instant');
    assert.equal(capture.growth.requestCount, 2, 'the captured mutation contains the real second request');
    assert.ok(capture.growth.panel.height > before.panel.height, 'the person panel grew before the browser movement assertion');
    assert.ok(capture.preRestore, 'the actual product restoration call is measured after panel growth');
    assert.equal(capture.preRestore.before.scrollY, before.scrollY,
      'person-request panel growth does not move the reading position before product restoration');
    assert.equal(capture.preRestore.after.scrollY, before.scrollY,
      'the existing product restoration keeps the original page position');
    assert.equal(capture.growth.pageOverflowAnchor, 'none', 'the live person-request page opts out of viewport anchoring');
    assert.equal(capture.growth.selected, 'G2', 'the selected reading row stays the same through panel growth');
    assert.deepEqual(intents[1], { verb: 'spec-approve', args: { ids: 'G2' } }, 'the measured action is the real G2 approval request');
    t.diagnostic(`sixfold person-request growth capture: ${JSON.stringify({ throttle, before, capture, intent:intents[1], timeline:requestTimeline,
      clocks:{ browser:'performance.now()', fixture:'Date.now()' } })}`);
  } finally {
    if (chrome) {
      if (traceArmed) {
        try {
          const trace=await chrome.stable('JSON.stringify(window.__personRequestGrowthTrace ?? null)');
          t.diagnostic(`sixfold person-request growth trace on original outcome: ${trace}`);
        } catch (error) { t.diagnostic(`sixfold person-request trace unavailable: ${error.name}: ${error.message}; timeline=${JSON.stringify(requestTimeline)}`); }
        await chrome.stable('window.__personRequestGrowthTrace?.dispose(); delete window.__personRequestGrowthTrace').catch(() => undefined);
      }
      await chrome.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => undefined);
      await closeSnapshotChrome(chrome);
    }
    await new Promise(resolvePromise => server.close(resolvePromise));
    await live.stop();
  }
});

test('read-only Needs-you preserves each entry as text while its transport stays read-only [N26,N27,B26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME to run the browser transport proof.');

  const box = machine();
  const app = project(box, 'read only transport', `${SPEC}- G3 [pending, must] Confirm the read-only question. | gate: review\n- G4 [draft, must] Confirm the draft row. | gate: review\n`);
  box.run(app.repo, 'add', 'web', 'Read-only fixture item', '--specs', 'G1', '--criterion', 'keeps action controls in the DOM');
  box.run(app.repo, 'shout', 'person', 'Should the read-only fixture ship?', '--decision');
  box.run(app.repo, 'hold', 'web', '--reason', 'read-only fixture hold');
  const live = await startView(box);
  const pageKey = 'page-relay-secret';
  const headerKey = 'header-relay-secret';
  const page = cockpitPage(pageKey, {
    readOnly: true,
    transportModule: '/transport.js',
    apiBase: 'https://private.invalid/board?secret=api-base-secret',
    apiHeaders: { 'x-pullboard-key': headerKey },
    stylesheet: '/view.css',
  });
  for (const secret of [pageKey, headerKey, 'api-base-secret']) assert.equal(page.includes(secret), false, 'custom transport page options do not expose API credentials');
  assert.throws(() => cockpitPage('', { transportModule: '' }), /transportModule/);

  const forwarded = [];
  const moduleSource = `export async function createTransport({ onUpdate }) {
    window.__transportCalls = [];
    window.__transportUpdate = onUpdate;
    return { async request(path, body) {
      window.__transportCalls.push({ path, body: body ?? null });
      const response = await fetch('/fixture' + path, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      const document = await response.json();
      if (!response.ok) throw new Error(document.error?.message || String(response.status));
      return document;
    } };
  }`;
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === '/missing') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(page);
      return;
    }
    if (url.pathname === '/transport.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(moduleSource);
      return;
    }
    if (url.pathname === '/view.css') {
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      response.end(readFileSync(new URL('../../src/view.css', import.meta.url), 'utf8'));
      return;
    }
    if (!url.pathname.startsWith('/fixture/')) {
      response.writeHead(404).end();
      return;
    }
    const target = url.pathname.slice('/fixture'.length) + url.search;
    const headers = { 'x-pullboard-key': live.key };
    if (request.method !== 'GET') {
      forwarded.push(request.method);
      response.writeHead(405, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'fixture transport accepts reads only' }));
      return;
    }
    forwarded.push(request.method);
    fetchLive(live.base + target, { headers }).then(async (reply) => {
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(await reply.text());
    }).catch((error) => {
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: String(error.message || error) }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-transport-chrome-'));
  scratch.push(profile);
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, live.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && !!data?.project && document.querySelector('#needs .row')?.textContent.includes('Should the read-only fixture ship?')");
    /** Read Needs-you labels with absolute API age timestamps so the comparison survives minute ticks. */
    const readNeedEntries = () => chrome.stable(`JSON.stringify([...document.querySelectorAll('#needs .row')].map((row) => {
      const time = row.querySelector('.row-age time'), ref = row.querySelector('.t > span');
      return [ref?.textContent, row.querySelector('.t').textContent.slice((ref?.textContent ?? '').length),
        row.querySelector('.meta .why').textContent + (time ? ' @' + time.dataset.ago : '')];
    }))`);
    const normalEntries = JSON.parse(await readNeedEntries());
    assert.deepEqual(normalEntries.map((row) => row[0]), [null, 'G3', 'web', '1'], 'the normal Needs-you list contains the decision, pending row, held lane, and draft summary');
    assert.match(normalEntries[0][2], /^NEEDS YOU a decision, asked by coordinator \(unknown\) @[^ ]+$/, 'the API-provided decision timestamp is shown as an age');
    assert.match(normalEntries[2][2], /^NEEDS YOU lane held by coordinator \(unknown\) @[^ ]+$/, 'the holder and API-provided hold timestamp are shown as an age');
    await chrome.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/` });
    await chrome.waitFor("typeof data === 'object' && document.body?.classList.contains('read-only') && !!data?.project && typeof window.__transportUpdate === 'function'");
    await chrome.waitFor("document.querySelector('#needs .row')?.textContent.includes('Should the read-only fixture ship?')");
    const readOnlyEntries = JSON.parse(await readNeedEntries());
    assert.deepEqual(readOnlyEntries, normalEntries, 'read-only Needs-you preserves the normal entries and their API-provided asker and ages');
    assert.equal(await chrome.stable("document.querySelectorAll('#needs button, #needs [data-go], #needs [data-new], #needs [data-shout], #needs [data-release]').length"), 0,
      'read-only Needs-you entries contain no answer, approve, navigation, or other action controls');
    const calls = JSON.parse(await chrome.stable('JSON.stringify(window.__transportCalls)'));
    assert.ok(calls.some((call) => call.path === '/api/v1/boards'));
    assert.ok(calls.some((call) => call.path.startsWith('/api/v1/boards/') && call.path.endsWith('/state')));
    assert.equal(await chrome.stable("document.querySelector('#live').textContent"), '', 'read-only transport keeps the page live, which says nothing');
    const actionSelectors = ['#new-item', '#add-form', '#shout-form', '#hold-form', '[data-release]', '[data-shout]', '[data-new]', '[data-go^="decide:"]'];
    const actionMatches = JSON.parse(await chrome.stable(`JSON.stringify(${JSON.stringify(actionSelectors)}.map((selector) => ({ selector, count: document.querySelectorAll(selector).length, visible: [...document.querySelectorAll(selector)].some((node) => !node.hidden && getComputedStyle(node).display !== 'none') })))`));
    assert.ok(actionMatches.every((entry) => entry.count > 0), 'the seeded item, decision and hold exercise every action selector');
    assert.deepEqual(actionMatches.filter((entry) => entry.visible).map((entry) => entry.selector), [], 'read-only mode hides every match for every action control');

    const refusedAction = JSON.parse(await chrome.stable(`(async () => JSON.stringify({ result: await act('shout', { to: 'all', text: 'blocked' }), message: document.querySelector('#console').textContent }))()`));
    assert.equal(refusedAction.result, false);
    assert.match(refusedAction.message, /read-only/i);
    const refusedApi = await chrome.stable(`(async () => { try { await api('/api/v1/boards/demo/moves', { verb: 'shout' }); return 'unexpected success'; } catch (error) { return error.message; } })()`);
    assert.match(refusedApi, /read-only/i, 'direct API mutation calls are refused before transport');
    assert.ok(forwarded.every((method) => method === 'GET'), 'read-only action attempts send no write through the transport');

    await chrome.stable(`window.__samePage = true; Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })`);
    box.run(app.repo, 'add', 'web', 'Transport refresh item', '--specs', 'G1', '--criterion', 'appears after a transport update');
    await chrome.stable('window.__transportUpdate()');
    assert.equal(await chrome.stable("data?.project?.items.some((item) => item.title === 'Transport refresh item') && window.__samePage === true"), true, 'onUpdate refreshes state in the same page without relying on the poll');
    assert.ok(forwarded.every((method) => method === 'GET'), 'transport update refreshed through reads only');

  } finally {
    if (chrome) {
      chrome.socket.close();
      await stopOwnedChrome(chrome.child, chrome.stopped);
    }
    await live.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a configured transport never falls back while loading or after import failure [N26,N27]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the transport startup proof.');

  const box = machine();
  const demo = project(box, 'transport-startup');
  box.run(demo.repo, 'add', 'web', 'Transport startup item', '--specs', 'G1', '--criterion', 'loads through the configured transport');
  const live = await startView(box);
  const slowPage = cockpitPage('', { transportModule: '/slow-transport.js' });
  const failedPage = cockpitPage('', { transportModule: '/failed-transport.js' });
  const localRequests = [];
  const relayRequests = [];
  let slowModuleRequested;
  const requested = new Promise((resolve) => { slowModuleRequested = resolve; });
  let releaseSlowModule;
  const slowModuleBarrier = new Promise((resolve) => { releaseSlowModule = resolve; });
  const transportSource = `export async function createTransport() {
    window.__transportReady = true;
    window.__transportCalls = [];
    return { async request(path, body) {
      window.__transportCalls.push(path);
      const response = await fetch('/relay' + path, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined });
      return response.json();
    } };
  }`;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/slow' || url.pathname === '/failed') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(url.pathname === '/slow' ? slowPage : failedPage);
      return;
    }
    if (url.pathname === '/slow-transport.js') {
      slowModuleRequested();
      await slowModuleBarrier;
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(transportSource);
      return;
    }
    if (url.pathname === '/failed-transport.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end("throw new Error('fixture transport import failed');");
      return;
    }
    if (url.pathname === '/view.css') {
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      response.end(readFileSync(new URL('../../src/view.css', import.meta.url), 'utf8'));
      return;
    }
    if (url.pathname.startsWith('/relay/')) {
      const path = url.pathname.slice('/relay'.length) + url.search;
      relayRequests.push(path);
      try {
        const reply = await fetchLive(live.base + path, { headers: { 'x-pullboard-key': live.key } });
        response.writeHead(reply.status, { 'content-type': 'application/json' });
        response.end(await reply.text());
      } catch (error) {
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: String(error.message || error) }));
      }
      return;
    }
    if (url.pathname.startsWith('/api/v1/')) {
      localRequests.push(url.pathname);
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'LOCAL_FALLBACK', message: 'the page-local API must not be used' } }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-transport-startup-chrome-'));
  let chrome;
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    chrome = await openSnapshotChrome(executable, `${origin}/slow`, profile);
    await requested;
    const loadingCall = await chrome.stable("api('/api/v1/boards').then(() => 'unexpected success', error => error.message)");
    assert.match(loadingCall, /transport.*loading/i, 'direct API calls refuse while the configured module is loading');
    await browserPause(3200);
    assert.equal(await chrome.stable('window.__transportReady === true'), false, 'the delayed module is still loading during the proof');
    assert.deepEqual(localRequests, [], 'neither direct reads nor the poll fall back while loading');

    releaseSlowModule();
    await chrome.waitFor('window.__transportReady === true && !!data?.project');
    assert.ok(relayRequests.includes('/api/v1/boards'), 'the initial board read uses the configured transport');
    assert.deepEqual(localRequests, [], 'loading the configured module never touched the page-local API');

    await chrome.send('Page.navigate', { url: `${origin}/failed` });
    await chrome.waitFor("document.querySelector('#live').textContent.includes('fixture transport import failed')");
    await browserPause(3200);
    assert.match(await chrome.stable("document.querySelector('#live').textContent"), /cannot reach the view: fixture transport import failed/,
      'the original module error remains visible after later poll intervals');
    assert.deepEqual(localRequests, [], 'a failed import also disables page-local polling');
  } finally {
    releaseSlowModule();
    if (chrome) await closeSnapshotChrome(chrome);
    await live.stop();
    await new Promise((resolve) => server.close(resolve));
    rmSync(profile, { recursive: true, force: true });
  }
});
