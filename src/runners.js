/** Exact committed source and bounded, credential-free SSH execution for machine runners [C7]. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFromSource, defaults } from './config.js';
import { blockedPaths, secretsIn } from './hooks.js';
import { cleanGitEnvironment, headCommit, headTree, isClean, untracked } from './git.js';
import { Refused } from './refused.js';

const MAX_OUTPUT_BYTES = 1024 ** 3;
const MAX_BLOB_BYTES = 8 * 1024 ** 2;
const TOOL_ROOT = fileURLToPath(new URL('../', import.meta.url));
const RUNTIME_NAMES = ['resources.js', 'git.js', 'machine-home.js', 'refused.js'];

/** Validate an SSH destination as one argument, never a command or an SSH option. */
export function validateRunner(value) {
  if (!value || typeof value.host !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@:\[\]-]{0,254}$/u.test(value.host)
    || !Number.isSafeInteger(value.slots) || value.slots < 1
    || !Number.isSafeInteger(value.browser) || value.browser < 0 || value.browser > value.slots) {
    throw new Refused('BAD_RUNNER', 'use an SSH host or alias, positive --slots, and --browser from zero through slots');
  }
  for (const key of ['node', 'root']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || /[\u0000-\u001f\u007f]/u.test(value[key])
      || !(value[key].startsWith('/') && value[key].length > 1 || key === 'node' && value[key] === 'node'))) {
      throw new Refused('BAD_RUNNER', `runner ${key} must be an absolute remote path${key === 'node' ? ' or node' : ''}`);
    }
  }
  return { host: value.host, slots: value.slots, browser: value.browser,
    ...(value.node ? { node: value.node } : {}), ...(value.root ? { root: value.root } : {}) };
}

/** Dirty or non-repository commands cannot claim to execute an exact committed source remotely. */
export function runnerSource(root) {
  try {
    if (!isClean(root) || untracked(root).length) return null;
    return { commit: headCommit(root), tree: headTree(root) };
  } catch { return null; }
}

/** A missing authenticated completion receipt is a transport loss, never a passing test result. */
export class RunnerDropped extends Error {
  constructor(host) {
    super(`runner ${host} disconnected before a complete result; the run returns to the queue`);
    this.name = 'RunnerDropped';
    this.host = host;
  }
}

/** Run a source-only Git read without inherited Git configuration, hooks or replacement objects. */
function sourceGit(root, args, options = {}) {
  const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: MAX_BLOB_BYTES, ...options,
  });
  if (result.status !== 0) throw new Refused('RUNNER_SOURCE', 'cannot read the exact committed source; check Git and retry the run');
  return result.stdout;
}

/** Scan every current blob and the commit message before any source bytes leave the controller. */
function sourceObjects(root, source) {
  const records = sourceGit(root, ['ls-tree', '-r', '-z', '--full-tree', source.commit]).split('\0').filter(Boolean);
  // Protection is pinned to the admitted commit, never a concurrently edited working file.
  const configRecord = records.find(record => record.endsWith('\tpullboard.json'));
  const configObject = configRecord?.match(/^\d+ blob ([a-f0-9]{40,64})\t/u)?.[1];
  const config = configObject ? configFromSource(sourceGit(root, ['cat-file', 'blob', configObject])) : defaults();
  const blobs = [];
  for (const record of records) {
    const match = /^(\d+) (\w+) ([a-f0-9]{40,64})\t([\s\S]+)$/u.exec(record);
    if (!match || match[2] !== 'blob') throw new Refused('RUNNER_SOURCE', 'runner source contains a submodule or unsupported object; keep this run local');
    const [, , , object, path] = match;
    if (blockedPaths([path], config.protect).length || /(?:^|\/)board\.sqlite(?:-(?:wal|shm))?$/u.test(path)) {
      throw new Refused('RUNNER_SECRET', 'committed runner source includes a blocked private file; remove it before remote execution');
    }
    const size = Number(sourceGit(root, ['cat-file', '-s', object]).trim());
    if (!Number.isSafeInteger(size) || size > MAX_BLOB_BYTES) {
      throw new Refused('RUNNER_SCAN_LIMIT', 'a committed blob exceeds the safe runner scan limit; keep the run local or reduce that file');
    }
    const text = sourceGit(root, ['cat-file', 'blob', object]);
    const findings = secretsIn(text.split(/\r?\n/u).map((line, index) => ({ path, line: index + 1, text: line })));
    if (findings.length) throw new Refused('RUNNER_SECRET', `source leak scan refused ${findings[0]}; remove the secret before remote execution`);
    blobs.push(object);
  }
  const commit = sourceGit(root, ['cat-file', 'commit', source.commit]);
  if (secretsIn(commit.split('\n').map((text, index) => ({ path: 'commit', line: index + 1, text }))).length) {
    throw new Refused('RUNNER_SECRET', 'the commit metadata contains a possible secret; keep this run local and correct the metadata');
  }
  // Tree traversal includes all current trees and blobs, but never follows commit parents.
  const objects = sourceGit(root, ['rev-list', '--objects', `${source.commit}^{tree}`])
    .split('\n').filter(Boolean).map(line => line.split(' ')[0]);
  return [...new Set([source.commit, ...objects, ...blobs])];
}

/** Quote one remote shell argument without permitting substitutions or expansion. */
function shellWord(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

/** Give the SSH client connection necessities only; arbitrary caller secrets cannot be forwarded. */
function sshEnvironment() {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK', 'TMPDIR', 'SystemRoot', 'WINDIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' };
}

/** Snapshot, scan and pin the actual tooling bytes independently of the project being tested. */
function trustedTooling() {
  const files = Object.fromEntries([...RUNTIME_NAMES, 'runner-worker.js']
    .map(name => [name, readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8')]));
  for (const [name, source] of Object.entries(files)) {
    if (Buffer.byteLength(source) > MAX_BLOB_BYTES
      || secretsIn(source.split(/\r?\n/u).map((text, index) => ({ path: `tooling/${name}`, line: index + 1, text }))).length) {
      throw new Refused('RUNNER_TOOLING_SECRET', 'the selected runner tooling failed its transfer scan; restore a trusted Pullboard installation');
    }
  }
  const manifest = JSON.parse(readFileSync(join(TOOL_ROOT, 'package.json'), 'utf8'));
  if (manifest.name !== 'pullboard' || typeof manifest.version !== 'string') {
    throw new Refused('RUNNER_TOOLING_IDENTITY', 'runner tooling must come from a named Pullboard installation; reinstall Pullboard');
  }
  let provenance = { kind: 'installed-package', name: manifest.name, version: manifest.version };
  if (existsSync(join(TOOL_ROOT, '.git'))) {
    const selected = runnerSource(TOOL_ROOT);
    if (!selected || Object.entries(files).some(([name, source]) => sourceGit(TOOL_ROOT, ['show', `${selected.commit}:src/${name}`]) !== source)) {
      throw new Refused('RUNNER_TOOLING_CHANGED', 'runner tooling differs from its selected committed revision; restore or commit the tooling before remote execution');
    }
    provenance = { ...provenance, kind: 'git-checkout', ...selected };
  }
  const tooling = { ...provenance, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
  const runtimeFiles = Object.fromEntries(RUNTIME_NAMES.map(name => [name, files[name]]));
  return { worker: files['runner-worker.js'], tooling,
    runtime: { files: runtimeFiles, sha256: createHash('sha256').update(JSON.stringify(runtimeFiles)).digest('hex') } };
}

/** Prepare a single shallow object pack and an explicit worker request; cleanup owns only its scratch directory. */
function requestFor(root, command, { runner, source, browser = false, pipefail = false, metadata = {} }) {
  runner = validateRunner(runner);
  const current = runnerSource(root);
  if (!current || (source && (current.commit !== source.commit || current.tree !== source.tree))) {
    throw new Refused('RUNNER_SOURCE_CHANGED', 'the queued source changed; restore the committed tree and retry the run');
  }
  if (secretsIn(command.split('\n').map((text, index) => ({ path: 'run command', line: index + 1, text }))).length) {
    throw new Refused('RUNNER_SECRET', 'the run command contains a possible secret; use a command that does not transfer credentials');
  }
  const objects = sourceObjects(root, current);
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-runner-send-'));
  let descriptor;
  try {
    const { worker, tooling, runtime } = trustedTooling();
    const spec = { version: 1, id: randomUUID(), runtime, tooling, ...current, command, pipefail, slots: runner.slots,
      browser: runner.browser, browserRequired: browser, landing: metadata.landing === true,
      itemCheck: metadata.itemCheck === true, diagnostic: metadata.diagnostic === true,
      item: String(metadata.item ?? ''), kind: String(metadata.kind ?? ''), ...(runner.root ? { root: runner.root } : {}) };
    const encodedSpec = Buffer.from(JSON.stringify(spec));
    if (encodedSpec.length > 1024 ** 2) throw new Refused('RUNNER_REQUEST_LIMIT', 'runner tooling request exceeds its safe transfer limit; keep this run local');
    const framed = join(directory, 'request.bin');
    const requestOutput = openSync(framed, 'wx', 0o600);
    try {
      writeSync(requestOutput, Buffer.from(`${encodedSpec.length}\n`));
      writeSync(requestOutput, encodedSpec);
      sourceGit(root, ['pack-objects', '--stdout'], { input: `${objects.join('\n')}\n`, stdio: ['pipe', requestOutput, 'pipe'] });
    } finally { closeSync(requestOutput); }
    descriptor = openSync(framed, 'r');
    const remote = `${shellWord(runner.node ?? 'node')} --input-type=module -e ${shellWord(worker)}`;
    // These are transport hang ceilings, independent of the command's execution budget.
    return { spec, runner, args: ['-T', '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
      '-o', 'SendEnv=-*', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
      '--', runner.host, remote], descriptor, env: sshEnvironment(),
    cleanup() { closeSync(descriptor); rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Verify exact source and complete raw output before accepting any remote status. */
function resultFrom(request, result) {
  const output = result.stdout ?? Buffer.alloc(0);
  const lines = String(result.stderr ?? '').split(/\r?\n/u);
  const prefix = `PULLBOARD_RUNNER_RESULT ${request.spec.id} `;
  const receipts = lines.filter(line => line.startsWith(prefix));
  let receipt;
  try {
    if (receipts.length !== 1) throw new Error('missing receipt');
    receipt = JSON.parse(Buffer.from(receipts[0].slice(prefix.length), 'base64').toString('utf8'));
  } catch { throw new RunnerDropped(request.runner.host); }
  if (result.error || result.status !== 0 || receipt.id !== request.spec.id || receipt.commit !== request.spec.commit
    || receipt.tree !== request.spec.tree || receipt.runtimeSha256 !== request.spec.runtime.sha256 || receipt.toolingSha256 !== request.spec.tooling.sha256 || !Number.isInteger(receipt.code) || receipt.code < 0 || receipt.code > 255
    || typeof receipt.root !== 'string' || !Number.isFinite(receipt.wallMs) || receipt.wallMs < 0
    || receipt.outputSha256 !== createHash('sha256').update(output).digest('hex')) {
    throw new RunnerDropped(request.runner.host);
  }
  return { isGreen: receipt.code === 0 && !receipt.signal, output: output.toString('utf8'),
    seconds: Math.round(receipt.wallMs / 1000), exitCode: receipt.code,
    executionRunner: request.runner.host, executionRoot: receipt.root, remoteWallMs: receipt.wallMs,
    executionSource: { commit: receipt.commit, tree: receipt.tree, tooling: request.spec.tooling } };
}

/** Execute one committed command over SSH; an authentic test failure remains a test failure. */
export function runOnRunner(root, command, options) {
  const request = requestFor(root, command, options);
  try {
    const result = spawnSync('ssh', request.args, { env: request.env, stdio: [request.descriptor, 'pipe', 'pipe'], maxBuffer: MAX_OUTPUT_BYTES });
    return resultFrom(request, result);
  } finally { request.cleanup(); }
}

/** Execute a comparison asynchronously without blocking other local queue holders. */
export async function runOnRunnerAsync(root, command, options) {
  const request = requestFor(root, command, options);
  try {
    const child = spawn('ssh', request.args, { env: request.env, stdio: [request.descriptor, 'pipe', 'pipe'] });
    const output = [], diagnostics = [];
    let bytes = 0, error;
    /** Bound both protocol streams before appending buffers to a result. */
    const capture = (target, chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { error = new Error('runner output exceeded limit'); child.kill(); }
      else target.push(chunk);
    };
    child.stdout.on('data', chunk => capture(output, chunk));
    child.stderr.on('data', chunk => capture(diagnostics, chunk));
    child.once('error', failure => { error = failure; });
    const status = await new Promise(resolve => child.once('close', resolve));
    return resultFrom(request, { status, error, stdout: Buffer.concat(output), stderr: Buffer.concat(diagnostics) });
  } finally { request.cleanup(); }
}
