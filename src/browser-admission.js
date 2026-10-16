/** Classify whether selected tests may launch Chrome; uncertainty keeps browser coverage enabled. */
import {
  accessSync,
  constants,
} from 'node:fs';
import {
  lstat,
  readFile,
  realpath,
  stat,
} from 'node:fs/promises';
import {
  posix,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  commonJsIn,
  importsIn,
} from './module-imports.js';
import {
  cleanGitEnvironment,
  git,
} from './git.js';

const MODULE_SUFFIXES = ['.js', '.mjs', '.cjs', '.cts', '.json'];
const CHROME_FIXTURE = 'test/chrome-fixture.js';
const FIXTURE_CHILD = 'test/fixture-child.js';
const JOURNEYS_TEST = 'test/journeys.test.js';
const TEST_RUNNER = 'bin/run-tests.js';
const VALUE_OPTIONS = new Set(['--test-concurrency', '--test-name-pattern', '--test-shard', '--test-skip-pattern', '--test-timeout']);
const FLAG_OPTIONS = new Set(['--test-only']);
/** Path-scoped child-process exceptions with a short reason for each reviewed non-Chrome helper. */
const SAFE_CHILD_PROCESS_MODULES = new Map([
  ['test/fixture-child.js', 'shared fixture runner for explicit fixture commands'],
  ['src/git.js', 'runs Git commands for repository inspection'],
  ['src/module-imports.js', 'runs the Node parser in an isolated child'],
  ['src/resources.js', 'reads process identity with /bin/ps'],
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
  const suffix = command.slice(bodyEnd + ending.length);
  const quotes = ['"', "'"];
  // Only the literal one-backslash newline form is part of the frozen capture shape.
  const prints = quotes.map(quote => `printf ${quote}%s\\n${quote} "$${variable}"`);
  for (const firstPrint of prints) for (const secondPrint of prints) {
    const prefix = `; ${firstPrint}; ${secondPrint} | grep -Eq `;
    if (!suffix.startsWith(prefix)) continue;
    for (const firstQuote of quotes) {
      const firstPatternStart = prefix + firstQuote;
      if (!suffix.startsWith(firstPatternStart)) continue;
      const remainder = suffix.slice(firstPatternStart.length);
      for (const lastPrint of prints) for (const lastQuote of quotes) {
        const separator = `${firstQuote} && ${lastPrint} | grep -Eq ${lastQuote}`;
        const split = remainder.indexOf(separator);
        if (split < 0 || !remainder.endsWith(lastQuote)) continue;
        const patterns = [remainder.slice(0, split), remainder.slice(split + separator.length, -1)];
        if (patterns[0].startsWith('^[[:space:]]*ok [0-9]+ - ') && !patterns[0].includes('$')
          && patterns[1] === '^# fail 0$' && patterns.every(pattern => !/["'\\`]/u.test(pattern))) return inner;
      }
    }
  }
  return null;
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

/** Allow only a side-effect fixture import or the fixed-Git helper; generic command helpers keep browser admission.
 * @param {string} source
 * @param {string} request
 * @returns {boolean}
 */
function safeFixtureChildImport(source, request) {
  const escaped = request.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const sideEffect = new RegExp(`^[ \\t]*import[ \\t]*(['"])${escaped}\\1[ \\t]*;?[ \\t]*$`, 'u');
  const fixedGit = new RegExp(`^[ \\t]*import[ \\t]*\\{[ \\t]*runFixtureGit(?:[ \\t]+as[ \\t]+[A-Za-z_$][\\w$]*)?[ \\t]*\\}[ \\t]*from[ \\t]*(['"])${escaped}\\1[ \\t]*;?[ \\t]*$`, 'u');
  let removedSafeImport = false;
  const remaining = source.split(/\r?\n/u).filter(line => {
    if (!line.includes(request)) return true;
    if (!sideEffect.test(line) && !fixedGit.test(line)) return true;
    removedSafeImport = true;
    return false;
  }).join('\n');
  if (!removedSafeImport) return false;
  try { return !importsIn([remaining])[0].includes(request); } catch { return false; }
}

/** Detect direct literal Chrome launchers without treating help text or refusal messages as launches. */
function namesChromeLauncher(source) {
  return /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(\s*(['"`])[^'"`\r\n]*\b(?:chrome|chromium|playwright|puppeteer)\b/iu.test(source);
}

/** Detect dynamic process builtin access, which can load launch-capable modules.
 * @param {string} source
 * @returns {boolean}
 */
function usesDynamicBuiltinLoader(source) {
  const loaderName = ['getBuiltin', 'Module'].join('');
  if (source.includes(loaderName) || /getBuiltin\\u(?:004d|\{4d\})odule/iu.test(source)) return true;
  if (/\bprocess\s*(?:\?\.)?\s*\[\s*(?!(['"])env\1\s*\])/u.test(source)) return true;
  const aliases = [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*process\b/gu)].map(match => match[1]);
  return aliases.some(alias => {
    const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const computedAlias = new RegExp(`\\b${escapedAlias}\\s*(?:\\?\\.)?\\[\\s*(?!(['"])env\\1\\s*\\])`, 'u');
    return computedAlias.test(source);
  });
}

/** Report a one-line explanation when uncertainty reserves browser capacity.
 * @param {(decision:{file:string,reason:string})=>void|undefined} onFallback
 * @param {string} file
 * @param {string} reason
 * @returns {true}
 */
function browserFallback(onFallback, file, reason) {
  onFallback?.({
    file: String(file).replace(/[\r\n\t]+/gu, ' '),
    reason: String(reason).replace(/[\r\n\t]+/gu, ' '),
  });
  return true;
}

/** Parse the frozen check and classify its explicit test files, failing closed on unknown shell. */
export async function checkNeedsBrowser(root, command, { commit, env = process.env, onFallback } = {}) {
  if (env.NODE_OPTIONS) return browserFallback(onFallback, '<frozen check>', 'NODE_OPTIONS may load an unclassified module');
  let words = literalShellWords(command);
  if (!words) {
    const inner = capturedRunner(command);
    if (!inner) return browserFallback(onFallback, '<frozen check>', 'shell syntax is outside the supported literal capture form');
    const grep = resolveExecutable('grep', env.PATH);
    if (!grep || !['/usr/bin/grep', '/bin/grep'].includes(await realpath(grep).catch(() => ''))) return browserFallback(onFallback, '<frozen check>', 'capture wrapper does not resolve the system grep');
    words = literalShellWords(inner);
  }
  if (!words || words.length < 3) return browserFallback(onFallback, '<frozen check>', 'command is not an explicit Node test selection');
  const node = resolveExecutable(words[0], env.PATH);
  if (!node || await realpath(node).catch(() => '') !== await realpath(process.execPath).catch(() => '')) return browserFallback(onFallback, '<frozen check>', 'Node executable does not resolve to this runtime');
  const runner = resolve(root, words[1]);
  if (runner !== resolve(root, TEST_RUNNER)) return browserFallback(onFallback, '<frozen check>', 'runner is not bin/run-tests.js in this repository');
  const files = explicitRunnerFiles(words.slice(2));
  if (!files) return browserFallback(onFallback, '<frozen check>', 'runner options or test selection are not statically understood');
  if (files.some(file => file === JOURNEYS_TEST || file === 'test/cockpit' || file.startsWith('test/cockpit/'))) return true;
  if (commit) {
    const committed = committedFiles(root, commit);
    const runnerEntry = committed?.get(TEST_RUNNER);
    if (!runnerEntry || runnerEntry.type !== 'blob' || !['100644', '100755'].includes(runnerEntry.mode)) return browserFallback(onFallback, TEST_RUNNER, 'committed runner is missing or is not a regular file');
    return testsNeedBrowserInTree(root, files, committed, onFallback);
  }
  if (await realpath(runner).catch(() => '') !== await realpath(resolve(root, TEST_RUNNER)).catch(() => '')) return browserFallback(onFallback, TEST_RUNNER, 'runner resolves outside the expected repository path');
  const runnerInfo = await lstat(runner).catch(() => null);
  let runnerInside = false;
  try { runnerInside = await staysInside(root, runner); } catch { /* Missing or unresolved runner is uncertain. */ }
  if (!runnerInfo?.isFile() || runnerInfo.isSymbolicLink() || !runnerInside) return browserFallback(onFallback, TEST_RUNNER, 'runner is not a regular in-repository file');
  return testsNeedBrowser(root, files, { onFallback });
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
async function testsNeedBrowserInTree(root, files, committed = null, onFallback) {
  if (!Array.isArray(files) || files.length === 0) return browserFallback(onFallback, '<test selection>', 'selection is empty or unavailable');
  const normalized = files.map((file) => repositoryPath(root, file));
  if (normalized.some((file) => file === null)) return browserFallback(onFallback, '<test selection>', 'a selected path is outside the repository');
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
        if (/\.(?:cjs|cts)$/u.test(path)) return browserFallback(onFallback, path, 'CommonJS loader behavior is not statically classified');
        paths.push(path);
        if (committed) {
          const source = committedSource(root, committed, path);
          if (source === null) return browserFallback(onFallback, path, 'committed source is missing or not a regular file');
          sources.push(source);
        } else {
          const absolute = resolve(root, ...path.split('/'));
          if (!(await staysInside(root, absolute))) return browserFallback(onFallback, path, 'live source resolves outside the repository');
          sources.push(await readFile(absolute, 'utf8'));
        }
      }
      if (!sources.length) break;
      if (paths.some((path, index) => (path.startsWith('test/') || SAFE_CHILD_PROCESS_MODULES.has(path))
        && namesChromeLauncher(sources[index]))) return true;
      const dynamicLoaderIndex = sources.findIndex(usesDynamicBuiltinLoader);
      if (dynamicLoaderIndex >= 0) return browserFallback(onFallback, paths[dynamicLoaderIndex], 'dynamic process builtin loading can load an unclassified module');
      const commonJsIndex = commonJsIn(sources).findIndex(Boolean);
      if (commonJsIndex >= 0) return browserFallback(onFallback, paths[commonJsIndex], 'CommonJS loading is not statically classified');
      const imports = importsIn(sources);
      const next = new Set();
      for (let index = 0; index < imports.length; index += 1) {
        for (const request of imports[index]) {
          if (request === 'node:child_process') {
            const policy = SAFE_CHILD_PROCESS_MODULES.get(paths[index]);
            if (!policy) return browserFallback(onFallback, paths[index], 'child_process use has no reviewed path-and-reason exception');
            continue;
          }
          if (request === 'node:module') return browserFallback(onFallback, paths[index], 'node:module can create a dynamic loader');
          if (request === 'node:worker_threads' || request === 'node:cluster') {
            return browserFallback(onFallback, paths[index], `${request} can launch an unclassified module`);
          }
          if (request === 'node:vm' && paths[index] !== 'src/module-imports.js') {
            return browserFallback(onFallback, paths[index], 'node:vm can evaluate an unclassified module');
          }
          if (request.startsWith('node:')) continue;
          if (!request.startsWith('.')) return browserFallback(onFallback, paths[index], `non-local import ${request} is not classified`);
          const target = committed
            ? committedTarget(committed, paths[index], request)
            : await localTarget(root, paths[index], request);
          if (!target) return browserFallback(onFallback, paths[index], `import ${request} is missing or ambiguous`);
          if (target === FIXTURE_CHILD && !safeFixtureChildImport(sources[index], request)) {
            return browserFallback(onFallback, paths[index], 'fixture-child import exposes a generic caller-selected process target');
          }
          if (target === CHROME_FIXTURE) return true;
          if (!target.endsWith('.json') && !seen.has(target)) next.add(target);
        }
      }
      frontier = [...next];
    }
    return false;
  } catch {
    return browserFallback(onFallback, '<test selection>', 'source graph could not be inspected safely');
  }
}

/** Return true for full or uncertain selections, cockpit tests, or imports reaching the Chrome fixture. */
export async function testsNeedBrowser(root, files, { onFallback } = {}) {
  return testsNeedBrowserInTree(root, files, null, onFallback);
}
