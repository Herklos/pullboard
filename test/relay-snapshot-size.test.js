/** Compression stays inside the device seal while both clients retain legacy snapshot reads [H5,H15,H17]. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { decodeBoardKey, seal, unseal } from '../src/seal.js';
import { ENGINE_VERSION } from '../src/machine.js';
import { presentationDigest, relaySnapshot } from '../src/relay-presentation.js';
import { relayClientFixture } from './relay-client-fixture.js';
import { findChromeExecutable, startChrome } from './relay-browser-fixture.js';
import { readSealedDescriptor } from '../src/sealed-pages.js';

const RELAY_LIMIT = 10_000_000;
const BODY_LIMIT = 14_000_000;

/** Preserve every SQLite value while normalizing row prototypes for JSON transport comparisons. */
function plainRows(rows) { return rows.map(row => ({ ...row })); }

/** Normalize all exported tables without dropping columns or changing their order. */
function plainTables(tables) { return Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, plainRows(rows)])); }

/** Run a real CLI text command inside the fixture process and return only its captured streams. */
async function textCommand(box, ...args) {
  const source = `
    import { main } from ${JSON.stringify(box.mainURL)};
    let stdout = '', stderr = '';
    const code = await main(${JSON.stringify(args)}, {
      cwd: process.cwd(),
      stdout: { write(value) { stdout += value; } },
      stderr: { write(value) { stderr += value; } },
    });
    console.log(JSON.stringify({ code, stdout, stderr }));
  `;
  return (await box.script(source)).document;
}

/** Seal a legacy plaintext snapshot at its current authenticated relay position. */
async function sealedSnapshot(box, document, sequence, compressed) {
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const json = Buffer.from(JSON.stringify(document));
  const plaintext = compressed ? gzipSync(json) : json;
  return Buffer.from(await seal(key, plaintext, { boardId: state.board, kind: 'snapshot', sequence })).toString('base64url');
}

test('a large board syncs to the relay compressed [H5,H15,H17]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  await box.link();

  // Pair a second native CLI while the board is small; it must later restore the relay snapshot.
  const pairing = await box.cli('relay', 'pair');
  const second = await box.otherDeviceJoin(pairing.document.code);

  // An ordinary older JSON snapshot remains readable by the CLI after the relay compacts it.
  assert.equal((await box.cli('add', box.lane, 'legacy snapshot cursor')).code, 0);
  let sourceState = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  let legacyDocument = relaySnapshot(box.root);
  const legacySealed = await sealedSnapshot(box, legacyDocument, sourceState.sequence, false);
  const legacyUpload = await fetch(box.origin + '/api/v1/boards/' + sourceState.board + '/state', {
    method: 'PUT',
    headers: { authorization: 'Bearer ' + sourceState.token, 'x-pullboard-engine': String(ENGINE_VERSION), 'content-type': 'application/json' },
    body: JSON.stringify({ sequence: sourceState.sequence, sealed: legacySealed }),
  });
  assert.equal(legacyUpload.status, 200, 'the relay continues accepting a stored legacy JSON snapshot');
  const legacyRead = await second.cli('status');
  assert.equal(legacyRead.code, 0, legacyRead.document?.error?.message);
  const legacyExport = await second.cli('export');
  assert.equal(legacyExport.code, 0);
  assert.deepEqual(plainRows(legacyExport.document.tables.item), plainRows(legacyDocument.tables.item), 'the CLI restored the legacy JSON snapshot from the relay');

  // The second CLI publishes its own current gzip checkpoint after restoring; replace it with the same legacy bytes before the browser reads.
  const browserLegacyUpload = await fetch(box.origin + '/api/v1/boards/' + sourceState.board + '/state', {
    method: 'PUT',
    headers: { authorization: 'Bearer ' + sourceState.token, 'x-pullboard-engine': String(ENGINE_VERSION), 'content-type': 'application/json' },
    body: JSON.stringify({ sequence: sourceState.sequence, sealed: legacySealed }),
  });
  assert.equal(browserLegacyUpload.status, 200);
  assert.equal((await browserLegacyUpload.json()).state.sealed, legacySealed, 'the browser starts with the exact stored uncompressed bytes');

  // The actual browser keeps reading a previously stored uncompressed JSON checkpoint too.
  const chrome = await startChrome();
  t.after(() => chrome.close());
  await chrome.send('Network.setCookie', {
    name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  });
  const encodedKey = readFileSync(box.keyFile, 'utf8').trim();
  await chrome.navigate(box.origin + '/#board=' + sourceState.board + '&key=' + encodedKey);
  try {
    await chrome.waitFor("document.querySelector('#chain')?.textContent.includes('legacy snapshot cursor')");
  } catch (error) {
    t.diagnostic('legacy browser read: ' + JSON.stringify(await chrome.evaluate("({ title: document.title, notice: document.querySelector('#relay-notice')?.textContent.slice(0, 800), signIn: document.body.textContent.includes('Sign in with GitHub'), hasLegacy: document.body.textContent.includes('legacy snapshot cursor') })")));
    throw error;
  }
  t.diagnostic('legacy browser snapshot read passed');

  const marker = 'COMPRESSED_RELAY_SNAPSHOT_EXACT_340_';
  const longText = marker + 'q'.repeat(7_200_000);
  const native = store.openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  try {
    store.shout(native, { from: 'coordinator', to: 'all', text: longText, lanes: [box.lane] });
    // The historical payload grows the native snapshot without sending a seven-megabyte paragraph to the recent UI feed.
    for (let index = 0; index < 100; index++) {
      store.shout(native, { from: 'coordinator', to: 'all', text: marker + 'recent ' + index, lanes: [box.lane] });
    }
  } finally { store.closeBoard(native); }
  const before = relaySnapshot(box.root);
  assert.ok(Buffer.byteLength(JSON.stringify(before)) > BODY_LIMIT, 'the uncompressed snapshot exceeds the unchanged relay body limit');
  const uncompressedSealed = await sealedSnapshot(box, before, JSON.parse(readFileSync(box.linkFile, 'utf8')).sequence, false);
  assert.ok(Buffer.from(uncompressedSealed, 'base64url').byteLength > BODY_LIMIT, 'the actual legacy sealed snapshot exceeds the relay body limit before base64 framing');

  assert.equal((await box.cli('status')).code, 0, 'the local CLI publishes a compressed pending snapshot');
  assert.equal((await box.cli('add', box.lane, 'advance compressed snapshot')).code, 0, 'an acknowledged move advances the relay snapshot cursor');
  const expected = relaySnapshot(box.root);
  const snapshotRequest = box.transit.filter(row => row.method === 'PUT' && row.path.endsWith('/state')).at(-1);
  assert.ok(snapshotRequest, 'the actual linked CLI uploaded a snapshot to the relay');
  const uploadBody = JSON.parse(snapshotRequest.request.toString('utf8'));
  const sealedBytes = Buffer.from(uploadBody.sealed, 'base64url');
  assert.ok(sealedBytes.byteLength < RELAY_LIMIT, 'the opaque compressed snapshot fits the decoded journal limit');
  assert.ok(snapshotRequest.request.byteLength < BODY_LIMIT, 'the base64 transport body fits the unchanged request limit');
  const boardKey = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const plaintext = await unseal(boardKey, sealedBytes, { boardId: JSON.parse(readFileSync(box.linkFile, 'utf8')).board, kind: 'snapshot', sequence: uploadBody.sequence });
  assert.deepEqual(plainTables(JSON.parse(gunzipSync(plaintext).toString('utf8')).tables), plainTables(expected.tables),
    'the gzip payload inside the device seal is the exact native snapshot');
  assert.equal(snapshotRequest.request.includes(Buffer.from(marker)), false, 'the relay request contains no board plaintext');
  assert.equal(snapshotRequest.response.includes(Buffer.from(marker)), false, 'the relay response contains no board plaintext');

  // A second CLI that predates this checkpoint must restore the compressed snapshot exactly.
  assert.equal((await second.cli('status')).code, 0, 'the paired CLI restores the compressed snapshot');
  const restored = await second.cli('export');
  assert.equal(restored.code, 0);
  assert.deepEqual(plainTables(restored.document.tables), plainTables(expected.tables), 'the paired CLI reads back the exact compressed snapshot');

  // The actual Chrome client reads that same compressed checkpoint and renders the full shout text.
  sourceState = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  await chrome.navigate(box.origin);
  try {
    await chrome.waitFor("document.querySelector('#feed')?.textContent.includes(" + JSON.stringify(marker) + ") || document.querySelector('#relay-notice')?.textContent.includes('Could not open this board with its saved key')");
  } catch (error) {
    t.diagnostic('compressed browser read: ' + JSON.stringify(await chrome.evaluate("({ title: document.title, notice: document.querySelector('#relay-notice')?.textContent.slice(0, 800), signIn: document.body.textContent.includes('Sign in with GitHub'), hasMarker: document.body.textContent.includes('COMPRESSED_RELAY_SNAPSHOT_EXACT_340_') })")));
    throw error;
  }
  assert.equal(await chrome.evaluate("document.querySelector('#feed')?.textContent.includes(" + JSON.stringify(marker) + ') ?? false'), true, 'the production browser decoder reads the compressed checkpoint');
  const projection = { ...expected.presentation.state, root: sourceState.board };
  const projectionHash = createHash('sha256').update(JSON.stringify(projection)).digest('hex');
  const tablesHash = createHash('sha256').update(JSON.stringify(expected.tables)).digest('hex');
  const browserRead = await chrome.evaluate(`(async () => {
    const { createTransport } = await import('/relay/client.js');
    const transport = await createTransport();
    const document = await transport.request('/api/v1/boards/${sourceState.board}/state');
    const { decodeBoardKey, unseal } = await import('/relay/seal.js');
    const response = await fetch('/api/v1/boards/${sourceState.board}/state', { headers: { 'x-pullboard-engine': '${ENGINE_VERSION}' } });
    const envelope = (await response.json()).state;
    const encoded = envelope.sealed.replaceAll('-', '+').replaceAll('_', '/');
    const ciphertext = Uint8Array.from(atob(encoded + '='.repeat((4 - encoded.length % 4) % 4)), value => value.charCodeAt(0));
    const keys = JSON.parse(localStorage.getItem('pullboard.relay.keys.v1'));
    const plain = await unseal(decodeBoardKey(keys['${sourceState.board}']), ciphertext, { boardId: '${sourceState.board}', kind: 'snapshot', sequence: envelope.sequence });
    const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
    const native = JSON.parse(await new Response(stream).text());
    /** Hash exact browser-decoded JSON without sending private contents into test diagnostics. */
    async function digest(value) {
      const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))));
      return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    }
    return { projectionHash: await digest(document.state), tablesHash: await digest(native.tables) };
  })()`, 'hash browser projection and native snapshot');
  assert.deepEqual(browserRead, { projectionHash, tablesHash }, 'the production browser client reads the exact projection and browser gzip retains every native table byte');

  // An older relay that does not advertise paged snapshots keeps its explicit per-request refusal.
  box.legacySnapshotApi();
  const oversizedDocument = relaySnapshot(box.root);
  const randomTitle = 'OVERSIZE_SNAPSHOT_340_' + randomBytes(5_050_000).toString('base64');
  const itemId = oversizedDocument.tables.item[0].item_id;
  oversizedDocument.tables.item.find(row => row.item_id === itemId).item_title = randomTitle;
  oversizedDocument.presentation.state.items.find(row => row.id === itemId).title = randomTitle;
  const oversizedGzip = await sealedSnapshot(box, oversizedDocument, sourceState.sequence, true);
  const oversizedBytes = Buffer.from(oversizedGzip, 'base64url').byteLength;
  assert.ok(oversizedBytes > RELAY_LIMIT, 'the compressed sealed snapshot still exceeds the relay journal limit');
  assert.ok(Buffer.byteLength(JSON.stringify({ sequence: sourceState.sequence, sealed: oversizedGzip })) < BODY_LIMIT,
    'the oversized sealed snapshot remains below the unchanged HTTP body limit');
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const localDigest = presentationDigest(relaySnapshot(box.root).presentation);
  link.checkpoint = { sequence: sourceState.sequence, sealed: oversizedGzip };
  link.checkpointPresentationDigest = localDigest;
  writeFileSync(box.linkFile, JSON.stringify(link), { mode: 0o600 });

  const status = await textCommand(box, 'status');
  assert.match(status.stdout, new RegExp(`relay snapshot for ${sourceState.board}: sealed snapshot \\d+\\.\\d MB over the relay limit 10\\.0 MB`));
  const doctor = await textCommand(box, 'doctor');
  assert.equal(doctor.code, 1);
  const doctorJSON = await box.cli('doctor');
  assert.equal(doctorJSON.code, 1);
  assert.ok(doctorJSON.document.problems.some(problem => problem.code === 'RELAY_SNAPSHOT_LIMIT'), 'doctor JSON names the stable oversize rule');
  assert.match(doctor.stdout, new RegExp(`relay snapshot for ${sourceState.board}: sealed snapshot \\d+\\.\\d MB over the relay limit 10\\.0 MB`));
});

/** Authenticate one private fixture object's graph path without exposing credentials in diagnostics. */
function pagedReadContext(box, link, head, key) {
  return { boardId: link.board, key, sequence: head.sequence,
    /** Public HTTP still checks the principal's pinned root; only this device interprets the sealed directory. */
    async get(id, parents) {
      const response = await fetch(box.origin + '/api/v2/boards/' + link.board + '/objects/' + id
        + '?pin=' + head.read.id + '&via=' + parents.join(','), {
        headers: { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION) },
      });
      const document = await response.json();
      assert.equal(response.status, 200, document.error?.message);
      return Buffer.from(document.page.sealed, 'base64url');
    },
  };
}

/** Select an old event leaf, so a controlled background hold cannot accidentally block the current-state boot. */
async function oldestEventPage(head, context) {
  const root = await readSealedDescriptor(head.root, context);
  const event = root.value.tables.indexOf('event');
  assert.ok(event >= 0);
  let reference = root.links[event + 3], parents = [head.root.id];
  for (;;) {
    const node = await readSealedDescriptor(reference, { ...context, parents });
    const range = node.value.entries[0], child = node.links[0];
    assert.ok(range && child);
    if (range.leaf) return child.id;
    parents = [...parents, reference.id]; reference = child;
  }
}

test('thirty thousand events open on the phone within three seconds and stream all sealed history beside live moves [H5,H15,H17]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const pairing = await box.cli('relay', 'pair');
  const second = await box.otherDeviceJoin(pairing.document.code);
  const currentMarker = 'PAGED_CURRENT_STATE_903';
  const oldestMarker = 'PAGED_OLDEST_SHOUT_903';
  const liveMarker = 'LIVE_MOVE_DURING_HISTORY_903';
  const native = store.openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  let oldest;
  try {
    // These are synthetic native fixture moves in one normal board transaction, never owner-board edits.
    store.atomic(native, () => {
      for (let index = 0; index < 900; index++) store.addItem(native, {
        by: 'coordinator', lane: box.lane, title: index === 899 ? currentMarker : 'Retained current work ' + index, route: 'strong',
      });
      oldest = store.shout(native, { from: 'coordinator', to: 'all', text: oldestMarker, lanes: [box.lane] });
      // Incompressible retained history proves several times the old cap in actual uploaded cipher bytes.
      for (let index = 0; index < 32; index++) store.shout(native, {
        from: 'coordinator', to: 'all', text: 'Private historical data ' + index + ':' + randomBytes(1_000_000).toString('base64'), lanes: [box.lane],
      });
      for (let index = 0; index < 30_017; index++) store.shout(native, {
        from: 'coordinator', to: 'all', text: 'Recent and retained work ' + index, lanes: [box.lane],
      });
    });
    assert.equal(store.allShouts(native)[0].shout_id, oldest, 'the addressed marker really is this board\'s oldest shout');
  } finally { store.closeBoard(native); }
  const before = relaySnapshot(box.root);
  assert.ok(before.tables.event.length >= 30_000 && before.tables.event.length < 31_000);
  assert.ok(gzipSync(Buffer.from(JSON.stringify(before))).byteLength > RELAY_LIMIT * 3, 'even compressed whole-board state is several times the old limit');
  assert.equal((await box.cli('status')).code, 0, 'the actual opted-in CLI publishes through bounded pages');
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  assert.equal(link.snapshotApiVersion, 2);
  assert.equal(link.checkpoint, undefined);
  const writes = box.transit.filter(row => row.method === 'PUT' && /\/api\/v2\/boards\/[^/]+\/uploads\/[^/]+\/objects\//u.test(row.path));
  const uploaded = new Map(writes.map(row => [row.path.split('/').at(-1), Buffer.from(JSON.parse(row.request).sealed, 'base64url').byteLength]));
  const cipherBytes = [...uploaded.values()].reduce((sum, bytes) => sum + bytes, 0);
  assert.ok(cipherBytes > RELAY_LIMIT * 3, 'real unique encrypted upload objects exceed thirty million bytes');
  assert.ok(writes.every(row => row.request.byteLength < 600_000), 'no request carries the whole board');
  assert.ok(writes.every(row => !row.request.includes(Buffer.from(oldestMarker))), 'the relay stores no historical plaintext');
  const headers = { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION) };
  const headResponse = await fetch(box.origin + '/api/v2/boards/' + link.board + '/state', { headers });
  const head = (await headResponse.json()).state;
  const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const context = pagedReadContext(box, link, head, key);
  const root = await readSealedDescriptor(head.root, context);
  assert.ok(root.links[0].bytes < 1_000_000, 'the authenticated current-state plaintext budget is under one megabyte');
  const heldPage = await oldestEventPage(head, context);
  const chrome = await startChrome();
  t.after(() => chrome.close());
  await chrome.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: String.raw`
    window.__phoneTiming = { firstBoardPaint: null, objectRequests: 0, loopbackReads: 0, historyHeld: false };
    window.__releaseOlderHistory = null;
    const originalFetch = window.fetch;
    window.fetch = async (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (['http://127.0.0.1:4890', 'http://localhost:4890'].includes(url.origin)) {
        __phoneTiming.loopbackReads++; throw new TypeError('No local view in this private phone fixture');
      }
      if (/\/api\/v2\/boards\/[^/]+\/objects\//u.test(url.pathname)) __phoneTiming.objectRequests++;
      if (url.pathname.endsWith('/objects/${heldPage}') && !window.__olderHistoryAllowed) {
        __phoneTiming.historyHeld = true;
        await new Promise(resolveHistory => { window.__releaseOlderHistory = resolveHistory; });
      }
      return originalFetch(input, options);
    };
    let queued = false;
    new MutationObserver(() => {
      const node = document.querySelector('#chain');
      if (queued || !node?.textContent.includes('${currentMarker}') || !node.getBoundingClientRect().height) return;
      queued = true;
      requestAnimationFrame(() => { __phoneTiming.firstBoardPaint = performance.now(); });
    }).observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  ` });
  await chrome.send('Network.setCookie', {
    name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  });
  await chrome.navigate(box.origin + '/#board=' + link.board + '&key=' + readFileSync(box.keyFile, 'utf8').trim());
  // Budget: the owner's explicit first-readable-board bar is three seconds, independent of historical streaming.
  await chrome.waitFor('Number.isFinite(window.__phoneTiming?.firstBoardPaint) && typeof transport !== "undefined" && !!transport?.historyProgress', 3000, 'bounded current board paints before all history');
  const first = await chrome.evaluate(`({ ...__phoneTiming, phone: document.documentElement.dataset.relayDevice, progress: transport.historyProgress('${link.board}') })`);
  assert.equal(first.phone, 'phone'); assert.ok(first.firstBoardPaint < 3000);
  assert.equal(first.loopbackReads, 0); assert.equal(first.progress.complete, false);
  // Budget: this fixture streams thirty thousand historical records before reaching its deliberately held oldest event leaf.
  await chrome.waitFor('window.__phoneTiming.historyHeld', 30_000, 'old history is streaming after the first readable board');
  try {
    assert.equal((await box.cli('add', box.lane, liveMarker)).code, 0, 'ordinary native moves continue while old history is pinned');
    await chrome.waitFor(`document.querySelector('#chain')?.textContent.includes('${liveMarker}')`, 15_000, 'new current state arrives while an older history page is held');
  } finally {
    await chrome.evaluate('window.__olderHistoryAllowed = true; window.__releaseOlderHistory?.(); true');
  }
  const expected = relaySnapshot(box.root);
  const finalSequence = Number(expected.tables.board_meta.find(row => row.meta_key === 'relay_applied_sequence').meta_value);
  // Budget: a complete loopback replay includes both the pinned predecessor and its live successor, never the three-second boot bar.
  await chrome.waitFor(`transport.historyProgress('${link.board}').complete && transport.historyProgress('${link.board}').sequence === ${finalSequence}`, 45_000, 'all sealed history is held at the live checkpoint');
  const oldestHash = createHash('sha256').update(oldestMarker).digest('hex');
  const read = await chrome.evaluate(`(async () => {
    const before = __phoneTiming.objectRequests;
    const reply = await transport.request('/api/v1/boards/${link.board}/shouts/${oldest}');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(reply.shout.shout_text)));
    return { hash: [...digest].map(byte => byte.toString(16).padStart(2, '0')).join(''), extraObjectReads: __phoneTiming.objectRequests - before,
      progress: transport.historyProgress('${link.board}'), loopbackReads: __phoneTiming.loopbackReads };
  })()`);
  assert.equal(read.hash, oldestHash); assert.equal(read.extraObjectReads, 0, 'the oldest shout is already held after the background stream');
  assert.equal(read.progress.loaded, read.progress.total); assert.equal(read.loopbackReads, 0);
  await chrome.evaluate(`location.hash = '#shout-${oldest}'; true`);
  await chrome.waitFor(`document.body.innerText.includes('${oldestMarker}')`, 3000, 'the actual phone view opens the streamed oldest shout');
  assert.equal((await second.cli('status')).code, 0, 'an independent paired CLI restores the same paged checkpoint');
  const restored = await second.cli('export');
  assert.equal(restored.code, 0);
  const nativeDigest = value => createHash('sha256').update(JSON.stringify(plainTables(value))).digest('hex');
  assert.equal(nativeDigest(restored.document.tables), nativeDigest(expected.tables), 'every native row, counter and receipt is retained');
  const metrics = { firstPaintMs: first.firstBoardPaint, events: expected.tables.event.length, uniqueCipherBytes: cipherBytes,
    largestUploadBody: Math.max(...writes.map(row => row.request.byteLength)), currentSnapshotBytes: root.links[0].bytes,
    progress: read.progress, oldestHash, nativeTablesHash: nativeDigest(expected.tables) };
  t.diagnostic(JSON.stringify(metrics));
  if (process.env.PULLBOARD_RELAY_PAGE_PROOF) {
    const output = process.env.PULLBOARD_RELAY_PAGE_PROOF;
    mkdirSync(output, { recursive: true, mode: 0o700 });
    writeFileSync(join(output, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n', { mode: 0o600 });
    const screenshot = await chrome.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(output, 'oldest-shout-phone.png'), Buffer.from(screenshot.data, 'base64'), { mode: 0o600 });
  }
});
