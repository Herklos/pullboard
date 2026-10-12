/** Real transport proves credential selection follows every public operation class [H2,H9,H16]. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { ENGINE_OPERATIONS } from '../src/engine.js';
import { ENGINE_VERSION } from '../src/machine.js';
import { decodeBoardKey, unseal } from '../src/seal.js';
import { relayClientFixture } from './relay-client-fixture.js';

test('every current operation selects its native actor credential without a second authorization policy [H2,H9,H16]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const actor = 'coordinator';
  const options = { agentId: actor, lane: box.lane, leaseMs: 3600000, reason: 'credential fixture', note: 'credential fixture', text: 'fixture', kind: 'observation', head: 'a'.repeat(40), frozen: { text: '{"rows":[]}', digest: 'f'.repeat(64) } };
  const cases = ENGINE_OPERATIONS.map(operation => {
    let args = [999999, options];
    let kind = 'agent';
    if (operation === 'register') { args = [{ lane: box.lane, path: '/private/credential-enrollment' }]; kind = 'machine'; }
    if (operation === 'ensureCoordinator') { args = [box.root]; kind = 'machine'; }
    if (operation === 'addItem') args = [{ by: actor, lane: box.lane, title: 'credential actor fixture' }];
    if (operation === 'shout') args = [{ from: actor, to: 'all', text: 'credential actor fixture', lanes: [box.lane] }];
    if (operation === 'release') args = [999999, actor];
    if (['claim', 'refreeze'].includes(operation)) args = [box.before.tables.item[0].item_id, options];
    if (operation === 'reserveNextReview') args = [options];
    if (operation === 'completeCheckBaseline') args = [999999, { ...options,
      expected: { command: 'true', main: 'a'.repeat(40), result: 'pending', request: '11111111-1111-4111-8111-111111111111' },
      baseline: { command: 'true', main: 'a'.repeat(40), result: 'green' },
    }];
    if (['recordLandingBatch', 'recordLandingFlake', 'finishLandingBatch'].includes(operation)) args = [options];
    if (operation === 'recordLandingWaiver') { args = [{ ...options, agentId: 'person', channel: 'terminal' }]; kind = 'person'; }
    if (operation === 'addMilestone') args = [{ agentId: actor, name: 'Credential fixture', items: [] }];
    if (['holdLane', 'releaseLane'].includes(operation)) args = [box.lane, options];
    if (operation === 'applyRowDecisions') args = [{ agentId: actor, events: [] }];
    if (operation === 'recordRowDecisions') { args = [{ agentId: 'person', channel: 'terminal', decisions: [] }]; kind = 'person'; }
    return { operation, args, kind, ...(kind === 'person' ? { sent: false } : {}) };
  });
  cases.push(
    { operation: 'answerDecision', args: [999999, { ...options, asPerson: true, channel: 'terminal' }], kind: 'person', sent: false },
    { operation: 'holdLane', args: [box.lane, { ...options, asPerson: true, channel: 'terminal' }], kind: 'person', sent: false },
    { operation: 'releaseLane', args: [box.lane, { ...options, asPerson: true, channel: 'terminal' }], kind: 'person', sent: false },
    { operation: 'shout', args: [{ from: actor, to: 'all', text: 'person request fixture', lanes: [box.lane], request: true }], kind: 'person', sent: false },
    { operation: 'applyRowDecisions', args: [{ agentId: actor, events: [] }], kind: 'machine', sent: false, expected: 'PERSON_REQUEST_CLOSED', personRequest: { id: 'credential-request', executor: actor, phase: 'execute', digest: '0'.repeat(64) } },
  );
  const start = box.moveAcks.length;
  const results = [];
  // Each child keeps the fixture's existing deadline while all moves share one durable board.
  for (let offset = 0; offset < cases.length; offset += 8) {
    const batch = cases.slice(offset, offset + 8);
    const result = await box.script(`
    import { relayOperation } from ${JSON.stringify(new URL('../src/relay.js', import.meta.url).href)};
    import { Refused } from ${JSON.stringify(new URL('../src/refused.js', import.meta.url).href)};
    const cases = ${JSON.stringify(batch)};
    const results = [];
    for (const entry of cases) {
      const io = { err() {}, onEvent() {}, ...(entry.personRequest ? { personRequest: entry.personRequest } : {}) };
      try { await relayOperation(process.cwd(), entry.operation, entry.args, io); results.push(null); }
      catch (error) { if (!(error instanceof Refused)) { results.push({ fatal: error.name, operation: entry.operation, stack: error.stack?.split('\\n').slice(1, 3).join('\\n') }); break; } results.push(error.code); }
    }
    console.log(JSON.stringify({ results }));
  `);
    assert.equal(result.code, 0, 'every operation reaches the real transport and deterministic replay');
    assert.equal(result.document.results.some(value => value?.fatal), false, JSON.stringify(result.document.results.filter(value => value?.fatal)));
    assert.equal(result.document.results.length, batch.length);
    results.push(...result.document.results);
  }
  const records = box.moveAcks.slice(start);
  const sentCases = cases.filter(entry => entry.sent !== false);
  assert.equal(records.length, sentCases.length, 'agent and machine moves are acknowledged; person-only moves stop before transport');
  const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  let recordIndex = 0;
  for (const [index, entry] of cases.entries()) {
    if (entry.sent === false) {
      assert.equal(results[index], entry.expected ?? 'HUMAN_REQUIRED', `${entry.operation} cannot use the saved machine credential for a person action`);
      continue;
    }
    const record = records[recordIndex++];
    const move = JSON.parse(new TextDecoder().decode(await unseal(key, Buffer.from(record.sealed, 'base64url'), { boardId: state.board, kind: record.kind, sequence: record.event_id })));
    assert.equal(move.operation, entry.operation);
    assert.equal(move.engine, ENGINE_VERSION, 'the current engine version is recorded on every sealed operation');
    assert.equal(record.sender.kind, entry.kind, `${entry.operation} selects the correct authenticated credential`);
    if (entry.kind === 'agent') assert.equal(record.sender.agent, actor, 'the scoped credential belongs to the native actor');
    if (entry.kind === 'machine') assert.equal(record.sender.machine, state.machine, 'the machine credential is attributed to this native machine');
    if (entry.personRequest) {
      assert.equal(results[index], 'RELAY_PERSON_ONLY', 'a machine cannot execute an unauthenticated synthetic person request');
    } else {
      assert.ok(!['RELAY_ACTOR', 'RELAY_SENDER', 'RELAY_SENDER_MISMATCH', 'RELAY_PERSON_ONLY'].includes(results[index]),
        `${entry.operation} passes main's shared sender policy`);
    }
  }
});

test('a person-only move is refused before the relay is asked [H2,H9,H16]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();

  /** Return one move's relay-call trace from the real linked CLI environment. */
  async function orderedMove(operation, args, io = {}) {
    return box.script(`
      import { relayOperation } from ${JSON.stringify(new URL('../src/relay.js', import.meta.url).href)};
      const io = ${JSON.stringify(io)};
      io.err = () => {};
      try { await relayOperation(process.cwd(), ${JSON.stringify(operation)}, ${JSON.stringify(args)}, io); console.log(JSON.stringify({ code: null })); }
      catch (error) { console.log(JSON.stringify({ code: error.code ?? error.name })); }
    `);
  }

  const orderedCases = [
    ['register', [{ lane: box.lane, path: '/private/person-refusal-machine-control' }], {}, null],
    ['addItem', [{ by: 'coordinator', lane: box.lane, title: 'person refusal agent control' }], {}, null],
    ['applyRowDecisions', [{ agentId: 'coordinator', events: [] }], {
      personRequest: { id: 'closed-person-request', executor: 'coordinator', phase: 'execute', digest: '0'.repeat(64) },
    }, 'PERSON_REQUEST_CLOSED'],
  ];
  for (const [operation, args, io, expected] of orderedCases) {
    const before = box.calls.length;
    const result = await orderedMove(operation, args, io);
    assert.equal(result.code, 0, `${operation} control runs in the real linked fixture`);
    assert.equal(result.document.code, expected, `${operation} retains its native outcome`);
    const calls = box.calls.slice(before);
    const catchUp = calls.findIndex(call => call.method === 'GET' && call.path.includes('/events?after='));
    assert.notEqual(catchUp, -1, `${operation} reads the relay event prefix before its outcome`);
    if (operation !== 'applyRowDecisions') {
      const move = calls.findIndex(call => call.method === 'POST' && call.path.endsWith('/moves'));
      assert.ok(move > catchUp, `${operation} catches up before sending its move`);
    } else {
      assert.ok(calls.some(call => call.method === 'GET' && call.path.includes('/events?after=')),
        'a person-request execution still follows the machine catch-up path');
    }
  }

  const arrivals = [];
  const blackhole = createServer(request => {
    arrivals.push({ method: request.method, path: request.url });
    request.resume();
    // Deliberately never answer; closing the socket makes a broken guard fail promptly.
    request.socket.destroy();
  });
  t.after(() => {
    blackhole.closeAllConnections();
    blackhole.close();
  });
  await new Promise(resolve => blackhole.listen(0, '127.0.0.1', resolve));
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  state.url = `http://127.0.0.1:${blackhole.address().port}`;
  writeFileSync(box.linkFile, JSON.stringify(state), { mode: 0o600 });

  const personCases = [
    ['recordLandingWaiver', [{ agentId: 'person', channel: 'terminal', reason: 'fixture' }]],
    ['recordRowDecisions', [{ agentId: 'person', channel: 'terminal', decisions: [] }]],
    ['answerDecision', [1, { agentId: 'person', asPerson: true, channel: 'terminal' }]],
    ['holdLane', [box.lane, { agentId: 'person', asPerson: true, channel: 'terminal', reason: 'fixture' }]],
    ['releaseLane', [box.lane, { agentId: 'person', asPerson: true, channel: 'terminal' }]],
    ['shout', [{ from: 'coordinator', to: 'all', text: 'person request fixture', lanes: [box.lane], request: true }]],
  ];
  const personResult = await box.script(`
    import { relayOperation } from ${JSON.stringify(new URL('../src/relay.js', import.meta.url).href)};
    const cases = ${JSON.stringify(personCases)};
    const results = [];
    for (const [operation, args] of cases) {
      try { await relayOperation(process.cwd(), operation, args, { err() {} }); results.push(null); }
      catch (error) { results.push(error.code ?? error.name); }
    }
    console.log(JSON.stringify({ results }));
  `);
  assert.equal(personResult.code, 0, 'the real private CLI environment runs every person-only operation');
  assert.deepEqual(personResult.document.results, personCases.map(() => 'HUMAN_REQUIRED'),
    `each person-only action is refused before asking an unreachable relay; observed requests: ${JSON.stringify(arrivals)}`);
  assert.deepEqual(arrivals, [], 'no person-only operation reaches the relay');
});
