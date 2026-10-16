/** Expired relay credentials retain local reads and ordered, actor-scoped moves [H16,H5]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { relayClientFixture } from './relay-client-fixture.js';
import { runFixtureGit } from './fixture-child.js';

/** Revoke one private fixture credential through the real relay authorization endpoint. */
async function revokeCredential(box, id) {
  const phone = await box.phoneSession();
  const response = await fetch(box.origin + '/auth/tokens/revoke', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + phone.token, 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  assert.equal(response.status, 200, 'the fixture revokes the selected opaque credential');
}

/** Read one real CLI result and check its single board-named local fallback diagnostic. */
async function assertLocalRead(box, board, ...args) {
  const result = await box.cli(...args);
  assert.equal(result.code, 0, result.failure ?? `${args[0]} answers from the local board`);
  assert.equal(result.document.diagnostics?.length, 1, `${args[0]} prints one auth-expiry line`);
  assert.match(result.document.diagnostics[0], new RegExp(board));
  assert.match(result.document.diagnostics[0], /sign-in expired or was revoked/u);
  assert.match(result.document.diagnostics[0], /pullboard relay on.*pullboard relay off/u);
  return result;
}

test('reads and status answer when the relay sign-in expired [H16,H5]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const seed = await box.cli('add', box.lane, 'local read fixture');
  assert.equal(seed.code, 0, seed.failure ?? 'the private real relay accepts a fixture move');
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  await revokeCredential(box, state.tokenId);

  const board = state.board;
  await assertLocalRead(box, board, 'status');
  await assertLocalRead(box, board, 'spec', 'check');
  await assertLocalRead(box, board, 'show', String(seed.document.item.item_id));
  await assertLocalRead(box, board, 'list', '--all');
  await assertLocalRead(box, board, 'decisions');
  await assertLocalRead(box, board, 'inbox');
  await assertLocalRead(box, board, 'log');
  const view = await assertLocalRead(box, board, 'view', '--export', join(box.root, 'local-view.html'));
  assert.equal(existsSync(view.document.path), true, 'the local view export is available after relay auth refusal');
});

test('a revoked agent token is never reminted from the machine credential; the person reissues the coordinator [H16,H5,H2]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const seed = await box.cli('add', box.lane, 'seed agent credential');
  assert.equal(seed.code, 0, seed.failure ?? 'the coordinator token from relay on sends the first move');
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const agent = state.agentTokens.coordinator;
  assert.ok(agent?.id, 'the board link caches a scoped coordinator credential');
  await revokeCredential(box, agent.id);

  const before = (await box.cli('export')).document.tables;
  const mintsBefore = box.calls.filter(call => call.method === 'POST' && call.path === '/auth/tokens').length;
  const acksBefore = box.moveAcks.length;
  const refused = await box.cli('add', box.lane, 'move after agent-token revocation');
  assert.equal(refused.code, 1, 'the machine credential never replaces a revoked seat token (#579)');
  assert.equal(refused.document.error.code, 'TOKEN_REVOKED');
  assert.equal(box.calls.filter(call => call.method === 'POST' && call.path === '/auth/tokens').length, mintsBefore,
    'no replacement token is minted');
  assert.equal(box.moveAcks.length, acksBefore, 'the relay acknowledges no move');
  assert.deepEqual((await box.cli('export')).document.tables, before, 'the refused move changes no local board state');

  // The person's own relay on reissues the coordinator token and records it.
  const relink = await box.cli('relay', 'on', '--url', box.origin);
  assert.equal(relink.code, 0, relink.failure ?? 'relay on reissues the coordinator token from the person sign-in');
  const reissued = JSON.parse(readFileSync(box.linkFile, 'utf8')).agentTokens.coordinator;
  assert.notEqual(reissued.id, agent.id, 'a new coordinator token replaces the revoked one');
  const moved = await box.cli('add', box.lane, 'move after person reissue');
  assert.equal(moved.code, 0, moved.failure ?? 'the reissued coordinator token sends moves again');
  const tokens = await box.cli('relay', 'tokens');
  assert.equal(tokens.code, 0, tokens.failure ?? 'the token inventory lists the coordinator audit');
  assert.deepEqual(tokens.document.coordinatorEvents.map(row => row.reason), ['bootstrap', 'reissue']);
  assert.equal(tokens.document.coordinatorEvents[1].issued, reissued.id);
});

test('a move without a machine credential refuses with the fix [H16,H5]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const seed = await box.cli('add', box.lane, 'seed revoked machine fixture');
  assert.equal(seed.code, 0, seed.failure ?? 'the initial move registers a scoped credential');
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const cliPath = fileURLToPath(new URL('../bin/pullboard.js', import.meta.url));
  writeFileSync(join(box.env.PATH, 'pullboard'), `#!/bin/sh\nexec node "${cliPath}" "$@"\n`, { mode: 0o700 });
  runFixtureGit(['add', '-A'], { cwd: box.root, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'test: prepare private ordered claim'], { cwd: box.root, env: box.env });
  const agentRoot = join(box.root, '..', 'claim-agent');
  runFixtureGit(['worktree', 'add', '-q', '-b', 'core/auth-claim', agentRoot], { cwd: box.root, env: box.env });
  const joined = await box.cliAt(agentRoot, 'join', box.lane);
  assert.equal(joined.code, 0, joined.failure ?? 'a real agent joins before the credentials are revoked');
  await revokeCredential(box, state.agentTokens.coordinator.id);
  const before = (await box.cli('export')).document.tables;
  const mintsBeforeExplicit = box.calls.filter(call => call.method === 'POST' && call.path === '/auth/tokens').length;
  const sendsBeforeExplicit = box.calls.filter(call => call.method === 'POST' && call.path.endsWith('/moves')).length;

  box.env.PULLBOARD_RELAY_TOKEN = state.agentTokens.coordinator.token;
  try {
    const explicit = await box.cli('add', box.lane, 'explicit revoked token is not replaced');
    assert.equal(explicit.code, 1);
    assert.equal(explicit.document.error.code, 'AUTH_REQUIRED');
    assert.match(explicit.document.error.message, /supplied PULLBOARD_RELAY_TOKEN was refused/u);
    assert.match(explicit.document.error.message, /unset PULLBOARD_RELAY_TOKEN.*supply a current PULLBOARD_RELAY_TOKEN/u);
    assert.equal(box.calls.filter(call => call.method === 'POST' && call.path === '/auth/tokens').length, mintsBeforeExplicit,
      'an explicit revoked token is never replaced from the machine credential');
    assert.equal(box.calls.filter(call => call.method === 'POST' && call.path.endsWith('/moves')).length, sendsBeforeExplicit,
      'the explicit-token refusal never reaches the relay move endpoint');
    assert.deepEqual((await box.cli('export')).document.tables, before,
      'an explicit revoked token is preserved as the caller identity and cannot apply a local move');
  } finally { delete box.env.PULLBOARD_RELAY_TOKEN; }

  await revokeCredential(box, state.tokenId);
  const refused = await box.cli('add', box.lane, 'must stay ordered without machine auth');
  assert.equal(refused.code, 1);
  assert.equal(refused.document.error.code, 'AUTH_REQUIRED');
  assert.equal(refused.document.error.message.split('\n').length, 1, 'the refusal stays on one line');
  assert.match(refused.document.error.message, new RegExp(state.board));
  assert.match(refused.document.error.message, /expired or was revoked/u);
  assert.match(refused.document.error.message, /pullboard relay on.*pullboard relay off/u);
  assert.deepEqual((await box.cli('export')).document.tables, before, 'a move without renewable machine authority is never applied locally out of order');
  const next = await box.cliAt(agentRoot, 'next', '--build');
  assert.equal(next.code, 1, 'next is an ordered claim/reservation move, not an offline read');
  assert.equal(next.document.error.code, 'AUTH_REQUIRED');
  assert.match(next.document.error.message, /pullboard relay on.*pullboard relay off/u);
  assert.deepEqual((await box.cli('export')).document.tables, before, 'an unauthenticated next cannot reserve locally out of order');
  const textRefusal = await box.script(`
    const { main } = await import(${JSON.stringify(box.mainURL)});
    let stdout = '', stderr = '';
    const code = await main(['join', ${JSON.stringify(box.lane)}], {
      cwd: ${JSON.stringify(agentRoot)}, stdout: { write(value) { stdout += value; } }, stderr: { write(value) { stderr += value; } },
    });
    console.log(JSON.stringify({ code, stdout, stderr }));
  `);
  assert.equal(textRefusal.code, 0, 'the private production CLI capture completes');
  assert.equal(textRefusal.document.code, 1);
  const stderrLines = textRefusal.document.stderr.trim().split('\n');
  const refusalLines = stderrLines.filter(line => !/^next: /u.test(line));
  assert.equal(refusalLines.length, 1, 'text registration reports exactly one refusal line');
  assert.equal(stderrLines.length - refusalLines.length, 1, 'followed by the one next step every text refusal ends with (#176)');
  assert.match(refusalLines[0], new RegExp(state.board));
  assert.match(refusalLines[0], /pullboard relay on.*pullboard relay off/u);
  const rejoin = await box.cliAt(agentRoot, 'join', box.lane);
  assert.equal(rejoin.code, 1);
  assert.equal(rejoin.document.error.code, 'AUTH_REQUIRED');
  assert.equal((rejoin.document.diagnostics ?? []).length, 0, 'registration reports only its refusal, without a read fallback first');
  assert.equal(rejoin.document.error.message.split('\n').length, 1);
  assert.match(rejoin.document.error.message, new RegExp(state.board));
  assert.match(rejoin.document.error.message, /pullboard relay on.*pullboard relay off/u);

  const phone = await box.phoneSession();
  for (const token of [state.agentTokens.coordinator.token, phone.token, undefined]) {
    const legacy = { ...JSON.parse(readFileSync(box.linkFile, 'utf8')), token };
    delete legacy.tokenId;
    delete legacy.agentTokens;
    writeFileSync(box.linkFile, JSON.stringify(legacy) + '\n', { mode: 0o600 });
    const oldRead = await assertLocalRead(box, state.board, 'status');
    assert.equal(oldRead.code, 0);
    const oldMove = await box.cli('add', box.lane, 'old links cannot apply out of order');
    assert.equal(oldMove.code, 1);
    assert.equal(oldMove.document.error.code, 'AUTH_REQUIRED');
    assert.equal((oldMove.document.diagnostics ?? []).length, 0);
    assert.equal(oldMove.document.error.message.split('\n').length, 1);
    assert.match(oldMove.document.error.message, new RegExp(state.board));
    assert.match(oldMove.document.error.message, /pullboard relay on.*pullboard relay off/u);
    assert.deepEqual((await box.cli('export')).document.tables, before, 'old PA, PS and tokenless links retain the local board');
  }
});

test('relay off keeps a board out of auto-link [H1,H7,H16]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const machineFile = join(box.env.PULLBOARD_HOME, 'relay-machine', 'state.json');
  const machine = JSON.parse(readFileSync(machineFile, 'utf8'));
  machine.autoLink = true;
  writeFileSync(machineFile, JSON.stringify(machine) + '\n', { mode: 0o600 });

  const off = await box.cli('relay', 'off');
  assert.equal(off.code, 0, off.failure ?? 'relay off always completes local unlink');
  assert.equal(existsSync(box.linkFile), false, 'relay off removes the local link immediately');
  const excluded = JSON.parse(readFileSync(machineFile, 'utf8')).excluded;
  assert.ok(excluded.includes(box.root), 'relay off durably records the local opt-out');

  const callsBeforeStatus = box.calls.length;
  const status = await box.cli('status');
  assert.equal(status.code, 0, status.failure ?? 'local status remains available after relay off');
  assert.equal(status.document.relay.linked, false, 'the auto-link pass leaves the board unlinked');
  assert.equal(box.calls.length, callsBeforeStatus, 'auto-link does not contact the relay or relink an excluded board');
  assert.ok(JSON.parse(readFileSync(machineFile, 'utf8')).excluded.includes(box.root));
});
