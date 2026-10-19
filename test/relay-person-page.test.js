/** Actual relay cockpit request capability and exported read-only guards [H12,H5]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cockpitPage } from '../src/cockpit.js';
import { ENGINE_VERSION } from '../src/machine.js';
import { findChromeExecutable, startChrome } from './relay-browser-fixture.js';
import { relayClientFixture } from './relay-client-fixture.js';
import { createRelayBrowserHandler } from '../relay/browser-page.js';

const chromeOptions = { skip: !findChromeExecutable() && 'Chrome is not installed' };

test('a signed-in phone shows its first screen before a local probe can answer [N26,H5,H17]', chromeOptions, async t => {
  const handle = createRelayBrowserHandler({ authenticate: async () => ({ kind: 'session' }) });
  const server = createServer(async (req, res) => {
    if (!await handle(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const chrome = await startChrome();
  t.after(() => chrome.close());
  await chrome.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.fetch = () => new Promise(() => {});',
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  await chrome.navigate(origin);
  await chrome.waitFor("document.readyState === 'complete' && document.documentElement.dataset.relayDevice === 'phone'");
  const first = await chrome.evaluate(`({
    screen: document.documentElement.dataset.relayScreen ?? null,
    visible: document.querySelector('#relay-screen h1')?.getClientRects().length > 0,
    text: document.body.innerText,
  })`);
  assert.equal(first.screen, 'share', 'a signed-in phone gets its screen before any asynchronous probe or board read');
  assert.equal(first.visible, true, 'the screen heading is painted, not merely present in hidden markup');
  assert.match(first.text, /One step on your computer/u);
});

test('a phone keeps its screen and the reason while a saved board fails or waits [N26,H5,H17]', chromeOptions, async t => {
  let code = 'BAD_SNAPSHOT';
  const handle = createRelayBrowserHandler({ authenticate: async () => ({ kind: 'session' }) });
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/auth/')) {
      const body = req.url.endsWith('/state') ? { version: 1, error: { code, message: 'Fixture snapshot is unavailable.' } }
        : { version: 1, boards: [{ id: 'a'.repeat(32), repository: 'fixture/project' }], warnings: [] };
      res.writeHead(req.url.endsWith('/state') ? 404 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    } else if (!await handle(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const chrome = await startChrome();
  t.after(() => chrome.close());
  await chrome.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('pullboard.relay.keys.v1', JSON.stringify({ ['a'.repeat(32)]: btoa('x'.repeat(32)).replaceAll('=', '') }));
const nativeFetch = window.fetch;
window.fetch = (input, options) => String(input).startsWith('http://127.0.0.1:4890/')
  ? Promise.reject(new TypeError('Fixture has no local view')) : nativeFetch(input, options);`,
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  for (const [failure, expected] of [['BAD_SNAPSHOT', 'Could not open this board'], ['NO_SNAPSHOT', 'waiting for its first snapshot']]) {
    code = failure;
    await chrome.navigate('about:blank');
    await chrome.navigate(origin);
    await chrome.waitFor(`document.querySelector('#relay-notice')?.textContent.includes(${JSON.stringify(expected)})`);
    const shown = await chrome.evaluate(`({ text: document.body.innerText, screen: document.documentElement.dataset.relayScreen ?? null })`);
    assert.equal(shown.screen, 'share', 'an unreadable saved board cannot dismiss the phone screen');
    assert.ok(shown.text.includes(expected), 'the person can read the actual reason, not just hidden banner markup');
  }
});

test("the relay page opens without a session and may call only the local view's default port [N26,H5,A2]", async t => {
  const box = await relayClientFixture(t);
  const privateTitle = 'PRIVATE_RELAY_BOARD_533';
  assert.equal((await box.cli('add', box.lane, privateTitle)).code, 0);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const privateKey = readFileSync(box.keyFile, 'utf8').trim();
  const response = await fetch(box.origin + '/');
  assert.equal(response.status, 200, 'the public entry does not require a relay session');
  const page = await response.text();
  assert.ok(page.includes('id="chain"'), 'the anonymous response is the cockpit shell');
  for (const privateValue of [privateTitle, link.board, privateKey, link.token]) {
    assert.equal(page.includes(privateValue), false, 'the shell contains no private board or credential value');
  }
  const policy = response.headers.get('content-security-policy');
  const directives = new Map(policy.split(';').map(part => part.trim().split(/\s+/u)).map(([name, ...values]) => [name, values]));
  assert.deepEqual(directives.get('connect-src'), ["'self'", 'http://127.0.0.1:4890', 'http://localhost:4890'],
    'only the relay itself and the two exact loopback default-port origins can be contacted');
  assert.deepEqual(directives.get('frame-ancestors'), ["'none'"]);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(page, /Sign in with GitHub/u, 'relay mode retains its sign-in path');
});


test('a signed-out relay page keeps sign-in visible without starting relay reads [N26,H5,A2]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const privateTitle = 'PRIVATE_RELAY_BOARD_533_ANONYMOUS';
  assert.equal((await box.cli('add', box.lane, privateTitle)).code, 0);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const privateKey = readFileSync(box.keyFile, 'utf8').trim();
  const chrome = await startChrome();
  t.after(() => chrome.close());
  await chrome.send('Page.enable', {});
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try { sessionStorage.setItem('relayAnonymousDocumentCount', String(Number(sessionStorage.getItem('relayAnonymousDocumentCount') || 0) + 1)); } catch {}",
  });
  const firstCall = box.calls.length;
  await chrome.navigate(box.origin + '/');
  // Budget: six seconds reproduce the reviewed reload loop and span a relay refresh interval.
  await new Promise(resolve => setTimeout(resolve, 6000));
  const calls = box.calls.slice(firstCall);
  assert.equal(calls.filter(call => call.method === 'GET' && call.path === '/').length, 1,
    'the anonymous shell does not reload');
  await chrome.waitFor("document.readyState === 'complete' && !!document.querySelector('a[href=\"/auth/github/start\"]')");
  const loads = await chrome.evaluate("Number(sessionStorage.getItem('relayAnonymousDocumentCount') || 0)");
  const privateValues = [privateTitle, link.board, privateKey, link.token];
  const retained = await chrome.evaluate(`({ html: document.documentElement.innerHTML,
    local: JSON.stringify(localStorage), session: JSON.stringify(Object.fromEntries(
      Array.from({ length: sessionStorage.length }, (_, index) => {
        const key = sessionStorage.key(index); return [key, sessionStorage.getItem(key)];
      }).filter(([key]) => key !== 'relayAnonymousDocumentCount'))) })`);
  assert.equal(loads, 1, 'the anonymous shell does not reload');
  assert.equal(calls.filter(call => call.method === 'GET' && call.path === '/api/v1/boards').length, 0,
    'the anonymous shell never starts relay board reads');
  assert.equal(await chrome.evaluate("!!document.querySelector('a[href=\"/auth/github/start\"]')"), true,
    'the original sign-in link remains available');
  assert.equal([retained.html, retained.local, retained.session].some(value => privateValues.some(secret => value.includes(secret))), false,
    'the anonymous page and its browser storage retain no private board or credential value');
});

test('a revoked relay session settles on sign-in without a reload loop [N26,H5,A2]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const privateTitle = 'PRIVATE_RELAY_BOARD_533_REVOKED';
  assert.equal((await box.cli('add', box.lane, privateTitle)).code, 0);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const privateKey = readFileSync(box.keyFile, 'utf8').trim();
  const phone = await box.phoneSession();
  const chrome = await startChrome();
  t.after(() => chrome.close());
  await chrome.send('Page.enable', {});
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try { sessionStorage.setItem('relayRevokedDocumentCount', String(Number(sessionStorage.getItem('relayRevokedDocumentCount') || 0) + 1)); } catch {}",
  });
  const cookie = await chrome.send('Network.setCookie', {
    name: 'pb_session', value: phone.token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  });
  assert.equal(cookie.success, true);
  box.revokeSessionOnNextListing();
  const firstCall = box.calls.length;
  await chrome.navigate(box.origin + '/');
  await chrome.waitFor("document.readyState === 'complete' && !!document.querySelector('a[href=\"/auth/github/start\"]')");
  // Budget: six seconds after reaching sign-in span a relay refresh interval.
  await new Promise(resolve => setTimeout(resolve, 6000));
  const loads = await chrome.evaluate("Number(sessionStorage.getItem('relayRevokedDocumentCount') || 0)");
  const calls = box.calls.slice(firstCall);
  const privateValues = [privateTitle, link.board, privateKey, link.token, phone.token];
  const retained = await chrome.evaluate(`({ html: document.documentElement.innerHTML,
    local: JSON.stringify(localStorage), session: JSON.stringify(Object.fromEntries(
      Array.from({ length: sessionStorage.length }, (_, index) => {
        const key = sessionStorage.key(index); return [key, sessionStorage.getItem(key)];
      }).filter(([key]) => key !== 'relayRevokedDocumentCount'))) })`);
  assert.equal(loads, 2, 'one authorization loss leads to one signed-out document');
  assert.equal(calls.filter(call => call.method === 'GET' && call.path === '/').length, 2,
    'the authenticated page redirects once to the signed-out entry');
  assert.equal(calls.filter(call => call.method === 'GET' && call.path === '/api/v1/boards').length, 1,
    'the invalidated session produces no repeated board listings');
  assert.equal(await chrome.evaluate("!!document.querySelector('a[href=\"/auth/github/start\"]') && !!document.querySelector('#relay-notice')"), true,
    'the signed-out notice and original sign-in link remain visible');
  assert.equal([retained.html, retained.local, retained.session].some(value => privateValues.some(secret => value.includes(secret))), false,
    'the signed-out page and browser storage retain no private board or credential value');
});

test('relay data still needs a session [N26,H5,A2]', async t => {
  const box = await relayClientFixture(t);
  const before = (await box.cli('export')).document.tables;
  const board = 'a'.repeat(32);
  const device = 'device-' + 'b'.repeat(32);
  const locator = 'c'.repeat(22);
  const prefix = '/api/v1/boards/' + board;
  const routes = [
    ['GET', '/api/v1/boards'], ['GET', '/api/v1/events?boards=' + board],
    ['GET', prefix + '/state'], ['PUT', prefix + '/state'], ['DELETE', prefix],
    ['GET', prefix + '/events?after=0'], ['POST', prefix + '/moves'], ['POST', prefix + '/requests'],
    ['GET', prefix + '/code'], ['GET', prefix + '/tokens'], ['POST', prefix + '/tokens'],
    ['GET', prefix + '/items'], ['GET', prefix + '/items/1'], ['GET', prefix + '/shouts/1'],
    ['POST', '/api/v1/pairings/' + board + '/' + locator],
    ['POST', '/api/v1/pairings/' + board + '/' + locator + '/consume'],
    ['GET', '/api/v1/devices/session'], ['POST', '/api/v1/devices/approvals'],
    ['GET', '/api/v1/devices/approvals/approval'],
    ...['authorize', 'complete', 'execute'].map(action => ['POST', '/api/v1/devices/approvals/approval/' + action]),
    ['GET', '/api/v1/devices/' + device + '/approvals'],
    ...['GET', 'POST', 'PUT', 'DELETE'].map(method => [method, '/api/v1/devices/enrollments/' + locator]),
    ['GET', '/api/v1/devices/' + device + '/boards'],
    ['PUT', '/api/v1/devices/' + device + '/boards/' + board],
    ['POST', '/api/v1/devices/' + device], ['DELETE', '/api/v1/devices/' + device],
    ...['session', 'boards'].map(path => ['GET', '/auth/' + path]),
    ['GET', '/auth/tokens?board=' + board],
    ['POST', '/auth/boards/link', { board, repository: 'fixture/project' }],
    ['POST', '/auth/machines', { board, machine: 'fixture-machine' }],
    ['POST', '/auth/tokens', { board, agent: 'fixture-agent' }],
    ['POST', '/auth/tokens/revoke', { id: 'fixture-token-id' }],
  ];
  for (const [method, path, payload] of routes) {
    const response = await fetch(box.origin + path, {
      method,
      headers: { origin: box.origin, 'content-type': 'application/json', 'x-pullboard-engine': String(ENGINE_VERSION),
        ...(path.startsWith('/api/v1/events?') ? { accept: 'text/event-stream' } : {}) },
      ...(['POST', 'PUT'].includes(method) ? { body: JSON.stringify(payload ?? {}) } : {}),
    });
    const document = await response.json();
    assert.equal(response.status, 401, method + ' ' + path + ' refuses before returning data or applying an action');
    assert.equal(document.error?.code, 'AUTH_REQUIRED', method + ' ' + path + ' reaches its authentication boundary');
    for (const field of ['boards', 'state', 'events', 'item', 'shout', 'session', 'tokens', 'wraps', 'approval']) {
      assert.equal(Object.hasOwn(document, field), false, 'an anonymous refusal carries no relay data');
    }
  }
  const after = (await box.cli('export')).document.tables;
  for (const table of ['item', 'event', 'shout', 'verdict']) {
    assert.deepEqual(after[table], before[table], 'anonymous relay calls do not change local board ' + table);
  }
});

test('the actual relay page seals its shout and refuses generic direct moves [H12,H5]', chromeOptions, async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const chrome = await startChrome();
  t.after(() => chrome.close());
  const cookie = await chrome.send('Network.setCookie', { name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax' });
  assert.equal(cookie.success, true);
  await chrome.navigate(box.origin + '/#board=' + link.board + '&key=' + readFileSync(box.keyFile, 'utf8').trim());
  await chrome.waitFor('typeof data !== "undefined" && !!data?.project && !!transport');
  const capability = await chrome.evaluate('({readOnly,requests,snapshot,display:getComputedStyle(document.querySelector("#shout-form")).display})');
  assert.deepEqual(capability, { readOnly: true, requests: true, snapshot: false, display: 'flex' });
  const before = (await box.cli('export')).document;
  const callsBefore = box.calls.length;
  const direct = await chrome.evaluate(`api(boardPath(view.root) + '/moves', {verb:'claim',item:1}).then(() => 'allowed', error => error.message)`);
  assert.match(direct, /read-only view/);
  assert.equal(box.calls.slice(callsBefore).some(call => call.method === 'POST'), false, 'the generic direct move never reaches the relay');
  await chrome.evaluate(`document.querySelector('[data-tab=shouts]').click(); document.querySelector('#shout-to').value='coordinator'; document.querySelector('#shout-text').value='RELAY_PAGE_SEALED_SHOUT'; document.querySelector('#shout-form').requestSubmit(); true`);
  await chrome.waitFor('data.project.personRequests?.some(row => row.move?.args?.text === "RELAY_PAGE_SEALED_SHOUT")');

  const request = await chrome.evaluate('data.project.personRequests.find(row => row.move?.args?.text === "RELAY_PAGE_SEALED_SHOUT")');
  assert.equal(request.status, 'waiting');
  assert.deepEqual(request.move, { verb: 'shout', args: { to: 'coordinator', text: 'RELAY_PAGE_SEALED_SHOUT' } });
  assert.equal(box.calls.some(call => call.method === 'POST' && call.path === `/api/v1/boards/${link.board}/requests`), true);
  assert.equal(box.calls.slice(callsBefore).some(call => call.method === 'POST' && call.path.endsWith('/moves')), false, 'the page never posts an executable engine move');
  const response = await fetch(box.origin + '/api/v1/boards/' + link.board + '/events?after=0', { headers: { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION) } });
  assert.equal(response.status, 200);
  const events = await response.json();
  assert.equal(JSON.stringify(events).includes('RELAY_PAGE_SEALED_SHOUT'), false, 'the relay holds ciphertext, not shout text');
  assert.ok(events.events.some(event => event.kind === 'request' && typeof event.sealed === 'string'));
  assert.equal(box.keyInRequest(), false);
  // The browser queued intent; only the next native command may author the shout.
  assert.equal(before.tables.shout.some(row => row.shout_text === 'RELAY_PAGE_SEALED_SHOUT'), false);
  assert.equal((await box.cli('status')).code, 0);
  const after = (await box.cli('export')).document;
  assert.equal(after.tables.shout.filter(row => row.shout_from === 'person' && row.shout_text === 'RELAY_PAGE_SEALED_SHOUT').length, 1);
});

test('an actual exported snapshot and local read-only page refuse all seven person actions [H12,H5]', chromeOptions, async t => {
  const box = await relayClientFixture(t);
  const directory = join(box.root, 'readonly-export');
  assert.equal((await box.cli('view', '--export', directory)).code, 0);
  const readonly = cockpitPage('', { readOnly: true });
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/readonly') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(readonly); return; }
    let file = join(directory, path === '/' ? 'index.html' : path.slice(1));
    if ((!existsSync(file) || !statSync(file).isFile()) && existsSync(file + '.json')) file += '.json';
    if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': file.endsWith('.json') ? 'application/json' : 'text/html' });
    res.end(readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const chrome = await startChrome();
  t.after(() => chrome.close());
  for (const [path, exported] of [['/', true], ['/readonly', false]]) {
    await chrome.navigate(origin + path);
    await chrome.waitFor('typeof data !== "undefined" && !!data?.project');
    assert.deepEqual(await chrome.evaluate('({snapshot,requests,readOnly})'), { snapshot: exported, requests: false, readOnly: !exported });
    const refusals = await chrome.evaluate(`(async () => {
      const actions=[['add',{lane:'web',title:'refused'}],['shout',{to:'coordinator',text:'refused'}],['answer',{id:1,text:'refused'}],['hold',{lane:'web',reason:'refused'}],['release',{lane:'web'}],['spec-approve',{ids:'G1'}],['spec-decline',{ids:'G1',reason:'refused'}]];
      const results=[];
      for(const [command,args] of actions) results.push(await act(command,args));
      return results;
    })()`);
    assert.deepEqual(refusals, Array(7).fill(false), 'all seven handlers refuse without the requests capability');
    assert.match(await chrome.evaluate(`api(boardPath(view.root)+'/moves',{verb:'shout',args:{to:'coordinator',text:'refused'}}).then(()=>'allowed',error=>error.message)`), /read-only/);
  }
  assert.equal((await box.cli('export')).document.tables.shout.some(row => row.shout_text === 'refused'), false);
});
