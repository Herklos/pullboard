/** The view uses the actual device authorization and all-board linking path without a terminal [H5,N26]. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import * as setup from '../src/relay-setup.js';
import { relayClientFixture } from './relay-client-fixture.js';
import { runFixtureChild, startFixtureChild } from './fixture-child.js';

/** Run the public view adapter in a process whose complete home, registry and boards are private. */
async function viewScenario(box, mode) {
  const setupModule = pathToFileURL(resolve(import.meta.dirname, '../src/relay-setup.js')).href;
  const relayModule = pathToFileURL(resolve(import.meta.dirname, '../src/relay.js')).href;
  const cliModule = pathToFileURL(resolve(import.meta.dirname, '../src/cli.js')).href;
  const fixtureModule = pathToFileURL(resolve(import.meta.dirname, 'fixture-child.js')).href;
  const machineModule = pathToFileURL(resolve(import.meta.dirname, '../src/relay-machine.js')).href;
  return box.script(`
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as setup from ${JSON.stringify(setupModule)};
import { relayLinkAvailability } from ${JSON.stringify(relayModule)};
import { main } from ${JSON.stringify(cliModule)};
import { runFixtureGit } from ${JSON.stringify(fixtureModule)};
import { updateRelayMachine } from ${JSON.stringify(machineModule)};
const root = ${JSON.stringify(box.root)};
const relayUrl = ${JSON.stringify(box.origin)};
const mode = ${JSON.stringify(mode)};
const shouldLink = ['linked','pairing-cleanup-refused','excluded'].includes(mode);
const expectedLinked = mode === 'excluded' ? 1 : 2;
const other = join(dirname(root), 'second-view-board');
mkdirSync(other);
for (const args of [['init','-q','-b','main'], ['-c','commit.gpgsign=false','commit','--allow-empty','-q','-m','chore: private view board'],
  ['remote','add','origin','git@github.com:fixture/repository.git']]) runFixtureGit(args, {cwd:other,env:process.env});
const quiet = {cwd:other,stdin:process.stdin,stdout:{isTTY:false,write(){}},stderr:{write(){}}};
assert.equal(await main(['init','--json'], quiet), 0, 'the second board is registered through the production CLI');
const links = [root,other].map(repo => join(repo,'.git','pullboard','relay.json'));
for (const repo of [root,other]) assert.deepEqual(relayLinkAvailability(repo),{linked:false,unlinking:false});
if (mode === 'excluded') updateRelayMachine(state => { state.excluded.push(other); });
let intentId;
let linkingCancelRefused = false;
let releasePairingDelete;
let pairingDeleteStarted = false;
let holdPairingDelete = mode === 'linked';
let releaseDeviceCancel;
let deviceCancelStarted = false;
let holdDeviceCancel = true;
let corruptInstructions = ['invalid-url','cleanup-refused'].includes(mode);
const originalFetch = globalThis.fetch;
const starting = new AbortController();
globalThis.fetch = async (input, options) => {
  const address = new URL(input instanceof Request ? input.url : input);
  if (mode === 'abort-start' && address.pathname === '/auth/device/start') {
    starting.abort();
    throw new DOMException('private start aborted', 'AbortError');
  }
  if (shouldLink && address.pathname === '/auth/boards/link' && !linkingCancelRefused) {
    assert.equal(setup.viewSignInStatus(intentId).state, 'linking');
    await assert.rejects(setup.cancelViewSignIn(intentId), {code:'VIEW_SIGN_IN_LINKING'});
    linkingCancelRefused = true;
  }
  if (holdPairingDelete && options?.method === 'DELETE' && address.pathname.startsWith('/api/v1/devices/enrollments/')) {
    pairingDeleteStarted = true;
    await new Promise(resolve => { releasePairingDelete = resolve; });
  }
  if (corruptInstructions && address.pathname === '/auth/device/start') {
    const response = await originalFetch(input,options);
    const body = await response.json();
    body.verificationURL = 'https://example.invalid/login/device';
    return new Response(JSON.stringify(body),{status:response.status,headers:response.headers});
  }
  if (corruptInstructions && holdDeviceCancel && address.pathname === '/auth/device/cancel') {
    deviceCancelStarted = true;
    await new Promise(resolve => { releaseDeviceCancel = resolve; });
    if (mode === 'cleanup-refused') return new Response(JSON.stringify({version:1,cancelled:false}),{status:200});
  }
  if (mode === 'pairing-cleanup-refused' && options?.method === 'DELETE'
    && address.pathname.startsWith('/api/v1/devices/enrollments/')) {
    return new Response(JSON.stringify({version:1,error:{code:'UNAVAILABLE',message:'private cleanup unavailable'}}),{status:503});
  }
  return originalFetch(input,options);
};
/** Await a state transition; this is a hang ceiling, never a performance assertion. */
async function until(read) {
  const deadline = Date.now()+20000;
  do {
    const found = read();
    if (found) return found;
    await new Promise(done => setTimeout(done,25));
  } while (Date.now()<deadline);
  assert.fail('the private view operation did not reach its expected state');
}
/** Scan private fixture files in bounded chunks; no session or device ticket belongs on disk. */
function containsPersonMaterial(directory) {
  for (const entry of readdirSync(directory,{withFileTypes:true})) {
    const path = join(directory,entry.name);
    if (entry.isDirectory()) { if (containsPersonMaterial(path)) return true; continue; }
    if (!entry.isFile()) continue;
    const fd = openSync(path,'r');
    const chunk = Buffer.alloc(65536);
    let tail = '';
    try {
      let length;
      while ((length=readSync(fd,chunk,0,chunk.length,null))) {
        const text = tail+chunk.subarray(0,length).toString('latin1');
        if (/(?:ps_|pd_|pg_)[A-Za-z0-9_-]{43}/u.test(text)) return true;
        tail = text.slice(-96);
      }
    } finally { closeSync(fd); }
  }
  return false;
}
try {
  if (corruptInstructions) {
    let settled = false;
    const pending = setup.startViewSignIn({relayUrl}).then(
      () => { settled = true; assert.fail('foreign provider instructions must be refused'); },
      error => { settled = true; return error; });
    try {
      await until(() => deviceCancelStarted);
      assert.equal(settled,false,'the error must wait for real ticket cleanup');
      assert.equal(links.some(existsSync),false);
    } finally { holdDeviceCancel = false; releaseDeviceCancel?.(); }
    const error = await pending;
    assert.equal(error.code,mode === 'cleanup-refused' ? 'OAUTH_CLEANUP' : 'VIEW_SIGN_IN_RESPONSE');
    corruptInstructions = false;
    const recovery = await setup.startViewSignIn({relayUrl});
    intentId = recovery.intentId;
    const cancelled = await setup.cancelViewSignIn(intentId);
    assert.equal(cancelled.state,'cancelled','finished failed startup does not leave a busy view');
    assert.equal(links.some(existsSync),false);
    assert.equal(containsPersonMaterial(dirname(root)),false);
    process.stdout.write(JSON.stringify({state:error.code,linked:0,storedPersonMaterial:false}));
  } else if (mode === 'abort-start') {
    await assert.rejects(setup.startViewSignIn({relayUrl,signal:starting.signal}), {code:'OAUTH_CANCELLED'});
    assert.equal(links.some(existsSync),false,'a cancelled start does not link a board');
    assert.equal(containsPersonMaterial(dirname(root)),false,'no private session or ticket is saved');
    process.stdout.write(JSON.stringify({state:'cancelled',linked:0,storedPersonMaterial:false}));
  } else {
    const instructions = await setup.startViewSignIn({relayUrl});
    intentId = instructions.intentId;
    assert.deepEqual(Object.keys(instructions).sort(),['expiresAt','intentId','userCode','verificationURL']);
    assert.equal(new URL(instructions.verificationURL).pathname,'/login/device');
    assert.equal(instructions.userCode,'TEST-ONLY');
    assert.equal(setup.viewSignInStatus(intentId).state,'waiting');
    await assert.rejects(setup.startViewSignIn({relayUrl}),{code:'VIEW_SIGN_IN_BUSY'});
    let final;
    if (mode === 'cancel') {
      final = await setup.cancelViewSignIn(intentId);
      assert.equal(final.state,'cancelled');
    } else if (shouldLink) {
      const pairing = await until(() => setup.viewSignInStatus(intentId).state === 'pairing');
      assert.equal(pairing,true);
      const publicStatus = setup.viewSignInStatus(intentId);
      assert.equal(publicStatus.boards.length,2);
      if (mode === 'excluded') {
        assert.equal(publicStatus.boards.find(board => board.root === root)?.outcome,'linked');
        const skipped = publicStatus.boards.find(board => board.root === other);
        assert.equal(skipped?.outcome,'skipped','an excluded registered board still has an explicit result');
        assert.match(skipped.reason,/Excluded from automatic linking/u);
      } else assert.ok(publicStatus.boards.every(board => board.outcome === 'linked'));
      assert.ok(!JSON.stringify(publicStatus).includes('#device='),'public status never contains the pairing capability');
      assert.ok(!/(?:ps_|pd_|pg_)[A-Za-z0-9_-]{43}/u.test(JSON.stringify(publicStatus)));
      const navigation = setup.viewSignInPairingNavigation(intentId);
      assert.equal(new URL(navigation.url).origin,relayUrl);
      assert.ok(new URL(navigation.url).hash.startsWith('#device='),'only the trusted view redirect accessor returns pairing navigation');
      assert.equal(linkingCancelRefused,true,'linking finishes as one batch despite a cancel request');
      const cancellation = setup.cancelViewSignIn(intentId);
      try {
        if (mode === 'linked') {
          await until(() => pairingDeleteStarted);
          assert.equal(setup.viewSignInStatus(intentId).state,'pairing','cleanup has not completed yet');
          assert.throws(() => setup.viewSignInPairingNavigation(intentId),{code:'VIEW_PAIRING_NOT_READY'},
            'navigation is revoked while the real enrollment deletion is still pending');
        }
      } finally { releasePairingDelete?.(); }
      final = await cancellation;
      assert.equal(final.state,'pairing-stopped');
      assert.equal(final.pairingCleanup,mode === 'pairing-cleanup-refused' ? 'unconfirmed' : 'confirmed');
      if (mode === 'pairing-cleanup-refused') assert.equal(final.error.code,'VIEW_PAIRING_CLEANUP',
        'unconfirmed remote deletion remains visible to the user');
      assert.equal(final.boards.filter(board => board.outcome === 'linked').length,expectedLinked);
      for (const repo of [root,other]) assert.deepEqual(relayLinkAvailability(repo),{linked:!(mode === 'excluded' && repo === other),unlinking:false});
      const saved = readFileSync(links[0],'utf8');
      try {
        writeFileSync(links[0],JSON.stringify({...JSON.parse(saved),unlinking:true}));
        assert.deepEqual(relayLinkAvailability(root),{linked:false,unlinking:true},
          'the lightweight read preserves pending unlink cleanup eligibility');
      } finally { writeFileSync(links[0],saved); }
      assert.throws(() => setup.viewSignInPairingNavigation(intentId),{code:'VIEW_PAIRING_NOT_READY'});
    } else {
      final = await until(() => {
        const status=setup.viewSignInStatus(intentId);
        return ['declined','expired','done'].includes(status.state) ? status : null;
      });
      assert.equal(final.state,mode);
    }
    const linked = links.filter(existsSync).length;
    assert.equal(linked,shouldLink ? expectedLinked : 0,'only confirmed sign-in may link eligible boards');
    assert.equal(containsPersonMaterial(dirname(root)),false,'neither the person session nor the relay ticket is written to any fixture file');
    process.stdout.write(JSON.stringify({state:final.state,linked,storedPersonMaterial:false}));
  }
} finally {
  holdPairingDelete = false;
  releasePairingDelete?.();
  holdDeviceCancel = false;
  releaseDeviceCancel?.();
  if (intentId) await setup.cancelViewSignIn(intentId);
  globalThis.fetch = originalFetch;
}
`);
}

test("the view's sign-in links every board without a terminal or a stored session [H5,N26]", async (t) => {
  assert.equal(typeof setup.startViewSignIn, 'function', 'core exposes a view sign-in adapter');
  assert.equal(typeof setup.viewSignInStatus, 'function');
  assert.equal(typeof setup.cancelViewSignIn, 'function');
  for (const mode of ['linked', 'cancel', 'declined', 'expired', 'abort-start', 'invalid-url', 'cleanup-refused', 'pairing-cleanup-refused', 'excluded']) {
    await t.test(mode, async (t) => {
      const box = await relayClientFixture(t);
      box.providerState.deviceAuthorized = ['linked','pairing-cleanup-refused','excluded'].includes(mode);
      box.providerState.deviceDeclined = mode === 'declined';
      box.providerState.deviceExpired = mode === 'expired';
      const before = box.providerCalls.filter(call => call.path === '/login/device/code').length;
      const result = await viewScenario(box, mode);
      assert.equal(result.code, 0, result.failure ?? 'the private view scenario failed');
      const outcome = result.document;
      assert.equal(outcome.linked, ['linked','pairing-cleanup-refused','excluded'].includes(mode) ? (mode === 'excluded' ? 1 : 2) : 0);
      assert.equal(outcome.storedPersonMaterial, false);
      const after = box.providerCalls.filter(call => call.path === '/login/device/code').length;
      assert.equal(after - before, mode === 'abort-start' ? 0 : ['invalid-url','cleanup-refused'].includes(mode) ? 2 : 1, 'one device sign-in serves each attempt, including explicit recovery after invalid instructions');
    });
  }
});

/** Run the production CLI in plain words, with a finite hang ceiling and stdout kept as text. */
function plainCommand(root, env, args) {
  const child = startFixtureChild(process.execPath, [resolve(import.meta.dirname, '../bin/pullboard.js'), ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', value => { output.stdout += value; });
  child.stderr.setEncoding('utf8').on('data', value => { output.stderr += value; });
  const done = new Promise((resolveResult, reject) => {
    child.once('error', reject);
    child.once('close', code => resolveResult({ code, ...output }));
  });
  return { child, output, done };
}

test('relay on --all says who signed in, what it linked and what it waits for [H5,I1]', async (t) => {
  const box = await relayClientFixture(t);
  const second = join(dirname(box.root), 'second-board');
  mkdirSync(second);
  for (const args of [['init', '-q', '-b', 'main'], ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'fixture base'],
    ['remote', 'add', 'origin', 'git@github.com:fixture/repository.git']]) {
    assert.equal(runFixtureChild('git', args, { cwd: second, env: box.env }).status, 0);
  }
  assert.equal(runFixtureChild(process.execPath, [resolve(import.meta.dirname, '../bin/pullboard.js'), 'init', '--json'], { cwd: second, env: box.env }).status, 0,
    'the second board registers through the actual init command');
  const setup = plainCommand(box.root, box.env, ['relay', 'on', '--all', '--url', box.origin]);
  t.after(async () => { if (setup.child.exitCode === null) setup.child.kill('SIGTERM'); await setup.done; });
  const deadline = Date.now() + 20_000; // budget: hang ceiling for the loopback sign-in, two links and the first pairing poll.
  // Every pairing line is written before the first enrollment poll, so that poll marks the wait.
  while (!box.calls.some(call => call.method === 'GET' && call.path.startsWith('/api/v1/devices/enrollments/'))) {
    assert.ok(Date.now() < deadline && setup.child.exitCode === null, 'relay on --all reaches its pairing wait');
    await new Promise(done => setTimeout(done, 25));
  }
  setup.child.kill('SIGINT');
  const finished = await setup.done;
  assert.equal(finished.code, 0, 'Ctrl-C during the pairing wait keeps the links and exits cleanly');
  const waiting = finished.stdout.split('Boards linked; phone pairing stopped.')[0];
  const lines = waiting.split('\n');
  assert.ok(lines.includes('Signed in to GitHub as fixture-user.'), 'it names the GitHub account it signed in as');
  assert.ok(lines.includes('Linked repo.') && lines.includes('Linked second-board.'), 'it names each board it linked');
  assert.ok(lines.includes('Linked 2 of 2 registered boards.'), 'it says how many registered boards it linked');
  assert.ok(lines.includes('Now waiting for a phone to pair. On your phone, scan the code below or open this link.'), 'it says what it waits for');
  const pairLink = lines.find(line => line.startsWith('Pair your phone once: '));
  assert.match(pairLink ?? '', /^Pair your phone once: http:\/\/127\.0\.0\.1:\d+\/#device=/u, 'it gives the pairing link beside the code');
  assert.match(waiting, /^To skip pairing, press Ctrl-C\. The linked boards stay linked, and pullboard relay on --all gives a fresh code later\./mu,
    'it says how to skip the wait');
  assert.ok(lines.indexOf('Signed in to GitHub as fixture-user.') < lines.indexOf('Linked repo.')
    && lines.indexOf('Linked 2 of 2 registered boards.') < lines.indexOf('Now waiting for a phone to pair. On your phone, scan the code below or open this link.'),
    'it says each step in the order it happens');
  assert.doesNotMatch(finished.stdout + finished.stderr, /\b(?:ps|pm|pa|pd|pg)_[A-Za-z0-9_-]{20,}/u, 'no token or session is printed');
  assert.equal((finished.stdout.match(/#device=/gu) ?? []).length, 1, 'the pairing secret appears only in the one existing link');

  const board = JSON.parse(readFileSync(join(box.root, '.git/pullboard/relay.json'), 'utf8')).board;
  const status = plainCommand(box.root, box.env, ['relay']);
  const shown = await status.done;
  assert.equal(shown.code, 0, shown.stderr);
  const statusLine = shown.stdout.split('\n').find(line => line.startsWith('relay: ')) ?? '';
  assert.ok(statusLine.startsWith(`relay: repo (board ${board}) `), `relay status names the linked board: ${statusLine}`);
  assert.ok(statusLine.includes(' is linked for GitHub fixture-user; '), `relay status names the linked account: ${statusLine}`);
  assert.match(statusLine, /; sequence \d+; \d+ pending uploads$/u, 'relay status still gives the sequence and pending uploads');
});
