/**
 * The gate (V4, C3, Q1, Q2, V18): the repo's check command and shared queue for gates and item checks. A green
 * run over a committed tree, with nothing untracked and nothing changed while it ran, leaves that
 * tree's id in the git dir, so the same tree is never checked twice. An agent sees a digest of the
 * run, not the run (V10): a passing suite's output costs tokens and says nothing.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { availableParallelism } from 'node:os';
import { gitChildEnv, gitPath, headTree, invalidateGitFacts, isClean, untracked } from './git.js';
import { secretsIn } from './hooks.js';
import { Refused } from './refused.js';
import { GATE_SLOT_HELD_ENV, gateSlotEnvironment, inheritedGateSlot, memoryAdmission, readMachineMemory, takeResource } from './resources.js';
import { browserFreeChecksEnabled, loadMachineSettings, memoryFloorMB } from './settings.js';
import { selectAffectedTests } from './affected-tests.js';
import { checkNeedsBrowser, testsNeedBrowser } from './browser-admission.js';
import { timingFromOutput, timingRunner } from './timing.js';

const STAMP = 'pullboard-gate-green';
const LOG = 'pullboard-gate.log';
const LANDING_RUN_ENV = 'PULLBOARD_LANDING_RUN';
const DIGEST_CHARS = 3000;
const TAIL_CHARS = 1000;
const LINE_CHARS = 300;
const FAILURE_RE = /fail|error|expected|received|assert|not ok|✗|×|cannot|undefined|exception/i;
// A passing test's own lines, whatever its name says: TAP's `ok N` and the `# Subtest:` before it.
const PASSING_RE = /^\s*(ok \d+\b|# Subtest:)/;
// Lines kept under a failure, where test runners say why: the message, expected and actual.
const CONTEXT_LINES = 10;

/** Detect the performance-core budget on Apple Silicon, or the runtime's usable CPU budget elsewhere. */
export function performanceCores() {
  if (process.platform === 'darwin') {
    const result = spawnSync('/usr/sbin/sysctl', ['-n', 'hw.perflevel0.physicalcpu'], { encoding: 'utf8' });
    const count = Number(result.stdout?.trim());
    if (result.status === 0 && Number.isSafeInteger(count) && count > 0) return count;
  }
  return Math.max(1, availableParallelism());
}

/** One policy for native file concurrency and the separate per-run browser-file limit. */
export function testConcurrency(root, cores = performanceCores()) {
  const file = join(root, 'pullboard.json');
  let config = {};
  if (existsSync(file)) {
    try { config = JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw new Refused('BAD_CONFIG', 'pullboard.json must be valid JSON before running tests'); }
  }
  const setting = config.testConcurrency ?? {};
  if (!setting || typeof setting !== 'object' || Array.isArray(setting)) {
    throw new Refused('BAD_CONFIG', 'testConcurrency must be an object with positive integer files and browser fields');
  }
  const files = setting.files ?? cores;
  const browser = setting.browser ?? 2;
  if (!Number.isSafeInteger(files) || files < 1 || !Number.isSafeInteger(browser) || browser < 1 || browser > 2) {
    throw new Refused('BAD_CONFIG', 'testConcurrency.files must be positive; testConcurrency.browser must be 1 or 2');
  }
  return { files, browser: Math.min(files, browser) };
}

/**
 * The lines of a failure worth an agent's attention: each line that looks like a failure with the
 * lines under it that say why, then the end of the output, within one cap, so a refusal or a retry
 * carries the reason and not the whole log. Passing tests are skipped however they are named. The
 * end has its own share of the cap and every line is cut short, so no single long line can push the
 * summary out.
 *
 * @param {string} output
 * @returns {string}
 */
export function digestOf(output) {
  const lines = output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => (line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}…` : line));
  const tail = [];
  let room = TAIL_CHARS;
  for (let at = lines.length - 1; at >= 0 && tail.length < 15 && lines[at].length < room; at -= 1) {
    tail.unshift(lines[at]);
    room -= lines[at].length + 1;
  }
  room = DIGEST_CHARS - (TAIL_CHARS - room);
  const body = lines.slice(0, lines.length - tail.length);
  const failing = [];
  for (let at = 0; at < body.length && failing.length < 40; at += 1) {
    if (PASSING_RE.test(body[at]) || !FAILURE_RE.test(body[at])) continue;
    const block = body.slice(at, at + CONTEXT_LINES + 1);
    const end = block.findIndex((line, n) => n > 0 && (PASSING_RE.test(line) || /^\s*(not ok \d+|\.\.\.)\s*$|^\s*not ok \d+/.test(line)));
    for (const line of end === -1 ? block : block.slice(0, end)) {
      if (line.length >= room) break;
      failing.push(line);
      room -= line.length + 1;
    }
    at += (end === -1 ? block.length : end) - 1;
  }
  return [...failing, ...tail].join('\n');
}

/**
 * The tree a gate run would check, or null when the working copy differs from HEAD or holds
 * untracked files, since a pass over it would vouch for something no commit holds.
 *
 * @param {string} root
 * @returns {string | null}
 */
export function committedTree(root) {
  if (!isClean(root) || untracked(root).length) return null;
  return headTree(root);
}

/**
 * True when the gate already passed on exactly this committed tree.
 *
 * @param {string} root
 * @returns {boolean}
 */
export function isStampedGreen(root) {
  const tree = committedTree(root);
  const file = gitPath(root, STAMP);
  return tree !== null && existsSync(file) && readFileSync(file, 'utf8').trim() === tree;
}

/**
 * Run a shell command in a checkout for a digest: both streams in one pipe, in order, read whole
 * however long, stdin closed so nothing waits on a person.
 *
 * @param {string} root
 * @param {string} command
 * @param {{ pipefail?: boolean, env?: NodeJS.ProcessEnv }} [options] - Gate-only pipefail and additional child environment values.
 * @returns {{ isGreen: boolean, output: string, seconds: number }}
 */
export function runShell(root, command, { pipefail = false, env = {} } = {}) {
  const started = Date.now();
  const options = { cwd: root, env: { ...gitChildEnv(root), ...env }, shell: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 2 ** 30 };
  let prefix = '';
  if (pipefail) {
    // Probe the same shell as the command, with no load-sensitive deadline or alternate shell.
    const probe = spawnSync('set -o pipefail', options);
    if (probe.status === 0) prefix = 'set -o pipefail\n';
    else if (hasPipeline(command)) {
      throw new Refused('PIPEFAIL_UNAVAILABLE', 'the repo gate shell cannot enable pipefail; rewrite the gate without a pipe');
    }
  }
  // Newlines, not spaces, around the command, so a trailing comment in it cannot swallow the `)`.
  const result = spawnSync(`${prefix}(\n${command}\n) 2>&1`, options);
  invalidateGitFacts();
  return { isGreen: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`, seconds: Math.round((Date.now() - started) / 1000) };
}

/** Replace a possible secret-bearing line before persisting a direct item-check log. */
function safeLog(output) {
  return output.split('\n').map((line, index) => {
    if (Buffer.byteLength(line, 'utf8') > 64 * 1024) return '[redacted output line exceeds 64 KiB safe-scan limit]';
    const findings = secretsIn([{ path: 'item check output', line: index + 1, text: line }]);
    return findings.length ? `[redacted ${findings.map(finding => finding.slice(0, finding.lastIndexOf(' at '))).join(', ')}]` : line;
  }).join('\n');
}

/** Run the unchanged caller command and profile only timings already present in its output.
 * @param {string} root
 * @param {string} command
 * @param {{ waitMs?: number, artifactDirectory?: string, artifactPrefix?: string, persistLog?: boolean, profileFile?: string, pipefail?: boolean, gateSlotHeld?: boolean, gateLease?: object, landing?: boolean }} [options]
 */
export function runProfiledShell(root, command, { waitMs = 0, artifactDirectory, artifactPrefix = 'pullboard-gate', persistLog = false, profileFile, pipefail = false, gateSlotHeld = false, gateLease, landing = false } = {}) {
  const directory = artifactDirectory ?? dirname(gitPath(root, LOG));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const profilePath = profileFile ?? join(directory, `${artifactPrefix}-${id}.profile.json`);
  const logPath = persistLog ? join(directory, `${artifactPrefix}-${id}.log`) : null;
  const started = Date.now();
  const inherited = {
    ...(gateLease ? gateSlotEnvironment(gateLease) : gateSlotHeld ? { [GATE_SLOT_HELD_ENV]: '1' } : {}),
    [LANDING_RUN_ENV]: landing ? '1' : '0',
  };
  const run = runShell(root, command, { pipefail, env: inherited });
  const profile = writeTimingProfile(profilePath, {
    ...timingFromOutput(run.output, timingRunner(command)),
    waitMs: Math.max(0, Math.round(waitMs)), wallMs: Math.max(0, Date.now() - started),
  });
  if (logPath) writeFileSync(logPath, safeLog(run.output), { mode: 0o600 });
  return { ...run, profile, profilePath, logPath };
}

/** Run an independent focused comparison without blocking other holders of the machine pool.
 * @param {string} root
 * @param {string} command
 * @param {{ waitMs?: number, gateSlotHeld?: boolean, gateLease?: object, landing?: boolean }} [options]
 * @returns {Promise<object>} The unchanged shell verdict and its private timing profile.
 */
export async function runProfiledShellAsync(root, command, { waitMs = 0, gateSlotHeld = false, gateLease, landing = false } = {}) {
  const started = Date.now();
  const inherited = {
    ...(gateLease ? gateSlotEnvironment(gateLease) : gateSlotHeld ? { [GATE_SLOT_HELD_ENV]: '1' } : {}),
    [LANDING_RUN_ENV]: landing ? '1' : '0',
  };
  const env = { ...gitChildEnv(root), ...inherited };
  const child = spawn(`(\n${command}\n) 2>&1`, { cwd: root, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  let bytes = 0;
  let overflow = false;
  let failure = null;
  /** Retain merged shell output within the same one-GiB limit as the synchronous gate runner. */
  const capture = part => {
    bytes += Buffer.byteLength(part);
    if (bytes > 2 ** 30) { overflow = true; child.kill(); }
    else chunks.push(part);
  };
  child.stdout.setEncoding('utf8').on('data', capture);
  child.stderr.setEncoding('utf8').on('data', capture);
  child.once('error', error => { failure = error; });
  const status = await new Promise(resolveClose => child.once('close', resolveClose));
  invalidateGitFacts();
  const output = chunks.join('') + (overflow ? '\nFocused comparison output exceeded one GiB.\n' : '')
    + (failure ? `\n${failure.message}\n` : '');
  const wallMs = Math.max(0, Date.now() - started);
  const profilePath = join(dirname(gitPath(root, LOG)), `pullboard-gate-${randomUUID()}.profile.json`);
  const profile = writeTimingProfile(profilePath, { ...timingFromOutput(output, timingRunner(command)),
    waitMs: Math.max(0, Math.round(waitMs)), wallMs });
  return { isGreen: status === 0 && !overflow && !failure, output, seconds: Math.round(wallMs / 1000), profile, profilePath, logPath: null };
}

/** Persist one sanitized timing profile as a private artifact.
 * @param {string} path
 * @param {{ files?: Array<object>, tests?: Array<object>, [key: string]: any }} profile
 * @returns {object} The sanitized profile written to disk.
 */
export function writeTimingProfile(path, profile) {
  /** Sanitize one reporter-controlled string before persistence or display.
   * @param {unknown} value
   * @param {string} label
   * @returns {unknown}
   */
  const sanitize = (value, label) => {
    if (typeof value !== 'string') return value;
    if (Buffer.byteLength(value, 'utf8') > 64 * 1024) return '[redacted profile field exceeds 64 KiB safe-scan limit]';
    const findings = secretsIn([{ path: `timing profile ${label}`, line: 1, text: value }]);
    return findings.length ? `[redacted ${findings.map(finding => finding.slice(0, finding.lastIndexOf(' at '))).join(', ')}]` : value;
  };
  /** Accept only measured, nonnegative durations from reporter events. */
  const validDuration = value => Number.isFinite(value) && value >= 0;
  const files = (profile.files ?? []).filter(file => typeof file?.path === 'string' && validDuration(file.durationMs))
    .map(file => ({ path: sanitize(file.path, 'file path'), durationMs: file.durationMs }));
  const tests = (profile.tests ?? []).filter(test => (typeof test?.file === 'string' || test?.file === null) && typeof test?.name === 'string' && validDuration(test.durationMs))
    .map(test => ({ file: sanitize(test.file, 'test file'), name: sanitize(test.name, 'test name'), durationMs: test.durationMs, passed: test.passed === true }));
  const sanitized = {
    version: 1,
    waitMs: validDuration(profile.waitMs) ? profile.waitMs : 0,
    wallMs: validDuration(profile.wallMs) ? profile.wallMs : null,
    files,
    tests,
    runner: sanitize(profile.runner ?? 'shell', 'runner'),
    format: sanitize(profile.format ?? 'none', 'format'),
    unavailable: sanitize(profile.unavailable ?? null, 'availability'),
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 });
  return sanitized;
}

/** Conservatively detect a pipe when the configured gate shell cannot enforce every stage's status. */
function hasPipeline(command) {
  for (let index = 0; index < command.length; index += 1) {
    if (command[index] === '|' && command[index + 1] !== '|' && command[index - 1] !== '|') return true;
  }
  return false;
}

/** Run work under the machine queue: landings first, then every other eligible waiter in arrival order.
 * The whole queue waits while the machine is out of memory, so a run never starts into swap.
 *
 * @param {string} root - Checkout used to locate the machine resource database.
 * @param {(lease: { waitMs: number, token?: string, pool?: string, browser?: boolean, release: () => void }) => any | Promise<any>} action - Work to perform while holding a slot.
 * @param {{ landing?: boolean, itemCheck?: boolean, diagnostic?: boolean, browser?: boolean, agent?: string, item?: string|number, kind?: string, onWait?: (state: object) => void, readMemory?: typeof readMachineMemory }} [options] - Queue class, progress reporter and, for tests, the machine memory reader.
 * @returns {Promise<any>} The action's result after releasing its lease.
 */
export async function withGateSlot(root, action, { landing = false, itemCheck = false, diagnostic = false, browser = false, agent, item = '', kind = '', onWait, readMemory = readMachineMemory } = {}) {
  const inherited = inheritedGateSlot({ root, browser });
  if (inherited) {
    try { return await action(inherited); }
    finally { inherited.release(); }
  }
  const settingsProvider = () => loadMachineSettings();
  const capacityProvider = () => settingsProvider().gateSlots;
  const lease = await takeResource({
    name: 'gate',
    capacity: capacityProvider(),
    capacityProvider,
    browserCapacityProvider: () => settingsProvider().browserSlots,
    scope: 'machine',
    root,
    repo: root,
    agent,
    item: String(item),
    kind,
    landing,
    itemCheck,
    diagnostic,
    browser,
    allowIdleCapacityUpdate: true,
    memory: memoryAdmission({ floorBytes: () => memoryFloorMB() * 1024 ** 2, read: readMemory }),
    onWait,
  });
  try {
    return await action(lease);
  } finally {
    lease.release();
  }
}

/**
 * Run the configured gate in the repo, unless this exact tree already passed. Its output, both
 * streams in order, is kept whole in the git dir and returned for a digest.
 *
 * A passed tree is marked by a stamp file in the git dir, which any agent can write. So the stamp
 * only saves a run where nothing is proven by it, such as pre-push (C3). A submission that falls
 * back to the full gate always runs it afresh (V16).
 *
 * @param {string} root
 * @param {any} config
 * @param {{ trustStamp?: boolean, onWait?: (state: object) => void, landing?: boolean, agent?: string, item?: string|number }} [options]
 * @returns {Promise<{ isGreen: boolean, isCached: boolean, output: string, seconds: number, log: string, profile?: object, profilePath?: string }>}
 */
export async function runGate(root, config, { trustStamp = true, onWait, landing = false, agent, item = '' } = {}) {
  if (!config.gate.trim()) {
    throw new Refused('NO_GATE', 'no gate configured; set "gate" in pullboard.json, e.g. "npm test"');
  }
  if (trustStamp && isStampedGreen(root)) return { isGreen: true, isCached: true, output: '', seconds: 0, log: '' };
  return await withGateSlot(root, (lease) => fullGateRun(root, config, trustStamp, { waitMs: lease.waitMs, gateLease: lease, landing }), {
    landing, browser: true, agent, item, kind: landing ? 'landing' : 'gate', onWait,
  });
}

/** Run a full gate while its caller owns the queue lease; only a full run may stamp its tree. */
function fullGateRun(root, config, trustStamp = false, { waitMs = 0, log = gitPath(root, LOG), gateLease, landing = false } = {}) {
  if (trustStamp && isStampedGreen(root)) return { isGreen: true, isCached: true, output: '', seconds: 0, log: '' };
  const before = committedTree(root);
  const { isGreen, output, seconds, profile, profilePath } = runProfiledShell(root, config.gate, { waitMs, pipefail: true, profileFile: `${log}.profile.json`, gateLease, landing });
  writeFileSync(log, output);
  if (isGreen && before !== null && committedTree(root) === before) writeFileSync(gitPath(root, STAMP), `${before}\n`);
  return { isGreen, isCached: false, output, seconds, log, profile, profilePath };
}

/** Quote a fixed executable or selected path without permitting shell expansion. */
function commandWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * Prove the frozen item check and selected imports under one lease. Subsets neither read nor write
 * the full-gate stamp. An uncertain selection runs the full configured gate and records its reason.
 *
 * @param {string} root
 * @param {any} config
 * @param {{base:string|null, trunk?:string, changed?:string[], check:string, agent?:string, item?:string|number, kind?:string, onWait?:(state:object)=>void, onBrowserFallback?:(decision:{file:string,reason:string})=>void}} options
 * @returns {Promise<any>}
 */
export async function runSubmitGate(root, config, { base, trunk, changed, check, agent, item = '', kind = 'submit', onWait, onBrowserFallback }) {
  if (!config.gate.trim()) throw new Refused('NO_GATE', 'no gate configured; set "gate" in pullboard.json, e.g. "npm test"');
  const selection = config.affectedTests
    ? selectAffectedTests(root, { base, trunk, changed })
    : { full: true, reason: 'affected-test selection is not enabled for this project', files: [] };
  const deferred = config.submitGate === 'landing';
  const deferFullFallback = deferred && selection.full;
  const allowBrowserFreeChecks = browserFreeChecksEnabled();
  const checkUsesBrowser = check ? (!allowBrowserFreeChecks || await checkNeedsBrowser(root, check, { onFallback: onBrowserFallback })) : false;
  const proofUsesBrowser = !deferFullFallback && (selection.full || !allowBrowserFreeChecks || await testsNeedBrowser(root, selection.files, { onFallback: onBrowserFallback }));
  const browser = checkUsesBrowser || proofUsesBrowser;
  return await withGateSlot(root, (lease) => {
    const startedAt = Date.now();
    const log = gitPath(root, 'pullboard-submit.log');
    const checkLog = `${log}.check.log`;
    const proofLog = `${log}.proof.log`;
    const criterion = check ? runProfiledShell(root, check, {
      waitMs: lease.waitMs, profileFile: `${checkLog}.profile.json`, gateLease: lease,
    }) : { isGreen: true, output: '', seconds: 0 };
    if (check) writeFileSync(checkLog, safeLog(criterion.output), { mode: 0o600 });
    const receipt = { command: check, green: criterion.isGreen, seconds: criterion.seconds, checked: Boolean(check),
      ...(check ? { log: checkLog, profilePath: criterion.profilePath, profile: criterion.profile } : {}) };
    /** Persist the whole submission's wall time and queue wait once, alongside its combined raw log. */
    const finish = (proof) => {
      const profilePath = `${log}.profile.json`;
      const profiles = [criterion.profile, proof.profile].filter(Boolean);
      const profile = writeTimingProfile(profilePath, {
        waitMs: lease.waitMs, wallMs: Math.max(0, Date.now() - startedAt),
        files: profiles.flatMap(value => value.files), tests: profiles.flatMap(value => value.tests),
        runner: [...new Set(profiles.map(value => value.runner))].join(', '),
        format: [...new Set(profiles.map(value => value.format))].join('+'),
        unavailable: profiles.some(value => value.unavailable) ? 'per-test timing unavailable: output was not TAP or JUnit (one or more phases)' : null,
      });
      return { ...proof, log, seconds: criterion.seconds + proof.seconds, ...selection, deferred, deferFullFallback, check: receipt,
        profile, profilePath, proofProfilePath: proof.profilePath, proofLog: proof.log };
    };
    if (!criterion.isGreen) {
      writeFileSync(log, criterion.output);
      return finish({ isGreen: false, isCached: false, output: criterion.output, seconds: 0, log: '' });
    }
    // The proof already owns this lease: its phase profile has no additional queue wait.
    const proofWait = check ? 0 : lease.waitMs;
    let proof;
    if (deferFullFallback) proof = { isGreen: true, isCached: false, output: '', seconds: 0, log: '' };
    else if (selection.full) proof = fullGateRun(root, config, false, { waitMs: proofWait, log: proofLog, gateLease: lease });
    else if (!selection.files.length) proof = { isGreen: true, output: '', seconds: 0, isCached: false, log: '' };
    else {
      const command = `${config.affectedTests.trimEnd()} ${selection.files.map(path => commandWord('./' + path)).join(' ')}`;
      proof = { ...runProfiledShell(root, command, { waitMs: proofWait, profileFile: `${proofLog}.profile.json`, gateLease: lease }), isCached: false, log: proofLog };
      writeFileSync(proofLog, proof.output);
    }
    const phase = deferFullFallback ? 'full suite deferred to the landing gate' : selection.full ? 'full gate' : 'affected tests';
    writeFileSync(log, `item check:\n${criterion.output}\n${phase}:\n${proof.output}`);
    return finish(proof);
  }, { browser, agent, item, kind, itemCheck: true, onWait });
}

/** Describe precisely which submission proof ran, including absent checks and full fallbacks. */
export function submitGateReport(gate) {
  const check = gate.check.checked ? `item check ${gate.check.green ? 'green' : 'red'} in ${gate.check.seconds}s` : 'no item check';
  if (gate.deferred) {
    const reason = gate.reason ? `: ${gate.reason}` : '';
    const timings = timingDigest(gate.profile);
    const detail = timings ? `\n${timings}\ntiming profile: ${gate.profilePath}` : '';
    const proof = gate.deferFullFallback
      ? `full suite deferred to the landing gate${reason}`
      : `affected tests: ${gate.files.length ? gate.files.join(', ') : 'none'}; full suite deferred to the landing gate`;
    const result = gate.deferFullFallback ? '' : `; ${gate.isGreen ? `affected tests green in ${gate.seconds}s` : gateReport(gate)}`;
    return `${check}; ${proof}${result}${detail}`;
  }
  const selection = gate.full ? `full gate: ${gate.reason}` : `affected tests: ${gate.files.length ? gate.files.join(', ') : 'none'}`;
  const timings = timingDigest(gate.profile);
  const detail = timings ? `\n${timings}\ntiming profile: ${gate.profilePath}` : '';
  const result = gate.isGreen && !gate.full ? `affected tests green in ${gate.seconds}s${detail}` : gateReport(gate);
  return `${check}; ${selection}; ${result}`;
}

/** Show wall and queue wait for every run; rank files only when their durations were printed. */
export function timingDigest(profile) {
  if (!profile) return '';
  const measured = value => Number.isFinite(value) ? `${(value / 1000).toFixed(2)}s` : 'unavailable';
  const summary = `timing (${profile.runner ?? 'shell'}): wall ${measured(profile.wallMs)}, slot wait ${measured(profile.waitMs)}`;
  const rows = [...(profile.files ?? [])].filter(file => typeof file.path === 'string' && Number.isFinite(file.durationMs) && file.durationMs >= 0).sort((left, right) => right.durationMs - left.durationMs).slice(0, 10);
  const files = rows.length ? `\nslowest test files:\n${rows.map(file => `  ${file.path}: ${(file.durationMs / 1000).toFixed(2)}s`).join('\n')}` : '';
  return `${summary}${profile.unavailable ? `\n${profile.unavailable}` : ''}${files}`;
}

/**
 * What an agent sees of a gate run (V10): one line when green; when red, the digest and where the
 * whole output is.
 *
 * @param {{ isGreen: boolean, isCached: boolean, output: string, seconds: number, log: string, profile?: object, profilePath?: string }} gate
 * @returns {string}
 */
export function gateReport(gate) {
  const timings = timingDigest(gate.profile);
  const profilePath = timings && gate.profilePath ? `\ntiming profile: ${gate.profilePath}` : '';
  if (gate.isGreen) {
    const summary = gate.isCached ? 'gate green (this tree already passed)' : `gate green in ${gate.seconds}s`;
    if (!gate.profile?.files?.length) return timings ? `${summary}; ${timings.replaceAll('\n', '; ')}${gate.profilePath ? `; timing profile: ${gate.profilePath}` : ''}` : summary;
    return `${summary}\n${timings}${profilePath}`;
  }
  return `gate red in ${gate.seconds}s:\n${digestOf(gate.output).replace(/^/gm, '  ')}\n${timings ? `${timings}\n` : ''}the whole output is in ${gate.log}${profilePath}`;
}
