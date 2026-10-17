/** The hosted page reads this machine's view straight, and the view answers only its own page and that one [N26,A2]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cockpitPage } from '../../src/cockpit.js';
import { Refused } from '../../src/refused.js';
import { createRelayBrowserHandler } from '../../relay/browser-page.js';
import { BIN, machine, project, startView, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, styleOf, proofShot } from './fixture.js';

const HOSTED = 'https://app.pullboard.dev';
const LOCAL = 'http://127.0.0.1:4890';

/** Start the real view on a named port, as pullboard view does, and wait until it answers its printed link. */
async function viewAt(box, port) {
  const child = spawn(process.execPath, [BIN, 'view', '--no-open', '--port', String(port)], { cwd: box.dir, env: { ...box.env, PULLBOARD_VIEW_FOREGROUND: '1' } });
  const stop = () => new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    child.once('exit', done);
    child.kill('SIGTERM');
  });
  try {
    const link = await new Promise((found, fail) => {
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += chunk;
        const match = /Pullboard view: (http:\/\/127\.0\.0\.1:\d+\/\?k=\S+)/.exec(out);
        if (match) found(new URL(match[1]));
      });
      child.once('exit', (code) => fail(new Error(`view exited ${code}: ${out}`)));
    });
    return { link, key: link.searchParams.get('k'), base: link.origin, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** One plain HTTP request to the view, with exactly these headers, following nothing. */
function call(view, path, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((done, fail) => {
    const outgoing = request(new URL(path, view.base), { method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.on('error', fail);
    outgoing.end(body);
  });
}

/** Where a round-trip page sends the browser: the one address its script replaces the page with. */
function onwardOf(page) {
  const literal = /location\.replace\(("(?:\\.|[^"\\])*")\)/.exec(page)?.[1];
  assert.ok(literal, 'the page sends the browser to one address');
  return new URL(JSON.parse(literal));
}

/**
 * Stand in for the hosted page at its real origin, and for this machine's default view address. Chrome answers every
 * request for https://app.pullboard.dev with the cockpit the relay would serve there and the view's styles. A request
 * for http://127.0.0.1:4890 goes to the view the test runs on its own port, as if that view held the default one, or
 * meets a closed port when the test names none: the suite never binds the machine's 4890, where a person's own view
 * may run. Every other request, to the view's own port, is untouched and meets Chrome's own cross-origin rules.
 */
async function hostedStandIn(chrome, pages, styles, local) {
  const failures = [];
  const tasks = [];
  const listener = ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.method !== 'Fetch.requestPaused') return;
    tasks.push((async () => {
      const { requestId, resourceType, request: asked } = message.params;
      const address = new URL(asked.url);
      if (address.origin === LOCAL) {
        if (!local.target) return chrome.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' });
        const headers = Object.fromEntries(Object.entries(asked.headers).filter(([name]) => name.toLowerCase() !== 'host'));
        const reply = await call({ base: local.target }, address.pathname + address.search, { method: asked.method, headers, body: asked.postData ?? '' });
        return chrome.send('Fetch.fulfillRequest', {
          requestId, responseCode: reply.status,
          responseHeaders: Object.entries(reply.headers).filter(([name]) => !['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'date'].includes(name)).map(([name, value]) => ({ name, value: String(value) })),
          body: Buffer.from(reply.body).toString('base64'),
        });
      }
      if (address.pathname === '/relay/client.js' && local.client) {
        return chrome.send('Fetch.fulfillRequest', {
          requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }, { name: 'Cache-Control', value: 'no-store' }],
          body: Buffer.from(local.client).toString('base64'),
        });
      }
      if (address.pathname === '/api/v1/boards') {
        return chrome.send('Fetch.fulfillRequest', {
          requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }],
          body: Buffer.from(JSON.stringify({ version: 1, boards: local.linked ?? [], warnings: [] })).toString('base64'),
        });
      }
      const document = resourceType === 'Document';
      const page = address.search === '?relay' ? pages.relay : pages.anonymous;
      await chrome.send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: document ? 'text/html; charset=utf-8' : 'text/css; charset=utf-8' },
          { name: 'Cache-Control', value: 'no-store' },
          // The connections #533's relay page allows, its own origin and the local view's default address, and here the
          // test view's own port, which the round trip names.
          ...(document ? [{ name: 'Content-Security-Policy', value: `connect-src 'self' ${LOCAL} http://localhost:4890 ${local.own}; frame-ancestors 'none'` }] : []),
        ],
        body: Buffer.from(document ? page : styles).toString('base64'),
      });
    })().catch((error) => failures.push(error.message)));
  };
  chrome.socket.addEventListener('message', listener);
  await chrome.send('Fetch.enable', { patterns: [{ urlPattern: HOSTED + '/*', requestStage: 'Request' }, { urlPattern: LOCAL + '/*', requestStage: 'Request' }] });
  return async () => {
    chrome.socket.removeEventListener('message', listener);
    try { await Promise.all(tasks); } finally { await chrome.send('Fetch.disable'); }
    assert.deepEqual(failures, [], 'the stand-in hosted page was served');
  };
}

test('a pullboard.dev page reads the local board [N26,A2]', { timeout: 120_000 }, async () => { // budget: hang ceiling for two real round trips in Chrome, a view restart and the unreachable cases.
  const executable = chromeExecutable();
  assert.ok(executable, 'the hosted page check needs real Chrome');
  const box = machine();
  const board = project(box, 'hosted-local');
  box.run(board.repo, 'add', 'web', 'A board that stays on this machine', '--specs', 'G1');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-local-origin-'));
  let view, chrome, stopStandIn, other;
  try {
    view = await startView(box);
    const port = view.link.port;
    const local = { own: view.base, target: null };
    chrome = await openSnapshotChrome(executable, 'about:blank', profile);
    // Each fetch the hosted page makes, with what the page showed and where its address stood as it made it.
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      if (location.origin !== ${JSON.stringify(HOSTED)}) return;
      const nativeFetch = window.fetch.bind(window);
      const log = window.__localFetches = [];
      window.fetch = (input, init) => {
        const note = document.getElementById('local-note');
        log.push({ url: String(typeof input === 'string' ? input : input.url), address: location.href, note: note ? !note.hidden : false, text: document.getElementById('local-note-text')?.textContent ?? '' });
        return nativeFetch(input, init);
      };
    })()` });
    // The page as relay/browser-page.js serves it, with its own banner, which the relay client fills.
    const relayPage = (relaySession) => cockpitPage('', { readOnly: true, requests: true, transportModule: '/relay/client.js', apiHeaders: {}, stylesheet: '/view.css', hostedLocal: true, relaySession, signIn: '/auth/github/start' })
      .replace('<main>', '<main><section class="card-panel" id="relay-notice" role="status"><p>Pairing this browser…</p></section>');
    const banner = "document.querySelector('#relay-notice').hidden";
    stopStandIn = await hostedStandIn(chrome, { anonymous: relayPage(false), relay: relayPage(true) }, await styleOf(view), local);
    const trips = () => chrome.requests.filter((entry) => new URL(entry.url).pathname === '/local/connect').length;
    const relayModule = () => chrome.requests.filter((entry) => entry.url === HOSTED + '/relay/client.js').length;
    /** Wait until the page has asked for the relay module this many times in all. */
    const relayAsked = async (times) => {
      for (const deadline = Date.now() + 10_000; relayModule() < times && Date.now() < deadline;) await new Promise((later) => setTimeout(later, 50)); // budget: hang ceiling for the relay module request.
      assert.equal(relayModule(), times, 'the page loads the relay module');
    };
    const localFetches = "JSON.stringify((window.__localFetches || []).filter((entry) => entry.url.startsWith('http://127.0.0.1:')))";

    // With no view on this machine, the page says why and links the local view; a person with no relay session gets
    // the sign-in link and the relay module is never loaded, while one with a session gets the relay page. The browser
    // has not been allowed to reach this device yet, so the page says why it may ask before it first asks.
    await view.stop();
    await chrome.send('Page.navigate', { url: HOSTED + '/' });
    await chrome.waitFor("location.search === '' && /cannot reach a local view/.test(document.querySelector('#local-note-text')?.textContent)", 20_000); // budget: hang ceiling for one refused loopback request.
    const asked = JSON.parse(await chrome.stable(localFetches));
    assert.equal(asked[0]?.url, LOCAL + '/local/protocol', 'the page first reads the public protocol at the default address');
    assert.ok(asked[0].note && /may ask to let this page reach apps on this device/.test(asked[0].text), `the line saying why the browser may ask is on screen before that request: ${JSON.stringify(asked[0])}`);
    const away = JSON.parse(await chrome.stable("JSON.stringify({ links: !document.querySelector('#local-note-links').hidden, view: document.querySelector('#local-note-view').href, signIn: document.querySelector('#local-note-sign-in').hidden ? null : document.querySelector('#local-note-sign-in').getAttribute('href') })"));
    assert.deepEqual(away, { links: true, view: LOCAL + '/local/view', signIn: '/auth/github/start' }, 'an unreachable view is named, with the local view and sign-in linked');
    assert.equal(relayModule(), 0, 'without a relay session the relay module is never loaded');
    assert.equal(await chrome.stable(banner), true, 'and the relay\'s banner does not speak for it');
    await chrome.send('Page.navigate', { url: HOSTED + '/?relay' });
    await chrome.waitFor("location.search === '?relay' && !document.querySelector('#local-note-links').hidden", 20_000); // budget: hang ceiling for one refused loopback request.
    // A browser that has since refused this page the access is named as the reason, as it is the one the page knows.
    const second = JSON.parse(await chrome.stable(`(async () => JSON.stringify({ text: document.querySelector('#local-note-text').textContent, permission: await navigator.permissions.query({ name: 'loopback-network' }).then((p) => p.state, () => null) }))()`));
    assert.match(second.text, second.permission === 'denied' ? /has refused this page access to apps on this device/ : /cannot reach a local view/, `the page names what it knows: ${JSON.stringify(second)}`);
    await relayAsked(1);
    assert.equal(await chrome.stable("document.querySelector('#local-note-sign-in').hidden"), true, 'a person with a relay session is not asked to sign in');
    assert.equal(await chrome.stable(banner), false, 'and the relay page keeps its banner');
    // A relay pairing link stays the relay's: the page does not look for this machine on that load.
    await chrome.send('Page.navigate', { url: HOSTED + '/#board=b1&key=k1' });
    await relayAsked(2);
    assert.deepEqual(JSON.parse(await chrome.stable(localFetches)), [], 'a pairing load makes no request to the local view');
    // A person who allowed this page to reach this device. One grant refuses every permission it does not name, and
    // the names differ between Chrome versions, so the widest set this Chrome knows is granted at once.
    for (const permissions of [['loopbackNetwork', 'localNetwork', 'localNetworkAccess'], ['localNetworkAccess']]) {
      try { await chrome.send('Browser.grantPermissions', { origin: HOSTED, permissions }); break; } catch { /* a name this Chrome does not have */ }
    }
    // A view that speaks another protocol is named as not matching this page.
    other = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': HOSTED });
      res.end(JSON.stringify({ version: 2, apiVersion: 2, hostedOrigin: HOSTED }));
    });
    await new Promise((ready) => other.listen(0, '127.0.0.1', ready));
    local.target = 'http://127.0.0.1:' + other.address().port;
    await chrome.send('Page.navigate', { url: HOSTED + '/?other' });
    await chrome.waitFor("location.search === '?other' && /does not match this page/.test(document.querySelector('#local-note-text')?.textContent)", 20_000); // budget: hang ceiling for one loopback request.
    assert.equal(trips(), 0, 'no round trip starts toward a view the page cannot use');

    // This machine's view: the page finds it at the default address, goes round for its secret, and reads the board.
    view = await viewAt(box, port);
    local.target = view.base;
    await chrome.send('Page.navigate', { url: HOSTED + '/' });
    await chrome.waitFor("location.origin === 'https://app.pullboard.dev' && document.querySelector('#chain')?.textContent.includes('A board that stays on this machine')", 30_000); // budget: hang ceiling for the discovery, one top-level round trip and the first board read.
    const shown = JSON.parse(await chrome.stable(`JSON.stringify({ address: location.href, base: connection.base, readOnly, transportModule, kept: sessionStorage.getItem('pullboard.local.session'), lasting: Object.keys(localStorage).map((name) => localStorage.getItem(name)).join(' '), log: window.__localFetches })`));
    assert.ok(!shown.address.includes('pullboard-local') && !shown.address.includes(view.key), 'the secret is gone from the address bar');
    assert.equal(shown.base, view.base, 'the page reads the local view the round trip named');
    assert.equal(shown.readOnly, false, 'the local board is not read-only');
    assert.equal(shown.transportModule, null, 'the relay transport is never loaded');
    assert.equal(await chrome.stable(banner), true, 'and the relay\'s banner is hidden over the local board');
    assert.deepEqual(JSON.parse(shown.kept), { version: 1, origin: view.base, key: view.key }, 'the session is kept for this tab');
    assert.ok(!shown.lasting.includes(view.key), 'nothing lasting holds the secret');
    const atDefault = chrome.requests.map((entry) => entry.url).filter((url) => url.startsWith(LOCAL));
    assert.deepEqual(atDefault.slice(-2), [LOCAL + '/local/protocol', LOCAL + '/local/connect'], 'the page found the view at the default address, then went round to it at the top level');
    const reads = shown.log.filter((entry) => entry.url.startsWith(view.base));
    assert.ok(reads.every((entry) => !entry.address.includes('pullboard-local')), 'no request is made while the secret is in the address');
    assert.ok(reads.some((entry) => entry.url.startsWith(view.base + '/api/')), 'the page reads the board through the view\'s API');
    assert.equal(trips(), 1, 'the page itself started one top-level round trip');
    const api = chrome.requests.filter((entry) => entry.url.startsWith(view.base + '/api/') && entry.method !== 'OPTIONS');
    assert.ok(api.length > 0 && api.every((entry) => Object.entries(entry.headers).some(([name, value]) => name.toLowerCase() === 'x-pullboard-key' && value === view.key)), 'every API request carries the secret in x-pullboard-key');
    assert.ok(chrome.requests.every((entry) => !new URL(entry.url).search.includes(view.key)), 'no request carries the secret in its query');

    // The view restarts with a new secret: the page goes round again by itself.
    const before = view.key;
    await view.stop();
    view = await viewAt(box, port);
    local.target = view.base;
    assert.notEqual(view.key, before, 'the restarted view has a new secret');
    await chrome.waitFor(`connection.headers['x-pullboard-key'] === ${JSON.stringify(view.key)} && document.querySelector('#chain')?.textContent.includes('A board that stays on this machine')`, 45_000); // budget: hang ceiling for the next refresh to meet the refusal, a second round trip and a read.
    assert.equal(trips(), 2, 'the page repeated the round trip without the person');
    assert.ok(!(await chrome.stable('location.href')).includes(view.key), 'the new secret is gone from the address bar too');
    assert.ok(chrome.requests.every((entry) => !new URL(entry.url).search.includes(view.key) && !new URL(entry.url).search.includes(before)), 'neither secret ever rode in a query');
    // A signed-in person with only local boards has no need for the decrypting relay client. The metadata
    // read is on the hosted origin and must never carry this machine's local credential.
    const modulesBefore = relayModule();
    const metadataBefore = chrome.requests.filter((entry) => entry.url === HOSTED + '/api/v1/boards').length;
    await chrome.send('Page.navigate', { url: HOSTED + '/?relay' });
    await chrome.waitFor("location.search === '?relay' && document.querySelector('#chain')?.textContent.includes('A board that stays on this machine')", 20_000); // budget: hang ceiling for a tab-session read and empty linked-board metadata.
    await chrome.waitFor("(window.__localFetches || []).some((entry) => entry.url === '/api/v1/boards')", 10_000); // budget: hang ceiling for the same-origin metadata request.
    assert.equal(await chrome.stable('transportModule'), null, 'an empty linked list leaves the relay transport unloaded even when signed in');
    assert.equal(relayModule(), modulesBefore, 'a local-only signed-in page does not request the relay module');
    const metadata = chrome.requests.filter((entry) => entry.url === HOSTED + '/api/v1/boards').slice(metadataBefore);
    assert.ok(metadata.length > 0, 'the signed-in page checked its linked-board metadata');
    assert.ok(metadata.every((entry) => !Object.keys(entry.headers).some((name) => name.toLowerCase() === 'x-pullboard-key')), 'same-origin metadata never gets the local secret header');
    assert.equal(await chrome.stable('readOnly'), false, 'the local board remains writable');
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught exceptions');
    // A local read that fails once, as while the view restarts or is busy, is no reason to load the relay module
    // either: this person's linked list is empty, so the page reads the view again instead (#748).
    const { identifier: failOnce } = await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      if (location.origin !== ${JSON.stringify(HOSTED)} || sessionStorage.getItem('pullboard.test.fail-local-list') !== '1') return;
      sessionStorage.removeItem('pullboard.test.fail-local-list');
      const nextFetch = window.fetch;
      window.fetch = (input, init) => {
        if (!window.__localListFailed && String(typeof input === 'string' ? input : input.url) === ${JSON.stringify(view.base + '/api/v1/boards')}) {
          window.__localListFailed = true;
          return Promise.reject(new TypeError('Failed to fetch'));
        }
        return nextFetch(input, init);
      };
    })()` });
    assert.equal(await chrome.stable("(() => { sessionStorage.setItem('pullboard.test.fail-local-list', '1'); return true; })()"), true, 'the next load meets one failed local read');
    await chrome.send('Page.navigate', { url: HOSTED + '/?relay' });
    await chrome.waitFor("location.search === '?relay' && window.__localListFailed === true && document.querySelector('#chain')?.textContent.includes('A board that stays on this machine')", 20_000); // budget: hang ceiling for one failed read and the next timed refresh.
    await chrome.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: failOnce });
    assert.equal(relayModule(), modulesBefore, 'a failed local read on a local-only signed-in page does not request the relay module');
    assert.equal(await chrome.stable('transportModule'), null, 'and the relay transport stays unloaded');
    assert.deepEqual(chrome.exceptions, [], 'the failed read is handled: Chrome reports no uncaught exceptions');
  } finally {
    try { if (stopStandIn) await stopStandIn(); }
    finally {
      try { if (chrome) await closeSnapshotChrome(chrome); }
      finally {
        try { if (other) await new Promise((closed) => { other.close(closed); other.closeAllConnections(); }); }
        finally {
          try { if (view) await view.stop(); }
          finally { rmSync(profile, { recursive: true, force: true }); }
        }
      }
    }
  }
});


test('a signed-in local view with linked metadata and no paired transport says how to pair [N26,H5]', { timeout: 60_000 }, async () => { // budget: one real local-view discovery/round trip and the resulting hosted list read.
  const executable = chromeExecutable();
  assert.ok(executable, 'the mixed local and relay state check needs real Chrome');
  const box = machine();
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-local-unpaired-'));
  const linked = [{ id: 'a'.repeat(32), repository: 'acme/web', linkedAt: 0 }];
  const client = 'export function rememberPairing() { return null; }\nexport async function createTransport() { return { async request(path) { if (path === "/api/v1/boards") { globalThis.__749transportListCalls = (globalThis.__749transportListCalls || 0) + 1; return { version: 1, boards: [], warnings: [] }; } throw new Error("no paired board"); } }; }\n';
  let view, chrome, stopStandIn;
  try {
    view = await startView(box);
    const direct = await call(view, '/api/v1/boards', { headers: { 'x-pullboard-key': view.key } });
    assert.equal(direct.status, 200, 'the real private view answers with its valid session key');
    assert.deepEqual(JSON.parse(direct.body).boards, [], 'the private view genuinely has no boards');
    chrome = await openSnapshotChrome(executable, 'about:blank', profile);
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      if (location.origin !== ${JSON.stringify(HOSTED)}) return;
      const nativeFetch = window.fetch.bind(window);
      window.__749fetches = [];
      window.fetch = async (input, init) => {
        const response = await nativeFetch(input, init);
        const address = new URL(String(typeof input === 'string' ? input : input.url), location.href);
        if (address.origin === ${JSON.stringify(HOSTED)} || ['127.0.0.1', 'localhost'].includes(address.hostname)) window.__749fetches.push({ origin: address.origin, path: address.pathname, status: response.status });
        return response;
      };
    })()` });
    const page = cockpitPage('', { readOnly: true, requests: true, transportModule: '/relay/client.js', apiHeaders: {}, stylesheet: '/view.css', hostedLocal: true, relaySession: true, signIn: '/auth/github/start' })
      .replace('<main>', '<main><section class="card-panel" id="relay-notice" role="status"><p>Relay status</p></section>');
    stopStandIn = await hostedStandIn(chrome, { anonymous: page, relay: page }, await styleOf(view), {
      own: view.base, target: view.base, linked,
      client,
    });
    for (const permissions of [['loopbackNetwork', 'localNetwork', 'localNetworkAccess'], ['localNetworkAccess']]) {
      try { await chrome.send('Browser.grantPermissions', { origin: HOSTED, permissions }); break; } catch { /* a name this Chrome does not have */ }
    }
    await chrome.send('Page.navigate', { url: HOSTED + '/' });
    // Wait for all independent authorities to finish, then make the state assertion directly. The condition does not
    // wait for an unpaired label; loading must finish before the semantic assertion, including the final metadata read.
    await chrome.waitFor(`location.origin === 'https://app.pullboard.dev' && sessionStorage.getItem('pullboard.local.session') && (window.__749fetches || []).some((x) => x.origin === ${JSON.stringify(view.base)} && x.path === '/api/v1/boards' && x.status === 200) && (window.__749fetches || []).some((x) => x.origin === 'https://app.pullboard.dev' && x.path === '/api/v1/boards' && x.status === 200) && window.__749transportListCalls >= 1 && !document.body.classList.contains('loading')`, 30_000); // budget: local discovery, round trip, local list, linked metadata, and empty paired transport.
    const seen = JSON.parse(await chrome.stable(`JSON.stringify({
      state: document.querySelector('#local-note')?.dataset.state ?? null,
      hidden: document.querySelector('#local-note')?.hidden ?? true,
      heading: document.querySelector('#local-note-title')?.textContent.trim() ?? null,
      text: document.querySelector('#local-note-text')?.textContent.trim() ?? null,
      command: document.querySelector('#local-note-code')?.textContent.trim() ?? null,
      hasSession: Boolean(sessionStorage.getItem('pullboard.local.session')),
      sessionOrigin: JSON.parse(sessionStorage.getItem('pullboard.local.session'))?.origin ?? null,
      localSessionMatches: (() => { const saved = JSON.parse(sessionStorage.getItem('pullboard.local.session')); return saved?.version === 1 && saved.origin === ${JSON.stringify(view.base)} && saved.key === ${JSON.stringify(view.key)}; })(),
      fetches: window.__749fetches,
      transportLists: window.__749transportListCalls,
      cards: document.querySelectorAll('#proj-list .proj').length,
    })`));
    assert.equal(seen.hasSession, true, 'the browser holds a tab-scoped local-view session');
    assert.equal(seen.sessionOrigin, view.base, 'the session names this private view');
    assert.equal(seen.localSessionMatches, true, 'the browser uses the private view session without returning its secret');
    assert.ok(seen.transportLists >= 1, 'the relay transport confirmed its real empty paired-board list');
    assert.ok(seen.fetches.some((x) => x.origin === view.base && x.path === '/api/v1/boards' && x.status === 200), 'the hosted page read the reachable private view');
    assert.ok(seen.fetches.some((x) => x.origin === 'https://app.pullboard.dev' && x.path === '/api/v1/boards' && x.status === 200), 'the hosted page read the signed-in account metadata');
    assert.equal(seen.state, 'unpaired', `linked account metadata with no paired transport must show pairing guidance, not the generic local empty state: ${JSON.stringify(seen)}`);
    assert.equal(seen.hidden, false);
    assert.equal(seen.heading, 'Pair this browser');
    assert.match(seen.text, /acme\/web/);
    assert.equal(seen.command, 'pullboard relay on --all');
    assert.match(seen.text, /scan its QR/, 'the pairing guidance tells the person to use the QR printed by relay on --all');
    assert.equal(seen.cards, 0, 'no local or paired board is falsely shown');
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught exceptions');
  } finally {
    try { if (stopStandIn) await stopStandIn(); }
    finally {
      try { if (chrome) await closeSnapshotChrome(chrome); }
      finally {
        try { if (view) await view.stop(); }
        finally { rmSync(profile, { recursive: true, force: true }); }
      }
    }
  }
});

test('a foreign origin or wrong Host is refused by the local view [N26,A2]', { timeout: 60_000 }, async () => { // budget: hang ceiling for one real view and a few local requests.
  const box = machine();
  project(box, 'local-origin-refusals');
  const view = await startView(box);
  try {
    const port = view.link.port;
    const key = { 'x-pullboard-key': view.key };
    // Another site, even holding the secret, gets a plain refusal and no permission to read it.
    for (const path of ['/api/v1/boards', '/local/protocol', '/local/connect', '/?k=' + view.key]) {
      const foreign = await call(view, path, { headers: { ...key, origin: 'https://foreign.example' } });
      assert.equal(foreign.status, 403, `a foreign origin is refused at ${path.replace(view.key, '<key>')}`);
      assert.equal(foreign.headers['access-control-allow-origin'], undefined, 'and is not allowed to read the answer');
      assert.equal(JSON.parse(foreign.body).error, 'this view answers its own page and https://app.pullboard.dev only');
      assert.ok(!foreign.body.includes(view.key));
    }
    const foreignWrite = await call(view, '/api/v1/boards', { method: 'POST', headers: { ...key, origin: 'https://foreign.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(foreignWrite.status, 403, 'a foreign origin cannot write');
    const foreignPreflight = await call(view, '/api/v1/boards', { method: 'OPTIONS', headers: { origin: 'https://foreign.example', 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-pullboard-key' } });
    assert.equal(foreignPreflight.status, 403, 'a foreign preflight is refused');
    assert.equal(foreignPreflight.headers['access-control-allow-private-network'], undefined);
    // A name of another site pointed at 127.0.0.1, as DNS rebinding sends it, reaches nothing.
    for (const path of ['/local/protocol', '/local/connect', '/?k=' + view.key]) {
      const rebound = await call(view, path, { headers: { ...key, host: 'foreign.example:' + port } });
      assert.equal(rebound.status, 403, `a wrong Host is refused at ${path.replace(view.key, '<key>')}`);
      assert.ok(!rebound.body.includes(view.key));
    }
    const reboundApi = await call(view, '/api/v1/boards', { headers: { ...key, host: 'foreign.example:' + port } });
    assert.equal(reboundApi.status, 401, 'the API refuses a wrong Host in its own words');
    assert.equal(JSON.parse(reboundApi.body).error.code, 'AUTH_REQUIRED');
    // The hosted page itself is refused without the secret in its header.
    const bare = await call(view, '/api/v1/boards', { headers: { origin: HOSTED } });
    assert.equal(bare.status, 403, 'the allowed origin without the secret is refused');
    assert.ok(!bare.body.includes(view.key));
    const queried = await call(view, '/api/v1/boards?k=' + view.key, { headers: { origin: HOSTED } });
    assert.equal(queried.status, 403, 'the allowed origin may not send the secret in a query');
    const bearer = await call(view, '/api/v1/boards', { headers: { origin: HOSTED, authorization: 'Bearer ' + view.key } });
    assert.equal(bearer.status, 403, 'nor in another header');
    const wrongKey = await call(view, '/api/v1/boards', { headers: { origin: HOSTED, 'x-pullboard-key': 'not-' + view.key } });
    assert.equal(wrongKey.status, 401, 'nor with a wrong secret');
    // With its header, the hosted page reads and writes, writes only as JSON.
    const preflight = await call(view, '/api/v1/boards', { method: 'OPTIONS', headers: { origin: HOSTED, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-pullboard-key', 'access-control-request-private-network': 'true' } });
    assert.equal(preflight.status, 204, 'the hosted page\'s preflight is answered');
    assert.equal(preflight.headers['access-control-allow-origin'], HOSTED);
    assert.equal(preflight.headers['access-control-allow-private-network'], 'true');
    assert.match(preflight.headers['access-control-allow-headers'], /x-pullboard-key/);
    assert.match(preflight.headers.vary, /Origin/);
    const widened = await call(view, '/api/v1/boards', { method: 'OPTIONS', headers: { origin: HOSTED, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
    assert.equal(widened.status, 403, 'a preflight for any other header is refused');
    const read = await call(view, '/api/v1/boards', { headers: { ...key, origin: HOSTED } });
    assert.equal(read.status, 200, 'the hosted page reads with its header');
    assert.equal(read.headers['access-control-allow-origin'], HOSTED);
    const id = JSON.parse(read.body).boards[0].id;
    const shout = JSON.stringify({ verb: 'shout', args: { to: 'all', text: 'from the hosted page' } });
    const plain = await call(view, `/api/v1/boards/${id}/moves`, { method: 'POST', headers: { ...key, origin: HOSTED, 'content-type': 'text/plain' }, body: shout });
    assert.equal(plain.status, 400, 'a write that is not JSON is refused, as a form could send it');
    const moved = await call(view, `/api/v1/boards/${id}/moves`, { method: 'POST', headers: { ...key, origin: HOSTED, 'content-type': 'application/json' }, body: shout });
    assert.equal(moved.status, 200, `the hosted page writes as JSON: ${moved.body}`);
    // The view's own page and its printed link are as before.
    const own = await call(view, '/api/v1/boards', { headers: { ...key, origin: view.base } });
    assert.equal(own.status, 200, 'the view\'s own page still reads');
    assert.equal(own.headers['access-control-allow-origin'], undefined, 'and needs no cross-origin permission');
    assert.equal((await call(view, view.link.pathname + view.link.search)).status, 200, 'the printed link still opens the board');
  } finally {
    await view.stop();
  }
});

test('every hosted page state says what it is and what to do next [N26,H5]', { timeout: 120_000 }, async () => { // budget: hang ceiling for six hosted page loads in Chrome, one with a real round trip.
  const executable = chromeExecutable();
  assert.ok(executable, 'the hosted page check needs real Chrome');
  const box = machine();
  const board = project(box, 'hosted-states');
  box.run(board.repo, 'add', 'web', 'A board the hosted page lists', '--specs', 'G1');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-hosted-states-'));
  const relay = createRelayBrowserHandler({ authenticate: async () => { if (stand.signedIn) return { kind: 'session' }; throw new Refused('AUTH_REQUIRED', 'Sign in.'); } });
  // What the stand-in answers: the relay's real page and assets, a relay client that has paired no board, the
  // account's linked boards, and this machine's default view address, closed unless the test names a view.
  const stand = { signedIn: false, linked: [], local: null };
  const client = 'export function rememberPairing() { return null; }\nexport async function createTransport() { return { async request(path) { if (path === "/api/v1/boards") return { version: 1, boards: [], warnings: [] }; throw new Error("no paired board"); } }; }\n';
  let view, chrome, listener, old;
  const failures = [];
  try {
    view = await startView(box);
    chrome = await openSnapshotChrome(executable, 'about:blank', profile);
    listener = ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.method !== 'Fetch.requestPaused') return;
      const { requestId, request: asked } = message.params;
      const address = new URL(asked.url);
      const fulfil = (type, body, headers = []) => chrome.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Cache-Control', value: 'no-store' }, ...headers], body: Buffer.from(body).toString('base64') });
      (async () => {
        if (address.origin === LOCAL) {
          if (!stand.local) return chrome.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' });
          const reply = await call({ base: stand.local }, address.pathname + address.search, { method: asked.method, headers: Object.fromEntries(Object.entries(asked.headers).filter(([name]) => name.toLowerCase() !== 'host')) });
          return chrome.send('Fetch.fulfillRequest', { requestId, responseCode: reply.status, responseHeaders: Object.entries(reply.headers).filter(([name]) => !['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'date'].includes(name)).map(([name, value]) => ({ name, value: String(value) })), body: Buffer.from(reply.body).toString('base64') });
        }
        if (address.pathname === '/relay/client.js') return fulfil('text/javascript', client);
        if (address.pathname === '/api/v1/boards') return fulfil('application/json', JSON.stringify({ version: 1, boards: stand.linked, warnings: [] }));
        let head = {}, body = '';
        const handled = await relay({ method: 'GET', url: address.pathname, headers: {} }, { writeHead: (status, headers) => { head = headers; }, end: (content) => { body = content ?? ''; } });
        if (!handled) return chrome.send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
        // The relay's own policy, which also lets the page reach the test view's own port the round trip names.
        const policy = head['content-security-policy'].replace("connect-src 'self'", "connect-src 'self' " + view.base);
        return fulfil(head['content-type'], body, [{ name: 'Content-Security-Policy', value: policy }]);
      })().catch((error) => failures.push(error.message));
    };
    chrome.socket.addEventListener('message', listener);
    await chrome.send('Fetch.enable', { patterns: [{ urlPattern: HOSTED + '/*', requestStage: 'Request' }, { urlPattern: LOCAL + '/*', requestStage: 'Request' }] });
    // A browser that has refused this page its local network permission, as Chrome reports it.
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      if (location.origin !== ${JSON.stringify(HOSTED)} || location.search !== '?blocked') return;
      const query = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (asked) => ['loopback-network', 'local-network-access'].includes(asked?.name) ? Promise.resolve({ state: 'denied' }) : query(asked);
    })()` });
    const shown = `JSON.stringify((() => {
      const on = (element) => Boolean(element) && !element.hidden && element.getClientRects().length > 0;
      const text = (id) => on(document.getElementById(id)) ? document.getElementById(id).textContent.trim() : null;
      const probe = document.body.appendChild(document.createElement('span'));
      const tokens = ['--accent-strong', '--ink', '--ink-muted', '--surface'].map((token) => { probe.style.color = 'var(' + token + ')'; return getComputedStyle(probe).color; });
      probe.remove();
      return {
        state: document.getElementById('local-note').dataset.state, heading: text('local-note-title'), text: text('local-note-text'), hint: text('local-note-hint'), command: text('local-note-code'),
        steps: [...document.querySelectorAll('#local-note-links a, #local-note-links button')].filter(on).map((step) => [step.textContent.trim(), step.getAttribute('href')]),
        ways: on(document.getElementById('ways-in')) ? [...document.querySelectorAll('#ways-in dt')].map((title) => title.textContent) : null,
        waysText: text('ways-in'), side: document.getElementById('side-hint').hidden ? null : document.getElementById('side-hint').textContent, banner: on(document.getElementById('relay-notice')), browser: hostedBrowser(navigator),
        defaults: [...document.querySelectorAll('*')].filter((element) => ['rgb(0, 0, 238)', 'rgb(85, 26, 139)'].includes(getComputedStyle(element).color)).map((element) => element.outerHTML.slice(0, 80)),
        bare: [...document.querySelectorAll('a')].filter((link) => on(link) && !link.className && !tokens.includes(getComputedStyle(link).color)).map((link) => link.outerHTML.slice(0, 80)),
      };
    })())`;
    /** Open the hosted page at this address and read the state it settles in. */
    // Every visible control beside a reference of its own kind that sees only the browser's own styles: a control that
    // matches it on appearance, background, border and radius is a native default the view never styled.
    const native = `JSON.stringify((() => {
      const host = document.body.appendChild(document.createElement('div'));
      const root = host.attachShadow({ mode: 'open' });
      const signature = (element) => { const style = getComputedStyle(element); return [style.appearance, style.backgroundColor, style.borderTopStyle, style.borderTopWidth, style.borderRadius].join(' | '); };
      const found = [...document.querySelectorAll('button, input, select, textarea')].filter((element) => element.type !== 'hidden' && element.getClientRects().length > 0).filter((element) => {
        const probe = root.appendChild(document.createElement(element.tagName));
        if (element.type) probe.type = element.type;
        return signature(element) === signature(probe);
      }).map((element) => element.outerHTML.slice(0, 90));
      host.remove();
      return found;
    })())`;
    /** Check every visible control at phone and desktop width, in light and in dark. */
    const styledControls = async (state) => {
      for (const width of [390, 1280]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        for (const theme of ['light', 'dark']) {
          await chrome.stable(`document.documentElement.dataset.theme = '${theme}'`);
          assert.deepEqual(JSON.parse(await chrome.stable(native)), [], `${state}: no visible control keeps the browser's native look at ${width}px in ${theme}`);
        }
      }
      await chrome.stable('delete document.documentElement.dataset.theme');
      await chrome.send('Emulation.clearDeviceMetricsOverride');
    };
    const open = async (address, state) => {
      await chrome.send('Page.navigate', { url: HOSTED + '/' + address });
      await chrome.waitFor(`location.search === ${JSON.stringify(address.split('#')[0])} && document.querySelector('#local-note')?.dataset.state === ${JSON.stringify(state)} && !document.querySelector('#local-note').hidden`, 20_000); // budget: hang ceiling for one refused loopback request and an empty relay list.
      const seen = JSON.parse(await chrome.stable(shown));
      await proofShot(chrome, 'hosted-' + state + '-phone', 390);
      await proofShot(chrome, 'hosted-' + state, 1280);
      assert.deepEqual(seen.defaults, [], `${state}: no element keeps the browser's default link colours`);
      assert.deepEqual(seen.bare, [], `${state}: every link has a class or the view's colours`);
      assert.deepEqual(seen.ways, ['The local view', 'This computer through pullboard.dev', 'Your phone and other devices', 'A second computer'], `${state}: the Ways in panel lists every route`);
      for (const command of ['pullboard view', 'pullboard relay on --all', 'pullboard relay pair', 'pullboard relay join <code>']) assert.ok(seen.waysText.includes(command), `${state}: Ways in names ${command}`);
      assert.ok(seen.side, `${state}: the empty sidebar says what fills it`);
      await styledControls(state);
      return seen;
    };
    const retry = [['Try again', null]];

    const blocked = await open('?blocked', 'blocked');
    assert.equal(blocked.heading, 'Let this page reach Pullboard');
    assert.match(blocked.text, new RegExp('^' + blocked.browser + ' has refused this page access to apps on this device'), 'the line names the browser and what it refused');
    assert.equal(blocked.browser, 'Chrome', 'the fixture Chrome is named as Chrome');
    assert.match(blocked.hint ?? '', /^In Chrome, click the icon at the left of the address bar, turn on Local network access, then try again\.$/, 'the step is the one for this browser');
    assert.deepEqual(blocked.steps, retry, 'and its button tries again');

    const absent = await open('?absent', 'not-running');
    assert.equal(absent.heading, 'Start Pullboard on this computer');
    assert.match(absent.text, /cannot reach a local view on this computer/);
    assert.equal(absent.command, 'pullboard view', 'the next step is the command that starts the local view');
    assert.deepEqual(absent.steps, retry);
    assert.equal(await chrome.stable("document.querySelector('#local-note-copy').textContent"), 'Copy', 'the command has a copy button');
    assert.equal(absent.banner, false, 'the relay\'s banner stays out of it');

    const out = await open('?out#board=' + 'b'.repeat(32) + '&key=k1', 'signed-out');
    assert.equal(out.heading, 'Sign in to pair this browser');
    assert.deepEqual(out.steps, [['Sign in with GitHub', '/auth/github/start']], 'the next step is signing in');
    assert.equal(out.banner, false, 'the state speaks for the relay\'s banner');

    stand.signedIn = true;
    const none = await open('?in', 'no-linked');
    assert.equal(none.heading, 'No linked boards yet');
    assert.equal(none.command, 'pullboard relay on --all', 'the next step links the boards');
    assert.equal(none.banner, false);
    assert.equal(await chrome.stable("document.querySelector('#local-note-sign-in').hidden"), true, 'a signed-in person is not asked to sign in');

    stand.linked = [{ id: 'a'.repeat(32), repository: 'acme/web', linkedAt: 0 }];
    const unpaired = await open('?linked', 'unpaired');
    assert.equal(unpaired.heading, 'Pair this browser');
    assert.match(unpaired.text, /^You are signed in, .*acme\/web\. Each browser pairs once before it can read it\..*scan its QR:$/, 'the line says the person is signed in, names the board, that each browser pairs once, and the QR');
    assert.equal(unpaired.command, 'pullboard relay on --all', 'the next step prints the QR');

    // This machine's view: the normal list, with no state over it.
    stand.signedIn = false;
    stand.linked = [];
    stand.local = view.base;
    // The person allowed this page to reach this device, under whichever permission names this Chrome knows.
    for (const permissions of [['loopbackNetwork', 'localNetwork', 'localNetworkAccess'], ['localNetworkAccess']]) {
      try { await chrome.send('Browser.grantPermissions', { origin: HOSTED, permissions }); break; } catch { /* a name this Chrome does not have */ }
    }
    // A view from before 0.8.29 refuses the hosted page without the header that would let it read the refusal. The page
    // makes one discovery request of this device (P5), so it reads as no view, and the state's hint names the update.
    old = createServer((req, res) => { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'this view needs its own address and secret: open the link pullboard view printed' })); });
    await new Promise((ready) => old.listen(0, '127.0.0.1', ready));
    stand.local = 'http://127.0.0.1:' + old.address().port;
    const outdated = await open('?old', 'not-running');
    assert.equal(outdated.heading, 'Start Pullboard on this computer');
    assert.equal(outdated.hint, 'A Pullboard older than 0.8.29 cannot answer this page, so update it first with npm i -g pullboard.', 'the state names the update an old view needs');
    assert.deepEqual(outdated.steps, retry);
    stand.local = view.base;
    await chrome.send('Page.navigate', { url: HOSTED + '/?list' });
    await chrome.waitFor("location.origin === 'https://app.pullboard.dev' && document.querySelector('#chain')?.textContent.includes('A board the hosted page lists')", 30_000); // budget: hang ceiling for the discovery, one round trip and the first board read.
    const list = JSON.parse(await chrome.stable(`JSON.stringify({ note: document.querySelector('#local-note').hidden, ways: document.querySelector('#ways-in').hidden, heading: document.querySelector('#proj-list .proj.on .pname')?.textContent, source: document.querySelector('#proj-list .proj.on .src')?.textContent, tab: document.querySelector('.tab.on')?.textContent, step: document.querySelector('#new-item').getClientRects().length > 0, side: document.querySelector('#side-hint').hidden, state: JSON.parse(${shown}) })`));
    // Normal-list next actions use the view styles at both sizes and in both themes (outside review 950).
    for (const width of [390, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      for (const theme of ['light', 'dark']) {
        await chrome.stable(`document.documentElement.dataset.theme = '${theme}'`);
        const controls = JSON.parse(await chrome.stable(`JSON.stringify((() => {
          const probe = document.createElement('button'); probe.textContent = 'UA reference'; document.body.append(probe);
          const signature = (element) => { const style = getComputedStyle(element); return {
            appearance: style.appearance, background: style.backgroundColor, radius: style.borderRadius,
            border: style.borderTopStyle, width: style.borderTopWidth, padding: style.padding,
          }; };
          const baseline = signature(probe);
          const actions = [...document.querySelectorAll('#detail button[data-shout], #detail button[data-new]')]
            .filter((element) => element.getClientRects().length).map((element) => ({ text: element.textContent,
              style: signature(element), height: element.getBoundingClientRect().height }));
          probe.remove(); return { baseline, actions };
        })())`));
        assert.equal(controls.actions.length, 2, `both next actions appear at ${width}px in ${theme}`);
        for (const action of controls.actions) {
          assert.notDeepEqual(action.style, controls.baseline, `${action.text} uses the view styles at ${width}px in ${theme}`);
          if (width === 390) assert.ok(action.height >= 44, `${action.text} retains a phone touch target in ${theme}`);
        }
      }
      await proofShot(chrome, width === 390 ? 'hosted-list-phone' : 'hosted-list', width);
    }
    await chrome.stable('delete document.documentElement.dataset.theme');
    await styledControls('list');
    assert.deepEqual({ note: list.note, ways: list.ways, side: list.side }, { note: true, ways: true, side: true }, 'the list shows with no state, panel or hint over it');
    assert.equal(list.heading, 'hosted-states', 'the sidebar names the board shown');
    assert.equal(list.source, 'this computer', 'with a quiet label for where it comes from');
    assert.equal(list.tab, 'Items', 'its items are open');
    assert.equal(list.step, true, 'and the next step is a new item');
    assert.deepEqual(list.state.defaults, [], 'no element keeps the browser\'s default link colours');
    assert.deepEqual(list.state.bare, [], 'every link has a class or the view\'s colours');
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught exceptions');
  } finally {
    try { if (chrome) { if (listener) chrome.socket.removeEventListener('message', listener); await closeSnapshotChrome(chrome); } }
    finally {
      try { if (old) await new Promise((closed) => { old.close(closed); old.closeAllConnections(); }); }
      finally {
        try { if (view) await view.stop(); }
        finally { rmSync(profile, { recursive: true, force: true }); }
      }
    }
  }
  assert.deepEqual(failures, [], 'the stand-in hosted page was served');
});

test('the local view hands its secret only to the hosted page [N26,A2]', { timeout: 60_000 }, async () => { // budget: hang ceiling for one real view and a few local requests.
  const box = machine();
  project(box, 'local-origin-handoff');
  const view = await startView(box);
  try {
    const trip = await call(view, '/local/connect', { headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' } });
    assert.equal(trip.status, 200, 'any page may start the round trip with a top-level visit, without the secret');
    assert.equal(trip.headers['x-frame-options'], 'DENY', 'the round-trip page refuses to be framed');
    assert.match(trip.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(trip.headers['referrer-policy'], 'no-referrer');
    assert.equal(trip.headers['cache-control'], 'no-store');
    assert.match(trip.body, /if \(window\.top === window\.self\)/, 'a framed copy never runs its redirect');
    const onward = onwardOf(trip.body);
    assert.equal(onward.origin, HOSTED, 'the secret goes back to https://app.pullboard.dev only');
    assert.equal(onward.pathname, '/');
    assert.equal(onward.search, '', 'never in a query');
    assert.deepEqual(JSON.parse(new URLSearchParams(onward.hash.slice(1)).get('pullboard-local')), { version: 1, origin: view.base, key: view.key }, 'only in the fragment');
    const elsewhere = onwardOf((await call(view, '/local/connect?return=' + encodeURIComponent('https://foreign.example/'))).body);
    assert.equal(elsewhere.origin, HOSTED, 'no address a page names can turn the round trip elsewhere');
    // A script's read, a frame and another site's name get nothing.
    for (const [why, headers] of [
      ['a script on the hosted page', { origin: HOSTED, 'sec-fetch-dest': 'empty' }],
      ['a script on another site', { origin: 'https://foreign.example' }],
      ['a frame', { 'sec-fetch-dest': 'iframe' }],
      ['a script tag', { 'sec-fetch-dest': 'script' }],
      ['another site\'s name for this address', { host: 'foreign.example:' + view.link.port }],
    ]) {
      const refused = await call(view, '/local/connect', { headers });
      assert.equal(refused.status, 403, `${why} is refused`);
      assert.ok(!refused.body.includes(view.key), `${why} gets no secret`);
    }
    const protocol = await call(view, '/local/protocol', { headers: { origin: HOSTED } });
    assert.equal(protocol.status, 200, 'the hosted page can read what this view speaks');
    assert.equal(protocol.headers['access-control-allow-origin'], HOSTED);
    assert.deepEqual(JSON.parse(protocol.body), { version: 1, apiVersion: 1, hostedOrigin: HOSTED, connect: '/local/connect', view: '/local/view' }, 'and nothing else: no secret and no board');
    const opened = onwardOf((await call(view, '/local/view')).body);
    assert.equal(opened.origin, view.base, 'the local view link opens this view itself');
    assert.equal(opened.searchParams.get('k'), view.key, 'as the link pullboard view printed does');
  } finally {
    await view.stop();
  }
});
