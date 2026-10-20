/** One bounded diagnostic pair under the existing admission; the original gate remains authoritative [C7,H16]. */
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  availableParallelism,
  freemem,
  loadavg,
} from 'node:os';
import {
  closeSync,
  constants,
  copyFileSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  isAbsolute,
  join,
  relative,
} from 'node:path';
import {
  headCommit,
  headTree,
  invalidateGitFacts,
  isClean,
  tryGit,
  untracked,
} from './git.js';
import {
  checkAtCommit,
  mainPolicy,
} from './trusted-policy.js';
import { fileURLToPath } from 'node:url';
import { runProfiledShell } from './gate.js';

/** Hash immutable bytes without retaining a potentially credential-bearing command in board data. */
function digest(value) { return createHash('sha256').update(value).digest('hex'); }

/** Hash large raw evidence in bounded chunks rather than loading another complete log into memory. */
function fileDigest(file) {
  const hash = createHash('sha256');
  const descriptor = openSync(file, 'r');
  const buffer = Buffer.alloc(65536);
  try {
    let length;
    while ((length = readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, length));
  } finally { closeSync(descriptor); }
  return hash.digest('hex');
}

/** Quote one literal selector argument, preserving its bytes without shell interpolation. */
function word(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }

/** Bind the source before the original run; uncertainty is recorded rather than silently retried. */
export function flakeSource(root, { commit, main, privateCheck = false } = {}) {
  invalidateGitFacts();
  const head = commit ?? headCommit(root);
  const tree = head && tryGit(root, ['rev-parse', '--verify', head + '^{tree}']);
  let trunk = main ?? null;
  if (!trunk) { try { trunk = mainPolicy(root).commit; } catch { /* Missing main prevents classification. */ } }
  return { head, tree: tree?.status === 0 ? tree.stdout.trim() : null, main: trunk, privateCheck,
    clean: privateCheck || isClean(root) && untracked(root).length === 0,
    load: { average: loadavg(), cpus: availableParallelism(), freeMB: Math.floor(freemem() / 1048576) } };
}

/** Resolve live aliases; deleted private checks already carry their physical execution root. */
function physicalPath(path) {
  try { return realpathSync(path); }
  catch { return path; }
}

/** Read structured Node TAP blocks only; nested selectors and cancelled parents stay unsupported. */
function tapTests(output, root) {
  const rows = [];
  let active;
  for (const raw of output.split('\n')) {
    const match = /^(\s*)(not ok|ok)\s+\d+\s+-\s+(.*)$/u.exec(raw);
    if (match) {
      active = { name: match[3], passed: match[2] === 'ok', indent: match[1].length, file: null, skip: /\s+#\s*(?:SKIP|TODO)\b/iu.test(match[3]), type: null, failureType: null };
      rows.push(active); continue;
    }
    if (!active) continue;
    const field = /^(\s*)(location|type|failureType):\s*(.*?)\s*$/u.exec(raw);
    if (!field || field[1].length !== active.indent + 2) continue;
    const value = field[3].replace(/^(['"])(.*)\1$/u, '$2');
    if (field[2] === 'location') {
      const path = value.replace(/:\d+(?::\d+)?$/u, '');
      const file = isAbsolute(path) ? relative(physicalPath(root), physicalPath(path)) : path.replace(/^\.\//u, '');
      if (file && !file.startsWith('../') && !file.includes('\\')) active.file = file;
    } else active[field[2]] = value;
  }
  return rows;
}

/** Use only a known structured Node runner; arbitrary shell, Jest and Vitest commands are never replaced. */
function nodePrefix(command, config, root, pin) {
  const executable = '(?:node|/[^\\s\'";|&`$]+/node)';
  const own = new RegExp('^(' + executable + ')\\s+((?:\\./)?bin/run-tests\\.js)(?:\\s|$)', 'u');
  const builtin = new RegExp('^(' + executable + ')\\s+--test(?:\\s|$)', 'u');
  const match = own.exec(command);
  if (match) return knownRunner(root, pin) ? match[1] + ' ' + match[2] : null;
  const native = builtin.exec(command);
  if (native) {
    const rest = command.slice(native[0].length);
    if (/[;&|`$()<>\r\n]/u.test(rest) || /(?:^|\s)--(?!test-reporter=tap(?:\s|$))\S+/u.test(rest)) return null;
    return native[1] + ' --test --test-reporter=tap';
  }
  if (new RegExp('^' + executable + '\\s', 'u').test(command)) return null;
  const configured = typeof config.affectedTests === 'string' ? own.exec(config.affectedTests) : null;
  return configured && knownRunner(root, pin) && config.affectedTests.trim() === configured[1] + ' ' + configured[2]
    ? config.affectedTests.trim() : null;
}

/** Recognize the bundled runner by committed bytes, never by a conventional filename in an end-user repo. */
function knownRunner(root, pin) {
  try {
    const bundled = tryGit(root, ['hash-object', '--no-filters', fileURLToPath(new URL('../bin/run-tests.js', import.meta.url))]);
    if (bundled.status !== 0) return false;
    return [...new Set([pin.head, pin.main].filter(Boolean))].every(commit => {
      if (!committedTest(root, commit, 'bin/run-tests.js')) return false;
      const source = tryGit(root, ['rev-parse', '--verify', commit + ':bin/run-tests.js']);
      return source.status === 0 && source.stdout === bundled.stdout;
    });
  } catch { return false; }
}

/** Confirm the file is a committed regular test at the pinned source, without reading a live substitute. */
function committedTest(root, commit, file) {
  if (!file || !/\.(?:[cm]?js)$/u.test(file) || file.startsWith('/') || file.includes('\\') || file.split('/').some(part => !part || part === '..' || part === '.')) return false;
  const result = tryGit(root, ['--literal-pathspecs', 'ls-tree', '-z', commit, '--', file]);
  return result.status === 0 && /^(?:100644|100755) blob [a-f0-9]+\t/u.test(result.stdout) && result.stdout.split('\0').filter(Boolean).length === 1;
}

/** Copy the whole output/profile to unique durable evidence before any diagnostic executes. */
function saveReceipt(directory, id, label, run) {
  const file = join(directory, label + '.log');
  const source = run.log || run.logPath;
  if (source) copyFileSync(source, file, constants.COPYFILE_EXCL);
  else writeFileSync(file, run.output ?? '', { flag: 'wx', mode: 0o600 });
  let profileSha256 = null;
  if (run.profilePath) {
    copyFileSync(run.profilePath, join(directory, label + '.profile.json'), constants.COPYFILE_EXCL);
    profileSha256 = fileDigest(run.profilePath);
  }
  return { green: run.isGreen, sha256: fileDigest(file), bytes: statSync(file).size, artifact: 'flake-evidence/' + id + '/' + label + '.log', profileSha256 };
}

/** A probe proves one selected target only if its real completion is present, not merely a zero exit. */
function targetResult(run, root, name) {
  if (run.executionSourceUnchanged === false) return null;
  const matches = tapTests(run.output ?? '', run.executionRoot ?? root).filter(row => row.type !== 'suite' && !row.skip);
  if (matches.length !== 1 || matches[0].indent !== 0 || matches[0].name !== name || ['subtestsFailed', 'cancelledByParent', 'testAborted'].includes(matches[0].failureType)) return null;
  return matches[0].passed === run.isGreen ? run.isGreen : null;
}

/** Run an exact-target private source comparison, preserving the trusted check's full receipt. */
function privateProbe(root, commit, command, lease, policyCommit) {
  const item = { item_id: 0, item_commit: commit, item_claim_head: policyCommit, item_frozen: JSON.stringify({ check: command }) };
  const check = checkAtCommit(root, item, { gateLease: lease });
  const output = check.outputPath ? readFileSync(check.outputPath, 'utf8') : '';
  return { isGreen: check.state === 'pass', unverified: check.state === 'unverified', output, log: check.outputPath,
    executionRoot: check.executionRoot, executionSourceUnchanged: check.executionSourceUnchanged, profilePath: check.profilePath, profile: check.profile };
}

/** Report only a bounded code when diagnostic work fails; never replace the original gate's red result. */
export async function observeNativeFailure(options) {
  const started = Date.now();
  try { await observeFailure(options); }
  catch (error) { diagnosticUnavailable(options, error, started); }
}

/** Record a bounded diagnostic failure without replacing the original run or exposing arbitrary exception text. */
export function diagnosticUnavailable(options, error, started = Date.now()) {
  const code = diagnosticCode(error);
  options.run.flakeDiagnostics = { ...(options.run.flakeDiagnostics ?? { observations: [] }), wallMs: Date.now() - started, error: code };
  const message = `failure diagnostics could not finish (${code}); the original result stays red; inspect the retained gate log and pullboard flakes\n`;
  try {
    if (typeof options.onError === 'function') options.onError({ code, message });
    else process.stderr.write(message);
  } catch { /* An unavailable diagnostic channel cannot change the original verdict. */ }
}

/** Retain an operational code without echoing arbitrary command text or credentials from an exception. */
function diagnosticCode(error) {
  return /^[A-Z][A-Z0-9_]{0,79}$/u.test(error?.code ?? '') ? error.code : 'FLAKE_DIAGNOSTIC_FAILED';
}

/** Observe one red run, optionally run one pair, then persist typed results without changing its verdict. */
async function observeFailure({ root, config, pin, run, command, lease, kind, record }) {
  if (run.isGreen || !pin.head || !pin.tree) return;
  const started = Date.now();
  const observedAt = new Date().toISOString();
  const load = { average: loadavg(), cpus: availableParallelism(), freeMB: Math.floor(freemem() / 1048576) };
  const prefix = nodePrefix(command, config, root, pin);
  const parsed = tapTests(run.output ?? '', run.executionRoot ?? root).filter(row => !row.passed && row.type !== 'suite' && !['subtestsFailed', 'cancelledByParent', 'testAborted'].includes(row.failureType));
  const failures = parsed.length ? parsed : [{ file: null, name: null, indent: null }];
  const common = tryGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.status !== 0) throw new Error('Cannot retain flake evidence without the board Git directory.');
  const evidence = join(common.stdout.trim(), 'pullboard', 'flake-evidence');
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const observations = [];
  for (const failure of failures) {
    const targetStarted = Date.now();
    const id = randomUUID();
    const directory = join(evidence, id); mkdirSync(directory, { mode: 0o700 });
    const original = saveReceipt(directory, id, 'original', run);
    let paired = null, mainReceipt = null, classification = 'unclassified';
    let reason = config.flakes?.rerun === true ? 'No supported structured Node test selector is available.' : 'Paired reruns are off for this board; the original red is retained.';
    const named = failure.file && failure.name && committedTest(root, pin.head, failure.file);
    invalidateGitFacts();
    const changed = run.executionSourceUnchanged === false || !pin.privateCheck && (headCommit(root) !== pin.head || headTree(root) !== pin.tree || !isClean(root) || untracked(root).length > 0);
    if (!pin.clean || changed) reason = 'The source is dirty or changed; no unchanged-head diagnostic is claimed.';
    else if (lease?.runner) reason = 'This remote admission has no supported pinned-main comparison; no local substitute is run.';
    else if (config.flakes?.rerun === true && prefix && named && failure.indent === 0) {
      const pattern = '^' + failure.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '$';
      const selected = prefix + ' --test-name-pattern ' + word(pattern) + ' ' + word(failure.file);
      const pairRun = pin.privateCheck ? privateProbe(root, pin.head, selected, lease, pin.main ?? pin.head)
        : runProfiledShell(root, selected, { gateLease: lease });
      paired = saveReceipt(directory, id, 'paired', pairRun);
      const pairResult = pairRun.unverified ? null : targetResult(pairRun, root, failure.name);
      let mainResult = pin.main === pin.head ? false : null;
      if (pin.main && pin.main !== pin.head && committedTest(root, pin.main, failure.file)) {
        const mainRun = privateProbe(root, pin.main, selected, lease, pin.main);
        mainReceipt = saveReceipt(directory, id, 'main', mainRun);
        mainResult = mainRun.unverified ? null : targetResult(mainRun, root, failure.name);
      }
      if (mainResult === true) { classification = 'possible-regression'; reason = 'The exact target passes on pinned main; this candidate failure is not a flake observation.'; }
      else if (pairResult === true && mainResult === false) { classification = 'flake'; reason = 'The red target passed its one paired rerun at the same pinned head; original red retained.'; }
      else if (pairResult === false) { classification = 'stable-red'; reason = 'The target remains red in its one paired rerun; original red retained.'; }
      else reason = 'A probe did not establish the exact target at its pinned source; it remains unclassified.';
      invalidateGitFacts();
      if (!pin.privateCheck && (headCommit(root) !== pin.head || headTree(root) !== pin.tree || !isClean(root) || untracked(root).length > 0)) {
        classification = 'unclassified'; reason = 'The source changed during diagnostics; no unchanged-head classification is claimed.';
      }
    }
    const observation = { id, file: named ? failure.file : null, name: named ? failure.name : null, head: pin.head, tree: pin.tree, main: pin.main,
      kind, classification, reason, commandSha256: digest(command), at: observedAt, diagnosticMs: Date.now() - targetStarted,
      load, original, paired, mainReceipt };
    writeFileSync(join(directory, 'observation.json'), JSON.stringify(observation, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const manifest = Object.fromEntries(readdirSync(directory).map(file => [file, fileDigest(join(directory, file))]));
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const summary = { id, classification, file: observation.file, name: observation.name, paired: paired !== null, recorded: false };
    observations.push(summary);
    run.flakeDiagnostics = { wallMs: Date.now() - started, observations };
    try { await record(observation); summary.recorded = true; }
    catch (error) {
      // The completed evidence manifest remains immutable; the recording failure gets its own addendum.
      try { writeFileSync(join(directory, 'recording-error.addendum.json'), JSON.stringify({ code: diagnosticCode(error), originalRetained: true }) + '\n', { flag: 'wx', mode: 0o600 }); }
      catch { /* A failing disk cannot justify replacing the original verdict. */ }
      throw error;
    }
  }
  run.flakeDiagnostics = { wallMs: Date.now() - started, observations };
}
