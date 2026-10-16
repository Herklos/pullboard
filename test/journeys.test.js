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

/** Serve the real relay shell and proxy every API byte, including long-lived event streams. */
async function journeyRelaySite(box, localOrigin) {
  const browser = createRelayBrowserHandler({
    async authenticate(req) {
      const token = /(?:^|;\s*)pb_session=([^;]+)/u.exec(req.headers.cookie || '')?.[1];
      if (!token) return { kind: 'anonymous' };
      try { return await box.auth.authenticate(token); } catch { return { kind: 'anonymous' }; }
    },
  });
  const server = createServer((req, res) => {
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
          'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
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
  return { server, base: 'http://127.0.0.1:' + server.address().port };
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
        await chrome.send('Fetch.continueRequest', { requestId, url: site.base + address.pathname + address.search });
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
    const linkedSetup = await setup.done;
    assert.equal(linkedSetup.code, 0, 'A completes the real relay on --all after phone pairing');
    assert.equal(linkedSetup.document.linked.length, 1, 'the one registered A board links through the CLI');
    assert.equal(linkedSetup.document.paired, true, 'the fixture phone completes the actual device enrollment');
    await chromeB.waitFor("location.hash === '' && document.querySelector('#chain')?.textContent.includes('linked machine A board')", 45_000);
    await chromeB.send('Page.navigate', { url: 'about:blank' });
    await chromeB.send('Page.navigate', { url: JOURNEY_HOSTED + '/' });
    await chromeB.waitFor("[...document.querySelectorAll('#proj-list .proj.repo')].some(row => row.textContent.includes('fixture/repository')) && [...document.querySelectorAll('#proj-list .proj.repo')].some(row => row.textContent.includes('local-machine-b'))", 45_000);
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
    await chromeA.waitFor("document.querySelector('#chain')?.textContent.includes('linked machine A board')", 30_000);

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
    await chromeB.waitFor('Number.isFinite(window.__journeyUpdateAt)', 5_000);
    const updateAt = await chromeB.stable('window.__journeyUpdateAt');
    const moveStart = await chromeA.stable('window.__journeyMoveStarted');
    const elapsedMs = updateAt - moveStart;
    assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= 2_000,
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
    await chromeB.waitFor('Number.isFinite(window.__detailLatency)', 1_000);
    const detailMs = await chromeB.stable('window.__detailLatency');
    assert.ok(detailMs <= 250, `B opens one of 40 local items within 250 ms from trusted click dispatch (${Math.round(detailMs)} ms)`);
    assert.equal(existsSync(linkBFile), false, 'B stays unlinked after the complete hosted journey');
    assert.equal(existsSync(keyBFile), false, 'the complete journey creates no relay key for B');
    assert.deepEqual(chromeA.exceptions, [], 'A’s real view UI has no browser errors');
    assert.deepEqual(chromeB.exceptions, [], 'B’s hosted mixed-board page has no browser errors');
  } finally {
    try { await stopRelayAll(setup); }
    finally {
      try { if (stopRoutes && chromeB) await stopRoutes(); }
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
