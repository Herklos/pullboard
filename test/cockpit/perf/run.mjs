/** Measure each frozen cockpit action on a generated board in an isolated machine and browser profile. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { performance as nodePerformance } from 'node:perf_hooks';
import { closeBoard, openBoard, shout } from '../../../src/board.js';
import * as gate from '../../../src/gate.js';
import * as resources from '../../../src/resources.js';
import { findChromeExecutable, startChrome } from '../../chrome-fixture.js';
import { press, stableChrome } from '../stable.js';
import { generateStressBoard, removeStressBoard } from './generate.mjs';

const ROOT = resolve(import.meta.dirname, '../../..');
const BIN = join(ROOT, 'bin', 'pullboard.js');
const ACTION_TIMEOUT_MS = 60_000;
const VIEW_START_TIMEOUT_MS = 30_000;
const VIEW_STOP_TIMEOUT_MS = 5_000;
const LANES = ['core', 'view', 'coordinator', 'docs'];
const VIEWER_ACTIONS = [
  ['tab:shouts', 'shouts', '#feed .shout'],
  ['tab:spec', 'spec', '#spec-list .row'],
  ['tab:doctrine', 'doctrine', '#doctrine-list .row'],
  ['tab:activity', 'activity', '#activity > *'],
  ['tab:roadmap', 'roadmap', '#roadmap .milestone'],
  ['tab:items', 'items', '#chain .row'],
];

/** Hold the real shared browser pool for fixture setup, Chrome actions and teardown. */
export async function withPerfSlot(action) {
  if (typeof action !== 'function') throw new TypeError('the performance slot needs an action');
  if (typeof resources.gateSlotEnvironment !== 'function') {
    throw new Error('the browser-capable shared gate API is unavailable; merge the current resource-pool update before running the performance harness');
  }
  return gate.withGateSlot(ROOT, async (lease) => {
    const proofEnvironment = resources.gateSlotEnvironment(lease);
    if (lease.browser !== true || proofEnvironment[resources.BROWSER_SLOT_HELD_ENV] !== '1') {
      throw new Error('the performance harness needs a live browser-capable shared gate slot');
    }
    return action((options) => runPerfHarnessInSlot(options, lease));
  }, { browser: true, item: '606', kind: 'cockpit-performance' });
}

/** Install page-side input timestamps, Long Task observation and safe request-size collection. */
function timingScript() {
  return `(() => {
    const state = window.__pb606 = { active: null, marks: Object.create(null), tasks: [] };
    const mark = eventType => event => {
      if (state.active?.eventType === eventType && state.marks[state.active.name] === null) {
        state.marks[state.active.name] = performance.now();
      }
    };
    addEventListener('mousedown', mark('mousedown'), true);
    addEventListener('keydown', mark('keydown'), true);
    try {
      state.longTaskObserver = new PerformanceObserver(list => state.tasks.push(...list.getEntries().map(entry => ({ startTime: entry.startTime, duration: entry.duration }))));
      state.longTaskObserver.observe({ type: 'longtask', buffered: true });
      state.longTaskObserverStatus = 'available';
    } catch (error) {
      state.longTaskObserverStatus = 'unsupported';
      state.longTaskObserverError = error?.name ?? 'unknown';
    }
    performance.setResourceTimingBufferSize(10000);
    window.__pb606Begin = (name, eventType) => { state.active = { name, eventType }; state.marks[name] = null; };
    window.__pb606Collect = (name, startAt, endAt, stable) => {
      state.tasks.push(...(state.longTaskObserver?.takeRecords() ?? []).map(entry => ({ startTime: entry.startTime, duration: entry.duration })));
      const tasks = state.tasks.filter(entry => entry.startTime < endAt && entry.startTime + entry.duration > startAt && entry.duration > 50)
        .map(entry => ({ startMs: entry.startTime - startAt, durationMs: entry.duration }));
      return { name, stable, startMs: startAt, endMs: endAt, durationMs: endAt - startAt,
        longTaskObserverStatus: state.longTaskObserverStatus,
        longTaskObserverError: state.longTaskObserverError ?? null,
        longTasks: tasks,
        largestLongTaskMs: state.longTaskObserverStatus === 'available' ? Math.max(0, ...tasks.map(entry => entry.durationMs)) : null,
        timeOrigin: performance.timeOrigin,
        longTaskObserverUnavailable: state.longTaskObserverStatus !== 'available' };
    };
  })()`;
}

/** Attach a private CDP observer that retains local request paths and actual encoded response byte counts. */
async function openNetworkCapture(profile, localOrigin) {
  const port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('isolated Chrome did not publish a valid local DevTools port');
  const targetsResponse = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5_000) });
  if (!targetsResponse.ok) throw new Error('isolated Chrome did not return its local page target');
  const targets = await targetsResponse.json();
  const target = targets.find((entry) => entry.type === 'page' && entry.url === 'about:blank' && typeof entry.webSocketDebuggerUrl === 'string');
  if (!target) throw new Error('isolated Chrome has no blank page target for local network observation');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const records = [];
  const active = new Map();
  const commands = new Map();
  let nextCommand = 0;
  let closed = false;
  const opened = new Promise((resolveOpen, rejectOpen) => {
    const timeout = setTimeout(() => rejectOpen(new Error('local Chrome network observer did not connect')), 5_000);
    socket.addEventListener('open', () => { clearTimeout(timeout); resolveOpen(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); rejectOpen(new Error('local Chrome network observer failed to connect')); }, { once: true });
    socket.addEventListener('close', () => { clearTimeout(timeout); rejectOpen(new Error('local Chrome network observer closed before connecting')); }, { once: true });
  });
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.id !== undefined) {
      const pending = commands.get(message.id);
      if (!pending) return;
      commands.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error('local Chrome network observation command failed'));
      else pending.resolve(message.result);
      return;
    }
    const params = message.params ?? {};
    if (message.method === 'Network.requestWillBeSent') {
      if (params.redirectResponse) {
        const redirected = active.get(params.requestId);
        if (redirected) {
          redirected.status = params.redirectResponse.status ?? null;
          redirected.responseBytes = Number.isFinite(params.redirectResponse.encodedDataLength)
            ? params.redirectResponse.encodedDataLength : redirected.receivedBytes;
          redirected.complete = true;
          redirected.redirect = true;
          redirected.finishedWallTimeMs = Number.isFinite(params.timestamp) && Number.isFinite(redirected.startTimestamp)
            ? redirected.startWallTimeMs + (params.timestamp - redirected.startTimestamp) * 1_000 : null;
        }
      }
      let url;
      try { url = new URL(params.request?.url); } catch { active.delete(params.requestId); return; }
      if (url.origin !== localOrigin) { active.delete(params.requestId); return; }
      const request = { path: url.pathname, method: params.request?.method ?? 'OTHER', type: params.type ?? 'Other',
        startWallTimeMs: Number.isFinite(params.wallTime) ? params.wallTime * 1_000 : null,
        startTimestamp: params.timestamp ?? null, status: null, responseBytes: null, receivedBytes: 0,
        chunks: [], complete: false, failed: false };
      records.push(request);
      active.set(params.requestId, request);
      return;
    }
    const request = active.get(params.requestId);
    if (!request) return;
    if (message.method === 'Network.responseReceived') request.status = params.response?.status ?? null;
    if (message.method === 'Network.dataReceived' && Number.isFinite(params.encodedDataLength)) {
      request.receivedBytes += params.encodedDataLength;
      request.chunks.push({ atWallTimeMs: Number.isFinite(params.timestamp) && Number.isFinite(request.startTimestamp)
        ? request.startWallTimeMs + (params.timestamp - request.startTimestamp) * 1_000 : null,
      bytes: params.encodedDataLength });
    }
    if (message.method === 'Network.loadingFinished') {
      request.responseBytes = Number.isFinite(params.encodedDataLength) ? params.encodedDataLength : request.receivedBytes;
      request.complete = true;
      request.finishedWallTimeMs = Number.isFinite(params.timestamp) && Number.isFinite(request.startTimestamp)
        ? request.startWallTimeMs + (params.timestamp - request.startTimestamp) * 1_000 : null;
      request.durationMs = Number.isFinite(params.timestamp) && Number.isFinite(request.startTimestamp)
        ? Math.max(0, (params.timestamp - request.startTimestamp) * 1_000) : null;
      active.delete(params.requestId);
    }
    if (message.method === 'Network.loadingFailed') {
      request.responseBytes = request.receivedBytes;
      request.complete = true;
      request.failed = true;
      request.finishedWallTimeMs = Number.isFinite(params.timestamp) && Number.isFinite(request.startTimestamp)
        ? request.startWallTimeMs + (params.timestamp - request.startTimestamp) * 1_000 : null;
      active.delete(params.requestId);
    }
  });
  const send = (method, params = {}) => new Promise((resolveCommand, rejectCommand) => {
    const id = ++nextCommand;
    const timer = setTimeout(() => {
      commands.delete(id);
      rejectCommand(new Error('local Chrome network observation command timed out'));
    }, 5_000);
    commands.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    await opened;
    await send('Network.enable');
  } catch (error) {
    socket.close();
    throw error;
  }
  return {
    snapshot(name, startMs, endMs, timeOrigin) {
      const firstLoad = name === 'firstLoad';
      const requests = records.map((request) => {
        if (!Number.isFinite(request.startWallTimeMs)) return false;
        const relative = request.startWallTimeMs - timeOrigin;
        const beganInAction = (firstLoad ? relative >= -5_000 : relative >= startMs) && relative <= endMs;
        const chunks = request.chunks.filter((chunk) => Number.isFinite(chunk.atWallTimeMs)
          && chunk.atWallTimeMs - timeOrigin >= startMs && chunk.atWallTimeMs - timeOrigin <= endMs);
        if (!beganInAction && !chunks.length) return null;
        const completedDuringAction = Number.isFinite(request.finishedWallTimeMs)
          && request.finishedWallTimeMs - timeOrigin >= startMs && request.finishedWallTimeMs - timeOrigin <= endMs;
        const completedForFirstLoad = firstLoad && request.complete && !request.failed
          && Number.isFinite(request.finishedWallTimeMs) && request.finishedWallTimeMs - timeOrigin <= endMs;
        const responseBytes = completedForFirstLoad || (beganInAction && request.complete && completedDuringAction)
          ? request.responseBytes : chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
        return { path: request.path, method: request.method, type: request.type, status: request.status,
          responseBytes, complete: request.complete, failed: request.failed,
          startMs: relative - startMs, durationMs: request.durationMs ?? null };
      }).filter(Boolean);
      return { requests, requestBytes: requests.reduce((sum, request) => sum + request.responseBytes, 0),
        incompleteRequests: requests.filter((request) => !request.complete).length };
    },
    close() {
      if (closed) return;
      closed = true;
      for (const pending of commands.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('local Chrome network observer closed'));
      }
      commands.clear();
      socket.close();
    },
  };
}

/** Wait for the named target and condition to remain visibly unchanged for two animation frames. */
async function waitPaintedAndStable(raw, network, name, selector, condition, firstLoad = false) {
  const expression = `(() => {
    const name = ${JSON.stringify(name)}, selector = ${JSON.stringify(selector)};
    const startAt = ${firstLoad ? '0' : `window.__pb606?.marks[${JSON.stringify(name)}]`};
    if (!Number.isFinite(startAt)) throw new Error('the measured input event was not observed');
    const deadline = performance.now() + ${ACTION_TIMEOUT_MS};
    return new Promise((resolve, reject) => {
      let previous = '', stableFrames = 0;
      const sample = () => {
        const node = document.querySelector(selector);
        const style = node ? getComputedStyle(node) : null;
        const rect = node?.getBoundingClientRect();
        const ready = !!node && !!rect && !node.closest('[hidden]') && !document.body.classList.contains('switching') && style.display !== 'none'
          && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 && (${condition});
        const signature = ready ? JSON.stringify([rect.x, rect.y, rect.width, rect.height,
          node.childElementCount, node.textContent.length]) : '';
        stableFrames = signature && signature === previous ? stableFrames + 1 : 0;
        previous = signature;
        if (stableFrames >= 2) {
          const endAt = performance.now();
          resolve(window.__pb606Collect(name, startAt, endAt, true));
          return;
        }
        if (performance.now() >= deadline) { reject(new Error('the named target did not become visibly stable')); return; }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  })()`;
  const measurement = await raw.evaluate(expression, `measure ${name}`, ACTION_TIMEOUT_MS + 1_000);
  return { ...measurement, ...network.snapshot(name, measurement.startMs, measurement.endMs, measurement.timeOrigin) };
}

/** Give the browser a bounded wait without leaving a timer after the requested idle window. */
function pause(ms) {
  return new Promise((resolvePause) => setTimeout(resolvePause, ms)); // budget: the required idle observation lasts exactly the configured 30000ms by default.
}

/** Keep useful startup diagnostics while removing URL credentials and query secrets. */
function safeStartupDiagnostic(stderr) {
  return stderr
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/https?:\/\/[^\s"'<>]+/gu, (value) => {
      try {
        const url = new URL(value);
        url.username = '';
        url.password = '';
        if (url.search) url.search = '?[redacted]';
        if (url.hash) url.hash = '#[redacted]';
        return url.href;
      } catch {
        return '[redacted URL]';
      }
    })
    .replace(/((?:token|secret|key|credential|authorization)\s*[:=]\s*)[^\s,;]+/giu, '$1[redacted]')
    .trim()
    .slice(-2_048);
}

/** Start the generated board's foreground view server without exposing its local key in diagnostics. */
async function startView(board) {
  const env = { ...board.env, PULLBOARD_VIEW_FOREGROUND: '1' };
  const child = spawn(process.execPath, [BIN, 'view', '--no-open', '--port', '0'], {
    cwd: board.root, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let stderr = '';
  let spawnError = null;
  let closeResult = null;
  const closed = new Promise((resolveClosed) => child.once('close', (code, signal) => {
    closeResult = { code, signal };
    resolveClosed(closeResult);
  }));
  child.once('error', (error) => { spawnError = error; });
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output = `${output}${chunk}`.slice(-16_384); });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_096); });
  const deadline = Date.now() + VIEW_START_TIMEOUT_MS;
  while (Date.now() < deadline && !spawnError && !closeResult) {
    const match = /Pullboard view: (http:\/\/127\.0\.0\.1:\d+\/\?k=[^\s]+)/u.exec(output);
    if (match) return { child, closed, link: new URL(match[1]), stderr: () => stderr };
    await pause(25); // budget: polling bounds discovery of the fixture server URL, not product speed.
  }
  await stopView({ child, closed });
  const diagnostic = safeStartupDiagnostic(stderr);
  throw new Error(`the isolated view did not publish a local link within ${VIEW_START_TIMEOUT_MS}ms${spawnError ? `; child could not start: ${spawnError.message}` : closeResult ? `; it exited with status ${closeResult.code ?? 'null'}` : ''}${diagnostic ? `; stderr: ${diagnostic}` : ''}`);
}

/** Stop the one view process started by this harness and wait for its direct child to close. */
async function stopView(view) {
  if (view.child.exitCode === null && view.child.signalCode === null) {
    try { view.child.kill('SIGTERM'); } catch { /* The owned CLI process may have exited between the check and signal. */ }
  }
  const waitForClose = async (timeoutMs) => {
    let timer;
    const result = await Promise.race([view.closed.then(() => true), new Promise((resolveClose) => {
      timer = setTimeout(() => resolveClose(false), timeoutMs);
    })]);
    clearTimeout(timer);
    return result;
  };
  const result = await waitForClose(VIEW_STOP_TIMEOUT_MS);
  if (!result) {
    try { view.child.kill('SIGKILL'); } catch { /* The owned CLI process may have exited before escalation. */ }
    const killed = await waitForClose(VIEW_STOP_TIMEOUT_MS);
    if (!killed) throw new Error('the isolated view did not close after bounded cleanup');
  }
}

/** Record one real CDP key event so the search action includes its actual typing cadence. */
async function typeKey(chrome, value) {
  const code = `Key${value.toUpperCase()}`;
  const keyCode = value.toUpperCase().charCodeAt(0);
  await chrome.send('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code, windowsVirtualKeyCode: keyCode, text: value, unmodifiedText: value });
  await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code, windowsVirtualKeyCode: keyCode });
}

/** Begin measuring the next native input of the requested type without including setup waits. */
async function beginAction(raw, name, eventType) {
  await raw.evaluate(`window.__pb606Begin(${JSON.stringify(name)}, ${JSON.stringify(eventType)})`, `arm ${name}`, 2_000);
}

/** Capture one run's first load, six tabs, two item opens, search and live idle interval. */
async function measureRun(board, runIndex, executable, idleMs, liveEveryMs) {
  const profile = join(board.workspace, `chrome-${runIndex + 1}`);
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  let view = null;
  let raw = null;
  let chrome = null;
  let network = null;
  let measurementError = null;
  const actions = [];
  try {
    view = await startView(board);
    raw = await startChrome({ url: 'about:blank', executable, profileDirectory: profile,
      commandTimeoutMs: ACTION_TIMEOUT_MS, taskTimeoutMs: ACTION_TIMEOUT_MS,
      env: { HOME: profile, PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: process.env.LANG ?? 'en_US.UTF-8' } });
    network = await openNetworkCapture(raw.profileDirectory, view.link.origin);
    await raw.send('Network.setCacheDisabled', { cacheDisabled: true }, 'disable the fresh profile cache', ACTION_TIMEOUT_MS);
    await raw.send('Page.addScriptToEvaluateOnNewDocument', { source: timingScript() }, 'install performance observers', ACTION_TIMEOUT_MS);
    const browserVersion = await raw.send('Browser.getVersion', {}, 'pin the isolated browser runtime', ACTION_TIMEOUT_MS);
    chrome = await stableChrome(raw);
    await raw.navigate(view.link.href);
    actions.push(await waitPaintedAndStable(raw, network, 'firstLoad', '#chain .row',
      `document.readyState === 'complete' && !document.body.classList.contains('loading')`, true));

    for (const [name, tab, target] of VIEWER_ACTIONS) {
      await beginAction(raw, name, 'mousedown');
      await press(chrome, `document.querySelector('[data-tab="${tab}"]')`);
      actions.push(await waitPaintedAndStable(raw, network, name, target,
        `document.querySelector('.tab.on')?.dataset.tab === ${JSON.stringify(tab)}`));
    }

    const smallRow = `document.querySelector('#chain .row[data-item="${board.smallItemId}"]')`;
    await beginAction(raw, 'openSmallItem', 'mousedown');
    await press(chrome, smallRow);
    actions.push(await waitPaintedAndStable(raw, network, 'openSmallItem', '#detail .stack',
      `view.item === ${board.smallItemId} && document.querySelector('#detail .stack h2')?.textContent.includes(${JSON.stringify(board.smallItemTitle)})`));

    const longRow = `document.querySelector('#chain .row[data-item="${board.longestHistoryItemId}"]')`;
    await beginAction(raw, 'openLongestHistoryItem', 'mousedown');
    await press(chrome, longRow);
    actions.push(await waitPaintedAndStable(raw, network, 'openLongestHistoryItem', '#detail .stack',
      `view.item === ${board.longestHistoryItemId} && document.querySelector('#detail .stack h2')?.textContent.includes(${JSON.stringify(board.longestHistoryTitle)})`));

    await press(chrome, "document.querySelector('#q')");
    await beginAction(raw, 'search', 'keydown');
    for (const character of 'Small') {
      await typeKey(chrome, character);
      await pause(90); // budget: reproduce the measured person's 90ms key cadence; the search sample starts at the first keydown.
    }
    actions.push(await waitPaintedAndStable(raw, network, 'search', '#find-results [data-find]',
      `document.querySelector('#q').value === 'Small' && !document.querySelector('#find-results').hidden`));

    await beginAction(raw, 'idleSetup', 'mousedown');
    await press(chrome, "document.querySelector('[data-tab=\"shouts\"]')");
    await waitPaintedAndStable(raw, network, 'idleSetup', '#feed .shout',
      `document.querySelector('.tab.on')?.dataset.tab === 'shouts'`);
    const liveMessages = Array.from({ length: Math.ceil(idleMs / liveEveryMs) }, (_, index) =>
      `Live stress update ${index + 1} for seed ${board.seed}, run ${runIndex + 1}.`);
    await raw.evaluate(`(() => {
      const feed = document.querySelector('#feed');
      if (!feed) throw new Error('the shouts feed is unavailable for the live observation');
      window.__pb606IdleExpected = new Map(${JSON.stringify(liveMessages)}.map(text => [text, null]));
      const scan = () => {
        const text = feed.textContent;
        for (const [message, at] of window.__pb606IdleExpected) {
          if (at === null && text.includes(message)) window.__pb606IdleExpected.set(message, performance.now());
        }
      };
      window.__pb606IdleScan = scan;
      window.__pb606IdleObserver = new MutationObserver(scan);
      window.__pb606IdleObserver.observe(feed, { childList: true, subtree: true, characterData: true });
      scan();
      if ([...window.__pb606IdleExpected.values()].some(at => at !== null)) {
        throw new Error('a live update marker was already present before this idle sample');
      }
    })()`, 'observe live feed updates', 2_000);
    let liveBoard = null;
    let liveWrites = 0;
    const idleStart = await raw.evaluate('performance.now()', 'start live idle window', 2_000);
    const wallStart = nodePerformance.now();
    const liveWriteOffsetsMs = [];
    try {
      liveBoard = openBoard(board.boardFile);
      for (let targetMs = 0; targetMs < idleMs; targetMs += liveEveryMs) {
        const delay = wallStart + targetMs - nodePerformance.now();
        if (delay > 0) await pause(delay); // budget: each write remains on a fixed wall-clock cadence inside the 30-second sample.
        const text = liveMessages[liveWrites];
        shout(liveBoard, { from: board.liveWriter, to: 'all', text, lanes: LANES });
        liveWrites += 1;
        liveWriteOffsetsMs.push(nodePerformance.now() - wallStart);
      }
      const remaining = wallStart + idleMs - nodePerformance.now();
      if (remaining > 0) await pause(remaining); // budget: retain the full 30-second idle observation after the sixth write.
    } finally {
      if (liveBoard) closeBoard(liveBoard);
    }
    const idleEnd = await raw.evaluate('performance.now()', 'finish live idle window', 2_000);
    const renderedAtMs = await raw.evaluate(`(() => { window.__pb606IdleScan?.(); return [...(window.__pb606IdleExpected ?? new Map())].map(([text, at]) => ({ text, at })); })()`, 'collect visible live writes', 2_000);
    const renderedWrites = renderedAtMs.filter(({ at }) => Number.isFinite(at) && at <= idleEnd).length;
    const idle = await raw.evaluate(`window.__pb606Collect('idleWithLiveWrites', ${idleStart}, ${idleEnd}, true)`, 'collect live idle metrics', 5_000);
    idle.renderedWrites = renderedWrites;
    idle.liveWriteOffsetsMs = liveWriteOffsetsMs;
    idle.renderedAtMs = renderedAtMs.map(({ at }) => Number.isFinite(at) ? at - idleStart : null);
    Object.assign(idle, network.snapshot('idleWithLiveWrites', idleStart, idleEnd, idle.timeOrigin));
    idle.liveWrites = liveWrites;
    actions.push(idle);
    actions.browserVersion = browserVersion;
    return actions;
  } catch (error) {
    measurementError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    try { network?.close(); } catch (error) { cleanupErrors.push(`network observer: ${error.message}`); }
    try { if (raw) await raw.close(); } catch (error) { cleanupErrors.push(`Chrome connection: ${error.message}`); }
    try { if (view) await stopView(view); } catch (error) { cleanupErrors.push(`view process: ${error.message}`); }
    if (measurementError || cleanupErrors.length) {
      const failurePath = join(board.workspace, `run-${runIndex + 1}-failure.json`);
      try {
        writeFileSync(failurePath, `${JSON.stringify({ version: 1, run: runIndex + 1,
          error: measurementError?.message ?? 'cleanup failed', cleanupErrors, actions,
          chromeProfile: profile }, null, 2)}\n`, { mode: 0o600 });
      } catch (error) { cleanupErrors.push(`failure record: ${error.message}`); }
      if (measurementError && cleanupErrors.length) measurementError.cleanupErrors = cleanupErrors;
      else if (cleanupErrors.length) throw new AggregateError(cleanupErrors.map((message) => new Error(message)), 'the performance harness cleanup did not finish cleanly');
    }
  }
}

/** Return the median of a nonempty numeric sample. */
function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

/** Summarize action samples without adding any pass/fail latency threshold. */
function summarize(runs) {
  const labels = runs[0].map((entry) => entry.name);
  return labels.map((name) => {
    const samples = runs.map((entries) => entries.find((entry) => entry.name === name));
    const durations = samples.map((entry) => entry.durationMs);
    const statuses = samples.map((entry) => ({ status: entry.longTaskObserverStatus ?? 'unsupported', error: entry.longTaskObserverError ?? null }));
    const allLongTaskSamplesAvailable = statuses.every(({ status }) => status === 'available');
    const longCounts = samples.map((entry, index) => statuses[index].status === 'available' ? entry.longTasks.length : null);
    return { name, medianMs: median(durations), worstMs: Math.max(...durations),
      longTaskStatusPerRun: statuses,
      medianLongTasks: allLongTaskSamplesAvailable ? median(longCounts) : null,
      worstLongTasks: allLongTaskSamplesAvailable ? Math.max(...longCounts) : null,
      largestLongTaskMs: allLongTaskSamplesAvailable ? Math.max(...samples.map((entry) => entry.largestLongTaskMs)) : null,
      requestBytesPerRun: samples.map((entry) => entry.requestBytes),
      requestsPerRun: samples.map((entry) => entry.requests),
      samples };
  });
}

/** Render the same action summaries as a compact Markdown table for the terminal. */
function renderTable(actions) {
  const lines = ['| action | median stable ms | worst stable ms | long tasks / run (median, worst) | largest long task ms | request bytes / run |',
    '|---|---:|---:|---:|---:|---:|'];
  for (const action of actions) {
    const longTaskCount = Number.isFinite(action.medianLongTasks)
      ? `${action.medianLongTasks}, ${action.worstLongTasks}` : 'unavailable';
    const largestLongTask = Number.isFinite(action.largestLongTaskMs) ? action.largestLongTaskMs.toFixed(1) : 'unavailable';
    lines.push(`| ${action.name} | ${action.medianMs.toFixed(1)} | ${action.worstMs.toFixed(1)} | ${longTaskCount} | ${largestLongTask} | ${action.requestBytesPerRun.join(', ')} |`);
  }
  return lines.join('\n');
}

/** Run the user-facing harness with an isolated generated board and headless real Chrome. */
async function runPerfHarnessInSlot({ board, runs = 1, idleMs = 30_000, liveEveryMs = 5_000,
  executable = findChromeExecutable() } = {}, lease) {
  if (!board?.workspace || !board?.boardFile) throw new TypeError('board must come from generateStressBoard');
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 20) throw new RangeError('runs must be an integer from 1 through 20');
  if (!Number.isSafeInteger(idleMs) || idleMs < 0 || idleMs > 300_000) throw new RangeError('idleMs must be an integer from 0 through 300000');
  if (!Number.isSafeInteger(liveEveryMs) || liveEveryMs < 1_000 || liveEveryMs > 60_000) throw new RangeError('liveEveryMs must be an integer from 1000 through 60000');
  if (!executable) throw new Error('Chrome was not found; install Chrome or set PULLBOARD_CHROME.');
  const capture = async (lease) => {
    const captured = [];
    for (let index = 0; index < runs; index += 1) captured.push(await measureRun(board, index, executable, idleMs, liveEveryMs));
    const actions = summarize(captured);
    const report = { version: 1, seed: board.seed, size: board.size, digest: board.digest,
      gate: { browser: lease.browser === true, waitMs: lease.waitMs },
      boardShape: { statuses: board.statusTotals, lanes: board.laneTotals, agents: board.agentCount,
        itemEvents: board.itemEvents, shouts: board.shoutCount, milestones: board.milestoneCount,
        milestoneRows: board.milestoneRows, specRows: board.specRows, specStatuses: board.specStatusTotals }, runs, idleMs, liveEveryMs,
      browser: { input: 'real Chrome through CDP', executable, versions: captured.map(run => run.browserVersion) },
      actions, table: renderTable(actions) };
    writeFileSync(join(board.workspace, 'performance-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    return report;
  };
  return capture(lease);
}

/** Run the complete browser sample while owning the shared browser-capable slot. */
export async function runPerfHarness(options = {}) {
  return withPerfSlot((run) => run(options));
}

/** Parse and execute the standalone command when this file is the program entry point. */
async function main(argv) {
  const parsed = parseArgs({ args: argv, options: {
    seed: { type: 'string', default: 'pullboard-perf-606' }, size: { type: 'string', default: '3000' },
    runs: { type: 'string', default: '5' }, idle: { type: 'string', default: '30' }, liveEvery: { type: 'string', default: '5' },
    keep: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } });
  if (parsed.values.help) {
    process.stdout.write('Usage: node test/cockpit/perf/run.mjs [--seed text] [--size 3000] [--runs 5] [--idle 30] [--live-every 5] [--keep]\n');
    return;
  }
  let board = null;
  let completed = false;
  try {
    await withPerfSlot(async (run) => {
      board = generateStressBoard({ seed: parsed.values.seed, size: Number(parsed.values.size) });
      try {
        const report = await run({ board, runs: Number(parsed.values.runs), idleMs: Number(parsed.values.idle) * 1_000,
          liveEveryMs: Number(parsed.values.liveEvery) * 1_000 });
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n\n${report.table}\n`);
        if (parsed.values.keep) process.stdout.write(`Generated board kept at ${board.root}\n`);
        completed = true;
      } finally {
        if (!parsed.values.keep && completed) removeStressBoard(board);
      }
    });
  } catch (error) {
    if (board && !completed) process.stderr.write(`Performance evidence retained at ${board.workspace}\n`);
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main(process.argv.slice(2));
