/** Coordinator landing batches retain exact Git and gate receipts across interruptions [B3,R3]. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import * as store from './board.js';
import { git, headCommit, headTree, isClean, mainCheckout, repoInfo, tryGit, untracked } from './git.js';
import { runGate, runProfiledShell, withGateSlot } from './gate.js';
import { laneOf } from './lanes.js';
import { Refused } from './refused.js';

/** Quote a command argument without allowing shell interpolation. */
function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

/** Hash a test's current bytes, so a real correction can unblock its held batch. */
function testHash(root, file) {
  try { return createHash('sha256').update(readFileSync(join(root, file))).digest('hex'); }
  catch { return null; }
}

/** Derive failing test identities from TAP names and source locations, refusing unknown paths. */
export function landingFailures(output, root) {
  const failures = [];
  let active = null;
  for (const line of output.split('\n')) {
    const failed = /^\s*not ok\s+\d+\s+-\s+(.*)$/u.exec(line);
    if (failed) {
      active = { name: failed[1].replace(/\s+#.*$/u, ''), file: null };
      failures.push(active);
      if (/^(?:\.\/)?(?:test|tests)\/[^\r\n]+\.(?:[cm]?js|ts|py)$/u.test(active.name)) active.file = active.name.replace(/^\.\//u, '');
    }
    const location = /^\s*location:\s*['"]?(.+?):\d+(?::\d+)?['"]?\s*$/u.exec(line);
    if (active && location) {
      const path = location[1];
      const file = isAbsolute(path) ? relative(root, path) : path.replace(/^\.\//u, '');
      if (file && !file.startsWith('../') && !file.includes('\\')) active.file = file;
    }
  }
  const unique = new Map(failures.map((entry) => [`${entry.file}\0${entry.name}`, entry]));
  return [...unique.values()];
}

/** Produce a hook-valid lower-case merge subject at a word boundary [R3]. */
export function landingSubject(item) {
  const suffix = item.item_spec_ids ? ` [${item.item_spec_ids.split(/[\s,]+/u).filter(Boolean).join(',')}]` : '';
  const prefix = 'chore(merge): ';
  const budget = 72 - prefix.length - suffix.length;
  if (budget < 1) throw new Refused('LAND_HEADER', `item #${item.item_id} cites too many rows for a merge header; shorten its cited set before landing`);
  const words = item.item_title.toLowerCase().replace(/[\p{Extended_Pictographic}\u200d\uFE0E\uFE0F]/gu, '').replace(/[\r\n]+/gu, ' ').replace(/\[[^\]]*\]/gu, '').trim().split(/\s+/u);
  let subject = '';
  for (const word of words) {
    if ((subject ? `${subject} ${word}` : word).length > budget) break;
    subject = subject ? `${subject} ${word}` : word;
  }
  if (!subject) subject = `item ${item.item_id}`.length <= budget ? `item ${item.item_id}` : String(item.item_id);
  if (subject.length > budget) throw new Refused('LAND_HEADER', `item #${item.item_id} has no title word that fits its merge header; shorten its cited set before landing`);
  return `${prefix}${subject.replace(/\.$/u, '')}${suffix}`;
}

/** Select verified, unmerged candidates in verdict order, retaining dependency order [B3,R3]. */
function candidates(board, root, base, maximum) {
  const all = store.listItems(board, { all: true });
  const pending = all.filter((item) => item.item_status === 'verified' && !item.item_merged_commit);
  const order = new Map();
  for (const event of store.events(board)) if (event.event_kind === 'accept') order.set(event.item_id, event.event_id);
  pending.sort((left, right) => (order.get(left.item_id) ?? Infinity) - (order.get(right.item_id) ?? Infinity) || left.item_id - right.item_id);
  const ready = [];
  const blocked = [];
  const knownReds = store.landingBatches(board).flatMap((batch) => batch.culprits ?? []);
  for (const item of pending) {
    const known = knownReds.find((entry) => entry.id === item.item_id && entry.commit === item.item_commit);
    if (known && !known.tests.every((failure) => store.landingWaiverFor(board, failure))) {
      blocked.push({ id: item.item_id, code: 'LAND_KNOWN_RED', tests: known.tests });
      continue;
    }
    const dependencies = (item.item_after || '').split(',').filter(Boolean).map(Number);
    if (dependencies.some((id) => !all.find((other) => other.item_id === id)?.item_merged_commit && !ready.some((other) => other.item_id === id))) continue;
    const stacked = store.unverifiedSubmissions(board).find((other) => other.item_id !== item.item_id
      && tryGit(root, ['merge-base', '--is-ancestor', other.item_commit, item.item_commit]).status === 0
      && tryGit(root, ['merge-base', '--is-ancestor', other.item_commit, base]).status !== 0);
    if (stacked) {
      blocked.push({ id: item.item_id, code: 'STACKED_UNVERIFIED', stacked: stacked.item_id });
      continue;
    }
    if (ready.length < maximum) ready.push(item);
  }
  return { ready, blocked };
}

/** Append a durable snapshot before or after each external side effect. */
async function save(state, patch) {
  const conflicts = [...new Map([...(state.batch.conflicts ?? []), ...(patch.conflicts ?? [])].map((entry) => [entry.id, entry])).values()];
  state.batch = await state.write('recordLandingBatch', [{ agentId: 'coordinator', batch: { ...state.batch, ...patch, conflicts }, revision: state.batch.revision ?? 0 }]);
  return state.batch;
}

/** Merge one ordered group from the immutable batch base, preserving each first-containing commit. */
async function mergeGroup(state, items) {
  const { batch } = state;
  if (!isClean(batch.root) || untracked(batch.root).length) throw new Refused('LAND_DIRTY', 'the landing worktree has unfinished edits; inspect its recorded path before adopting');
  git(batch.root, ['checkout', '--detach', batch.base]);
  const merged = [];
  const conflicts = [];
  for (const entry of items) {
    const item = store.getItem(state.board, entry.id ?? entry.item_id);
    if (item.item_status !== 'verified' || item.item_commit !== (entry.commit ?? item.item_commit)) throw new Refused('LAND_ITEM_MOVED', `item #${item.item_id} changed; rebuild the batch from current verified work`);
    const result = tryGit(batch.root, ['merge', '--no-ff', item.item_commit, '-m', landingSubject(item)]);
    if (result.status !== 0) {
      const files = tryGit(batch.root, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
      if (!files.length) throw new Refused('LAND_MERGE', `merge of #${item.item_id} failed outside a conflict: ${result.stderr || result.stdout}; inspect ${batch.root} and its hooks before adopting`);
      git(batch.root, ['merge', '--abort']);
      conflicts.push({ id: item.item_id, files });
      state.say(`conflict #${item.item_id}: ${files.join(', ')}`);
      continue;
    }
    const first = git(batch.root, ['rev-list', '--first-parent', '--reverse', 'HEAD']).split('\n')
      .find((commit) => tryGit(batch.root, ['merge-base', '--is-ancestor', item.item_commit, commit]).status === 0);
    merged.push({ id: item.item_id, commit: item.item_commit, merge: first });
  }
  return { items: merged, conflicts, tip: headCommit(batch.root) };
}

/** Read positive TAP completion counts while rejecting the canonical runner's incomplete accounts. */
function completionAccount() {
  let early = false;
  let plan = null;
  let topLevel = 0;
  const counts = {};
  /** Recognize canonical incomplete accounts even when only a bounded line prefix is retained. */
  const markerPrefix = (text) => {
    if (/^(?:Landing gate stopped early after |Files not run: |Interrupted test files: )/u.test(text)) early = true;
  };
  return {
    markerPrefix,
    /** Consume one complete output line without retaining test output or diagnostic blocks. */
    line(text) {
      markerPrefix(text);
      if (/^(?:not )?ok \d+\b/u.test(text)) topLevel++;
      const planned = /^1\.\.(\d+)\s*$/u.exec(text);
      if (planned) plan = Number(planned[1]);
      const count = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/u.exec(text);
      if (count) counts[count[1]] = Number(count[2]);
    },
    /** A complete plan accounts for every test and contains no interrupted or cancelled work. */
    complete() {
      return !early && Number.isSafeInteger(plan) && plan > 0 && plan === topLevel && Number.isSafeInteger(counts.tests)
        && Number.isSafeInteger(counts.pass) && Number.isSafeInteger(counts.fail)
        && (counts.cancelled ?? 0) === 0
        && counts.pass + counts.fail + (counts.skipped ?? 0) + (counts.todo ?? 0) === counts.tests;
    },
  };
}

/** Require positive completion evidence from this run, or stream the retained legacy raw account. */
function completeGate(gate) {
  if (typeof gate.complete === 'boolean') return gate.complete;
  const account = completionAccount();
  if (typeof gate.output === 'string') {
    for (const line of gate.output.split('\n')) account.line(line);
    return account.complete();
  }
  if (!gate.logPath || !existsSync(gate.logPath)) return false;
  const input = openSync(gate.logPath, 'r');
  const chunk = Buffer.alloc(64 * 1024);
  let pending = '';
  let oversized = false;
  try {
    let count;
    while ((count = readSync(input, chunk, 0, chunk.length, null)) > 0) {
      const parts = chunk.toString('latin1', 0, count).split('\n');
      for (const [index, part] of parts.entries()) {
        if (index) {
          if (oversized) account.markerPrefix(pending);
          else account.line(pending);
          pending = ''; oversized = false;
        }
        if (pending.length + part.length > 256) oversized = true;
        pending += part.slice(0, 256 - pending.length);
      }
    }
    if (oversized) account.markerPrefix(pending);
    else account.line(pending);
    return account.complete();
  } finally { closeSync(input); }
}

/** Whether current person waivers cover every named failure of this exact recorded run. */
function coveredFailures(state, gate) {
  return gate.failures.length > 0 && gate.failures.every((failure) => failure.file && store.landingWaiverFor(state.board, failure));
}

/** Run one full landing gate and retain its complete output under this batch's immutable phase path. */
async function gateGroup(state, label) {
  const tree = headTree(state.batch.root);
  const cached = state.gates.get(tree);
  if (cached && (completeGate(cached) || !coveredFailures(state, cached))) return cached;
  const directory = join(dirname(state.batch.root), 'logs');
  mkdirSync(directory, { recursive: true });
  const logPath = join(directory, `${label}-${state.batch.revision}.log`);
  await save(state, { state: 'gating', tip: headCommit(state.batch.root), logPath });
  const gate = await runGate(state.batch.root, state.config, { trustStamp: false, landing: true, agent: 'coordinator', onWait: state.onWait, stages: true, waivers: liveWaiverProjection(state.board) });
  copyFileSync(gate.log, logPath);
  if (gate.profilePath) copyFileSync(gate.profilePath, `${logPath}.profile.json`);
  const result = { ...gate, failures: landingFailures(gate.output, state.batch.root), accounted: accountedFailures(gate, state.batch.root), complete: completeGate(gate),
    requiresGreen: Boolean(cached && !completeGate(cached)), tree, logPath };
  state.gates.set(tree, result);
  await save(state, { gateResults: [...state.gates.values()].map(({ tree: testedTree, isGreen, failures, accounted, complete, requiresGreen, logPath: log }) =>
    ({ tree: testedTree, isGreen, failures, accounted: accounted ?? null, complete: complete ?? null, requiresGreen: Boolean(requiresGreen), logPath: log })) });
  return result;
}

/** Run each failing file once alone, with the same queued machine capacity as other checks. */
async function diagnose(state, failures) {
  if (!failures.length || failures.some((entry) => !entry.file)) throw new Refused('LAND_DIAGNOSTIC', `the gate did not name a failing test file; inspect ${state.batch.logPath} and make its reporter name source files`);
  const files = [...new Set(failures.map((entry) => entry.file))];
  const flakes = [];
  for (const file of files) {
    if (state.diagnosed.has(file)) { if (state.diagnosed.get(file)) flakes.push(file); continue; }
    const runner = state.config.affectedTests || (/\.[cm]?js$/u.test(file) ? 'node --test' : null);
    if (!runner) throw new Refused('LAND_DIAGNOSTIC', `no runner can isolate ${file}; configure affectedTests for the project’s test runner`);
    const result = await withGateSlot(state.batch.root, (lease) => runProfiledShell(state.batch.root, `${runner} ${quote(file)}`, {
      waitMs: lease.waitMs, artifactDirectory: dirname(state.batch.logPath), artifactPrefix: 'diagnostic', persistLog: true, pipefail: true, gateLease: lease,
    }), { landing: true, browser: true, agent: 'coordinator', kind: 'land-diagnostic', onWait: state.onWait });
    state.diagnosed.set(file, result.isGreen);
    await save(state, { diagnostics: [...state.diagnosed].map(([test, isGreen]) => ({ test, isGreen })) });
    if (result.isGreen) flakes.push(file);
  }
  return flakes;
}

/**
 * Read one stage's TAP strictly: test lines outside YAML blocks, each failure's file from its own
 * block, and a final `# fail N` that equals the failures read. Anything after that summary other
 * than summary counts or the package manager's own failure report means something else failed,
 * so the stage is unaccounted and null is returned [B3,R3].
 */
export function tapFailures(output, root) {
  const lines = output.split('\n');
  const failures = [];
  let yaml = null;
  let active = null;
  let version = false;
  let summary = null;
  let summaryAt = -1;
  let cancelled = 0;
  for (const [index, line] of lines.entries()) {
    if (yaml !== null) {
      if (line === `${yaml}...`) { yaml = null; continue; }
      const location = /^\s*location:\s*['"]?(.+?):\d+(?::\d+)?['"]?\s*$/u.exec(line);
      if (active && location) {
        const path = location[1];
        const file = isAbsolute(path) ? relative(root, path) : path.replace(/^\.\//u, '');
        if (file && !file.startsWith('../') && !file.includes('\\')) active.file = file;
      }
      continue;
    }
    const block = /^(\s*)---\s*$/u.exec(line);
    if (block) { yaml = block[1]; continue; }
    if (/^TAP version \d+\s*$/u.test(line)) version = true;
    const failed = /^\s*not ok\s+\d+\s+-\s+(.*)$/u.exec(line);
    if (failed) {
      active = { name: failed[1].replace(/\s+#.*$/u, ''), file: null };
      if (/^(?:\.\/)?(?:test|tests)\/[^\r\n]+\.(?:[cm]?js|ts|py)$/u.test(active.name)) active.file = active.name.replace(/^\.\//u, '');
      failures.push(active);
      continue;
    }
    if (/^\s*ok\s+\d+/u.test(line)) { active = null; continue; }
    const count = /^# fail (\d+)\s*$/u.exec(line);
    if (count) { summary = Number(count[1]); summaryAt = index; }
    const stopped = /^# cancelled (\d+)\s*$/u.exec(line);
    if (stopped) cancelled = Number(stopped[1]);
  }
  if (yaml !== null || !version || summary === null || summary < 1 || summary !== failures.length || cancelled !== 0) return null;
  const trailer = lines.slice(summaryAt + 1).every((line) => !line.trim() || /^# [a-z_]+ \d+(?:\.\d+)?\s*$/u.test(line) || /^npm (?:ERR!|error|warn|notice)\b/u.test(line));
  return trailer ? failures : null;
}

/**
 * The failures that explain a red run, or null when anything else may have failed: the command
 * could not be split into stages, a stage did not finish, a stage exited other than 0 without
 * exactly 1 and a complete TAP account of its failures, or a pipeline in a stage had a component
 * that left no status or a second failing component. Waivers only ever subtract these [B3,R3].
 */
export function accountedFailures(gate, root) {
  if (gate.isGreen || !Array.isArray(gate.stages) || !gate.stages.length) return null;
  const failures = [];
  for (const stage of gate.stages) {
    if (!Number.isInteger(stage.status)) return null;
    // In a pipeline every component's own status counts: at most one may fail, and only with exit 1 [B3,R3].
    if (stage.pipeline !== undefined && !pipelineAccounted(stage.pipeline)) return null;
    if (stage.status === 0) continue;
    const own = stage.status === 1 ? tapFailures(stage.output ?? '', root) : null;
    if (!own) return null;
    failures.push(...own);
  }
  return failures.length ? failures : null;
}

/**
 * True when a stage's pipeline statuses leave one place a failure can come from. A producer that
 * fails beside a failing TAP consumer is an independent red no waiver names, so it voids the run.
 */
function pipelineAccounted(statuses) {
  if (!Array.isArray(statuses) || statuses.some((status) => !Number.isInteger(status))) return false;
  const failed = statuses.filter((status) => status !== 0);
  return failed.length === 0 || (failed.length === 1 && failed[0] === 1);
}

/**
 * Pair every named failure of a red run with the live person waiver covering it, or return null.
 * One unnamed, unfiled or unwaived failure voids the whole run, so a waiver never hides another red [B3,R3].
 */
export function waivedFailures(board, failures) {
  if (!Array.isArray(failures) || !failures.length || failures.some((entry) => !entry.file)) return null;
  const covered = failures.map((failure) => ({ ...failure, waiver: store.landingWaiverFor(board, failure) }));
  return covered.every((entry) => entry.waiver) ? covered : null;
}

/** Project the live person waivers a landing run may read, so it does not stop early on one [B3]. */
export function liveWaiverProjection(board) {
  const now = board.clock.now().getTime();
  return store.landingWaivers(board).filter((waiver) => Date.parse(waiver.until) > now)
    .map((waiver) => ({ kind: waiver.kind ?? store.landingWaiverKind(waiver.test), test: waiver.test }));
}

/** Name one waived failure with the person's waiver, its reason and its expiry [B3]. */
export function waiverLine(failure) {
  const { waiver } = failure;
  return `waived: ${failure.name} (${failure.file}) by person waiver ${waiver.id} for ${waiver.kind ?? store.landingWaiverKind(waiver.test)} ${waiver.test}: ${waiver.reason}; expires ${waiver.until}`;
}

/** Record every failure's exact live waiver rather than changing which tests the gate runs. */
function waivedProof(state, gate) {
  if (!completeGate(gate) || gate.requiresGreen) return null;
  const failures = waivedFailures(state.board, gate.accounted);
  return failures ? { tree: gate.tree, failures: failures.map((entry) => ({ ...entry, waiver: entry.waiver.id })), logPath: gate.logPath } : null;
}

/** Bisect a reproducible red without retrying any previously tested group. */
async function bisect(state, items, failures, label = 'split') {
  if (items.length === 1) {
    const item = items[0];
    const text = `Landing batch ${state.batch.id} reproduces failures: ${failures.map((failure) => `${failure.file}: ${failure.name}`).join('; ')}`;
    if (!store.itemThread(state.board, item.id).some((entry) => entry.type === 'fact' && entry.text === text)) {
      await state.write('appendFact', [item.id, { agentId: 'coordinator', kind: 'measurement', text }]);
    }
    const mergeCommit = state.batch.tip;
    if (!state.culprits.some((entry) => entry.id === item.id)) state.culprits.push({ id: item.id, commit: item.commit, mergeCommit, tests: failures });
    await save(state, { culprits: state.culprits });
    await returnCulprits(state);
    state.say(`culprit #${item.id}: ${failures.map((failure) => failure.name).join(', ')}`);
    return [];
  }
  const middle = Math.ceil(items.length / 2);
  const green = [];
  for (const [index, part] of [items.slice(0, middle), items.slice(middle)].entries()) {
    const build = await mergeGroup(state, part);
    await save(state, { ...build, state: 'bisecting' });
    const gate = await gateGroup(state, `${label}-${index}`);
    if (gate.isGreen || waivedProof(state, gate)) green.push(...build.items);
    else {
      const flakyFiles = await diagnose(state, gate.failures);
      if (flakyFiles.length) {
        await fileFlakes(state, gate, flakyFiles);
        state.flaky = true;
        return [];
      }
      green.push(...await bisect(state, build.items, gate.failures, `${label}-${index}`));
    }
  }
  return green;
}

/** Return recorded red candidates once, including a saved failure interrupted before its move. */
async function returnCulprits(state) {
  for (const culprit of state.culprits) {
    const item = store.getItem(state.board, culprit.id);
    if (item.item_status !== 'verified' || item.item_merged_commit || item.item_commit !== culprit.commit
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(culprit.mergeCommit ?? '')) continue;
    const note = `Landing batch ${state.batch.id} failed ${culprit.tests.map((failure) => `${failure.file}: ${failure.name}`).join('; ')}; merge commit ${culprit.mergeCommit}`;
    await state.write('reopen', [culprit.id, { agentId: 'coordinator', note }]);
  }
}

/** File a flake once against its named test and leave the batch stopped. */
async function fileFlakes(state, gate, files) {
  const flakes = [];
  for (const file of files) {
    const owner = laneOf(state.config, file);
    const lane = owner === 'coordinator' ? store.getItem(state.board, state.batch.items[0].id).item_lane : owner;
    flakes.push(await state.write('recordLandingFlake', [{ agentId: 'coordinator', test: file, hash: testHash(state.batch.root, file),
      names: gate.failures.filter((entry) => entry.file === file).map((entry) => entry.name), lane, batchId: state.batch.id }]));
  }
  await save(state, { state: 'flaky', failures: gate.failures, flakes });
  state.say(`flake: ${files.join(', ')}; nothing landed; fix the test or ask the person for an expiring waiver`);
}

/** Name the remote a landing pushes the trunk to: the trunk branch's own remote, else origin [B3]. */
function landingRemoteName(root, branch) {
  return tryGit(root, ['config', '--get', `branch.${branch.replace(/^refs\/heads\//u, '')}.remote`]).stdout || 'origin';
}

/**
 * Name the configured remote a landing would push the trunk to, or null when this repo has none [B3].
 * An accept uses it to say which landing command fits this repo; the landing itself refuses on null.
 */
export function landingRemote(root, branch) {
  const remote = landingRemoteName(root, branch);
  return tryGit(root, ['remote', 'get-url', remote]).status === 0 ? remote : null;
}

/** Build the one LAND_PUSH refusal every landing push failure reports, real or previewed [B3]. */
function pushRefused(reason, next = 'inspect the remote and hooks, then run pullboard land --adopt') {
  return new Refused('LAND_PUSH', `the landing push failed: ${reason}; ${next}`);
}

/**
 * Return the remote a landing pushes to, refusing LAND_PUSH when it does not exist [B3].
 * The dry run and the real landing both call this, so a preview cannot say "would land" for a push that must fail.
 */
function requirePushTarget(root, branch) {
  const remote = landingRemote(root, branch);
  if (remote) return remote;
  const missing = landingRemoteName(root, branch);
  throw pushRefused(`this repo has no ${missing} remote to push ${branch.replace(/^refs\/heads\//u, '')} to`,
    `add one with git remote add ${missing} <url> and run pullboard land again, or merge each verified commit on the trunk with git merge --no-ff and record it with pullboard merged <id> <commit>`);
}

/** Push the exact gated tip before recording receipts, then fast-forward only a clean unchanged main. */
async function publish(state) {
  let batch = state.batch;
  const remote = requirePushTarget(state.root, batch.branch);
  if (batch.proof?.failures?.length && batch.state !== 'pushed') {
    const failures = batch.proof.failures.map((failure) => ({ ...failure, waiver: store.landingWaiverFor(state.board, failure)?.id }));
    if (!failures.every((failure) => failure.waiver)) throw new Refused('LAND_WAIVER', 'the landing proof has an expired or missing person waiver; ask the person for a new expiring waiver, then adopt the batch');
    batch = await save(state, { proof: { ...batch.proof, failures } });
  }
  if (batch.state !== 'pushed') {
    if (headCommit(batch.root) !== batch.tip || !isClean(batch.root) || untracked(batch.root).length) throw new Refused('LAND_MOVED', 'the gated landing tree changed; inspect the batch and adopt it again');
    const current = mainCheckout(state.root);
    if (current?.commit !== batch.base) throw new Refused('LAND_TRUNK_MOVED', 'main moved during the landing; rebuild the batch from its new tip');
    const alreadyPushed = tryGit(batch.root, ['ls-remote', remote, batch.branch]).stdout.split(/\s+/u)[0] === batch.tip;
    if (!alreadyPushed) {
      const pushed = tryGit(batch.root, ['push', remote, `HEAD:${batch.branch}`]);
      if (pushed.status !== 0) throw pushRefused(pushed.stderr || pushed.stdout);
    }
    await save(state, { state: 'pushed' });
  }
  if (tryGit(batch.root, ['ls-remote', remote, batch.branch]).stdout.split(/\s+/u)[0] !== batch.tip) {
    throw new Refused('LAND_REMOTE_MOVED', 'the remote no longer names the pushed batch tip; inspect it before adopting, without rewriting the remote');
  }
  state.batch = await state.write('finishLandingBatch', [{ agentId: 'coordinator', id: state.batch.id, tip: state.batch.tip }]);
  const main = mainCheckout(state.root);
  if (main?.commit === state.batch.base && isClean(state.root) && !untracked(state.root).length) git(state.root, ['merge', '--ff-only', state.batch.tip]);
  state.say(`landed ${state.batch.items.map((entry) => `#${entry.id}`).join(', ')} at ${state.batch.tip}`);
  return state.batch;
}

/** Build, gate, diagnose and durably land one coordinator batch; all external actions stay in its worktree. */
export async function land({ root, board, config, write, say, owner, maximum = Infinity, dryRun = false, adopt = false, onWait }) {
  let trunk = mainCheckout(root);
  const recorded = store.landingBatches(board).findLast((batch) => batch.state === 'landed' && batch.base === trunk?.commit);
  if (!dryRun && recorded && isClean(root) && !untracked(root).length) {
    git(root, ['merge', '--ff-only', recorded.tip]);
    trunk = mainCheckout(root);
  }
  if (!trunk?.commit) throw new Refused('LAND_TRUNK', 'landing needs the coordinator’s primary branch; return its checkout to the trunk');
  const unfinished = store.landingBatches(board).findLast((batch) => batch.state !== 'landed' && batch.state !== 'blocked');
  const selected = candidates(board, root, trunk.commit, maximum);
  if (dryRun) {
    if (selected.ready.length) requirePushTarget(root, trunk.branch);
    const conflicts = [];
    for (const item of selected.ready) {
      const merge = tryGit(root, ['merge-tree', '--write-tree', '--name-only', '-z', trunk.commit, item.item_commit]);
      if (merge.status === 1) {
        const parts = merge.stdout.split('\0').slice(1);
        const end = parts.indexOf('');
        conflicts.push({ id: item.item_id, files: parts.slice(0, end < 0 ? parts.length : end) });
      } else if (merge.status !== 0) throw new Refused('LAND_MERGE', 'Git could not preview the landing; restore its objects and retry the dry run');
    }
    return { batch: null, landed: [], conflicts, blocked: selected.blocked, culprits: [], flakes: [], items: selected.ready.map((item) => item.item_id) };
  }
  if (unfinished && !adopt && unfinished.state !== 'flaky') throw new Refused('LAND_ADOPT', `batch ${unfinished.id} is ${unfinished.state}; inspect pullboard resume, then run pullboard land --adopt`);
  if (adopt && !unfinished) throw new Refused('LAND_ADOPT', 'there is no interrupted landing batch; run pullboard land');
  let batch = unfinished;
  if (batch?.state === 'flaky') {
    const held = (batch.flakes ?? []).filter((flake) => {
      const corrected = batch.base !== trunk.commit && testHash(root, flake.test) !== null && testHash(root, flake.test) !== flake.hash;
      const failures = (batch.failures ?? []).filter((failure) => failure.file === flake.test);
      return !corrected && (!failures.length || !failures.every((failure) => store.landingWaiverFor(board, failure)));
    });
    if (held.length) throw new Refused('LAND_FLAKE', `batch ${batch.id} is held by ${held.map((entry) => entry.test).join(', ')}; fix the test or ask the person for an expiring waiver; nothing retries`);
  }
  if (batch && batch.base !== trunk.commit && batch.state !== 'pushed') {
    await write('recordLandingBatch', [{ agentId: 'coordinator', batch: { ...batch, state: 'blocked', supersededByMain: trunk.commit }, revision: batch.revision }]);
    batch = null;
  }
  if (!batch && !selected.ready.length) {
    for (const entry of selected.blocked) say(`${entry.code} #${entry.id}${entry.stacked ? ` carries #${entry.stacked}` : ''}`);
    return { batch: null, landed: [], conflicts: [], blocked: selected.blocked, culprits: [], flakes: [] };
  }
  if (!batch) {
    requirePushTarget(root, trunk.branch);
    const id = randomUUID();
    const directory = join(repoInfo(root).commonDir, 'pullboard', 'landings', id);
    batch = { version: 1, id, base: trunk.commit, tip: trunk.commit, branch: trunk.branch, root: join(directory, 'worktree'),
      candidates: selected.ready.map((item) => ({ id: item.item_id, commit: item.item_commit })),
      items: selected.ready.map((item) => ({ id: item.item_id, commit: item.item_commit })), conflicts: [], blocked: selected.blocked,
      state: 'merging', owner, logPath: join(directory, 'logs', 'batch.log'), revision: 0 };
    batch = await write('recordLandingBatch', [{ agentId: 'coordinator', batch }]);
    mkdirSync(directory, { recursive: true });
    git(root, ['worktree', 'add', '--detach', batch.root, batch.base]);
  }
  const state = { root, board, config, write, say, onWait, batch, culprits: batch.culprits ?? [], flaky: false, gates: new Map((batch.gateResults ?? []).map((result) => [result.tree, result])), diagnosed: new Map((batch.diagnostics ?? []).map((result) => [result.test, result.isGreen])) };
  await save(state, { owner });
  await returnCulprits(state);
  if (state.batch.state === 'pushed' || state.batch.state === 'ready') await publish(state);
  else {
    const initialItems = (state.batch.candidates ?? state.batch.items)
      .filter((entry) => !state.culprits.some((culprit) => culprit.id === entry.id && culprit.commit === entry.commit));
    if (!existsSync(state.batch.root)) throw new Refused('LAND_WORKTREE', `the recorded landing worktree is missing at ${state.batch.root}; restore it before adopting`);
    const build = await mergeGroup(state, initialItems);
    await save(state, { ...build, conflicts: [...state.batch.conflicts, ...build.conflicts] });
    for (const entry of state.batch.blocked ?? []) say(`${entry.code} #${entry.id}${entry.stacked ? ` carries #${entry.stacked}` : ''}`);
    if (!build.items.length) await save(state, { state: 'blocked' });
    else {
      let gate = await gateGroup(state, 'batch');
      let proof = gate.isGreen ? null : waivedProof(state, gate);
      if (!gate.isGreen && !proof) {
        const flakyFiles = await diagnose(state, gate.failures);
        if (flakyFiles.length) { await fileFlakes(state, gate, flakyFiles); state.flaky = true; }
        else {
          const green = await bisect(state, build.items, gate.failures);
          if (!state.flaky && green.length) {
            const rebuilt = await mergeGroup(state, green);
            await save(state, { ...rebuilt, culprits: state.culprits });
            gate = await gateGroup(state, 'green-items');
            proof = gate.isGreen ? null : waivedProof(state, gate);
            if (!gate.isGreen && !proof) {
              await save(state, { state: 'blocked', failures: gate.failures, culprits: state.culprits });
              throw new Refused('LAND_INTERACTION', 'the individually green items fail together; nothing retries or lands; inspect the batch’s failing tests');
            }
          } else if (!state.flaky) await save(state, { state: 'blocked', culprits: state.culprits });
        }
      }
      if (!state.flaky && (gate.isGreen || proof)) {
        await save(state, { state: 'ready', proof: proof ?? { tree: gate.tree, failures: [], logPath: gate.logPath }, culprits: state.culprits });
        await publish(state);
      }
    }
  }
  return { batch: state.batch, landed: state.batch.state === 'landed' ? state.batch.items.map((entry) => entry.id) : [],
    conflicts: state.batch.conflicts ?? [], blocked: state.batch.blocked ?? [], culprits: state.culprits, flakes: state.batch.flakes ?? [] };
}
