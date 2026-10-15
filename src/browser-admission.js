/** Classify whether selected tests may launch Chrome; uncertainty keeps browser coverage enabled. */
import { createHash } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { posix, relative, resolve, sep } from 'node:path';
import { commonJsIn, importsIn } from './module-imports.js';
import { cleanGitEnvironment, git } from './git.js';

const MODULE_SUFFIXES = ['.js', '.mjs', '.cjs', '.cts', '.json'];
const CHROME_FIXTURE = 'test/chrome-fixture.js';
const JOURNEYS_TEST = 'test/journeys.test.js';
const TEST_RUNNER = 'bin/run-tests.js';
const TRUSTED_TEST_RUNNER_BLOB = '2166ff4052d4c24835aff3de561948843d4ff30c';
const TRUSTED_TEST_RUNNER_SHA256 = '03df8bbb82585ff10df88ec4ecba9354301f73c091fd7eecddf1d57a84ef47f5';
const VALUE_OPTIONS = new Set(['--test-concurrency', '--test-name-pattern', '--test-shard', '--test-skip-pattern', '--test-timeout']);
const FLAG_OPTIONS = new Set(['--test-only']);
/** Known read-only or test-runner child-process modules; hash pins prevent path-only exemptions. */
const SAFE_CHILD_PROCESS_MODULES = new Map([
  ['test/fixture-child.js', { hash: '77013ed0773d16e439fc1ab235364a612d9a9d19b911dc406050e0e5a512517e', reason: 'shared fixture runner for explicit fixture commands' }],
  ['src/git.js', { hash: '35b278a548b95a55e142df2058092e7ea7ab80453d40acc9f22a86bcf68ca5ff', reason: 'runs Git commands for repository inspection' }],
  ['src/module-imports.js', { hash: 'a4853eca3cbb4140391a1003dfe145fb8e6ad46dfb06b2c4285c66fbc97fa2de', reason: 'runs the Node parser in an isolated child' }],
  ['src/resources.js', { hash: 'cd57aa2ac72315d10f07ae4b15af7ffd399d0c34b14e326651ed281b83553bee', reason: 'reads process identity with /bin/ps' }],
]);

/** Split a literal shell command into words, refusing expansion, operators, and incomplete quoting. */
function literalShellWords(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const words = [];
  let word = '';
  let started = false;
  let quote = '';
  for (const character of command) {
    if (character === '\n' || character === '\r') return null;
    if (quote === "'") {
      if (character === "'") quote = '';
      else word += character;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = '';
      else if ('$`\\'.includes(character)) return null;
      else word += character;
      started = true;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; started = true; continue; }
    if (/\s/u.test(character)) {
      if (started) { words.push(word); word = ''; started = false; }
      continue;
    }
    if (';&|<>$`(){}*?[]\\'.includes(character)) return null;
    word += character;
    started = true;
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

/** Parse only explicit Node test-runner files and the small, literal option set used by frozen checks. */
function explicitRunnerFiles(args) {
  const files = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument.startsWith('-')) {
      const separator = argument.indexOf('=');
      const name = separator < 0 ? argument : argument.slice(0, separator);
      if (VALUE_OPTIONS.has(name)) {
        if (separator < 0 && ++index >= args.length) return null;
        if (separator >= 0 && !argument.slice(separator + 1)) return null;
        continue;
      }
      if (FLAG_OPTIONS.has(name) && separator < 0) continue;
      return null;
    }
    files.push(argument);
  }
  return files.length && files.every(file => /^test\/.+\.test\.(?:js|mjs|cjs|cts)$/u.test(file)) ? files : null;
}

/** Resolve a command word through PATH using the same inherited environment as the check shell.
 * @param {string} command
 * @param {string | undefined} pathValue
 * @returns {string | null}
 */
function resolveExecutable(command, pathValue = process.env.PATH) {
  if (command.includes('/')) return resolve(command);
  const suffixes = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const directory of (pathValue ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    for (const suffix of suffixes) {
      const candidate = resolve(directory || '.', command + suffix);
      try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* continue through PATH */ }
    }
  }
  return null;
}

/** Recognize the exact output-capture and grep shape used by frozen named-test checks. */
function capturedRunner(command) {
  const opening = /^([A-Za-z_][A-Za-z0-9_]*)=\$\(/u.exec(command);
  if (!opening) return null;
  const variable = opening[1];
  const ending = ' 2>&1)';
  const bodyEnd = command.indexOf(ending, opening[0].length);
  if (bodyEnd < 0) return null;
  const inner = command.slice(opening[0].length, bodyEnd);
  let suffix = command.slice(bodyEnd + ending.length);
  const first = `; printf "%s\\n" "$${variable}"; printf "%s\\n" "$${variable}" | grep -Eq "`;
  const second = `" && printf "%s\\n" "$${variable}" | grep -Eq "`;
  if (!suffix.startsWith(first)) return null;
  suffix = suffix.slice(first.length);
  const split = suffix.indexOf(second);
  if (split < 0 || !suffix.endsWith('"')) return null;
  const patterns = [suffix.slice(0, split), suffix.slice(split + second.length, -1)];
  if (!patterns[0].startsWith('^[[:space:]]*ok [0-9]+ - ') || patterns[0].includes('$')
    || patterns[1] !== '^# fail 0$' || patterns.some(pattern => /["\\`]/u.test(pattern))) return null;
  return inner;
}

/** Read a commit's regular-file map so verification classifies only the submitted source tree. */
function committedFiles(root, commit) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{40,64}$/iu.test(commit)) return null;
  let output;
  try {
    output = git(root, ['--no-replace-objects', '-c', 'core.quotepath=false', 'ls-tree', '-rz', '--full-tree', commit], {
      env: cleanGitEnvironment(), maxBuffer: 64 * 1024 * 1024,
    });
  } catch { return null; }
  if (!output) return null;
  const files = new Map();
  for (const record of output.split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    if (tab < 0) return null;
    const [mode, type, object] = record.slice(0, tab).split(' ');
    files.set(record.slice(tab + 1), { mode, type, object });
  }
  return files;
}

/** Read a regular committed blob, rejecting symlinks and non-file objects as uncertain. */
function committedSource(root, files, path) {
  const entry = files.get(path);
  if (!entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) return null;
  try {
    return git(root, ['--no-replace-objects', 'cat-file', 'blob', entry.object], {
      env: cleanGitEnvironment(), maxBuffer: 16 * 1024 * 1024,
    });
  } catch { return null; }
}

/** Resolve a module edge against a committed tree without following symlinks. */
function committedTarget(files, importer, request) {
  if (typeof request !== 'string' || !request.startsWith('.')) return null;
  const raw = request.split(/[?#]/u)[0];
  const base = posix.normalize(posix.join(posix.dirname(importer), raw));
  if (base === '..' || base.startsWith('../') || base.startsWith('/')) return null;
  const candidates = posix.extname(base) ? [base] : [base, ...MODULE_SUFFIXES.map(suffix => base + suffix), ...MODULE_SUFFIXES.map(suffix => posix.join(base, `index${suffix}`))];
  const found = candidates.filter(candidate => files.has(candidate));
  return found.length === 1 && ['100644', '100755'].includes(files.get(found[0]).mode) ? found[0] : null;
}

/** Detect direct literal Chrome launchers without treating help text or refusal messages as launches. */
function namesChromeLauncher(source) {
  return /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(\s*(['"`])[^'"`\r\n]*\b(?:chrome|chromium|playwright|puppeteer)\b/iu.test(source);
}

/** Parse the frozen check and classify its explicit test files, failing closed on unknown shell. */
export async function checkNeedsBrowser(root, command, { commit, env = process.env } = {}) {
  if (env.NODE_OPTIONS) return true;
  let words = literalShellWords(command);
  if (!words) {
    const inner = capturedRunner(command);
    if (!inner) return true;
    const grep = resolveExecutable('grep', env.PATH);
    if (!grep || !['/usr/bin/grep', '/bin/grep'].includes(await realpath(grep).catch(() => ''))) return true;
    words = literalShellWords(inner);
  }
  if (!words || words.length < 3) return true;
  const node = resolveExecutable(words[0], env.PATH);
  if (!node || await realpath(node).catch(() => '') !== await realpath(process.execPath).catch(() => '')) return true;
  const runner = resolve(root, words[1]);
  if (runner !== resolve(root, TEST_RUNNER)) return true;
  const files = explicitRunnerFiles(words.slice(2));
  if (!files) return true;
  if (files.some(file => file === JOURNEYS_TEST || file === 'test/cockpit' || file.startsWith('test/cockpit/'))) return true;
  if (commit) {
    const committed = committedFiles(root, commit);
    const runnerEntry = committed?.get(TEST_RUNNER);
    if (!runnerEntry || runnerEntry.type !== 'blob' || !['100644', '100755'].includes(runnerEntry.mode)
      || runnerEntry.object !== TRUSTED_TEST_RUNNER_BLOB) return true;
    return testsNeedBrowserInTree(root, files, committed);
  }
  if (await realpath(runner).catch(() => '') !== await realpath(resolve(root, TEST_RUNNER)).catch(() => '')) return true;
  const runnerSource = await readFile(runner, 'utf8').catch(() => '');
  if (createHash('sha256').update(runnerSource).digest('hex') !== TRUSTED_TEST_RUNNER_SHA256) return true;
  return testsNeedBrowser(root, files);
}

/** Convert an in-root absolute or relative selection to a normalized repository-relative path. */
function repositoryPath(root, file) {
  if (typeof file !== 'string' || !file) return null;
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, file);
  const rel = relative(absoluteRoot, absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  return rel.split(sep).join('/');
}

/** Check that a resolved path stays inside the real repository, including through symlinks. */
async function staysInside(root, absolute) {
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(absolute)]);
  return realTarget.startsWith(realRoot + sep);
}

/** Resolve one literal relative module request using file metadata, returning null when ambiguous. */
async function localTarget(root, importer, request) {
  if (typeof request !== 'string' || !request.startsWith('.')) return null;
  const raw = request.split(/[?#]/u)[0];
  const base = posix.normalize(posix.join(posix.dirname(importer), raw));
  if (base === '..' || base.startsWith('../') || base.startsWith('/')) return null;
  const candidates = posix.extname(base)
    ? [base]
    : [base, ...MODULE_SUFFIXES.map((suffix) => base + suffix), ...MODULE_SUFFIXES.map((suffix) => posix.join(base, `index${suffix}`))];
  const found = [];
  for (const candidate of candidates) {
    const absolute = resolve(root, ...candidate.split('/'));
    try {
      if (!(await staysInside(root, absolute))) return null;
      if ((await stat(absolute)).isFile()) found.push(candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
  }
  return found.length === 1 ? found[0] : null;
}

/** Classify test imports from either the current checkout or one immutable committed tree. */
async function testsNeedBrowserInTree(root, files, committed = null) {
  if (!Array.isArray(files) || files.length === 0) return true;
  const normalized = files.map((file) => repositoryPath(root, file));
  if (normalized.some((file) => file === null)) return true;
  if (normalized.some((file) => file === JOURNEYS_TEST || file === 'test/cockpit' || file.startsWith('test/cockpit/'))) return true;

  let frontier = [...new Set(normalized)];
  const seen = new Set();
  try {
    while (frontier.length) {
      const paths = [];
      const sources = [];
      for (const path of frontier) {
        if (seen.has(path)) continue;
        seen.add(path);
        if (path === CHROME_FIXTURE) return true;
        if (path.endsWith('.json')) continue;
        if (/\.(?:cjs|cts)$/u.test(path)) return true;
        paths.push(path);
        if (committed) {
          const source = committedSource(root, committed, path);
          if (source === null) return true;
          sources.push(source);
        } else {
          const absolute = resolve(root, ...path.split('/'));
          if (!(await staysInside(root, absolute))) return true;
          sources.push(await readFile(absolute, 'utf8'));
        }
      }
      if (!sources.length) break;
      if (paths.some((path, index) => (path.startsWith('test/') || SAFE_CHILD_PROCESS_MODULES.has(path))
        && namesChromeLauncher(sources[index]))) return true;
      if (commonJsIn(sources).some(Boolean)) return true;
      const imports = importsIn(sources);
      const next = new Set();
      for (let index = 0; index < imports.length; index += 1) {
        for (const request of imports[index]) {
          if (request === 'node:child_process') {
            const policy = SAFE_CHILD_PROCESS_MODULES.get(paths[index]);
            if (!policy || createHash('sha256').update(sources[index]).digest('hex') !== policy.hash) return true;
            continue;
          }
          if (request === 'node:module') return true;
          if (request.startsWith('node:')) continue;
          if (!request.startsWith('.')) return true;
          const target = committed
            ? committedTarget(committed, paths[index], request)
            : await localTarget(root, paths[index], request);
          if (!target) return true;
          if (target === CHROME_FIXTURE) return true;
          if (!target.endsWith('.json') && !seen.has(target)) next.add(target);
        }
      }
      frontier = [...next];
    }
    return false;
  } catch {
    return true;
  }
}

/** Return true for full or uncertain selections, cockpit tests, or imports reaching the Chrome fixture. */
export async function testsNeedBrowser(root, files) {
  return testsNeedBrowserInTree(root, files);
}
