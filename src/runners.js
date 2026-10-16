/** Exact committed source and bounded, credential-free SSH execution for machine runners [C7]. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, createReadStream, existsSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { configFromSource, defaults } from './config.js';
import { blockedPaths, secretsIn } from './hooks.js';
import { cleanGitEnvironment, headCommit, headTree, isClean, repoInfo, untracked } from './git.js';
import { Refused } from './refused.js';

// Budget: 64 MiB bounds worst-case JSON bridge escaping below Node string limits.
const MAX_OUTPUT_BYTES = 64 * 1024 ** 2;
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
  }
  const commit = sourceGit(root, ['cat-file', 'commit', source.commit]);
  if (secretsIn(commit.split('\n').map((text, index) => ({ path: 'commit', line: index + 1, text }))).length) {
    throw new Refused('RUNNER_SECRET', 'the commit metadata contains a possible secret; keep this run local and correct the metadata');
  }
  return config.protect;
}

/** Reject blocked historical paths as well as current ones before an object pack crosses SSH. */
function protectedHistoryPath(path, protect) {
  return blockedPaths([path], protect).length || /(?:^|\/)board\.sqlite(?:-(?:wal|shm))?$/u.test(path);
}

/** Apply current protection rules to all selected historical names before any anonymous cache seed. */
function protectHistory(root, source, protect) {
  const paths = [...new Set(sourceGit(root, ['log', '--format=', '--name-only', '-z', '--no-renames', '--root', '-m', '--full-history', source.commit])
    .split('\0').filter(Boolean))];
  if (paths.some(path => protectedHistoryPath(path, protect))) {
    throw new Refused('RUNNER_SECRET', 'selected history includes a blocked private path; keep this run local or remove that private history');
  }
}

/** Select a locally known published ancestor, never an anonymous origin's unchecked latest tip. */
function originAncestor(root, source) {
  const tip = sourceGit(root, ['for-each-ref', '--format=%(objectname)', 'refs/remotes/origin']).split('\n')
    .find(value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value));
  if (!tip) return undefined;
  const result = spawnSync('git', ['--no-replace-objects', 'merge-base', source.commit, tip], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 4096,
  });
  const base = result.stdout?.trim();
  return result.status === 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(base) ? base : undefined;
}

/** Read one exact cat-file record without loading a repository's history into memory. */
function objectRecord(descriptor) {
  const header = [];
  const byte = Buffer.alloc(1);
  while (readSync(descriptor, byte, 0, 1, null)) {
    if (byte[0] === 10) break;
    if (header.length > 200) throw new Refused('RUNNER_SOURCE', 'invalid source object header; keep this run local');
    header.push(byte[0]);
  }
  const match = /^([a-f0-9]{40,64}) (blob|tree|commit|tag) (\d+)$/u.exec(Buffer.from(header).toString('ascii'));
  if (!match) throw new Refused('RUNNER_SOURCE', 'cannot scan the selected history objects; keep this run local');
  const size = Number(match[3]);
  if (!Number.isSafeInteger(size) || size > MAX_BLOB_BYTES) throw new Refused('RUNNER_SCAN_LIMIT', 'a historical object exceeds the safe runner scan limit; keep this run local');
  const data = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = readSync(descriptor, data, offset, size - offset, null);
    if (!read) throw new Refused('RUNNER_SOURCE', 'incomplete history object; retry from the committed repository');
    offset += read;
  }
  if (readSync(descriptor, byte, 0, 1, null) !== 1 || byte[0] !== 10) throw new Refused('RUNNER_SOURCE', 'incomplete history object; retry from the committed repository');
  return { object: match[1], type: match[2], data };
}

/** Scan and pack exactly the candidate objects absent from the locked remote cache inventory. */
function historyPack(root, source, tips, directory) {
  const known = sourceGit(root, ['cat-file', '--batch-check'], { input: tips.map(tip => `${tip}\n`).join('') })
    .split('\n').map(line => /^([a-f0-9]{40,64}) commit \d+$/u.exec(line)?.[1]).filter(Boolean);
  const records = sourceGit(root, ['rev-list', '--objects', source.commit, '--not', ...known])
    .split('\n').filter(Boolean).map(line => {
      const match = /^([a-f0-9]{40,64})(?: (.*))?$/u.exec(line);
      if (!match) throw new Refused('RUNNER_SOURCE', 'unsupported history path; keep this run local');
      return { object: match[1], path: match[2] ?? '' };
    });
  const objects = [...new Set(records.map(record => record.object))];
  const names = new Map(records.map(record => [record.object, record.path]));
  const historicalTrees = new Set();
  const config = sourceGit(root, ['ls-tree', '--name-only', source.commit, '--', 'pullboard.json']).trim()
    ? configFromSource(sourceGit(root, ['show', `${source.commit}:pullboard.json`])) : defaults();
  const metadata = sourceGit(root, ['cat-file', '--batch-check'], { input: objects.map(object => `${object}\n`).join('') });
  for (const line of metadata.split('\n').filter(Boolean)) {
    const match = /^[a-f0-9]{40,64} (blob|tree|commit|tag) (\d+)$/u.exec(line);
    if (!match || Number(match[2]) > MAX_BLOB_BYTES) throw new Refused('RUNNER_SCAN_LIMIT', 'a historical object exceeds the safe runner scan limit; keep this run local');
  }
  if (objects.length) {
    const scanFile = join(directory, 'history.scan');
    const output = openSync(scanFile, 'wx', 0o600);
    try { sourceGit(root, ['cat-file', '--batch'], { input: `${objects.join('\n')}\n`, stdio: ['pipe', output, 'pipe'] }); }
    finally { closeSync(output); }
    const input = openSync(scanFile, 'r');
    try {
      for (let index = 0; index < objects.length; index++) {
        const { object, type, data } = objectRecord(input);
        const path = names.get(object) || `history/${object}`;
        if (type === 'commit') {
          const tree = /^tree ([a-f0-9]{40,64})$/mu.exec(data.toString('utf8'))?.[1];
          if (!tree) throw new Refused('RUNNER_SOURCE', 'invalid historical commit; keep this run local');
          historicalTrees.add(tree);
        }
        if (type === 'tree') {
          let cursor = 0;
          while (cursor < data.length) {
            const space = data.indexOf(32, cursor), nul = data.indexOf(0, space + 1);
            if (space < cursor || nul < 0) throw new Refused('RUNNER_SOURCE', 'invalid historical tree; keep this run local');
            const mode = data.subarray(cursor, space).toString('ascii');
            const name = data.subarray(space + 1, nul).toString('utf8');
            const full = names.get(object) ? `${names.get(object)}/${name}` : name;
            if (mode === '160000' || protectedHistoryPath(full, config.protect)
              || secretsIn([{path:'historical tree',line:1,text:name}]).length) throw new Refused('RUNNER_SECRET', 'historical source includes a blocked private path or submodule; keep this run local');
            cursor = nul + 1 + source.commit.length / 2;
          }
          if (cursor !== data.length) throw new Refused('RUNNER_SOURCE', 'invalid historical tree; keep this run local');
        } else if (protectedHistoryPath(path, config.protect)
          || secretsIn(data.toString('utf8').split(/\r?\n/u).map((text, line) => ({ path, line: line + 1, text }))).length) {
          throw new Refused('RUNNER_SECRET', 'historical source failed its transfer scan; remove the private history or keep this run local');
        }
      }
    } finally { closeSync(input); rmSync(scanFile, { force: true }); }
  }
  // Check every full historical path, including reused cached blobs moved beneath a newly blocked prefix.
  for (const tree of historicalTrees) {
    for (const record of sourceGit(root, ['ls-tree', '-r', '-z', '--full-tree', tree]).split('\0').filter(Boolean)) {
      const match = /^(\d+) (\w+) [a-f0-9]{40,64}\t([\s\S]+)$/u.exec(record);
      if (!match || match[2] !== 'blob' || protectedHistoryPath(match[3], config.protect)) {
        throw new Refused('RUNNER_SECRET', 'historical source includes a blocked private path or submodule; keep this run local');
      }
    }
  }
  const pack = join(directory, 'source.pack');
  const output = openSync(pack, 'wx', 0o600);
  try { sourceGit(root, ['pack-objects', '--stdout'], { input: objects.map(object => `${object}\n`).join(''), stdio: ['pipe', output, 'pipe'] }); }
  finally { closeSync(output); }
  return pack;
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

/** Use only a credential-free anonymous HTTPS origin; SSH authentication is never forwarded. */
function anonymousOrigin(root) {
  const result = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 4096 });
  if (result.status !== 0) return undefined;
  let address = result.stdout.trim();
  const ssh = /^git@([A-Za-z0-9][A-Za-z0-9.-]*):([^\s?#]+)$/u.exec(address);
  if (ssh) address = `https://${ssh[1]}/${ssh[2]}`;
  try {
    const url = new URL(address);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname || address.length > 2048) return undefined;
    if (secretsIn([{path:'anonymous origin',line:1,text:address}]).length) return undefined;
    return url.href;
  } catch { return undefined; }
}

/** Prepare the pinned request before negotiating history; cleanup owns only its scratch directory. */
function requestFor(root, command, { runner, source, browser = false, pipefail = false, metadata = {} }) {
  runner = validateRunner(runner);
  const current = runnerSource(root);
  if (!current || (source && (current.commit !== source.commit || current.tree !== source.tree))) {
    throw new Refused('RUNNER_SOURCE_CHANGED', 'the queued source changed; restore the committed tree and retry the run');
  }
  if (secretsIn(command.split('\n').map((text, index) => ({ path: 'run command', line: index + 1, text }))).length) {
    throw new Refused('RUNNER_SECRET', 'the run command contains a possible secret; use a command that does not transfer credentials');
  }
  const protect = sourceObjects(root, current);
  protectHistory(root, current, protect);
  const origin = anonymousOrigin(root);
  const originBase = origin ? originAncestor(root, current) : undefined;
  const repoId = createHash('sha256').update(realpathSync(repoInfo(root).commonDir)).digest('hex');
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-runner-send-'));
  try {
    const { worker, tooling, runtime } = trustedTooling();
    const spec = { version: 1, id: randomUUID(), repoId, ...(originBase ? { origin, originBase } : {}), runtime, tooling, ...current, command, pipefail, slots: runner.slots,
      browser: runner.browser, browserRequired: browser, landing: metadata.landing === true,
      itemCheck: metadata.itemCheck === true, diagnostic: metadata.diagnostic === true,
      item: String(metadata.item ?? ''), kind: String(metadata.kind ?? ''), ...(runner.root ? { root: runner.root } : {}) };
    const encodedSpec = Buffer.from(JSON.stringify(spec));
    if (encodedSpec.length > 1024 ** 2) throw new Refused('RUNNER_REQUEST_LIMIT', 'runner tooling request exceeds its safe transfer limit; keep this run local');
    const remote = `${shellWord(runner.node ?? 'node')} --input-type=module -e ${shellWord(worker)}`;
    // These are transport hang ceilings, independent of the command's execution budget.
    return { spec, runner, args: ['-T', '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
      '-o', 'SendEnv=-*', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
      '--', runner.host, remote], root, source: current, directory, frame: Buffer.concat([Buffer.from(`${encodedSpec.length}\n`), encodedSpec]), env: sshEnvironment(),
    cleanup() { rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) {
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

/** Keep synchronous gate callers on the same negotiated transport as asynchronous comparisons. */
export function runOnRunner(root, command, options) {
  const script = `import { runOnRunnerAsync } from ${JSON.stringify(import.meta.url)};
let input=''; for await (const chunk of process.stdin) input+=chunk;
const request=JSON.parse(input);
const canceled=new AbortController();
const abort=()=>canceled.abort();
process.on('SIGTERM',abort); process.on('SIGHUP',abort); process.stdout.on('error',abort);
// Budget: check actual parent identity every second while the negotiated SSH transport is active.
const parentWatch=setInterval(()=>{if(process.ppid!==request.parentPid)abort();},1000);
if(process.ppid!==request.parentPid)abort();
try { process.stdout.write(JSON.stringify({result:await runOnRunnerAsync(request.root,request.command,{...request.options,signal:canceled.signal})})); }
catch(error) { process.stdout.write(JSON.stringify({error:{name:error.name,code:error.code,message:error.message,host:error.host}})); process.exitCode=1; }
finally {clearInterval(parentWatch);}`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, input: JSON.stringify({ root, command, options, parentPid: process.pid }), encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES * 6 + 1024 ** 2,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let reply;
  try { reply = JSON.parse(child.stdout); } catch { throw new RunnerDropped(options.runner.host); }
  if (reply.error?.name === 'Refused') {
    const prefix = `[${reply.error.code}] `;
    throw new Refused(reply.error.code, reply.error.message.startsWith(prefix) ? reply.error.message.slice(prefix.length) : reply.error.message);
  }
  if (reply.error || child.error || child.status !== 0) throw new RunnerDropped(options.runner.host);
  return reply.result;
}

/** Negotiate missing history objects while the remote cache lease stays held in one SSH session. */
export async function runOnRunnerAsync(root, command, options) {
  if (options.signal?.aborted) throw new RunnerDropped(options.runner.host);
  const request = requestFor(root, command, options);
  let removeAbort = () => {};
  try {
    const child = spawn('ssh', request.args, { env: request.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [], diagnostics = [];
    let bytes = 0, error, control = '', requested = false, transfer = null, cleanupReason = '';
    const abort = () => { error ??= new Error('runner transport canceled'); child.stdin.destroy(); child.kill('SIGTERM'); };
    options.signal?.addEventListener('abort', abort, { once: true });
    removeAbort = () => options.signal?.removeEventListener('abort', abort);
    if (options.signal?.aborted) abort();
    /** Bound both protocol streams before retaining a complete result. */
    const capture = (target, chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { error = new Refused('RUNNER_OUTPUT_LIMIT', 'runner output exceeded 64 MiB; reduce command output or keep this run local'); child.kill(); }
      else target.push(chunk);
    };
    child.stdout.on('data', chunk => capture(output, chunk));
    child.stderr.on('data', chunk => {
      capture(diagnostics, chunk);
      control += chunk.toString('utf8');
      if (control.length > 256 * 1024) { error = new Error('runner control frame exceeded limit'); child.kill(); return; }
      let newline;
      while ((newline = control.indexOf('\n')) >= 0) {
        const line = control.slice(0, newline); control = control.slice(newline + 1);
        const cleanupPrefix = `PULLBOARD_RUNNER_CLEANUP_UNVERIFIED ${request.spec.id} `;
        if (line.startsWith(cleanupPrefix)) cleanupReason = line.slice(cleanupPrefix.length, cleanupPrefix.length + 240);
        if (line === `PULLBOARD_RUNNER_CLEANUP_TIMEOUT ${request.spec.id}`) {
          error = new Refused('RUNNER_CLEANUP_TIMEOUT', `runner ${request.runner.host} could not verify cleanup within 30 seconds${cleanupReason ? ': ' + cleanupReason : ''}; inspect job ${request.spec.id} under its runner namespace before another run`);
          child.stdin.destroy(); child.kill('SIGTERM'); return;
        }
        const prefix = `PULLBOARD_RUNNER_NEED ${request.spec.id} `;
        if (!line.startsWith(prefix)) continue;
        if (requested) { error = new Error('duplicate runner inventory'); child.kill(); return; }
        requested = true;
        transfer = (async () => {
          const inventory = JSON.parse(Buffer.from(line.slice(prefix.length), 'base64').toString('utf8'));
          if (!Array.isArray(inventory.tips) || inventory.tips.length > 1024
            || inventory.tips.some(tip => typeof tip !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tip))) {
            throw new Error('invalid runner inventory');
          }
          const pack = historyPack(root, request.source, inventory.tips, request.directory);
          await pipeline(createReadStream(pack), child.stdin);
        })().catch(failure => { error = failure; child.stdin.destroy(); child.kill(); });
      }
    });
    child.stdin.on('error', failure => { if (failure.code !== 'EPIPE') error ??= failure; });
    child.once('error', failure => { error = failure; });
    child.stdin.write(request.frame);
    const status = await new Promise(resolve => child.once('close', resolve));
    if (transfer) await transfer;
    if (error instanceof Refused) throw error;
    return resultFrom(request, { status, error, stdout: Buffer.concat(output), stderr: Buffer.concat(diagnostics) });
  } finally { removeAbort(); request.cleanup(); }
}
