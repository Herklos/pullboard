/** @pullboard-test-loads src/board.js src/engine.js src/exchange.js */
/** Two independent Git/SQLite replicas derive verdict freshness without rewriting proof [E8]. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import * as store from '../src/board.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { applyEngineMove, prepareEngineMove } from '../src/engine.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { serveApi } from '../src/api.js';
import { main } from '../src/cli.js';
import { fetchFresh } from './http-fixture.js';
import { relaySnapshot, presentationDigest } from '../src/relay-presentation.js';
import { snapshotState } from '../relay/browser-model.js';
import { unpackRelease } from './release-archive.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Open a fixture's independent board and always close it after its observation or public move. */
function withBoard(root, action) {
  const board = store.openBoard(join(root, '.git', 'pullboard', 'board.sqlite'));
  try { return action(board); }
  finally { store.closeBoard(board); }
}

/** Run a real fixture CLI command, retaining the refusal or successful document verbatim. */
function run(box, root, ...args) {
  const result = box.run(root, ...args);
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}${result.out}`);
  return result.out;
}

/** Occupy this fixture's actual gate until its stale re-review enters the ordinary queue. */
async function holdForReviewQueue(box) {
  const ready = join(box.dir, 'review-gate-held');
  const observed = join(box.dir, 'review-was-queued');
  const source = `
import {writeFileSync} from 'node:fs';
import {setTimeout as pause} from 'node:timers/promises';
import {takeResource,listResources} from ${JSON.stringify(new URL('../src/resources.js', import.meta.url).href)};
import {loadMachineSettings} from ${JSON.stringify(new URL('../src/settings.js', import.meta.url).href)};
const [root,ready,observed]=process.argv.slice(1);
const capacity=loadMachineSettings().gateSlots;
const leases=[];
let stopping=false;
process.once('SIGTERM',()=>{stopping=true;});
try {
  for(let i=0;i<capacity;i++) leases.push(await takeResource({name:'gate',capacity,scope:'machine',root,agent:'stale-review-fixture-holder',browser:false}));
  writeFileSync(ready,'all ordinary slots really held');
  const deadline=Date.now()+30_000;
  while(!stopping) {
    const gate=listResources({root}).find(entry=>entry.name==='gate');
    if(gate?.line.some(entry=>entry.item==='1'&&entry.kind==='review')) {writeFileSync(observed,'the real review waiter was observed');break;}
    if(Date.now()>=deadline) throw Error('the stale review never entered the actual private gate queue');
    await pause(20);
  }
} finally {for(const lease of leases.reverse()) lease.release();}
`;
  const holder = helpers.launch(box, box.repo, process.execPath, ['--input-type=module', '-e', source, box.repo, ready, observed]);
  const deadline = Date.now() + 10_000;
  try {
    while (!existsSync(ready)) {
      assert.equal(holder.exitCode, null, holder.failure ?? holder.stderrText);
      assert.ok(Date.now() < deadline, 'the real private gate holder becomes ready');
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
  } catch (error) {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGTERM');
    await holder.closed;
    throw error;
  }
  return { holder, observed };
}

test('a verdict reads stale when main moves under its files [E8]', { timeout: 120_000 }, async t => { // budget: hang ceiling for two real replicas, CLI checks and Git history; not a speed target.
  const box = helpers.project();
  assert.equal(helpers.commitFile(box, box.repo, 'web/feature.js', 'feature = 0\nmain = 0\n', 'feat(web): baseline [G1]').status, 0);
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const checkedHeads = join(box.dir, 'checked-heads');
  const check = `grep -q '^feature = 1$' web/feature.js && git rev-parse HEAD >> '${checkedHeads}'`;
  run(box, box.repo, 'add', 'web', 'Feature', '--specs', 'G1', '--check', check, '--wait');
  run(box, box.web, 'claim', '1');
  assert.equal(helpers.commitFile(box, box.web, 'web/feature.js', 'feature = 1\nmain = 0\n', 'feat(web): feature [G1]').status, 0);
  const submitted = box.git(box.web, 'rev-parse', 'HEAD');
  run(box, box.web, 'submit', '1');
  const reviewer = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, submitted);
  run(box, reviewer, 'join', 'web');
  run(box, reviewer, 'next', '--verify', '1');
  run(box, reviewer, 'verify', '1', 'accept', '--note', 'The feature changes its first line and the frozen check observes it.');
  assert.equal(withBoard(box.repo, board => store.getItem(board, 1)).item_review_by,
    withBoard(box.repo, board => store.getItem(board, 1)).item_verified_by,
    'the original reservation stays in history after acceptance; it is not a live review lease');
  const original = withBoard(box.repo, board => store.verdictsFor(board, 1));
  const mainEditor = join(box.dir, 'main-caller-editor');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', mainEditor, 'main');
  run(box, mainEditor, 'join', 'web');
  const peer = join(box.dir, 'replica');
  box.git(box.dir, 'clone', '-q', box.repo, peer);
  withBoard(peer, board => importBoard(board, withBoard(box.repo, exportBoard)));

  /** Move only the peer's Git trunk; its independently stored acceptance stays unchanged. */
  const syncTrunk = () => {
    box.git(peer, 'fetch', '-q', 'origin', 'main');
    box.git(peer, 'merge', '-q', '--ff-only', 'origin/main');
  };
  /** Read each replica through its actual public CLI, rather than a test-only freshness helper. */
  const items = () => [box.repo, peer].map(root => JSON.parse(run(box, root, 'show', '1', '--json')));
  let streamController;
  let streamReader;
  let builds = 0;
  const api = await serveApi({ runCommand: main, projects: () => [{ root: reviewer, name: 'Verdict fixture' }], onStateBuild: () => { builds += 1; } });
  t.after(async () => {
    streamController?.abort();
    await streamReader?.cancel().catch(() => {});
    await api.close();
  });
  const address = new URL(api.url);
  const headers = { 'x-pullboard-key': address.searchParams.get('k') };
  const apiPath = '/api/v1/boards/' + withBoard(box.repo, store.boardId);
  /** Read one authenticated public HTTP endpoint on the persistent worktree-backed server. */
  const http = async suffix => {
    const response = await fetchFresh(address.origin + apiPath + suffix, { headers });
    const document = await response.json();
    assert.equal(response.status, 200, JSON.stringify(document));
    return document;
  };
  const initialState = (await http('/state')).state;
  const phoneBefore = relaySnapshot(reviewer);
  await http('/state');
  assert.equal(builds, 1, 'unchanged HTTP reads reuse the state cache');
  await http('/items/1'); // Warm the independent detail freshness projection for a verified item.
  const processMethods = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync'];
  const originals = new Map(processMethods.map(method => [method, childProcess[method]]));
  const processCalls = [];
  try {
    for (const method of processMethods) childProcess[method] = function (...args) {
      processCalls.push({ method, command: args[0] });
      return Reflect.apply(originals.get(method), this, args);
    };
    syncBuiltinESMExports();
    await http('/items/1');
    await http('/state');
    await http('/items/1');
    relaySnapshot(reviewer);
    relaySnapshot(reviewer);
    assert.deepEqual(processCalls, [], 'unchanged accepted-item detail, state and sealed phone snapshot reads spawn no process');
  } finally {
    for (const [method, original] of originals) childProcess[method] = original;
    syncBuiltinESMExports();
  }

  assert.ok(items().every(item => !item.item_verdict_state));
  assert.equal(helpers.commitFile(box, mainEditor, 'web/unrelated.js', 'unrelated = 1\n', 'feat(web): unrelated [G1]').status, 0);
  box.git(box.repo, 'merge', '-q', '--no-ff', box.git(mainEditor, 'rev-parse', 'HEAD'), '-m', 'chore(merge): unrelated main change [G1]');
  syncTrunk();
  assert.ok(items().every(item => !item.item_verdict_state), 'unrelated main files do not stale acceptance');
  assert.equal((await http('/state')).state.items[0].verdictState, undefined);
  const beforeMoveHead = box.git(reviewer, 'rev-parse', 'HEAD');
  streamController = new AbortController();
  const stream = await fetchFresh(address.origin + apiPath + '/events?after=' + initialState.sequence, {
    headers: { ...headers, accept: 'text/event-stream' }, signal: streamController.signal,
  });
  assert.equal(stream.status, 200);
  streamReader = stream.body.getReader();
  box.git(mainEditor, 'merge', '-q', '--ff-only', 'main');
  assert.equal(helpers.commitFile(box, mainEditor, 'web/feature.js', 'feature = 0\nmain = 1\n', 'feat(web): change main caller [G1]').status, 0);
  box.git(box.repo, 'merge', '-q', '--no-ff', box.git(mainEditor, 'rev-parse', 'HEAD'), '-m', 'chore(merge): change main caller [G1]');
  const movingCommit = box.git(box.repo, 'rev-parse', 'HEAD');
  syncTrunk();
  for (const item of items()) {
    assert.equal(item.item_verdict_state?.code, 'STALE_VERDICT');
    assert.equal(item.item_verdict_state.file, 'web/feature.js');
    assert.equal(item.item_verdict_state.commit, movingCommit);
    assert.equal(item.item_verdict, 'ACCEPT', 'the historical acceptance remains a fact');
  }
  assert.equal(box.git(reviewer, 'rev-parse', 'HEAD'), beforeMoveHead, 'the served worktree HEAD stayed fixed while main moved');
  const apiStale = (await http('/state')).state;
  assert.equal(apiStale.sequence, initialState.sequence, 'Git movement needs no board event to invalidate the state cache');
  assert.equal(apiStale.items[0].verdictState?.code, 'STALE_VERDICT');
  assert.equal(apiStale.items[0].verdictState.commit, movingCommit);
  const coldGit = [];
  const originalSpawn = childProcess.spawnSync;
  let phoneStale;
  try {
    childProcess.spawnSync = function (...args) {
      if (args[0] === 'git') coldGit.push(args[1]);
      return Reflect.apply(originalSpawn, this, args);
    };
    syncBuiltinESMExports();
    phoneStale = relaySnapshot(reviewer);
  } finally { childProcess.spawnSync = originalSpawn; syncBuiltinESMExports(); }
  assert.ok(coldGit.filter(args => args.includes('diff')).length <= 1,
    'unrelated main history must not start one file-diff process per commit: ' + JSON.stringify(coldGit));
  const phoneState = snapshotState(phoneStale, withBoard(box.repo, store.boardId));
  assert.equal(phoneState.items[0].verdictState?.commit, movingCommit, 'the sealed phone snapshot carries the same stale verdict at fixed served HEAD');
  assert.notEqual(presentationDigest(phoneBefore.presentation), presentationDigest(phoneStale.presentation), 'Git-only freshness changes cause a new sealed presentation');

  assert.equal((await http('/items/1')).item.verdictState?.commit, movingCommit);
  const streamDeadline = setTimeout(() => streamController.abort(new Error('trunk movement produced no live changed event')), 5_000); // budget: hang ceiling for a fixture-local change notification; no throughput claim.
  try {
    let buffered = '';
    while (!/event: changed\n/u.test(buffered)) {
      const { value, done } = await streamReader.read();
      assert.equal(done, false, 'the live stream stays open through the trunk change');
      buffered += new TextDecoder().decode(value);
    }
  } finally { clearTimeout(streamDeadline); }
  streamController.abort();
  await streamReader.cancel().catch(() => {});
  for (const root of [box.repo, peer]) {
    assert.match(run(box, root, 'show', '1'), /STALE_VERDICT/u);
    assert.equal(JSON.parse(run(box, root, 'list', '--all', '--json')).items[0].item_verdict_state?.commit, movingCommit);
    const resume = JSON.parse(run(box, root, 'resume', '--json'));
    assert.equal(resume.all[0].item_verdict_state?.commit, movingCommit);
    assert.deepEqual(resume.toMerge, [], 'resume never suggests landing a stale acceptance');
    assert.equal(resume.staleVerdicts[0].item_id, 1);
    assert.deepEqual(withBoard(root, board => store.verdictsFor(board, 1)), original, 'read projection cannot rewrite original proof');
    const refused = box.run(root, 'land', '--dry-run', '--json');
    assert.equal(refused.code, 1, refused.out + refused.err);
    const error = JSON.parse(refused.out).error;
    assert.equal(error.code, 'STALE_VERDICT');
    assert.ok(error.message.includes('web/feature.js') && error.message.includes(movingCommit), error.message);
  }
  box.git(box.repo, 'revert', '-m', '1', '--no-edit', movingCommit);
  syncTrunk();
  assert.ok(items().every(item => item.item_verdict_state?.commit === movingCommit), 'a revert cannot turn an old review into a new review');
  const priorChecks = readFileSync(checkedHeads, 'utf8');
  const oldHead = box.run(reviewer, 'verify', '1', 'accept', '--note', 'Trying the old candidate is insufficient.');
  assert.equal(oldHead.code, 1);
  assert.equal(readFileSync(checkedHeads, 'utf8'), priorChecks, 'old candidate is refused before running its check');
  box.git(reviewer, 'merge', '-q', '--no-edit', 'main');
  const composed = box.git(reviewer, 'rev-parse', 'HEAD');
  assert.notEqual(composed, submitted);
  const { holder, observed } = await holdForReviewQueue(box);
  let landingGuidance;
  try {
    landingGuidance = run(box, reviewer, 'verify', '1', 'accept', '--note', 'Re-reviewed the feature with the latest main caller and its reverted history.');
    assert.ok(existsSync(observed), 'the same prior reviewer really waited behind occupied fixture gate capacity');
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGTERM');
    const result = await holder.closed;
    assert.equal(result.code, 0, holder.failure ?? holder.stderrText);
  }
  assert.ok(landingGuidance.includes('git merge --no-ff ' + composed), 'the new-main manual landing hint names the checked composition, not the original submission');
  assert.equal(readFileSync(checkedHeads, 'utf8').trim().split('\n').at(-1), composed, 'the frozen check ran on the reviewed composition');
  const reviewed = withBoard(box.repo, board => store.verdictsFor(board, 1));
  assert.deepEqual(reviewed.slice(0, original.length), original);
  assert.equal(reviewed.length, original.length + 1, 're-review appends independent proof');
  const verdict = reviewed.at(-1);
  const outcome = withBoard(peer, board => {
    const move = prepareEngineMove(board, 'verify', [1, {
      agentId: verdict.verdict_by, decision: 'ACCEPT', note: verdict.verdict_note,
      head: verdict.verdict_head, digest: verdict.verdict_digest, policy: 'any',
      check: verdict.check, review: verdict.review,
    }]);
    return applyEngineMove(board, move, { sequence: 1, at: verdict.verdict_at });
  });
  assert.equal(outcome.error, undefined, JSON.stringify(outcome));
  const reviewPin = `refs/pullboard/items/1/${composed.slice(0, 12)}`;
  assert.equal(box.git(box.repo, 'rev-parse', reviewPin), composed, 'the checked commit is pinned durably for other replicas to fetch');
  assert.equal(items()[1].item_verdict_state?.code, 'STALE_VERDICT', 'a replica without the checked Git objects fails closed');
  const peerBoardId = withBoard(peer, store.boardId);
  assert.equal(snapshotState(relaySnapshot(peer), peerBoardId).items[0].verdictState?.code, 'STALE_VERDICT',
    'a sealed phone presentation also fails closed until the reviewed objects arrive');
  const peerApi = await serveApi({ runCommand: main, projects: () => [{ root: peer, name: 'Peer verdict fixture' }] });
  t.after(() => peerApi.close());
  const peerAddress = new URL(peerApi.url);
  /** Keep this peer's server alive across an object-only fetch without a board write. */
  const peerHttp = async suffix => {
    const response = await fetchFresh(peerAddress.origin + apiPath + suffix,
      { headers: { 'x-pullboard-key': peerAddress.searchParams.get('k') } });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await peerHttp('/state')).state.items[0].verdictState?.code, 'STALE_VERDICT');
  assert.equal((await peerHttp('/items/1')).item.verdictState?.code, 'STALE_VERDICT');
  box.git(peer, 'fetch', '-q', 'origin', reviewPin);
  assert.equal((await peerHttp('/items/1')).item.verdictState, undefined,
    'an object-only fetch clears a cached unavailable HTTP detail');
  assert.equal((await peerHttp('/state')).state.items[0].verdictState, undefined,
    'an object-only fetch clears a cached unavailable HTTP state');
  assert.equal(snapshotState(relaySnapshot(peer), peerBoardId).items[0].verdictState, undefined,
    'fetching the exact reviewed objects clears the sealed phone presentation without another board event or main move');
  assert.ok(items().every(item => !item.item_verdict_state), 'the same sealed re-review clears both replicas');
  assert.equal((await http('/state')).state.items[0].verdictState, undefined, 'a newer acceptance invalidates stale cached state');
  assert.equal((await http('/items/1')).item.verdictState, undefined);
  assert.equal(snapshotState(relaySnapshot(reviewer), withBoard(box.repo, store.boardId)).items[0].verdictState, undefined, 'the sealed phone presentation clears after the checked re-review');
  assert.deepEqual(withBoard(peer, board => store.verdictsFor(board, 1)), reviewed);
  box.git(box.repo, 'merge', '-q', '--no-edit', composed);
  syncTrunk();
  const landed = box.git(box.repo, 'rev-parse', 'HEAD');
  for (const root of [box.repo, peer]) withBoard(root, board => store.merged(board, 1, { agentId: 'coordinator', commit: landed }));
  assert.equal(helpers.commitFile(box, box.repo, 'web/feature.js', 'feature = 1\nmain = 2\n', 'feat(web): after landing [G1]').status, 0);
  syncTrunk();
  assert.ok(items().every(item => !item.item_verdict_state), 'landed items are not waiting for re-review');
  assert.ok(existsSync(join(peer, '.git', 'pullboard', 'board.sqlite')));
});


test('a checkout or trunk moving during verification cannot acquire proof [E8]', () => {
  const box = helpers.project();
  const reviewer = join(box.dir, 'moving-reviewer');
  const moveHead = join(box.dir, 'move-review-head');
  const moveMain = join(box.dir, 'move-review-main');
  const baseline = box.git(box.repo, 'rev-parse', 'main');
  const check = `grep -q '^feature = 1$' web/feature.js && if test -f '${moveHead}'; then git -C '${reviewer}' checkout -q --detach '${baseline}'; fi && if test -f '${moveMain}'; then git -C '${box.repo}' commit -q --allow-empty -m 'chore: move review trunk [G1]'; fi`;
  run(box, box.repo, 'add', 'web', 'Moving review', '--specs', 'G1', '--check', check, '--wait');
  run(box, box.web, 'claim', '1');
  assert.equal(helpers.commitFile(box, box.web, 'web/feature.js', 'feature = 1\n', 'feat(web): moving review feature [G1]').status, 0);
  const submitted = box.git(box.web, 'rev-parse', 'HEAD');
  run(box, box.web, 'submit', '1');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, submitted);
  run(box, reviewer, 'join', 'web');
  writeFileSync(moveHead, 'armed');
  const moved = box.run(reviewer, 'verify', '1', 'accept', '--note', 'The check moved the live reviewer checkout.');
  assert.equal(moved.code, 1, moved.out + moved.err);
  assert.match(moved.err, /NOT_AT_COMMIT/u);
  assert.equal(box.git(reviewer, 'rev-parse', 'HEAD'), baseline, 'the actual checkout moved while its private check was running');
  assert.deepEqual(withBoard(box.repo, board => store.verdictsFor(board, 1)), []);
  rmSync(moveHead);
  box.git(reviewer, 'checkout', '-q', '--detach', submitted);
  writeFileSync(moveMain, 'armed');
  const mainMoved = box.run(reviewer, 'verify', '1', 'accept', '--note', 'The check moved the known main.');
  assert.equal(mainMoved.code, 1, mainMoved.out + mainMoved.err);
  assert.match(mainMoved.err, /VERDICT_TRUNK_MOVED/u);
  assert.notEqual(box.git(box.repo, 'rev-parse', 'main'), baseline);
  assert.deepEqual(withBoard(box.repo, board => store.verdictsFor(board, 1)), []);
  rmSync(moveMain);
  run(box, reviewer, 'verify', '1', 'accept', '--note', 'The candidate and known trunk stayed fixed through the complete frozen check.');
  assert.equal(withBoard(box.repo, board => store.verdictsFor(board, 1)).length, 1);
});


test('landing retains the exact repair that passed stale re-review [E8,V8,R3]', () => {
  const box = helpers.project();
  const source = (feature, expected) => `feature = ${feature}\n${'// independent caller line\n'.repeat(12)}expected = ${expected}\n`;
  assert.equal(helpers.commitFile(box, box.repo, 'web/feature.txt', source(0, 1), 'feat(web): baseline caller [G1]').status, 0);
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const check = `test "$(sed -n 's/^feature = //p' web/feature.txt)" = "$(sed -n 's/^expected = //p' web/feature.txt)"`;
  run(box, box.repo, 'add', 'web', 'Repair follows its review', '--specs', 'G1', '--check', check, '--wait');
  run(box, box.web, 'claim', '1');
  assert.equal(helpers.commitFile(box, box.web, 'web/feature.txt', source(1, 1), 'feat(web): original feature [G1]').status, 0);
  const submitted = box.git(box.web, 'rev-parse', 'HEAD');
  run(box, box.web, 'submit', '1');
  const reviewer = join(box.dir, 'repair-reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, submitted);
  run(box, reviewer, 'join', 'web');
  run(box, reviewer, 'verify', '1', 'accept', '--note', 'The original feature matches the original caller.');
  const original = withBoard(box.repo, board => store.verdictsFor(board, 1));
  assert.equal(helpers.commitFile(box, box.repo, 'web/feature.txt', source(0, 2), 'feat(web): caller now requires two [G1]').status, 0);
  assert.equal(JSON.parse(run(box, box.repo, 'show', '1', '--json')).item_verdict_state?.code, 'STALE_VERDICT');
  box.git(reviewer, 'merge', '-q', '--no-edit', 'main');
  assert.equal(helpers.commitFile(box, reviewer, 'web/feature.txt', source(2, 2), 'feat(web): repair against the new caller [G1]').status, 0);
  assert.equal(helpers.commitFile(box, reviewer, 'web/repair.txt', 'ready\n', 'feat(web): add the repair companion [G1]').status, 0);
  const checked = box.git(reviewer, 'rev-parse', 'HEAD');
  run(box, reviewer, 'verify', '1', 'accept', '--note', 'The repaired composition matches the new caller; the original feature does not.');
  const reviewed = withBoard(box.repo, board => store.verdictsFor(board, 1));
  assert.deepEqual(reviewed.slice(0, original.length), original);
  assert.equal(reviewed.at(-1).verdict_head, checked);
  const probe = join(box.dir, 'repair-path-replica');
  box.git(box.dir, 'clone', '-q', box.repo, probe);
  withBoard(probe, board => importBoard(board, withBoard(box.repo, exportBoard)));
  box.git(probe, 'fetch', '-q', 'origin', `refs/pullboard/items/1/${checked.slice(0, 12)}`);
  assert.equal(helpers.commitFile(box, probe, 'web/repair.txt', 'main changed the repair\n', 'feat(web): main changes a repair file [G1]').status, 0);
  const changedRepair = JSON.parse(run(box, probe, 'show', '1', '--json'));
  assert.equal(changedRepair.item_verdict_state?.file, 'web/repair.txt', 'a file introduced by the checked repair must participate in later freshness');

  const remote = join(box.dir, 'landing-remote.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  const landed = JSON.parse(run(box, box.repo, 'land', '--json'));
  assert.deepEqual(landed.landed, [1], JSON.stringify(landed));
  assert.equal(box.git(box.repo, 'show', landed.batch.tip + ':web/feature.txt'), source(2, 2).trim(), 'landing must retain the exact repaired file that passed the frozen check');
  assert.equal(box.git(box.remote ?? remote, 'rev-parse', 'main'), landed.batch.tip);
  assert.equal(withBoard(box.repo, board => store.getItem(board, 1)).item_commit, submitted, 'the original submission remains the immutable item identity');
});

test('an older pushed landing shows stale checked proof and a correction path across public views [E8,H16,R3]',
  { timeout: 120_000 }, async t => { // budget: hang ceiling for real Git, private push and CLI verification; not a speed target.
    const box = helpers.project();
    assert.equal(helpers.commitFile(box, box.repo, 'web/feature.txt', 'feature = 0\n', 'feat(web): legacy landing base [G1]').status, 0);
    box.git(box.web, 'merge', '-q', '--ff-only', 'main');
    const base = box.git(box.repo, 'rev-parse', 'HEAD');
    run(box, box.repo, 'add', 'web', 'Legacy landing review', '--specs', 'G1', '--check', 'test -f web/feature.txt', '--wait');
    run(box, box.web, 'claim', '1');
    assert.equal(helpers.commitFile(box, box.web, 'web/feature.txt', 'feature = 1\n', 'feat(web): legacy pushed feature [G1]').status, 0);
    const submitted = box.git(box.web, 'rev-parse', 'HEAD');
    run(box, box.web, 'submit', '1');
    const reviewer = join(box.dir, 'legacy-landing-reviewer');
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, submitted);
    run(box, reviewer, 'join', 'web');
    run(box, reviewer, 'verify', '1', 'accept', '--note', 'The original submitted feature passed.');
    const remote = join(box.dir, 'legacy-landing-remote.git');
    box.git(box.dir, 'init', '-q', '--bare', remote);
    box.git(box.repo, 'remote', 'add', 'origin', remote);
    box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
    // The older coordinator pushed B; this replica's retained main still has A.
    box.git(box.web, 'push', '-q', 'origin', `${submitted}:refs/heads/main`);
    const entry = { id: 1, commit: submitted, merge: submitted };
    const batch = { version: 1, id: 'real-legacy-push', state: 'pushed', base, tip: submitted,
      branch: 'refs/heads/main', root: box.repo, owner: 'fixture', logPath: join(box.dir, 'landing.log'),
      candidates: [entry], items: [entry], revision: 0 };
    withBoard(box.repo, board => store.recordLandingBatch(board, { agentId: 'coordinator', batch }));
    const archived = join(box.dir, 'engine12');
    mkdirSync(archived);
    unpackRelease('59a6e2b286ee852add0d68a659f1a1e6b3257c44', archived);
    const oldStore = await import(pathToFileURL(join(archived, 'src/board.js')).href);
    const oldExchange = await import(pathToFileURL(join(archived, 'src/exchange.js')).href);
    const oldEngine = await import(pathToFileURL(join(archived, 'src/engine.js')).href);
    const old = oldStore.openBoard(join(box.dir, 'old.sqlite'));
    t.after(() => oldStore.closeBoard(old));
    oldExchange.importBoard(old, withBoard(box.repo, exportBoard));
    const finish = oldEngine.prepareEngineMove(old, 'finishLandingBatch', [{ agentId: 'coordinator', id: batch.id, tip: submitted }], { id: 'actual-legacy-in-flight-finish' });
    assert.equal(finish.engine, 12);

    assert.equal(helpers.commitFile(box, box.repo, 'web/feature.txt', 'feature = 2\n', 'feat(web): newer main requirement [G1]').status, 0);
    const conflict = box.tryGit(reviewer, 'merge', '-q', '--no-edit', 'main');
    assert.notEqual(conflict.status, 0, 'the older feature conflicts with this replica\'s newer requirement');
    assert.match(`${conflict.stdout ?? ''}${conflict.stderr ?? ''}`, /CONFLICT \(content\)/u);
    assert.equal(helpers.commitFile(box, reviewer, 'web/feature.txt', 'feature = 3\n', 'fix(web): checked correction composition [G1]').status, 0);
    const checked = box.git(reviewer, 'rev-parse', 'HEAD');
    run(box, reviewer, 'verify', '1', 'accept', '--note', 'The newer checked composition passed its frozen check.');
    const verdicts = withBoard(box.repo, board => store.verdictsFor(board, 1));
    const outcome = withBoard(box.repo, board => applyEngineMove(board, finish, { sequence: 1, at: '2026-10-17T20:00:00.000Z' }));
    assert.equal(outcome.error, undefined, JSON.stringify(outcome));
    assert.equal(box.git(remote, 'rev-parse', 'main'), submitted, 'the immutable receipt names the actual earlier private push');
    assert.equal(box.tryGit(box.repo, 'merge-base', '--is-ancestor', checked, 'main').status, 1, 'the newer checked composition has not landed');
    const item = JSON.parse(run(box, box.repo, 'show', '1', '--json'));
    assert.equal(item.item_merged_commit, submitted);
    assert.equal(item.item_verdict_state?.code, 'STALE_VERDICT');
    assert.equal(item.item_verdict_state?.landingCode, 'LAND_ITEM_MOVED');
    assert.equal(item.item_verdict_state?.checked, checked);
    const explanation = run(box, box.repo, 'show', '1');
    assert.match(explanation, /create a correction item/u);
    assert.match(explanation, new RegExp(checked));
    assert.doesNotMatch(explanation, /then another agent runs pullboard verify 1 accept/u);
    assert.deepEqual(withBoard(box.repo, board => store.verdictsFor(board, 1)), verdicts, 'presentation does not rewrite proof');
    const api = await serveApi({ runCommand: main, projects: () => [{ root: box.repo, name: 'Older landing fixture' }] });
    t.after(() => api.close());
    const address = new URL(api.url);
    const detail = await fetchFresh(address.origin + '/api/v1/boards/' + withBoard(box.repo, store.boardId) + '/items/1',
      { headers: { 'x-pullboard-key': address.searchParams.get('k') } });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).item.verdictState?.landingCode, 'LAND_ITEM_MOVED');
    assert.equal(snapshotState(relaySnapshot(box.repo), withBoard(box.repo, store.boardId)).items[0].verdictState?.landingCode, 'LAND_ITEM_MOVED');
    const missing = join(box.dir, 'legacy-landing-missing-objects');
    box.git(box.dir, 'clone', '-q', '--no-local', box.repo, missing);
    assert.notEqual(box.tryGit(missing, 'cat-file', '-e', checked).status, 0, 'this independent clone has not fetched the checked composition');
    withBoard(missing, board => importBoard(board, withBoard(box.repo, exportBoard)));
    const unavailable = JSON.parse(run(box, missing, 'show', '1', '--json'));
    assert.equal(unavailable.item_verdict_state?.landingCode, 'LAND_ITEM_MOVED');
    assert.equal(unavailable.item_verdict_state?.checked, checked);
    assert.match(run(box, missing, 'show', '1'), /create a correction item/u,
      'missing reviewed objects must never suggest re-reviewing an immutable landing');
    const refused = box.run(reviewer, 'verify', '1', 'accept', '--note', 'Cannot rewrite the original landing.');
    assert.equal(refused.code, 1);
    assert.match(refused.err, /NOT_SUBMITTED|ALREADY_MERGED/u, 'the existing merged-receipt guards stay in force');
    box.git(box.repo, 'merge', '-q', '--no-edit', checked);
    assert.equal(JSON.parse(run(box, box.repo, 'show', '1', '--json')).item_verdict_state, undefined,
      'a later correction containing the checked composition clears the derived warning without rewriting the old landing');
    assert.equal(withBoard(box.repo, board => store.getItem(board, 1)).item_merged_commit, submitted);
  });
