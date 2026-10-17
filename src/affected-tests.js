/** Select committed Node test files through import edges; uncertainty requires the full gate [V4,C7]. */
import { spawnSync } from 'node:child_process';
import { posix } from 'node:path';
import { cleanGitEnvironment } from './git.js';
import {
  commonJsIn,
  importsIn,
} from './module-imports.js';

const MODULE = /\.[cm]?js$/u;
const TEST = /\.(?:test|spec)\.[cm]?js$/u;
const DOC = /^docs\/.+\.md$/u;
// A scanner declares this header rather than executing code while the graph is read.
const TEST_TREE_INPUT = '/** @pullboard-test-input test-tree */';
const SOURCE_TREE_INPUT = '/** @pullboard-test-input source-tree */';
const DOCS_TREE_INPUT = '/** @pullboard-test-input docs-tree */';
const GLOBAL = new Set(['bin/run-tests.js', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'src/gate.js', 'src/cli.js', 'src/hooks.js', 'src/trusted-policy.js', 'src/affected-tests.js', 'src/module-imports.js']);

/** Read exact objects from this checkout, ignoring ambient Git selectors and replacement refs. */
function selectionGit(root, args) {
  const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.quotepath=false', ...args], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('the committed import graph could not be read');
  return result.stdout;
}

/** Read all committed module blobs in one Git batch, preserving exact names and source bytes. */
function modulesAt(root, commit) {
  const tracked = selectionGit(root, ['ls-tree', '-r', '-z', commit]).split('\0').filter(Boolean).map(record => {
    const tab = record.indexOf('\t');
    const [mode, type, hash] = record.slice(0, tab).split(' ');
    return { mode, type, hash, path: record.slice(tab + 1) };
  });
  const entries = tracked.filter(entry => MODULE.test(entry.path));
  // V8 compiles a require() expression as ESM too, but cannot supply its CommonJS edges.
  if (entries.some(entry => entry.path.endsWith('.js'))) {
    const policy = JSON.parse(selectionGit(root, ['show', `${commit}:package.json`]));
    if (policy.type !== 'module' || tracked.some(entry => entry.path.endsWith('/package.json'))) {
      throw new Error('CommonJS or nested package scopes cannot supply a complete ES-module import graph');
    }
  }
  if (entries.some(entry => entry.type !== 'blob' || entry.mode === '120000' || entry.path.endsWith('.cjs'))) {
    throw new Error('a tracked module uses an unsupported file mode or CommonJS');
  }
  if (!entries.length) return new Map();
  const hashes = [...new Set(entries.map(entry => entry.hash))];
  const result = spawnSync('git', ['--no-replace-objects', 'cat-file', '--batch'], {
    cwd: root, env: cleanGitEnvironment(), input: hashes.join('\n') + '\n', maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('committed module blobs could not be read');
  const sources = new Map();
  let at = 0;
  for (const hash of hashes) {
    const end = result.stdout.indexOf(10, at);
    const [actual, type, count] = result.stdout.subarray(at, end).toString().split(' ');
    const size = Number(count);
    if (actual !== hash || type !== 'blob' || !Number.isSafeInteger(size) || size < 0) throw new Error('committed module batch is incomplete');
    at = end + 1;
    sources.set(hash, result.stdout.subarray(at, at + size).toString('utf8'));
    at += size + 1;
  }
  return new Map(entries.map(entry => [entry.path, sources.get(entry.hash)]));
}

/**
 * Find literal documentation inputs without executing repository code. File references are resolved
 * both from the repository and from the reader; directory references deliberately overselect their
 * subtree. Split path arguments and template prefixes count as directory reads. Comments may add
 * readers, which is safe: this is conservative input discovery, not JavaScript data-flow analysis.
 * Computed Markdown names select the docs tree; opaque helpers declare DOCS_TREE_INPUT. The
 * landing gate remains complete and never uses this submit-only optimization.
 */
function documentationInputs(path, source, imports, changedDocs = []) {
  const inputs = new Set();
  if (source.split(/\r?\n/u).includes(DOCS_TREE_INPUT)) inputs.add('docs');
  // Plain text is the required conservative rule: syntax, comments, and escapes do not matter.
  // Keep the older literal-reader scan below as an additional conservative signal.
  if (source.includes('docs') && source.includes('.md')) {
    for (const doc of changedDocs) inputs.add(doc);
  }
  for (const doc of changedDocs) {
    const basename = posix.basename(doc).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const wholeWord = new RegExp(`(?:^|[^\\p{L}\\p{M}\\p{N}_])${basename}(?:$|[^\\p{L}\\p{M}\\p{N}_])`, 'u');
    if (wholeWord.test(source)) inputs.add(doc);
  }
  const markdownReader = imports.some(target => target === 'node:fs' || target === 'node:fs/promises');
  const literals = /(['"])(?:\\[\s\S]|(?!\1)[^\\\r\n])*\1|`(?:\\[\s\S]|[^`\\])*`/uy;
  // Try every quote start: a quote in a comment or regular expression must not hide a later real path.
  for (const quote of source.matchAll(/['"`]/gu)) {
    literals.lastIndex = quote.index;
    const match = literals.exec(source);
    if (!match) continue;
    let values;
    if (match[0][0] === '`') {
      const raw = match[0].slice(1,-1);
      // Cook escape sequences only; never evaluate an interpolation. Keep raw text too for tags.
      const cooked = raw.replace(/\\(u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|\r\n|[\s\S])/gu, (_, escape) => {
        if (/^u\{[\da-fA-F]+\}$/u.test(escape)) return String.fromCodePoint(parseInt(escape.slice(2,-1),16));
        if (/^(?:u[\da-fA-F]{4}|x[\da-fA-F]{2})$/u.test(escape)) return String.fromCharCode(parseInt(escape.slice(1),16));
        return ({ n:'\n', r:'\r', t:'\t', b:'\b', f:'\f', v:'\v', 0:'\0', '\n':'', '\r':'', '\r\n':'' })[escape] ?? escape;
      });
      values = [...new Set([raw,cooked])].map(text => {
        const rootDoc = /(?:^|\/)docs(?:\/|$)/u.exec(text);
        if (!rootDoc && text.includes('${') && text.endsWith('.md') && markdownReader) inputs.add('docs');
        return (rootDoc ? text.slice(rootDoc.index + (rootDoc[0].startsWith('/') ? 1 : 0)) : text).split('${',1)[0];
      });
    }
    else {
      // Only a complete quoted string matched above is evaluated, never a template or expression.
      try { values = [match[0].includes('\\') ? new Function(`return ${match[0]};`)() : match[0].slice(1,-1)]; }
      catch { continue; }
    }
    for (let value of values) {
      if (typeof value !== 'string') continue;
      value = value.split(/[?#]/u)[0].replace(/\/$/u,'');
      const embeddedRoot = /\/docs(?:\/|$)/u.exec(value);
      if (embeddedRoot) value = value.slice(embeddedRoot.index + 1);
      const wildcard = value.search(/[\*\[\{]/u);
      if (wildcard !== -1) value = value.slice(0,value.lastIndexOf('/',wildcard) + 1);
      if (value === '.md' && markdownReader) { inputs.add('docs'); continue; }
      if (!value) continue;
      const directoryReader = /\b(?:readdir|glob|opendir)/u.test(source);
      if (!value.includes('/') && !value.endsWith('.md') && value !== 'docs' && !directoryReader) continue;
      const prefix = value === 'docs' || value.endsWith('.md') ? source.slice(0,match.index).trimEnd() : '';
      if (/\.(?:startsWith|endsWith|includes|indexOf)\($/u.test(prefix)) continue;
      if (markdownReader && value.endsWith('.md') && !value.includes('docs/')
        && (/\+$/u.test(prefix) || /^\s*\+/u.test(source.slice(match.index + match[0].length)))) inputs.add('docs');
      // Bare "docs" is also a commit type or lane. In a call/path assignment, or a directory
      // scanner, it can name an input; a declaration of commit types alone is not a reader.
      const callArgument = /[,(]$/u.test(prefix) && prefix.lastIndexOf('(') > prefix.lastIndexOf('[');
      const joinedArray = prefix.lastIndexOf('[') > prefix.lastIndexOf(']')
        && /^[^\]]*\]\s*\.join\s*\(/u.test(source.slice(match.index + match[0].length));
      if (value === 'docs' && !callArgument && !joinedArray && !/(?<![=!<>])=$/u.test(prefix) && !directoryReader) continue;
      for (const candidate of [posix.normalize(value), posix.normalize(posix.join(posix.dirname(path),value))]) {
        if (candidate === 'docs' || candidate.startsWith('docs/')) inputs.add(candidate.replace(/\/$/u,''));
      }
    }
  }
  return inputs;
}

/**
 * Admit only the named builtin-export synchronizer, which cannot create module-loader edges.
 * Rewrite that exact import and ask V8 whether another node:module edge remains. Text in comments
 * or strings cannot hide a real unknown import. Keep dynamic builtin loaders and CommonJS unknown.
 */
function knownBuiltinSynchronizers(sources, imports) {
  const indices = sources.flatMap((_source, index) => imports[index].includes('node:module') ? [index] : []);
  if (!indices.length) return new Set();
  const synchronizer = /\bimport\s*\{\s*syncBuiltinESMExports\s*,?\s*\}\s*from\s*(['"])node:module\1/gu;
  const rewritten = indices.map(index => sources[index].replace(synchronizer,
    (_match, quote) => `import { syncBuiltinESMExports } from ${quote}node:fs${quote}`));
  const remaining = importsIn(rewritten);
  // Reuse V8's code-versus-text probe for the dynamic builtin loader as well as CommonJS words.
  const loaders = commonJsIn(indices.map(index => sources[index].replace(/\bgetBuiltinModule\b/gu, 'createRequire')));
  return new Set(indices.filter((_index, offset) => !remaining[offset].includes('node:module') && !loaders[offset]));
}

/** Compile this tree's import edges, plus the literal child-CLI dependency used by fixture modules. */
function graphAt(root, commit, changedDocs = []) {
  const modules = modulesAt(root, commit);
  const paths = [...modules.keys()];
  const sources = [...modules.values()];
  const imports = importsIn(sources);
  const synchronizers = knownBuiltinSynchronizers(sources, imports);
  const reverse = new Map();
  const unknown = new Map();
  const always = new Set();
  const testTreeReaders = new Set();
  const sourceTreeReaders = new Set();
  const docInputs = new Map();
  paths.forEach((path, index) => {
    if (changedDocs.length) docInputs.set(path, documentationInputs(path, modules.get(path), imports[index], changedDocs));
    if (TEST.test(path)) {
      for (const line of modules.get(path).split(/\r?\n/u)) {
        if (line === TEST_TREE_INPUT) testTreeReaders.add(path);
        else if (line === SOURCE_TREE_INPUT) sourceTreeReaders.add(path);
        else if (line === DOCS_TREE_INPUT) continue;
        else break;
      }
    }
    for (const target of imports[index]) {
      if (target === 'node:module') {
        if (!synchronizers.has(index)) unknown.set(path, 'a reached module may create CommonJS imports');
        continue;
      }
      if (target.startsWith('node:')) continue;
      if (target === '(computed)' && TEST.test(path)) { always.add(path); continue; }
      if (!target.startsWith('.')) {
        unknown.set(path, target === '(computed)' ? 'non-literal dynamic import' : 'unresolved package import');
        continue;
      }
      const dependency = posix.normalize(posix.join(posix.dirname(path), target.split(/[?#]/u)[0]));
      if (dependency.startsWith('../')) { unknown.set(path, 'import outside the repository'); continue; }
      if (!reverse.has(dependency)) reverse.set(dependency, new Set());
      reverse.get(dependency).add(path);
    }
    // A child process is not an import edge, but tests and helpers that name the CLI entry depend on
    // every module it imports. Keep this literal path edge narrow and build it for each committed tree.
    if (modules.get(path).includes('bin/pullboard.js')) {
      if (!reverse.has('bin/pullboard.js')) reverse.set('bin/pullboard.js', new Set());
      reverse.get('bin/pullboard.js').add(path);
    }
  });
  return { paths, reverse, unknown, always, testTreeReaders, sourceTreeReaders, docInputs };
}

/**
 * Select changed tests and every transitive importer in the old and new trees. Old edges cover
 * deletions and renames; declared tree readers also cover changed test or source inputs. Other filesystem
 * reads and process launches are not import edges, except literal documentation inputs and modules that
 * mention the Pullboard CLI entry (`bin/pullboard.js`), whose imported modules they exercise as subprocesses.
 *
 * @param {string} root
 * @param {{base:string|null, trunk?:string, commit?:string, changed?:string[]}} options
 * @returns {{full:boolean, reason:string, files:string[]}}
 */
export function selectAffectedTests(root, { base, trunk, commit = 'HEAD', changed }) {
  let files = [];
  try {
    if (!base) return { full: true, reason: 'no claim head recorded; the change cannot be selected', files };
    // The merge base includes topic parents and merge resolutions that receipt history omits.
    if (trunk) {
      const mergeBase = selectionGit(root, ['merge-base', trunk, commit]).trim();
      const submitted = selectionGit(root, ['rev-parse', '--verify', `${commit}^{commit}`]).trim();
      // A trunk submission has no distinct branch base; its claim bounds the submitted work.
      if (mergeBase !== submitted) base = mergeBase;
      changed = undefined;
    }
    changed ??= selectionGit(root, ['diff', '--no-renames', '--name-only', '-z', base, commit]).split('\0').filter(Boolean);
    const changedDocs = changed.filter(path => DOC.test(path));
    const after = graphAt(root, commit, changedDocs);
    files = after.paths.filter(path => TEST.test(path)).sort();
    const fallback = changed.find(path => GLOBAL.has(path) || path.startsWith('.githooks/'));
    if (fallback) return { full: true, reason: `${fallback} controls the gate or dependency selection`, files };
    if (!files.length) return { full: true, reason: 'no committed Node test files can be selected', files };
    const unsupported = changed.find(path => !MODULE.test(path) && !DOC.test(path));
    if (unsupported) return { full: true, reason: `import selection cannot compute the effect of ${unsupported}`, files };
    const before = graphAt(root, base, changedDocs);
    const reached = new Set(changed);
    const queue = [...changed];
    for (const doc of changed.filter(path => DOC.test(path))) {
      for (const graph of [before, after]) {
        for (const [reader, inputs] of graph.docInputs) {
          if ([...inputs].some(input => input === doc || doc.startsWith(input + '/'))) {
            if (!reached.has(reader)) { reached.add(reader); queue.push(reader); }
          }
        }
      }
    }
    for (let at = 0; at < queue.length; at += 1) {
      const path = queue[at];
      for (const graph of [before, after]) {
        if (graph.unknown.has(path)) return { full: true, reason: `${graph.unknown.get(path)} in reached file ${path}`, files };
        for (const importer of graph.reverse.get(path) ?? []) {
          if (!reached.has(importer)) { reached.add(importer); queue.push(importer); }
        }
      }
    }
    const changedTestInput = changed.some(path => path.startsWith('test/') || TEST.test(path) || /^test\.[cm]?js$/u.test(path));
    const changedSourceInput = changed.some(path => path.startsWith('src/') || path.startsWith('bin/'));
    const selected = files.filter(path => reached.has(path) || before.always.has(path) || after.always.has(path)
      || (changedTestInput && (before.testTreeReaders.has(path) || after.testTreeReaders.has(path)))
      || (changedSourceInput && (before.sourceTreeReaders.has(path) || after.sourceTreeReaders.has(path))));
    if (selected.length === files.length) return { full: true, reason: 'the change reaches every test file', files };
    return { full: false, reason: '', files: selected };
  } catch (error) {
    return { full: true, reason: `import selection could not be computed: ${error.message}`, files };
  }
}
