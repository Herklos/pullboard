/** Durable device cache and bounded native protocol retries, using real crypto and journal storage [H15,H17]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createRelayJournal } from '../relay/journal.js';
import { snapshotPageRoot } from '../relay/pages-http.js';
import { createRelayPageCache, snapshotSourceId } from '../src/relay-page-cache.js';
import { pagedSnapshotRequest, relaySnapshotRequest, relayStorage, relayStorageLine } from '../src/relay-page-client.js';
import { generateBoardKey } from '../src/seal.js';
import { writeSealedValue } from '../src/sealed-pages.js';
import { Refused } from '../src/refused.js';

/** Use only an isolated device home, restoring the surrounding test process after its cache closes. */
function privateHome(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-private-page-client-'));
  const old = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = join(root, 'device');
  t.after(() => { if (old === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = old; rmSync(root, { recursive: true, force: true }); });
  return root;
}

/** Dispatch the client's actual API2 objects against real journal/page transactions; HTTP auth has its separate tests. */
async function fixture(t) {
  const root = privateHome(t);
  const state = { board: 'a'.repeat(32), url: 'https://synthetic-relay.example' };
  const key = await generateBoardKey();
  const journal = createRelayJournal({ directory: join(root, 'journal'), boardId: state.board });
  const pages = journal.pages();
  t.after(() => { pages.close(); journal.close(); });
  const principal = { kind: 'machine', userId: 'fixture-account', machine: 'fixture-machine' };
  const storage = { account: { id: 'fixture-account', login: 'fixture-login' }, usedBytes: 0, limitBytes: 256_000_000 };
  const calls = [];
  let loseObjectAck = false, corruptRootAck = false;
  /** Preserve a strict bounded upload shape while returning the real storage's idempotent acknowledgements. */
  async function request(path, options = {}) {
    const body = options.body;
    calls.push({ path, method: options.method ?? 'GET', bytes: body ? Buffer.byteLength(JSON.stringify(body)) : 0,
      digest: body?.sealed ? snapshotSourceId(body.sealed) : null });
    const suffix = path.slice(('/api/v2/boards/' + state.board).length);
    if (suffix === '/uploads') return { apiVersion: 2, storage, upload: body.resume ? pages.resume(body.resume, principal, body.sequence) : pages.begin(principal, body.sequence) };
    const put = /^\/uploads\/([^/]+)\/objects\/([0-9a-f]{64})$/u.exec(suffix);
    if (put) {
      assert.deepEqual(Object.keys(body).sort(), ['children', 'sealed', 'sequence']);
      assert.ok(calls.at(-1).bytes < 600_000);
      const stored = pages.put(put[1], principal, { id: put[2], sequence: body.sequence, bytes: Buffer.from(body.sealed, 'base64url'), children: body.children });
      if (loseObjectAck) { loseObjectAck = false; throw new Refused('RELAY_UNAVAILABLE', 'Synthetic lost object ACK.'); }
      return { apiVersion: 2, page: stored };
    }
    const publish = /^\/uploads\/([^/]+)\/publish$/u.exec(suffix);
    if (publish) {
      const saved = pages.publish(publish[1], principal, body.root, (ref, bytes) => journal.saveSnapshot(ref.sequence, bytes, principal, { apiVersion: 2, pageBytes: ref.bytes }));
      pages.prune([body.root.id]);
      const result = { apiVersion: 2, state: { root: snapshotPageRoot(saved), sequence: saved.sequence, storage } };
      if (corruptRootAck) result.state.root.id = 'f'.repeat(64);
      return result;
    }
    if (suffix === '/state') {
      const saved = journal.snapshot();
      const reference = snapshotPageRoot(saved);
      return { apiVersion: 2, state: { ...saved, apiVersion: 2, root: reference, read: pages.pin(principal, reference), storage } };
    }
    const get = /^\/objects\/([0-9a-f]{64})\?(.+)$/u.exec(suffix);
    if (get) {
      const query = new URLSearchParams(get[2]);
      const object = pages.get(query.get('pin'), principal, get[1], query.get('via') ? query.get('via').split(',') : []);
      return { apiVersion: 2, page: { id: object.id, sequence: object.sequence, sealed: object.bytes.toString('base64url'), children: object.children } };
    }
    throw new Error('Unexpected synthetic API2 route.');
  }
  const shouts = [{ shout_id: 1, shout_text: randomBytes(700_000).toString('base64'), shout_decision: 0, shout_answers: null }];
  const document = { version: 1, tables: {
    board_meta: [{ meta_key: 'board_id', meta_value: state.board }, { meta_key: 'relay_engine_version', meta_value: '56' }, { meta_key: 'relay_applied_sequence', meta_value: '0' }],
    shout: shouts, event: [], item: [], agent: [], verdict: [], sqlite_sequence: [{ name: 'shout', seq: 19 }],
  }, presentation: { version: 1, config: {}, state: { items: [], agents: [], shouts: [], decisions: [], asked: [], events: [], holds: [], spec: [], practice: [], lanes: [], owning: [] }, shouts } };
  const adapter = { request, key, maxEngine: 56, decode: async () => structuredClone(document), encode: async value => JSON.stringify(value) };
  return { state, document, adapter, calls, pages, journal, principal,
    loseObjectAck() { loseObjectAck = true; }, corruptRootAck() { corruptRootAck = true; } };
}

test('a lost object ACK resumes the exact durable graph and native restore preserves all rows [H15,H17]', async t => {
  const box = await fixture(t);
  const pending = { sequence: 0, sealed: 'synthetic-original-pending-cipher' };
  box.loseObjectAck();
  await assert.rejects(pagedSnapshotRequest(box.state, { method: 'PUT', body: pending }, box.adapter), { code: 'RELAY_UNAVAILABLE' });
  assert.equal(box.journal.snapshot(), null, 'a partially uploaded graph is never installed');
  const first = box.calls.find(call => call.method === 'PUT');
  const result = await pagedSnapshotRequest(box.state, { method: 'PUT', body: pending }, box.adapter);
  assert.equal(result.state.sealed, pending.sealed, 'the existing retry carrier is acknowledged only after an exact root ACK');
  const retries = box.calls.filter(call => call.path === first.path && call.method === 'PUT');
  assert.equal(retries.length, 2); assert.equal(retries[0].digest, retries[1].digest);
  assert.ok(box.calls.some(call => call.path.endsWith('/uploads') && call.method === 'POST'));
  const read = await pagedSnapshotRequest(box.state, {}, box.adapter);
  assert.deepEqual(JSON.parse(read.state.sealed), box.document);
  assert.equal(box.state.storage.account.login, 'fixture-login');
});

test('a collected remote subtree is restaged despite old cached ACKs, without replacing the source graph [H15,H17]', async t => {
  const box = await fixture(t);
  const pending = { sequence: 0, sealed: 'synthetic-stable-pending-cipher' };
  const first = await pagedSnapshotRequest(box.state, { method: 'PUT', body: pending }, box.adapter);
  const count = box.calls.filter(call => call.method === 'PUT').length;
  box.pages.prune([]);
  const second = await pagedSnapshotRequest(box.state, { method: 'PUT', body: pending }, box.adapter);
  assert.equal(second.state.root.id, first.state.root.id);
  assert.ok(box.calls.filter(call => call.method === 'PUT').length > count);
  assert.deepEqual(JSON.parse((await pagedSnapshotRequest(box.state, {}, box.adapter)).state.sealed), box.document);
});

test('an incorrect root ACK never completes or discards the private durable upload [H15,H17]', async t => {
  const box = await fixture(t);
  const pending = { sequence: 0, sealed: 'synthetic-ack-check' };
  box.corruptRootAck();
  await assert.rejects(pagedSnapshotRequest(box.state, { method: 'PUT', body: pending }, box.adapter), { code: 'RELAY_RESPONSE' });
  const cache = createRelayPageCache(box.state);
  try { assert.ok(cache.job(snapshotSourceId(pending.sealed))); } finally { cache.close(); }
});

test('private reuse authenticates the fingerprint binding rather than trusting an unrelated cached page [H15,H17]', async t => {
  privateHome(t);
  const state = { board: 'b'.repeat(32), url: 'https://synthetic-relay.example' };
  const cache = createRelayPageCache(state);
  const context = { key: await generateBoardKey(), boardId: state.board, sequence: 0, put: cache.put };
  try {
    const ref = await writeSealedValue({ marker: 'private-data' }, context);
    cache.remember('f'.repeat(64), ref);
    await assert.rejects(cache.lookup('f'.repeat(64), context), { code: 'RELAY_PAGE_CACHE' });
  } finally { cache.close(); }
});

test('account status has a validated identity, exact byte counts and a clear operator-set limit [H15,H17]', () => {
  const storage = { account: { id: 'account-1', login: 'owner-login' }, usedBytes: 251_000_000, limitBytes: 256_000_000 };
  assert.deepEqual(relayStorage(storage), storage);
  assert.equal(relayStorageLine(storage), 'relay storage: account owner-login, 251.0 MB used of 256.0 MB');
  assert.equal(relayStorage({ ...storage, account: { ...storage.account, login: 'Bearer private text' } }), null);
  assert.equal(relayStorage({ ...storage, usedBytes: -1 }), null);
});

test('oversize native uploads negotiate API2, native reads upgrade explicitly, and a paged board never downgrades [H15,H17]', async t => {
  const box = await fixture(t);
  const pending = { sequence: 0, sealed: 'synthetic-large-legacy-carrier' };
  const oldPath = '/api/v1/boards/' + box.state.board + '/state';
  const calls = [];
  let advertised = 2, persisted = 0;
  const hooks = { ...box.adapter, key: () => box.adapter.key, legacyLimit: 1, persist() { persisted++; },
    /** The adapter must never send an oversized legacy body before negotiating bounded pages. */
    async raw(path, options) {
      calls.push(path);
      if (path === '/api/v2') return { version: 1, apiVersion: advertised };
      if (path === oldPath) { assert.notEqual(options.method, 'PUT'); throw new Refused('RELAY_API_VERSION', 'Use API2.'); }
      return box.adapter.request(path, options);
    },
  };
  const written = await relaySnapshotRequest(box.state, oldPath, { method: 'PUT', body: pending }, {}, hooks);
  assert.equal(written.state.sealed, pending.sealed);
  assert.equal(box.state.snapshotApiVersion, 2);
  assert.ok(!calls.includes(oldPath), 'the oversized wire body never reaches API1');
  delete box.state.snapshotApiVersion;
  const read = await relaySnapshotRequest(box.state, oldPath, {}, {}, hooks);
  assert.deepEqual(JSON.parse(read.state.sealed), box.document);
  assert.equal(box.state.snapshotApiVersion, 2);
  assert.equal(persisted, 2);
  advertised = 1;
  await assert.rejects(relaySnapshotRequest(box.state, oldPath, {}, {}, hooks), { code: 'RELAY_API_VERSION' });
});

test('a relay without API2 retains legacy snapshot behavior rather than guessing a new wire format [H15,H17]', async () => {
  const state = { board: 'a'.repeat(32), url: 'https://synthetic-legacy.example' };
  const path = '/api/v1/boards/' + state.board + '/state';
  const calls = [];
  const response = { version: 1, state: { sealed: 'legacy-ack' } };
  const hooks = { legacyLimit: 1,
    /** An old relay has no capability route and only accepts its original snapshot interface. */
    async raw(target) {
      calls.push(target);
      if (target === '/api/v2') throw Object.assign(new Refused('BAD_REQUEST', 'Legacy relay route.'), { httpStatus: 404, relayVersion: 1 });
      assert.equal(target, path); return response;
    },
  };
  assert.equal(await relaySnapshotRequest(state, path, { method: 'PUT', body: { sealed: 'long' } }, {}, hooks), response);
  assert.deepEqual(calls, ['/api/v2', path]);
  assert.equal(state.snapshotApiVersion, undefined);
});
