/** Real account attribution and a shared lifecycle lock protect storage across boards [H15,H17,H18]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createRelayAuth } from '../relay/auth.js';
import { createGitHubClient } from '../relay/github.js';
import { createRelayJournal } from '../relay/journal.js';
import { createRelayPages } from '../relay/page-store.js';
import { boardStorageBytes, createStorageQuota } from '../relay/storage-quota.js';
import { githubFixture } from './relay-fixture.js';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);

/** Complete a synthetic OAuth sign-in without returning any credential in a test assertion. */
async function signIn(auth) {
  const flow = auth.beginWeb();
  const redirect = await fetch(flow.authorizationURL, { redirect: 'manual' });
  const url = new URL(redirect.headers.get('location'));
  return auth.finishWeb(url.searchParams.get('state'), url.searchParams.get('code'), flow.binding);
}

/** Create actual private authentication and storage files with no owner data or relay connection. */
async function fixture(t, limitBytes = 300) {
  const provider = await githubFixture(t);
  const root = mkdtempSync(join(tmpdir(), 'pullboard-storage-quota-'));
  const directory = join(root, 'boards');
  const database = join(root, 'auth.sqlite');
  const auth = createRelayAuth({ database, github: createGitHubClient(provider.config) });
  const signed = await signIn(auth);
  await auth.linkBoard(signed.token, A, 'fixture/repository');
  await auth.linkBoard(signed.token, B, 'fixture/repository');
  const principal = { kind: 'machine', userId: signed.user.id, machine: 'fixture-native' };
  const quota = createStorageQuota({ directory, auth, limitBytes });
  const opened = [];
  t.after(() => { for (const store of opened) store.close(); quota.close(); auth.close(); rmSync(root, { recursive: true, force: true }); });
  /** Close each actual journal after one synchronous test operation. */
  function journal(id, work) {
    const store = createRelayJournal({ directory, boardId: id });
    try { return work(store); } finally { store.close(); }
  }
  /** Add real staged opaque bytes while leaving their interpretation on the client. */
  function page(id, size) {
    const store = createRelayPages({ directory, boardId: id }); opened.push(store);
    const upload = store.begin(principal, 0);
    const bytes = Buffer.alloc(size, 5);
    store.put(upload.id, principal, { id: createHash('sha256').update(bytes).digest('hex'), sequence: 0, bytes, children: [] });
    return store;
  }
  return { provider, root, directory, database, auth, signed, principal, quota, journal, page };
}

test('one account quota includes legacy bytes and unfinished pages across its boards [H15,H17]', async t => {
  const box = await fixture(t);
  box.journal(A, journal => journal.appendNext(Buffer.alloc(150), 'move', { kind: 'agent', userId: box.signed.user.id, agent: 'fixture' }));
  box.page(B, 110);
  assert.equal(boardStorageBytes(box.directory, A), 150);
  assert.equal(box.quota.usage(B).usedBytes, 262, 'the staged page and its opaque child index count alongside the other board');
  let wrote = false;
  assert.throws(() => box.quota.change(B, box.principal, 50, () => { wrote = true; }), { code: 'ACCOUNT_STORAGE_LIMIT' });
  assert.equal(wrote, false);
  const notice = box.quota.notice(B);
  assert.equal(notice.storage.account.id, box.signed.user.id);
  assert.equal(notice.storage.usedBytes, 262);
  assert.equal(notice.storage.limitBytes, 300);
  assert.ok(notice.message.includes(box.signed.user.login), 'the public notice names the authenticated account');
  const reopened = createStorageQuota({ directory: box.directory, auth: box.auth, limitBytes: 300 });
  try { assert.equal(reopened.notice(B).code, 'ACCOUNT_STORAGE_LIMIT', 'the warning survives a service restart'); }
  finally { reopened.close(); }
});

test('an existing storage account is stable across a second authorized link and another account has its own budget [H15,H17]', async t => {
  const box = await fixture(t);
  box.provider.state.accountID = 8; box.provider.state.permissionAccountID = 8;
  const other = await signIn(box.auth);
  await box.auth.linkBoard(other.token, A, 'fixture/repository');
  await box.auth.linkBoard(other.token, C, 'fixture/repository');
  assert.equal(box.auth.storageAccount(A, other.user.id).id, box.signed.user.id);
  assert.equal(box.auth.storageAccount(C).id, other.user.id);
  assert.deepEqual(box.auth.storageBoards(box.signed.user.id), [A, B]);
  assert.deepEqual(box.auth.storageBoards(other.user.id), [C]);
  box.page(A, 250);
  assert.equal(box.quota.usage(C).usedBytes, 0);
  box.quota.change(C, { kind: 'person', userId: other.user.id }, 200, () => {
    box.journal(C, journal => journal.saveSnapshot(0, Buffer.alloc(200), { kind: 'person', userId: other.user.id }));
  });
  assert.equal(box.quota.usage(C).usedBytes, 200);
  assert.equal(box.quota.usage(A).usedBytes, 252);
});

test('the quota lock remains held through the write and an over-quota account may still shrink [H15,H17]', async t => {
  const box = await fixture(t, 100);
  box.quota.change(A, box.principal, 90, () => {
    const independent = new DatabaseSync(box.database);
    try {
      independent.exec('PRAGMA busy_timeout=0');
      assert.throws(() => independent.exec('BEGIN IMMEDIATE'), /locked|busy/u, 'another connection cannot spend the same account budget during the write');
    } finally { independent.close(); }
    box.journal(A, journal => journal.saveSnapshot(0, Buffer.alloc(90), { kind: 'person', userId: box.signed.user.id }));
  });
  const lower = createStorageQuota({ directory: box.directory, auth: box.auth, limitBytes: 20 });
  try {
    box.journal(A, journal => {
      const replacement = Buffer.alloc(50);
      const delta = journal.snapshotDelta(0, replacement);
      assert.equal(delta, -40);
      lower.change(A, box.principal, delta, () => journal.saveSnapshot(0, replacement, { kind: 'person', userId: box.signed.user.id }));
    });
    assert.equal(lower.usage(A).usedBytes, 50, 'a reducing write remains possible even before usage falls below the lowered quota');
  } finally { lower.close(); }
});
