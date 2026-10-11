/** Cockpit snapshot checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { portableSnapshot } from '../../src/serve.js';
import { machine, project, build, sendBack, fetchLive, startView, accept, boardId, boardOf, assertObservationsEqual, chromeExecutable, browserPause, openSnapshotChrome, closeSnapshotChrome, press, travel, settled, roadmapRow, showing, readRoadmap, openRoadmapParts, serveFolder, proofShot } from './fixture.js';


test('static export stays in its prefix and replays read-only in Chrome [A10,A3]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME to run the static replay proof.');

  const box = machine();
  const alpha = project(box, 'snapshot replay');
  box.run(alpha.repo, 'add', 'web', 'Replay greeting', '--specs', 'G1', '--criterion', 'renders');
  build(box, alpha, 1, 'greeting.html');
  sendBack(box, alpha, 1, 'the first greeting needs a correction');
  build(box, alpha, 1, 'greeting-fix.html');
  // Accept the submitted commit from a throwaway coordinator checkout, then always restore main.
  box.git(alpha.repo, 'switch', '-q', '--detach', alpha.branch);
  try { box.run(alpha.repo, 'verify', '1', 'accept', '--note', 'the corrected greeting renders', '--as', 'coordinator'); }
  finally { box.git(alpha.repo, 'switch', '-q', 'main'); }
  // Exercise the person's decision button so snapshot mode must hide this real mutation control.
  box.run(alpha.repo, 'shout', 'person', 'Should the replay stay read-only?', '--decision');
  box.run(alpha.repo, 'hold', 'web', '--reason', 'Snapshot stays read-only');
  const scriptShout = '<script>window.__snapshotShoutRan = true</script>';
  box.run(alpha.repo, 'shout', 'all', scriptShout);

  // Capture the live API state before export; the exported replay must finish at exactly this state.
  const live = await startView(box);
  let expected;
  try { expected = portableSnapshot(await boardOf(live, alpha.repo), alpha.repo); }
  finally { await live.stop(); }

  const exportDir = join(box.dir, 'snapshot-export');
  box.run(alpha.repo, 'view', '--export', exportDir);
  assert.ok(existsSync(join(exportDir, 'index.html')));
  assert.ok(existsSync(join(exportDir, 'view.css')));
  const exportedBoards = JSON.parse(readFileSync(join(exportDir, 'api', 'v1', 'boards.json'), 'utf8'));
  const boardId = exportedBoards.boards[0].id;
  const exportedEvents = JSON.parse(readFileSync(join(exportDir, 'api', 'v1', 'boards', boardId, 'events.json'), 'utf8')).events;
  const fullBoardLog = JSON.parse(box.run(alpha.repo, 'log', '--json')).events;
  assert.equal(exportedEvents.length, fullBoardLog.length, 'the snapshot exports every board event');
  assert.deepEqual(exportedEvents.map((event) => event.event_id), fullBoardLog.map((event) => event.event_id),
    'the snapshot event file contains the complete ordered board log');

  const prefix = '/demo/';
  const staticRequests = [];
  const outsideRequests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const entry = { method: request.method, path: url.pathname, headers: request.headers };
    staticRequests.push(entry);
    if (!url.pathname.startsWith(prefix)) {
      outsideRequests.push(entry);
      response.writeHead(404).end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end();
      return;
    }
    let relativePath;
    try { relativePath = decodeURIComponent(url.pathname.slice(prefix.length)); }
    catch { response.writeHead(400).end(); return; }
    if (!relativePath) relativePath = 'index.html';
    const file = resolve(exportDir, relativePath);
    if (!file.startsWith(`${resolve(exportDir)}/`)) { response.writeHead(404).end(); return; }
    let body;
    try { body = readFileSync(file); }
    catch { response.writeHead(404).end(); return; }
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
      : file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.json') ? 'application/json; charset=utf-8'
      : 'application/octet-stream';
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-snapshot-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, `${base}${prefix}`, profile);
    const evaluate = chrome.stable;
    await chrome.waitFor("document.body?.classList.contains('snapshot') && typeof snapshotReplay === 'object' && !!data?.project && snapshotReplay.events.length > 0 && snapshotReplay.index === snapshotReplay.events.length");
    await chrome.waitFor("!!document.querySelector('#replay-play') && !!document.querySelector('#replay-pause') && !!document.querySelector('#replay-speed') && !!document.querySelector('#replay-progress')");

    const initial = JSON.parse(await evaluate(`JSON.stringify({ project: data.project, index: snapshotReplay.index, total: snapshotReplay.events.length, playing: snapshotReplay.playing, speedOptions: [...document.querySelector('#replay-speed').options].map((option) => option.value), bodyClass: document.body.classList.contains('snapshot') })`));
    assert.equal(initial.bodyClass, true);
    assertObservationsEqual(expected, initial.project, 'the initial snapshot is the final live API state');
    assert.deepEqual(initial.speedOptions, ['1', '4', '16']);
    assert.ok(initial.total >= 6, 'the exported board contains the complete claim/submit/reject/claim/submit/accept history');
    assert.ok(initial.index >= initial.total - 1, 'the initial replay position is the exported final state');

    const shout = JSON.parse(await evaluate(`JSON.stringify((() => {
      const feed = document.querySelector('#feed');
      return { text: feed.textContent, html: feed.innerHTML, scripts: feed.querySelectorAll('script').length };
    })())`));
    assert.ok(shout.text.includes(scriptShout), 'the shout is visible as literal text');
    assert.ok(shout.html.includes('&lt;script&gt;'), 'the snapshot escapes HTML in shout text');
    assert.equal(shout.scripts, 0, 'shout text never becomes an executable script element');

    await evaluate(`(() => {
      window.__snapshotRealAdvance = advanceReplay;
      window.__snapshotFirstPosition = null;
      window.advanceReplay = () => {
        window.__snapshotFirstPosition = { index: snapshotReplay.index, items: data.project.items.map((item) => item.id) };
        snapshotReplay.playing = false;
        replayControls();
      };
    })()`);
    await chrome.click("document.querySelector('#replay-play')");
    const firstPosition = JSON.parse(await evaluate('JSON.stringify(window.__snapshotFirstPosition)'));
    assert.deepEqual(firstPosition, { index: 0, items: [] }, 'play starts from an empty board before its first event');
    await evaluate('window.advanceReplay = window.__snapshotRealAdvance');

    const replayKinds = await evaluate(`JSON.stringify(snapshotReplay.events.map((event) => event.event_kind))`);
    const kinds = JSON.parse(replayKinds);
    const transitions = ['claim', 'submit', 'reject', 'claim', 'submit', 'accept'];
    let cursor = -1;
    for (const kind of transitions) {
      cursor = kinds.indexOf(kind, cursor + 1);
      assert.notEqual(cursor, -1, `replay includes ordered ${kind} event`);
    }

    const hiddenMutationControls = await evaluate(`JSON.stringify(['#new-item', '#add-form', '#shout-form', '#hold-form', '[data-release]', '[data-shout]', '[data-new]', '[data-go^="decide:"]'].filter((selector) => { const node = document.querySelector(selector); return node && !node.hidden && getComputedStyle(node).display !== 'none'; }))`);
    assert.deepEqual(JSON.parse(hiddenMutationControls), [], 'snapshot hides controls that could change the board');
    const writesBeforeAct = staticRequests.length;
    const directAction = await evaluate(`(async () => JSON.stringify({ result: await act('shout', { to: 'web', text: 'must remain local' }), message: document.body.innerText }))()`);
    assert.equal(JSON.parse(directAction).result, false, 'snapshot action refuses direct mutation calls');
    assert.match(JSON.parse(directAction).message, /snapshot/i, 'refusal explains that this is a snapshot');
    await browserPause(100);
    assert.equal(staticRequests.length, writesBeforeAct, 'a refused action makes no browser request');

    await evaluate(`(() => {
      window.__replayObserved = [];
      let previousIndex = null;
      const progress = document.querySelector('#replay-progress');
      new MutationObserver(() => {
        const index = snapshotReplay.index;
        if (index === previousIndex) return;
        previousIndex = index;
        const dot = document.querySelector('[data-item="1"] .dot');
        const status = dot && [...dot.classList].find((name) => ['open', 'building', 'verify', 'back', 'verified'].includes(name));
        if (status) window.__replayObserved.push({ index, status });
      }).observe(progress, { childList: true, characterData: true, subtree: true });
    })()`);
    await chrome.click("document.querySelector('#replay-play')");
    await chrome.waitFor('snapshotReplay.playing && snapshotReplay.index > 0 && snapshotReplay.index < snapshotReplay.events.length');
    const beforePause = await evaluate('snapshotReplay.index');
    await chrome.click("document.querySelector('#replay-pause')");
    await chrome.waitFor('!snapshotReplay.playing');
    const pausedIndex = await evaluate('snapshotReplay.index');
    assert.equal(pausedIndex, beforePause, 'pause keeps the current replay event');
    await browserPause(180);
    assert.equal(await evaluate('snapshotReplay.index'), pausedIndex, 'a paused replay does not advance');

    await evaluate(`(() => {
      window.__replayScheduledDelays = [];
      const nativeSetTimeout = window.setTimeout.bind(window);
      /** Observe replay pacing while preserving each native browser timeout unchanged. */
      window.setTimeout = (callback, delay, ...args) => {
        if (callback === window.advanceReplay) window.__replayScheduledDelays.push(delay);
        return nativeSetTimeout(callback, delay, ...args);
      };
    })()`);
    /** Replay the complete exported history and compare scheduled timer values, not elapsed time. */
    const assertScheduledDelay = async (speed, delay) => {
      await evaluate(`(() => {
        window.__replayScheduledDelays.length = 0;
        replayPosition(snapshotReplay.events.length);
        const select = document.querySelector('#replay-speed');
        select.value = '${speed}';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      assert.equal(await evaluate("document.querySelector('#replay-speed').value"), speed);
      await chrome.click("document.querySelector('#replay-play')");
      await chrome.waitFor('!snapshotReplay.playing', 30_000); // budget: hang-only ceiling for one complete replay.
      assert.equal(await evaluate('snapshotReplay.playing'), false, `${speed}× replay reaches its end`);
      assert.equal(await evaluate('snapshotReplay.index'), initial.total, `${speed}× replay renders the final exported event`);
      const scheduled = JSON.parse(await evaluate('JSON.stringify(window.__replayScheduledDelays)'));
      assert.equal(scheduled.length, initial.total - 1, `${speed}× schedules one timeout between each exported event`);
      assert.ok(scheduled.every((actual) => actual === delay), `${speed}× schedules ${delay} ms per step; got ${scheduled.join(', ')}`);
    };
    await assertScheduledDelay('1', 1000);
    await assertScheduledDelay('4', 250);
    await assertScheduledDelay('16', 62.5);
    assert.equal(await evaluate('snapshotReplay.playing'), false, 'each measured replay reaches its end');

    const changedSpeed = JSON.parse(await evaluate(`JSON.stringify((() => {
      window.__replayScheduledDelays.length = 0;
      replayPosition(snapshotReplay.events.length);
      const select = document.querySelector('#replay-speed');
      select.value = '4';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#replay-play').click();
      const wasPlaying = snapshotReplay.playing, atFour = window.__replayScheduledDelays.at(-1);
      select.value = '16';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const remainsPlaying = snapshotReplay.playing, atSixteen = window.__replayScheduledDelays.at(-1);
      document.querySelector('#replay-pause').click();
      return { wasPlaying, atFour, remainsPlaying, atSixteen, paused: !snapshotReplay.playing };
    })())`));
    assert.deepEqual(changedSpeed, { wasPlaying: true, atFour: 250, remainsPlaying: true, atSixteen: 62.5, paused: true },
      'changing speed while playing replaces the scheduled delay and leaves pause effective');
    await assertScheduledDelay('16', 62.5);
    const renderedStates = JSON.parse(await evaluate('JSON.stringify(window.__replayObserved.map((entry) => entry.status))'));
    const distinctStates = renderedStates.filter((state, index) => index === 0 || state !== renderedStates[index - 1]);
    const firstClaim = distinctStates.indexOf('building');
    assert.notEqual(firstClaim, -1, 'the rendered replay shows a claimed item');
    assert.deepEqual(distinctStates.slice(firstClaim, firstClaim + 6),
      ['building', 'verify', 'back', 'building', 'verify', 'verified'],
      'the actual item row renders claim, submit, reject, claim, submit, accept in order');
    const finalProject = await evaluate('JSON.stringify(data.project)');
    assertObservationsEqual(expected, JSON.parse(finalProject), 'replay ends at the same state served live before export');

    for (const [width, theme] of [[1280, 'light'], [375, 'dark']]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await evaluate(`document.documentElement.dataset.theme = '${theme}'`);
      assert.ok(await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'),
        'snapshot controls fit the viewport content area');
      if (process.env.PULLBOARD_SNAPSHOT_PROOF) {
        mkdirSync(process.env.PULLBOARD_SNAPSHOT_PROOF, { recursive: true });
        const shot = await chrome.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        writeFileSync(join(process.env.PULLBOARD_SNAPSHOT_PROOF, `snapshot-${width}-${theme}.png`), Buffer.from(shot.data, 'base64'));
      }
    }

    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught page exceptions');
    const nonHttpRequests = chrome.requests.filter(({ url }) => !/^https?:/i.test(url));
    assert.ok(nonHttpRequests.every(({ url }) => url.startsWith('data:')), 'the only non-network browser URL may be a local data favicon');
    const browserRequests = chrome.requests.filter(({ url }) => /^https?:/i.test(url)).map(({ method, url, headers }) => ({
      method,
      origin: new URL(url).origin,
      path: new URL(url).pathname,
      hasBoardKey: Object.keys(headers).some((name) => name.toLowerCase() === 'x-pullboard-key'),
    }));
    assert.ok(browserRequests.length > 0);
    assert.ok(browserRequests.every((request) => request.origin === base), 'Chrome makes HTTP requests only to the static host');
    assert.deepEqual(browserRequests.filter((request) => !request.path.startsWith(prefix)), [], 'Chrome never requests outside /demo/');
    assert.ok(browserRequests.every((request) => request.method === 'GET' && !request.hasBoardKey), 'static assets and API JSON are GET-only and carry no board key');
    assert.deepEqual(outsideRequests, [], 'the static host receives no request outside /demo/');
    assert.ok(staticRequests.every((request) => request.method === 'GET' || request.method === 'HEAD'), 'the static host serves reads only');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await new Promise((resolve) => server.close(resolve));
    rmSync(profile, { recursive: true, force: true });
  }
});

test('replay speed is judged by its scheduled delay [A10,C7]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the throttled replay timing proof');
  const box = machine();
  const alpha = project(box, 'throttled-snapshot');
  for (let id = 1; id <= 6; id++) {
    box.run(alpha.repo, 'add', 'web', `Throttled replay item ${id}`, '--specs', 'G1', '--criterion', 'replays');
  }
  const folder = join(box.dir, 'throttled-export');
  box.run(alpha.repo, 'view', '--export', folder);
  const host = await serveFolder(folder, '/demo/');
  const profile = join(box.dir, 'throttled-chrome');
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, `${host.base}/demo/`, profile);
    await settled(chrome, "document.body.classList.contains('snapshot') && !!data?.project && snapshotReplay.index === snapshotReplay.events.length");
    await chrome.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    const total = await chrome.stable('snapshotReplay.events.length');
    assert.ok(total >= 6, 'the exported history contains at least six native item moves');
    await chrome.stable(`(() => {
      window.__replayScheduledDelays = [];
      const nativeSetTimeout = window.setTimeout.bind(window);
      /** Observe replay pacing while preserving each native browser timeout unchanged. */
      window.setTimeout = (callback, delay, ...args) => {
        if (callback === window.advanceReplay) window.__replayScheduledDelays.push(delay);
        return nativeSetTimeout(callback, delay, ...args);
      };
    })()`);
    /** Confirm the pacing value for every scheduled step in a complete CPU-throttled replay. */
    const assertThrottledDelay = async (speed, delay) => {
      await chrome.stable(`(() => {
        window.__replayScheduledDelays.length = 0;
        replayPosition(snapshotReplay.events.length);
        const select = document.querySelector('#replay-speed');
        select.value = '${speed}';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await press(chrome, "document.querySelector('#replay-play')");
      await chrome.waitFor('!snapshotReplay.playing', 30_000); // budget: hang-only ceiling for one complete replay.
      assert.equal(await chrome.stable('snapshotReplay.playing'), false, `${speed}× replay reaches its end`);
      assert.equal(await chrome.stable('snapshotReplay.index'), total, `${speed}× replay renders the final exported event`);
      const scheduled = await chrome.stable('window.__replayScheduledDelays');
      assert.equal(scheduled.length, total - 1, `${speed}× schedules one delay between every replay step`);
      assert.ok(scheduled.every((actual) => actual === delay), `${speed}× schedules ${delay} ms per step`);
    };
    await assertThrottledDelay('1', 1000);
    await assertThrottledDelay('4', 250);
    await assertThrottledDelay('16', 62.5);
    const changedSpeed = await chrome.stable(`(() => {
      window.__replayScheduledDelays.length = 0;
      replayPosition(snapshotReplay.events.length);
      const select = document.querySelector('#replay-speed');
      select.value = '4';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#replay-play').click();
      const wasPlaying = snapshotReplay.playing, atFour = window.__replayScheduledDelays.at(-1);
      select.value = '16';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const remainsPlaying = snapshotReplay.playing, atSixteen = window.__replayScheduledDelays.at(-1);
      document.querySelector('#replay-pause').click();
      return { wasPlaying, atFour, remainsPlaying, atSixteen, paused: !snapshotReplay.playing };
    })()`);
    assert.deepEqual(changedSpeed, { wasPlaying: true, atFour: 250, remainsPlaying: true, atSixteen: 62.5, paused: true },
      'changing speed while playing replaces the scheduled delay under CPU throttle');
    assert.deepEqual(chrome.exceptions, [], 'the throttled snapshot reports no uncaught browser errors');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await host.close();
  }
});

test('static export redacts structured checkout paths but preserves paths people wrote [A10]', async () => {
  const box = machine();
  const alpha = project(box, 'private-project');
  box.run(alpha.repo, 'add', 'web', 'Private checkout item', '--specs', 'G1', '--criterion', 'exports without checkout paths');
  const projectRoot = alpha.repo;
  const worktreeRoot = alpha.web;
  const commonGitDir = box.git(alpha.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const live = await startView(box);
  try {
    const listingResponse = await fetchLive(`${live.base}/api/v1/boards`, { headers: { 'x-pullboard-key': live.key } });
    assert.equal(listingResponse.status, 200);
    const listing = await listingResponse.json();
    const board = listing.boards.find((entry) => entry.root === projectRoot);
    assert.ok(board, 'the live listing keeps the absolute project root');
    assert.equal(board.root, projectRoot);
    const state = await boardOf(live, projectRoot);
    assert.equal(state.root, projectRoot, 'live state keeps the absolute root');
    const agent = state.agents.find((entry) => entry.agent_id === 'web-1');
    assert.ok(agent);
    assert.equal(agent.agent_path, worktreeRoot, 'live state keeps the agent worktree path');
    assert.equal(box.git(alpha.web, 'rev-parse', '--path-format=absolute', '--git-common-dir'), commonGitDir,
      'the linked worktree still shares the repository common Git directory');
    const boardEvents = await fetchLive(`${live.base}/api/v1/boards/${board.id}/events`, { headers: { 'x-pullboard-key': live.key } });
    assert.equal(boardEvents.status, 200);
    const events = await boardEvents.json();
    assert.ok(events.events.length > 0);

    /** Enumerate every exported file, including the API document subtree. */
    const filesBelow = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(path) : [path];
    });
    /** Read all bytes so an unexpected exported field cannot hide a private folder. */
    const exportedText = (directory) => filesBelow(directory).map((path) => readFileSync(path, 'utf8')).join('\n');
    const snapshot = join(box.dir, 'export-structured');
    box.run(alpha.repo, 'view', '--export', snapshot);
    const structuredFiles = exportedText(snapshot);
    for (const privatePath of [box.dir, projectRoot, worktreeRoot, commonGitDir]) {
      assert.ok(!structuredFiles.includes(privatePath), `export does not include structured path ${privatePath}`);
    }

    // A second export deliberately includes paths in human-authored prose. Those exact values are
    // the only allowed occurrences; project.root, agent_path and common Git metadata stay redacted.
    const brief = `Keep this literal checkout reference: ${projectRoot}`;
    const shout = `Please inspect this literal agent folder: ${worktreeRoot}`;
    box.run(alpha.repo, 'add', 'web', 'Path in prose', '--specs', 'G1', '--criterion', 'keeps prose literal', '--brief', brief);
    box.run(alpha.web, 'shout', 'all', shout);
    const proseSnapshot = join(box.dir, 'export-prose');
    box.run(alpha.repo, 'view', '--export', proseSnapshot);
    const stateFile = JSON.parse(readFileSync(join(proseSnapshot, 'api', 'v1', 'boards', board.id, 'state.json'), 'utf8')).state;
    assert.notEqual(stateFile.root, projectRoot, 'export redacts structured project root');
    assert.notEqual(stateFile.agents.find((entry) => entry.agent_id === 'web-1').agent_path, worktreeRoot,
      'export redacts the structured agent worktree');
    assert.equal(stateFile.items.find((entry) => entry.title === 'Path in prose').brief, brief);
    assert.ok(stateFile.shouts.some((entry) => entry.shout_text === shout), 'the authored shout remains literal');
    const proseFiles = filesBelow(proseSnapshot).map((path) => readFileSync(path, 'utf8'));
    let scrubbedText = proseFiles.join('\n');
    for (const text of [brief, shout]) {
      scrubbedText = scrubbedText.replaceAll(JSON.stringify(text), '"<authored prose>"')
        .replaceAll(JSON.stringify(JSON.stringify(text)).slice(1, -1), '<authored event prose>');
    }
    for (const privatePath of [box.dir, projectRoot, worktreeRoot, commonGitDir]) {
      assert.ok(!scrubbedText.includes(privatePath), `outside authored prose, export does not include ${privatePath}`);
    }
  } finally {
    await live.stop();
  }
});

test('an exported roadmap has its own address under a folder, and Back and Forward return to it [N38,A10]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for exported roadmap checks.');
  const box = machine();
  const alpha = project(box, 'roadmap-snapshot');
  const beacon = project(box, 'beacon');
  box.run(alpha.repo, 'add', 'web', 'Verified page', '--specs', 'G1', '--criterion', 'renders');
  box.run(alpha.repo, 'add', 'web', 'Open page', '--specs', 'G1', '--criterion', 'renders');
  build(box, alpha, 1, 'one.txt');
  accept(box, alpha, 1);
  box.run(beacon.repo, 'add', 'web', 'Billing webhook retries', '--specs', 'G1', '--criterion', 'retries');
  box.run(alpha.repo, 'milestone', 'add', 'Launch', '--note', 'Ships with the snapshot.', '--items', '1,2,beacon#1');
  box.run(alpha.repo, 'milestone', 'add', 'Later');
  const folder = join(box.dir, 'roadmap-export');
  box.run(alpha.repo, 'view', '--export', folder);
  const host = await serveFolder(folder, '/demo/');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-export-chrome-'));
  const ready = "document.body.classList.contains('snapshot') && !!data?.project && snapshotReplay.index === snapshotReplay.events.length";
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, `${host.base}/demo/`, profile);
    await settled(chrome, `${ready} && ${showing('items', '/demo/')}`);
    await press(chrome, `document.querySelector('[data-tab="roadmap"]')`);
    await chrome.waitFor(showing('roadmap', '/demo/#roadmap'));
    await openRoadmapParts(chrome);
    const seen = await readRoadmap(chrome);
    assert.deepEqual(seen.cards[0].rows.map(({ id, label, tone, button }) => ({ id, label, tone, button })), [
      { id: '#1', label: 'verified', tone: 'ok', button: true },
      { id: '#2', label: 'unclaimed', tone: 'free', button: true },
      { id: 'beacon#1', label: 'unclaimed', tone: 'free', button: false },
    ], "the snapshot's rows read as its Items tab does; another repo's item, not in the snapshot, opens nothing");
    assert.equal(seen.cards[0].rows[2].tip, 'Billing webhook retries (not in this snapshot)', 'and says why');
    assert.deepEqual([seen.cards[1].name, seen.cards[1].empty], ['Later', 'No items yet.']);

    // The address survives a reload on a static host, and Back and Forward show the tab it names,
    // whether the browser keeps the page for an entry or loads it again.
    await chrome.send('Page.reload');
    await settled(chrome, `${ready} && ${showing('roadmap', '/demo/#roadmap')} && !!${roadmapRow('#1')}`);
    await travel(chrome, -1);
    await settled(chrome, `${ready} && ${showing('items', '/demo/')}`);
    await travel(chrome, 1);
    await settled(chrome, `${ready} && ${showing('roadmap', '/demo/#roadmap')} && !!${roadmapRow('#2')}`);
    await press(chrome, roadmapRow('#2'));
    await chrome.waitFor(`${showing('items', '/demo/')} && document.querySelector('#detail h2')?.innerText.includes('Open page')`);
    await travel(chrome, -1);
    await settled(chrome, `${ready} && ${showing('roadmap', '/demo/#roadmap')}`);

    // Opened afresh, the folder shows the board's tab, and its #roadmap address the Roadmap.
    for (const [address, pane] of [['/demo/', 'items'], ['/demo/#roadmap', 'roadmap']]) {
      await chrome.send('Page.navigate', { url: 'about:blank' });
      await settled(chrome, "location.href === 'about:blank'");
      await chrome.send('Page.navigate', { url: `${host.base}${address}` });
      await settled(chrome, `${ready} && ${showing(pane, address)}`);
    }
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      await openRoadmapParts(chrome);
      const layout = await readRoadmap(chrome);
      assert.ok(layout.document <= layout.client && layout.body <= layout.client, `${width}: no sideways scroll in the snapshot: ${JSON.stringify(layout)}`);
      await proofShot(chrome, 'snapshot-roadmap', width);
    }
    assert.deepEqual(host.requests.filter((request) => !request.path.startsWith('/demo/') || request.status !== 200), [], 'every request stays in the folder and finds its file');
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught page exceptions');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await host.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
