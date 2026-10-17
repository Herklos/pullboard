/**
 * The gate (V4, C3, Q1, Q2, V18): the repo's check command and shared queue for gates and item checks. A green
 * run over a committed tree, with nothing untracked and nothing changed while it ran, leaves that
 * tree's id in the git dir, so the same tree is never checked twice. An agent sees a digest of the
 * run, not the run (V10): a passing suite's output costs tokens and says nothing.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { gitChildEnv, gitPath, headTree, invalidateGitFacts, isClean, untracked } from './git.js';
import { secretsIn } from './hooks.js';
import { Refused } from './refused.js';
import { GATE_SLOT_HELD_ENV, gateSlotEnvironment, inheritedGateSlot, takeResource } from './resources.js';
import { browserFreeChecksEnabled, gateShortSlots, loadMachineSettings } from './settings.js';
import { selectAffectedTests } from './affected-tests.js';
import { checkNeedsBrowser, testsNeedBrowser } from './browser-admission.js';
import { timingFromOutput, timingRunner } from './timing.js';
import { landingShardProfile } from './landing-shards.js';
import { RunnerDropped, runOnRunner, runOnRunnerAsync, runnerSource } from './runners.js';

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
 * How many shards the landing gate's test files split into: `landingShards` in pullboard.json,
 * 1 when absent, which keeps today's single run.
 *
 * @param {string} root
 * @returns {number}
 */
export function landingShardCount(root) {
  const file = join(root, 'pullboard.json');
  if (!existsSync(file)) return 1;
  let config;
  try { config = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Refused('BAD_CONFIG', 'pullboard.json must be valid JSON before running tests'); }
  const count = config?.landingShards ?? 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > 64) {
    throw new Refused('BAD_CONFIG', 'landingShards must be a whole number from 1 to 64; set it in pullboard.json, or remove it for one landing run');
  }
  return count;
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
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { isGreen: result.status === 0, output, seconds: Math.round((Date.now() - started) / 1000),
    sandboxBlocked: result.status === 0 ? null : sandboxBlockedOperation(root, output) };
}

/** Resolve existing path prefixes so a symlink cannot hide an outside-worktree operation. */
function diagnosticPath(path) {
  let current = resolve(path);
  const missing = [];
  for (;;) {
    try { return resolve(realpathSync(current), ...missing); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
      const parent = dirname(current);
      if (parent === current) return null;
      missing.unshift(relative(parent, current));
      current = parent;
    }
  }
}

/** Describe one OS permission message, resolving file targets against the command's worktree. */
function permissionOperation(root, message, { includeFilePaths = true } = {}) {
  const network = /^(listen|bind) (EPERM|EACCES)\b/u.exec(message);
  if (network) return { code: network[2], syscall: network[1], operation: `${network[1]} (${network[2]})` };
  if (!includeFilePaths) return null;
  const file = /^(EPERM|EACCES): [^\n]*?, (open|mkdir|read|write|rename|unlink|scandir|access) (['"])([^\n]+?)\3(?= -> |$)/u.exec(message);
  const python = /^PermissionError: \[Errno (?:1|13)\] [^\n]*?: ['"]([^'"\n]+)['"]/u.exec(message);
  if (!file && !python) return null;
  const path = diagnosticPath(resolve(root, file ? file[4] : python[1]));
  const tree = diagnosticPath(root);
  if (!path || !tree) return null;
  const within = relative(tree, path);
  if (within !== '..' && !within.startsWith('../') && !isAbsolute(within)) return null;
  const code = file ? file[1] : 'EACCES';
  return { code, path, syscall: file ? file[2] : null,
    operation: `${file ? file[2] : 'file access'} ${JSON.stringify(path)} (${code})` };
}

/** Decode the single-line quoted YAML scalars emitted by Node's TAP reporter. */
function tapScalar(value) {
  if (value.startsWith('"')) {
    try { return JSON.parse(value); } catch { return null; }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/gu, "'");
  return /^[A-Z_]+$/u.test(value) ? value : null;
}

/** Scan complete lines with bounded TAP state so assertion messages cannot impersonate OS codes. */
export function sandboxBlockedScanner(root, { includeFilePaths = true } = {}) {
  let failureIndent = null;
  let fieldIndent = null;
  let permission = null;
  let code = null;
  let comment = null;
  let startup = null;
  let failureMessage = null;
  let failureType = false;
  let exitCode = null;
  /** Retain one pending fatal diagnostic and the current failed TAP record. */
  return (raw) => {
    const line = raw.trim().replace(/^#\s*/u, '');
    const indent = raw.length - raw.trimStart().length;
    // Node's TAP reporter prints test-console output as comments and assertion details
    // as indented YAML. Neither is a standalone gate diagnostic, even when it contains
    // text that looks exactly like an operating-system denial.
    if (indent === 0 && !raw.startsWith('#') && /^(?:Error: |PermissionError: )/u.test(line)) {
      const direct = permissionOperation(root, line.replace(/^Error: /u, ''), { includeFilePaths });
      if (direct) return direct.operation;
    }
    if (/^TAP version \d+$/u.test(raw)) {
      comment = null; startup = null;
      failureIndent = null; fieldIndent = null; permission = null; code = null;
      failureMessage = null; failureType = false; exitCode = null;
    }
    // Uncaught module-load errors are comments too. Keep their complete Node fatal
    // diagnostic pending; it is evidence only if the following file record failed
    // to start. A test logging a caught error and then asserting is not that record.
    if (indent === 0 && raw.startsWith('#')) {
      if (line.startsWith('Error: ')) {
        const operation = permissionOperation(root, line.slice('Error: '.length), { includeFilePaths });
        comment = operation ? { operation, code: null, syscall: null, path: null, closed: false, fatal: false } : null;
      } else if (comment) {
        const field = /^(code|syscall|path): (.*)$/u.exec(line);
        if (field) comment[field[1]] = tapScalar(field[2].replace(/,$/u, ''));
        else if (line === '}') comment.closed = true;
        else if (/^Node\.js v\d+\./u.test(line)) comment.fatal = true;
        else if (line && !/^at |^errno: |^address: |^port: /u.test(line)
          && !(comment.closed && comment.fatal && line.startsWith('Subtest: '))) comment = null;
      }
    }
    if (/^(?:not )?ok \d+\b/u.test(line)) {
      failureIndent = /^not ok /u.test(line) ? indent : null;
      const operation = comment?.operation;
      startup = failureIndent !== null && comment?.closed && comment.fatal
        && comment.code === operation.code && comment.syscall === operation.syscall
        && (!operation.path || (typeof comment.path === 'string'
          && diagnosticPath(resolve(root, comment.path)) === operation.path)) ? operation : null;
      comment = null;
      fieldIndent = null; permission = null; code = null;
      failureMessage = null; failureType = false; exitCode = null;
    } else if (line === '---' && failureIndent !== null && indent === failureIndent + 2) {
      fieldIndent = indent;
    } else if (line === '...' && indent === fieldIndent) {
      failureIndent = null; fieldIndent = null; permission = null; code = null;
      startup = null; comment = null;
      failureMessage = null; failureType = false; exitCode = null;
    } else if (fieldIndent !== null && indent === fieldIndent) {
      const field = /^(error|code|failureType|exitCode): (.*)$/u.exec(line);
      if (field) {
        const value = tapScalar(field[2]);
        if (field[1] === 'error') {
          failureMessage = value;
          permission = typeof value === 'string' ? permissionOperation(root, value, { includeFilePaths }) : null;
        } else if (field[1] === 'code') {
          code = value;
          if (code !== 'ERR_TEST_FAILURE') startup = null;
        } else if (field[1] === 'failureType') failureType = value === 'testCodeFailure' || field[2] === 'testCodeFailure';
        else exitCode = /^[1-9]\d*$/u.test(field[2]) && Number.isSafeInteger(Number(field[2])) ? Number(field[2]) : null;
        if (permission && permission.code === code) return permission.operation;
        if (startup && code === 'ERR_TEST_FAILURE' && failureMessage === 'test failed'
          && failureType && exitCode !== null) return startup.operation;
      }
    }
    return null;
  };
}

/** Recognize concrete OS permission diagnostics, keeping ordinary assertion failures ordinary. */
export function sandboxBlockedOperation(root, output, options) {
  const scan = sandboxBlockedScanner(root, options);
  for (const line of output.split('\n')) {
    const operation = scan(line);
    if (operation) return operation;
  }
  return null;
}

/** Refuse an environment-blocked proof after its ordinary raw logs and timings are persisted. */
export function refuseSandboxBlocked(run) {
  if (run.sandboxBlocked) throw new Refused('SANDBOX_BLOCKED',
    `The environment refused ${run.sandboxBlocked}. Ask the person to allow this operation, or run the gate outside the sandbox; keep the tests unchanged.`);
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
    ...(gateLease && !gateLease.runner ? gateSlotEnvironment(gateLease) : gateSlotHeld ? { [GATE_SLOT_HELD_ENV]: '1' } : {}),
    [LANDING_RUN_ENV]: landing ? '1' : '0',
  };
  const run = gateLease?.runner ? runOnRunner(root, command, { runner: gateLease.runner, source: gateLease.source,
    browser: gateLease.browser, pipefail, metadata: { ...(gateLease.runMetadata ?? {}), landing } }) : runShell(root, command, { pipefail, env: inherited });
  const sandboxBlocked = run.isGreen ? null : run.sandboxBlocked ?? (run.executionRunner
    // The controller cannot realpath remote files; retain the network denial signal without treating remote paths as local paths.
    ? sandboxBlockedOperation(root, run.output, { includeFilePaths: false })
    : sandboxBlockedOperation(root, run.output));
  const profiledRun = { ...run, sandboxBlocked };
  const profile = writeTimingProfile(profilePath, {
    ...runTiming(profiledRun, command),
    waitMs: Math.max(0, Math.round(waitMs)), wallMs: Math.max(0, Date.now() - started),
  });
  if (logPath) writeFileSync(logPath, safeLog(run.output), { mode: 0o600 });
  return { ...profiledRun, profile, profilePath, logPath };
}

/** Run an independent focused comparison without blocking other holders of the machine pool.
 * @param {string} root
 * @param {string} command
 * @param {{ waitMs?: number, gateSlotHeld?: boolean, gateLease?: object, landing?: boolean }} [options]
 * @returns {Promise<object>} The unchanged shell verdict and its private timing profile.
 */
export async function runProfiledShellAsync(root, command, { waitMs = 0, gateSlotHeld = false, gateLease, landing = false } = {}) {
  const started = Date.now();
  if (gateLease?.runner) {
    const run = await runOnRunnerAsync(root, command, { runner: gateLease.runner, source: gateLease.source,
      browser: gateLease.browser, metadata: { ...(gateLease.runMetadata ?? {}), landing } });
    const wallMs = Math.max(0, Date.now() - started);
    const profilePath = join(dirname(gitPath(root, LOG)), `pullboard-gate-${randomUUID()}.profile.json`);
    const sandboxBlocked = run.isGreen ? null : run.sandboxBlocked
      ?? sandboxBlockedOperation(root, run.output, { includeFilePaths: false });
    const profile = writeTimingProfile(profilePath, { ...runTiming(run, command), waitMs, wallMs });
    return { ...run, sandboxBlocked, seconds: Math.round(wallMs / 1000), profile, profilePath, logPath: null };
  }
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
  return { isGreen: status === 0 && !overflow && !failure, sandboxBlocked: status === 0 ? null : sandboxBlockedOperation(root, output), output, seconds: Math.round(wallMs / 1000), profile, profilePath, logPath: null };
}

/** Keep raw remote TAP intact while resolving its measured filenames against the local source. */
function runTiming(run, command) {
  const shards = landingShardProfile(run.output);
  const profile = { ...timingFromOutput(run.output, timingRunner(command)), ...(shards ? { landingShards: shards } : {}) };
  if (!run.executionRunner) return profile;
  /** Relocate only paths inside the actual remote checkout, never a foreign absolute path. */
  const localPath = path => {
    if (typeof path !== 'string') return path;
    const original = path;
    if (path.startsWith('file:')) {
      try { path = fileURLToPath(path); } catch { return original; }
    }
    if (!isAbsolute(path)) return original;
    const suffix = relative(run.executionRoot, path);
    return suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix) ? suffix : original;
  };
  return { ...profile, executionRunner: run.executionRunner, executionSource: run.executionSource,
    files: (profile.files ?? []).map(file => ({ ...file, path: localPath(file.path) })),
    tests: (profile.tests ?? []).map(test => ({ ...test, file: localPath(test.file) })) };
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
    ...(profile.executionRunner ? { executionRunner: sanitize(profile.executionRunner, 'execution runner') } : {}),
    ...(profile.landingShards ? { landingShards: {
      balance: sanitize(String(profile.landingShards.balance ?? 'unknown'), 'landing balance'),
      unverified: (profile.landingShards.unverified ?? []).map(entry => ({ shard: sanitize(String(entry.shard), 'landing unverified shard'),
        processes: sanitize(String(entry.processes), 'landing unverified processes') })),
      quarantined: (profile.landingShards.quarantined ?? []).map(entry => ({ host: sanitize(String(entry.host), 'landing quarantine host'),
        message: sanitize(String(entry.message), 'landing quarantine message') })),
      floor: profile.landingShards.floor && validDuration(profile.landingShards.floor.ms)
        ? { path: sanitize(String(profile.landingShards.floor.path), 'landing floor path'), ms: profile.landingShards.floor.ms } : null,
      // One entry per attempt, so a failed runner attempt stays beside its local rerun.
      shards: (profile.landingShards.shards ?? []).map(shard => ({ shard: sanitize(String(shard.shard), 'landing shard'),
        attempt: Number.isSafeInteger(shard.attempt) ? shard.attempt : 1,
        host: sanitize(String(shard.host), 'landing shard host'), status: sanitize(String(shard.status), 'landing shard status'),
        reason: shard.reason ? sanitize(String(shard.reason), 'landing shard reason') : null,
        wallMs: validDuration(shard.wallMs) ? shard.wallMs : null })),
      files: (profile.landingShards.files ?? []).filter(file => typeof file?.path === 'string').map(file => ({
        path: sanitize(file.path, 'landing file path'), shard: sanitize(String(file.shard), 'landing file shard'),
        host: sanitize(String(file.host), 'landing file host'), durationMs: validDuration(file.durationMs) ? file.durationMs : null })),
    } } : {}),
    ...(profile.executionSource ? { executionSource: {
      commit: sanitize(profile.executionSource.commit, 'execution commit'),
      tree: sanitize(profile.executionSource.tree, 'execution tree'),
      tooling: Object.fromEntries(Object.entries(profile.executionSource.tooling ?? {})
        .filter(([key]) => ['kind', 'name', 'version', 'commit', 'tree', 'sha256'].includes(key))
        .map(([key, value]) => [key, sanitize(value, `execution tooling ${key}`)])),
    } } : {}),
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
 *
 * @param {string} root - Checkout used to locate the machine resource database.
 * shortEligible marks a run that names its test files: with gate.shortSlots above 0 it may take a
 * short slot when every ordinary slot is held, and a full suite can never inherit that slot.
 *
 * @param {(lease: { waitMs: number, token?: string, pool?: string, browser?: boolean, slotClass?: 'gate'|'short', release: () => void }) => any | Promise<any>} action - Work to perform while holding a slot.
 * @param {{ landing?: boolean, itemCheck?: boolean, shortEligible?: boolean, diagnostic?: boolean, browser?: boolean, agent?: string, item?: string|number, kind?: string, onWait?: (state: object) => void }} [options] - Queue class and progress reporter.
 * @returns {Promise<any>} The action's result after releasing its lease.
 */
export async function withGateSlot(root, action, { landing = false, itemCheck = false, shortEligible = false, diagnostic = false, browser = false, remote = true, agent, item = '', kind = '', onWait } = {}) {
  const inherited = inheritedGateSlot({ root, browser, namedFiles: shortEligible });
  if (inherited) {
    try { return await action(inherited); }
    finally { inherited.release(); }
  }
  const settingsProvider = () => loadMachineSettings();
  const capacityProvider = () => settingsProvider().gateSlots;
  const source = runnerSource(root);
  let lease = await takeResource({
    name: 'gate',
    capacity: capacityProvider(),
    capacityProvider,
    shortCapacityProvider: () => gateShortSlots(),
    shortEligible,
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
    remote: remote && Boolean(source),
    runnerProvider: () => loadMachineSettings().runners ?? [],
    onWait,
  });
  try {
    while (true) {
      lease.source = source;
      lease.runMetadata = { landing, itemCheck, diagnostic, item: String(item), kind };
      try { return await action(lease); }
      catch (error) {
        if (!(error instanceof RunnerDropped) || !lease.runner || !lease.requeueRunner) throw error;
        const runnerUnavailable = { host: lease.runner.host, reason: 'transport lost before a complete result', until: 'the host is checked and re-registered' };
        if (onWait) await onWait({ holders: [], line: [], position: 0, runnerUnavailable });
        else process.stderr.write(`runner ${runnerUnavailable.host} unavailable: ${runnerUnavailable.reason}; until ${runnerUnavailable.until}; requeueing the run\n`);
        lease = await lease.requeueRunner('transport-lost');
      }
    }
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
  const run = runProfiledShell(root, config.gate, { waitMs, pipefail: true, profileFile: `${log}.profile.json`, gateLease, landing });
  const { isGreen, output, seconds, profile, profilePath } = run;
  writeFileSync(log, output);
  refuseSandboxBlocked(run);
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
  const invariants = deferred ? [...new Set(config.submitInvariants ?? [])].sort() : [];
  if (invariants.length && !config.affectedTests?.trim()) {
    throw new Refused('BAD_CONFIG', 'submitInvariants requires the project affectedTests runner');
  }
  for (const path of invariants) {
    let file = false;
    try { file = statSync(join(root, path)).isFile(); } catch { /* Missing or unreadable invariants refuse rather than silently disappearing. */ }
    if (!file) throw new Refused('BAD_CONFIG', `submitInvariants file ${path} is missing or unreadable; restore it or update the list on accepted main`);
  }
  const proofFiles = [...new Set([...(deferFullFallback ? [] : selection.files), ...invariants])].sort();
  const allowBrowserFreeChecks = browserFreeChecksEnabled();
  const checkUsesBrowser = check ? (!allowBrowserFreeChecks || await checkNeedsBrowser(root, check, { onFallback: onBrowserFallback })) : false;
  const proofUsesBrowser = deferFullFallback
    ? (proofFiles.length > 0 && (!allowBrowserFreeChecks || await testsNeedBrowser(root, proofFiles, { onFallback: onBrowserFallback })))
    : (selection.full || !allowBrowserFreeChecks || await testsNeedBrowser(root, proofFiles, { onFallback: onBrowserFallback }));
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
        ...(lease.runner ? { executionRunner: lease.runner.host,
          executionSource: profiles.find(value => value.executionSource)?.executionSource } : {}),
      });
      refuseSandboxBlocked(proof);
      return { ...proof, log, seconds: criterion.seconds + proof.seconds, ...selection, ...(deferred ? { files: proofFiles, submitInvariants: invariants } : {}), deferred, deferFullFallback, check: receipt,
        profile, profilePath, proofProfilePath: proof.profilePath, proofLog: proof.log };
    };
    if (!criterion.isGreen) {
      writeFileSync(log, criterion.output);
      return finish({ isGreen: false, sandboxBlocked: criterion.sandboxBlocked, isCached: false, output: criterion.output, seconds: 0, log: '' });
    }
    // The proof already owns this lease: its phase profile has no additional queue wait.
    const proofWait = check ? 0 : lease.waitMs;
    let proof;
    if (!deferFullFallback && selection.full) proof = fullGateRun(root, config, false, { waitMs: proofWait, log: proofLog, gateLease: lease });
    else if (!proofFiles.length) proof = { isGreen: true, output: '', seconds: 0, isCached: false, log: '' };
    else {
      const command = `${config.affectedTests.trimEnd()} ${proofFiles.map(path => commandWord('./' + path)).join(' ')}`;
      proof = { ...runProfiledShell(root, command, { waitMs: proofWait, profileFile: `${proofLog}.profile.json`, gateLease: lease }), isCached: false, log: proofLog };
      writeFileSync(proofLog, proof.output);
    }
    const phase = deferFullFallback ? `submit invariants: ${invariants.length ? invariants.join(', ') : 'none'}; full suite deferred to the landing gate` : selection.full ? 'full gate' : 'affected tests';
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
      ? `${gate.submitInvariants?.length ? 'submit invariants: ' + gate.submitInvariants.join(', ') + '; ' : ''}full suite deferred to the landing gate${reason}`
      : `affected tests: ${gate.files.length ? gate.files.join(', ') : 'none'}; full suite deferred to the landing gate${gate.submitInvariants?.length ? '; submit invariants: ' + gate.submitInvariants.join(', ') : ''}`;
    const result = gate.deferFullFallback && !gate.submitInvariants?.length ? '' : `; ${gate.isGreen ? `${gate.deferFullFallback ? 'submit invariants' : 'affected tests'} green in ${gate.seconds}s` : gateReport(gate)}`;
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
  const summary = `timing (${profile.runner ?? 'shell'}${profile.executionRunner ? ` on runner ${profile.executionRunner}` : ''}): wall ${measured(profile.wallMs)}, slot wait ${measured(profile.waitMs)}`;
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
