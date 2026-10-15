/** The hosted page reads this machine's view straight, and the view answers only its own page and that one [N26,A2]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cockpitPage } from '../../src/cockpit.js';
import { takeDefaultViewPort } from '../view-port-fixture.js';
import { BIN, machine, project, startView, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, styleOf } from './fixture.js';

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
 * Stand in for the hosted page at its real origin: Chrome answers every request for https://app.pullboard.dev with the
 * cockpit the relay would serve there and the view's styles, and nothing else is touched, so the requests to the
 * local view meet Chrome's own cross-origin rules.
 */
async function hostedStandIn(chrome, pages, styles) {
  const failures = [];
  const tasks = [];
  const listener = ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.method !== 'Fetch.requestPaused') return;
    tasks.push((async () => {
      const { requestId, resourceType, request: asked } = message.params;
      const document = resourceType === 'Document';
      const page = new URL(asked.url).search === '?relay' ? pages.relay : pages.anonymous;
      await chrome.send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: document ? 'text/html; charset=utf-8' : 'text/css; charset=utf-8' },
          { name: 'Cache-Control', value: 'no-store' },
          // The connections #533's relay page allows: its own origin and the local view's default address.
          ...(document ? [{ name: 'Content-Security-Policy', value: `connect-src 'self' ${LOCAL} http://localhost:4890; frame-ancestors 'none'` }] : []),
        ],
        body: Buffer.from(document ? page : styles).toString('base64'),
      });
    })().catch((error) => failures.push(error.message)));
  };
  chrome.socket.addEventListener('message', listener);
  await chrome.send('Fetch.enable', { patterns: [{ urlPattern: HOSTED + '/*', requestStage: 'Request' }] });
  return async () => {
    chrome.socket.removeEventListener('message', listener);
    try { await Promise.all(tasks); } finally { await chrome.send('Fetch.disable'); }
    assert.deepEqual(failures, [], 'the stand-in hosted page was served');
  };
}

test('a pullboard.dev page reads the local board [N26,A2]', { timeout: 120_000 }, async () => { // budget: hang ceiling for the default-port lease, two real round trips in Chrome and a view restart.
  const executable = chromeExecutable();
  assert.ok(executable, 'the hosted page check needs real Chrome');
  const box = machine();
  const board = project(box, 'hosted-local');
  box.run(board.repo, 'add', 'web', 'A board that stays on this machine', '--specs', 'G1');
  const lease = await takeDefaultViewPort(box.dir, { agent: 'local-origin-' + process.pid });
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-local-origin-'));
  let view, chrome, stopStandIn;
  try {
    view = await viewAt(box, 4890);
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
    stopStandIn = await hostedStandIn(chrome, { anonymous: relayPage(false), relay: relayPage(true) }, await styleOf(view));
    const trips = () => chrome.requests.filter((entry) => entry.url === LOCAL + '/local/connect').length;
    const relayModule = () => chrome.requests.filter((entry) => entry.url === HOSTED + '/relay/client.js').length;
    /** Wait until the page has asked for the relay module this many times in all. */
    const relayAsked = async (times) => {
      for (const deadline = Date.now() + 10_000; relayModule() < times && Date.now() < deadline;) await new Promise((later) => setTimeout(later, 50)); // budget: hang ceiling for the relay module request.
      assert.equal(relayModule(), times, 'the page loads the relay module');
    };
    const localFetches = 'JSON.stringify((window.__localFetches || []).filter((entry) => entry.url.startsWith(' + JSON.stringify(LOCAL) + ')))';

    // With nothing on this machine's port, the page says why and links the local view; a person with no relay session
    // gets the sign-in link and the relay module is never loaded, while one with a session gets the relay page. The
    // browser has not been allowed to reach this device yet, so the page says why it may ask before it first asks.
    await view.stop();
    await chrome.send('Page.navigate', { url: HOSTED + '/' });
    await chrome.waitFor("location.search === '' && /cannot reach a local view/.test(document.querySelector('#local-note-text')?.textContent)", 20_000); // budget: hang ceiling for one refused loopback request.
    const asked = JSON.parse(await chrome.stable(localFetches));
    assert.equal(asked[0]?.url, LOCAL + '/local/protocol', 'the page first reads the local view\'s public protocol');
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
    const other = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': HOSTED });
      res.end(JSON.stringify({ version: 2, apiVersion: 2, hostedOrigin: HOSTED }));
    });
    await new Promise((ready) => other.listen(4890, '127.0.0.1', ready));
    try {
      await chrome.send('Page.navigate', { url: HOSTED + '/?other' });
      await chrome.waitFor("location.search === '?other' && /does not match this page/.test(document.querySelector('#local-note-text')?.textContent)", 20_000); // budget: hang ceiling for one loopback request.
    } finally { await new Promise((closed) => { other.close(closed); other.closeAllConnections(); }); }
    assert.equal(trips(), 0, 'no round trip starts toward a view the page cannot use');

    view = await viewAt(box, 4890);
    await chrome.send('Page.navigate', { url: HOSTED + '/' });
    await chrome.waitFor("location.origin === 'https://app.pullboard.dev' && document.querySelector('#chain')?.textContent.includes('A board that stays on this machine')", 30_000); // budget: hang ceiling for the discovery, one top-level round trip and the first board read.
    const shown = JSON.parse(await chrome.stable(`JSON.stringify({ address: location.href, base: connection.base, readOnly, transportModule, kept: sessionStorage.getItem('pullboard.local.session'), lasting: Object.keys(localStorage).map((name) => localStorage.getItem(name)).join(' '), log: window.__localFetches })`));
    assert.ok(!shown.address.includes('pullboard-local') && !shown.address.includes(view.key), 'the secret is gone from the address bar');
    assert.equal(shown.base, LOCAL, 'the page reads the local view at its default address');
    assert.equal(shown.readOnly, false, 'the local board is not read-only');
    assert.equal(shown.transportModule, null, 'the relay transport is never loaded');
    assert.equal(await chrome.stable(banner), true, 'and the relay\'s banner is hidden over the local board');
    assert.deepEqual(JSON.parse(shown.kept), { version: 1, origin: LOCAL, key: view.key }, 'the session is kept for this tab');
    assert.ok(!shown.lasting.includes(view.key), 'nothing lasting holds the secret');
    const local = shown.log.filter((entry) => entry.url.startsWith(LOCAL));
    assert.equal(local[0]?.url, LOCAL + '/local/protocol', 'the page first reads the local view\'s public protocol');
    assert.ok(local.every((entry) => !entry.address.includes('pullboard-local')), 'no request is made while the secret is in the address');
    assert.ok(local.some((entry) => entry.url.startsWith(LOCAL + '/api/')), 'the page reads the board through the view\'s API');
    assert.equal(trips(), 1, 'the page itself started one top-level round trip');
    const api = chrome.requests.filter((entry) => entry.url.startsWith(LOCAL + '/api/') && entry.method !== 'OPTIONS');
    assert.ok(api.length > 0 && api.every((entry) => Object.entries(entry.headers).some(([name, value]) => name.toLowerCase() === 'x-pullboard-key' && value === view.key)), 'every API request carries the secret in x-pullboard-key');
    assert.ok(chrome.requests.every((entry) => !new URL(entry.url).search.includes(view.key)), 'no request carries the secret in its query');

    // The view restarts with a new secret: the page goes round again by itself.
    const before = view.key;
    await view.stop();
    view = await viewAt(box, 4890);
    assert.notEqual(view.key, before, 'the restarted view has a new secret');
    await chrome.waitFor(`connection.headers['x-pullboard-key'] === ${JSON.stringify(view.key)} && document.querySelector('#chain')?.textContent.includes('A board that stays on this machine')`, 45_000); // budget: hang ceiling for the next refresh to meet the refusal, a second round trip and a read.
    assert.equal(trips(), 2, 'the page repeated the round trip without the person');
    assert.ok(!(await chrome.stable('location.href')).includes(view.key), 'the new secret is gone from the address bar too');
    assert.ok(chrome.requests.every((entry) => !new URL(entry.url).search.includes(view.key) && !new URL(entry.url).search.includes(before)), 'neither secret ever rode in a query');
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught exceptions');
  } finally {
    try { if (stopStandIn) await stopStandIn(); }
    finally {
      try { if (chrome) await closeSnapshotChrome(chrome); }
      finally {
        try { if (view) await view.stop(); }
        finally { rmSync(profile, { recursive: true, force: true }); await lease.release(); }
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
