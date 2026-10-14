/** The view follows the board's event stream instead of a timer, in real Chrome [N26,A2]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as forward } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { browserPause, boardId, boardOf, chromeExecutable, closeSnapshotChrome, fetchLive, machine, openSnapshotChrome, project, startView } from './fixture.js';

/** The page's HTTP requests from a mark on, as method and path, leaving out data: URLs. */
function sent(chrome, mark = 0) {
  return chrome.requests.slice(mark).filter((request) => /^https?:/.test(request.url)).map((request) => request.method + ' ' + new URL(request.url).pathname);
}

/** One request header, whatever case Chrome reports it in. */
function header(request, name) {
  return Object.entries(request.headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? null;
}

/** The event-stream reads the page opened, each with the event it asked to start after. */
function streamReads(chrome) {
  return chrome.requests.filter((request) => /^https?:/.test(request.url) && /\/api\/v1\/boards\/[^/]+\/events$/.test(new URL(request.url).pathname)
    && /text\/event-stream/.test(header(request, 'accept') ?? '')).map((request) => header(request, 'last-event-id'));
}

/**
 * A loopback HTTP proxy in front of the real view, so a test can cut every connection through it and refuse new ones
 * until it is restored, as a lost network does. It names the view's own host, which the view's secret check requires.
 */
async function cuttableProxy(view) {
  const target = new URL(view.base);
  const sockets = new Set(), upstreams = new Set();
  let down = false;
  const server = createServer((req, res) => {
    const upstream = forward({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: { ...req.headers, host: target.host } }, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    upstreams.add(upstream);
    upstream.on('close', () => upstreams.delete(upstream));
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  server.on('connection', (socket) => {
    if (down) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  /** Drop every open connection, upstream and down. */
  const drop = () => { for (const socket of sockets) socket.destroy(); for (const upstream of upstreams) upstream.destroy(); };
  return {
    href: `http://127.0.0.1:${server.address().port}/?k=${encodeURIComponent(view.key)}`,
    cut() { down = true; drop(); },
    restore() { down = false; },
    close: () => new Promise((closed) => { down = true; drop(); server.close(() => closed()); }),
  };
}

/** A board with one open item, served by the real view and opened in real Chrome on the Items list. */
async function liveBoard(name, { proxied = false } = {}) {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the live view checks');
  const box = machine();
  const alpha = project(box, name);
  box.run(alpha.repo, 'add', 'web', 'Header', '--specs', 'G1', '--criterion', 'renders');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), `pullboard-${name}-chrome-`));
  let chrome, proxy;
  try {
    proxy = proxied ? await cuttableProxy(view) : null;
    chrome = await openSnapshotChrome(executable, proxy?.href ?? view.link.href, profile);
    await chrome.waitFor('data?.project?.items?.some(item => item.id === 1) && !!document.querySelector(\'#chain [data-item="1"]\')');
  } catch (error) {
    if (chrome) await closeSnapshotChrome(chrome);
    await proxy?.close();
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
    throw error;
  }
  /** Stop this test's Chrome, proxy and view, and remove its profile. */
  const close = async () => {
    await closeSnapshotChrome(chrome);
    await proxy?.close();
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  };
  return { box, alpha, view, chrome, proxy, close };
}

/** Record in the page when an expression first holds after a DOM change, on the page's own clock. */
async function watchFor(chrome, name, expression) {
  await chrome.stable(`(() => {
    window[${JSON.stringify(name)}] = null;
    const seen = () => { if (window[${JSON.stringify(name)}] === null && (${expression})) window[${JSON.stringify(name)}] = Date.now(); };
    new MutationObserver(seen).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    return true;
  })()`);
}

/** When the board recorded its latest event of a kind for an item, read back through the API. */
async function eventAt(view, root, kind, item) {
  const id = await boardId(view, root);
  const response = await fetchLive(`${view.base}/api/v1/boards/${id}/events`, { headers: { 'x-pullboard-key': view.key } });
  assert.equal(response.status, 200);
  const event = (await response.json()).events.filter((row) => row.event_kind === kind && row.item_id === item).at(-1);
  assert.ok(event, `the board recorded a ${kind} event for #${item}`);
  return Date.parse(event.event_at);
}

test('the view shows a move as it happens [N26,A2]', { timeout: 120_000 }, async (t) => {
  const { box, alpha, view, chrome, close } = await liveBoard('live-move');
  try {
    // A quiet board draws no reads: the old view polled every 3000 ms, so any timer would show in this window.
    const quiet = chrome.requests.length;
    await browserPause(3_500); // budget: declared quiet window, longer than the 3000 ms timer the view used to read on.
    assert.deepEqual(sent(chrome, quiet), [], 'the page makes no request while the board is quiet');
    const latest = (await boardOf(view, alpha.repo)).events[0].event_id;
    assert.deepEqual(streamReads(chrome), [String(latest)], 'the page follows the board\'s event stream after the latest event it read');

    await watchFor(chrome, '__claimShownAt', 'document.querySelector(\'#chain [data-item="1"] .chip.busy\')');
    const before = chrome.requests.length;
    box.run(alpha.web, 'claim', '1');
    await chrome.waitFor('window.__claimShownAt !== null', 15_000); // budget: hang ceiling for the claim to arrive; the latency is judged below.
    const shownAt = await chrome.stable('window.__claimShownAt');
    const latency = shownAt - await eventAt(view, alpha.repo, 'claim', 1);
    t.diagnostic(`the claim appeared ${latency} ms after the board recorded it`);
    assert.ok(latency <= 2_000, `the claim appears ${latency} ms after the board recorded it`); // budget: declared by #545's frozen criterion: a move appears within 2000 ms.
    // What the page read for it came after the move, and the stream it follows stayed open.
    assert.ok(sent(chrome, before).length > 0 && sent(chrome, before).every((line) => /^GET \/api\/v1\/boards(?:\/[^/]+\/(?:state|shouts\/\d+))?$/.test(line)), `the page read the board for the move: ${JSON.stringify(sent(chrome, before))}`);
    assert.equal(streamReads(chrome).length, 1, 'the page kept the one stream it opened');
    assert.equal(await chrome.stable("document.querySelector('#live').textContent"), '', 'the live line says the page is live');
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    await close();
  }
});

test('an idle view makes no requests [N26,A2]', { timeout: 150_000 }, async () => {
  const { box, alpha, chrome, close } = await liveBoard('live-idle');
  try {
    await chrome.waitFor('document.querySelector(\'#live\').textContent === \'\'');
    const mark = chrome.requests.length;
    await browserPause(30_000); // budget: declared by #545's frozen criterion: an unchanged board for 30 seconds.
    assert.deepEqual(sent(chrome, mark), [], 'the page makes no request while the board is unchanged for 30 seconds');
    assert.equal(await chrome.stable("document.querySelector('#live').textContent"), '', 'and it is still live');
    // The quiet was the stream waiting, not a page that stopped: a move after it still arrives.
    box.run(alpha.repo, 'add', 'web', 'After the quiet', '--specs', 'G1', '--criterion', 'renders');
    await chrome.waitFor('!!document.querySelector(\'#chain [data-item="2"]\')', 15_000); // budget: hang ceiling for the new item to arrive.
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    await close();
  }
});

test('a dropped stream reconnects from its last event [N26,A2]', { timeout: 120_000 }, async () => {
  const { box, alpha, view, chrome, proxy, close } = await liveBoard('live-drop', { proxied: true });
  try {
    await chrome.waitFor('document.querySelector(\'#live\').textContent === \'\'');
    const latest = (await boardOf(view, alpha.repo)).events[0].event_id;
    // The connection drops and stays down: the live line says the page is not live.
    proxy.cut();
    await chrome.waitFor('/^(offline|reconnecting)/.test(document.querySelector(\'#live\').textContent)', 15_000); // budget: hang ceiling for the dropped stream to show.
    // A move while the page is cut off is one the reopened stream must bring.
    box.run(alpha.web, 'claim', '1');
    proxy.restore();
    await chrome.waitFor('!!document.querySelector(\'#chain [data-item="1"] .chip.busy\')', 30_000); // budget: hang ceiling for one reconnect after the stream's longest 15000 ms wait.
    await chrome.waitFor('document.querySelector(\'#live\').textContent === \'\'');
    const reads = streamReads(chrome);
    assert.ok(reads.length >= 2, `the page opened the stream again: ${JSON.stringify(reads)}`);
    assert.deepEqual([...new Set(reads)], [String(latest)], 'every reopened stream names the last event the page received, as Last-Event-ID');
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    await close();
  }
});
