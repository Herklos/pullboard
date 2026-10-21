/** The relay browser client's sealed snapshot decode, in Chrome and in WebKit [H5,H16]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { findChromeExecutable, startChrome } from './relay-browser-fixture.js';

const CLIENT = new URL('../relay/browser-client.js', import.meta.url);
const DOCUMENT = { version: 1, board: { items: [{ id: 976, title: 'A linked board opens in Safari' }] } };

/** The snapshotDocument function exactly as the shipped browser client writes it, cut from the module source. */
function snapshotDocumentSource() {
  const source = readFileSync(CLIENT, 'utf8');
  const start = source.indexOf('async function snapshotDocument(');
  const end = source.indexOf('\n}\n', start) + 2;
  assert.ok(start > 0 && end > start, 'relay/browser-client.js still defines snapshotDocument');
  return source.slice(start, end);
}

/**
 * A page expression that runs the shipped snapshotDocument on sealed gzip bytes and returns the decoded document.
 * With `blobStreamFails` it first makes Blob.stream feed a decoder the failure WebKit gives it, so Chrome proves
 * the decode never depends on that path.
 */
function decodeExpression({ blobStreamFails }) {
  const bytes = gzipSync(JSON.stringify(DOCUMENT)).toString('base64');
  return `(async () => {
    class Refused extends Error { constructor(code, message) { super(message); this.code = code; } }
    const withBrowserDeadline = work => work();
    ${blobStreamFails ? `Blob.prototype.stream = function stream() {
      return new ReadableStream({ start(controller) { controller.error(new TypeError('Failed to Decode Data')); } });
    };` : ''}
    ${snapshotDocumentSource()}
    const plain = Uint8Array.from(atob(${JSON.stringify(bytes)}), character => character.charCodeAt(0));
    try { return JSON.stringify(await snapshotDocument(plain)); }
    catch (error) { return 'REFUSED ' + (error.code ?? error.name) + ': ' + error.message; }
  })()`;
}

/** The newest Playwright WebKit build this account has cached, or null on a machine without one. */
function findWebkit() {
  if (process.env.PULLBOARD_WEBKIT) return existsSync(process.env.PULLBOARD_WEBKIT) ? process.env.PULLBOARD_WEBKIT : null;
  if (process.platform !== 'darwin') return null;
  const cache = join(userInfo().homedir, 'Library', 'Caches', 'ms-playwright');
  let builds = [];
  try { builds = readdirSync(cache).filter(name => /^webkit-\d+$/u.test(name)); } catch { return null; }
  builds.sort((left, right) => Number(right.slice(7)) - Number(left.slice(7)));
  for (const build of builds) {
    const executable = join(cache, build, 'Playwright.app', 'Contents', 'MacOS', 'Playwright');
    if (existsSync(executable)) return executable;
  }
  return null;
}

/**
 * Evaluate one async expression in a real WebKit page and return its string value. It drives Playwright's WebKit
 * build over its inspector pipe (JSON separated by NUL on descriptors 3 and 4), with no package.
 */
async function evaluateInWebkit(executable, expression) {
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-webkit-'));
  const frameworks = dirname(dirname(dirname(dirname(executable))));
  const child = spawn(executable, ['--inspector-pipe', '--headless', '--no-startup-window', `--user-data-dir=${profile}`], {
    detached: true, env: { ...process.env, HOME: userInfo().homedir, DYLD_FRAMEWORK_PATH: frameworks, DYLD_LIBRARY_PATH: frameworks },
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolveExit => child.once('close', resolveExit));
  const pending = new Map();
  const targets = [];
  let nextId = 0;
  let buffer = '';
  /** Send one command and wait for its answer, with a hang ceiling. */
  const send = (method, params = {}, pageProxyId) => new Promise((resolveSend, rejectSend) => {
    const id = ++nextId;
    const timer = setTimeout(() => rejectSend(new Error(`WebKit ${method} gave no answer`)), 20_000); // budget: hang ceiling for one WebKit command.
    pending.set(id, message => { clearTimeout(timer); message.error ? rejectSend(new Error(`WebKit ${method}: ${message.error.message}`)) : resolveSend(message.result ?? {}); });
    child.stdio[3].write(JSON.stringify({ id, method, params, ...(pageProxyId ? { pageProxyId } : {}) }) + '\0');
  });
  child.stdio[4].setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    for (let end = buffer.indexOf('\0'); end >= 0; end = buffer.indexOf('\0')) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); } else targets.push(message);
    }
  });
  try {
    await send('Playwright.enable');
    const { browserContextId } = await send('Playwright.createContext');
    const { pageProxyId } = await send('Playwright.createPage', { browserContextId });
    let created = null;
    for (let wait = 0; !created && wait < 2_000; wait++) {
      created = targets.find(message => message.method === 'Target.targetCreated' && message.params.targetInfo.type === 'page');
      if (!created) await new Promise(resolveWait => setTimeout(resolveWait, 10)); // budget: poll interval, no speed claim.
    }
    assert.ok(created, 'WebKit made a page target');
    if (created.params.targetInfo.isPaused) await send('Target.resume', { targetId: created.params.targetInfo.targetId }, pageProxyId);
    const answers = new Map();
    let commandId = 0;
    /** Run one expression in the page and return its by-value answer; WebKit's Runtime.evaluate does not await promises. */
    const run = async source => {
      const id = ++commandId;
      const command = { id, method: 'Runtime.evaluate', params: { expression: source, returnByValue: true } };
      await send('Target.sendMessageToTarget', { targetId: created.params.targetInfo.targetId, message: JSON.stringify(command) }, pageProxyId);
      for (let wait = 0; !answers.has(id) && wait < 2_000; wait++) {
        for (const message of targets.splice(0)) {
          if (message.method !== 'Target.dispatchMessageFromTarget') continue;
          const inner = JSON.parse(message.params.message);
          if (inner.id !== undefined) answers.set(inner.id, inner);
        }
        if (!answers.has(id)) await new Promise(resolveWait => setTimeout(resolveWait, 10)); // budget: poll interval, no speed claim.
      }
      const answer = answers.get(id);
      assert.ok(answer, 'WebKit answered the evaluation');
      assert.ok(!answer.error && !answer.result?.wasThrown, `WebKit evaluation failed: ${JSON.stringify(answer.error ?? answer.result)}`);
      return answer.result.result.value;
    };
    await run(`window.settled = null; (${expression}).then(value => { window.settled = { value }; }, error => { window.settled = { value: 'THREW ' + error }; }); 0`);
    for (let wait = 0; wait < 500; wait++) {
      const settled = await run('window.settled');
      if (settled) return settled.value;
      await new Promise(resolveWait => setTimeout(resolveWait, 20)); // budget: poll interval, no speed claim.
    }
    assert.fail('WebKit never settled the decode');
  } finally {
    try { await send('Playwright.close'); } catch { /* The browser already stopped. */ }
    const stopped = await Promise.race([exited.then(() => true), new Promise(resolveStop => setTimeout(() => resolveStop(false), 3_000))]); // budget: hang ceiling for WebKit shutdown.
    if (!stopped) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The group already exited. */ } await exited; }
    rmSync(profile, { recursive: true, force: true });
  }
}

test('the sealed gzip snapshot decodes through a Response body, the way WebKit accepts [H5,H16]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const expected = JSON.stringify(DOCUMENT);
  const chrome = await startChrome();
  t.after(() => chrome.close());
  await chrome.navigate('about:blank');
  assert.equal(await chrome.evaluate(decodeExpression({ blobStreamFails: false }), 'decode the sealed snapshot'), expected,
    'Chrome opens the sealed gzip snapshot');
  assert.equal(await chrome.evaluate(decodeExpression({ blobStreamFails: true }), 'decode with the WebKit Blob.stream failure'), expected,
    'the decode does not depend on Blob.stream, which WebKit refuses with Failed to Decode Data');
  const webkit = findWebkit();
  if (!webkit) { t.diagnostic('No cached WebKit build on this machine; the WebKit half did not run, the Chrome half did.'); return; }
  assert.equal(await evaluateInWebkit(webkit, decodeExpression({ blobStreamFails: false })), expected,
    'real WebKit opens the same sealed gzip snapshot');
  t.diagnostic('WebKit ran: ' + webkit);
});
