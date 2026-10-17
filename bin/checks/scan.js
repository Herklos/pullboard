/**
 * Shared parts of Pullboard's Rigor checks [D1,C7]: the file walk, a small JavaScript lexer and the
 * report. Each check prints one line per problem as `path:line: text`, sorted by path and line, and
 * exits 0 with no problems or 1 with some, so a doctrine row's `gate: check` can count it and blame
 * a changed file by the repo path at the start of each line.
 *
 * The walk starts at the directory given as the first argument, or the working directory, and skips
 * node_modules, work and every directory whose name starts with a dot (.git among them). Paths are
 * repo-relative with forward slashes, and nothing depends on the order the file system lists them.
 */
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIPPED = new Set(['node_modules', 'work']);

/**
 * Every file under the root whose repo-relative path matches `pattern`, sorted.
 *
 * @param {string} root
 * @param {RegExp} pattern
 * @returns {string[]}
 */
export function walk(root, pattern) {
  const found = [];
  const pending = [resolve(root)];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name) && !entry.name.startsWith('.')) pending.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const name = relative(root, path).split(sep).join('/');
      if (pattern.test(name)) found.push(name);
    }
  }
  return found.sort(byText);
}

/** Compare by UTF-16 code units, so the order never depends on the machine's locale. */
function byText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Read one walked file as text.
 *
 * @param {string} root
 * @param {string} path - repo-relative
 * @returns {string}
 */
export function readText(root, path) {
  return readFileSync(join(root, path), 'utf8');
}

/** The root a check scans: its first argument, else the working directory. */
export function rootOf(argv = process.argv) {
  return resolve(argv[2] ?? process.cwd());
}

/**
 * Run a check and report when its file is the program Node started; importing it runs nothing.
 * Why: the test imports each check, so the affected-test selection sees an import edge to it.
 *
 * @param {ImportMeta} meta - the check's `import.meta`
 * @param {(root: string) => { path: string, line: number, text: string }[]} find
 */
export function runCheck(meta, find) {
  // Node resolves symlinks in a module's URL but not in argv, so compare real paths.
  if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(meta.url))) report(find(rootOf()));
}

/**
 * Print problems sorted by path, then line number, then text, and set the exit status: 0 with no
 * problems, 1 with some. One line each, as `path:line: text`.
 *
 * @param {{ path: string, line: number, text: string }[]} problems
 */
export function report(problems) {
  const sorted = [...problems].sort((a, b) => byText(a.path, b.path) || a.line - b.line || byText(a.text, b.text));
  if (sorted.length) process.stdout.write(sorted.map((problem) => `${problem.path}:${problem.line}: ${problem.text}\n`).join(''));
  process.exitCode = sorted.length ? 1 : 0;
}

/** A word before `/` that means a regular expression follows, not a division. */
const KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * Split JavaScript into code, strings and comments, without running it. `code` is the source with
 * the inside of every string, template text, regular expression and comment blanked to spaces
 * (newlines kept), so a pattern run over it only ever sees real code at its real offsets. A
 * template's `${...}` expressions stay code. Each string and template is listed whole, with its
 * text between the quotes; each comment with its span.
 *
 * Why a lexer: test files write fixture tests and catches inside strings, and a plain text search
 * would count those as the test file's own.
 *
 * @param {string} source
 * @returns {{ code: string, strings: { start: number, end: number, text: string }[], comments: { start: number, end: number }[] }}
 */
export function lex(source) {
  const code = source.split('');
  const strings = [];
  const comments = [];
  // Each open template, with the brace depth of its innermost `${` expression.
  const templates = [];
  let previous = '';
  const blank = (from, to) => { for (let at = from; at < to; at += 1) if (code[at] !== '\n') code[at] = ' '; };
  let at = 0;
  /** Scan template text from `at` to its end or its next `${`; returns true when the template closed. */
  const templateText = () => {
    const open = templates[templates.length - 1];
    while (at < source.length) {
      const char = source[at];
      if (char === '\\') { at += 2; continue; }
      if (char === '`') {
        blank(open.textFrom, at);
        strings.push({ start: open.start, end: at + 1, text: source.slice(open.start + 1, at) });
        templates.pop();
        at += 1;
        previous = '`';
        return;
      }
      if (char === '$' && source[at + 1] === '{') {
        blank(open.textFrom, at);
        open.depth = 0;
        at += 2;
        previous = '{';
        return;
      }
      at += 1;
    }
    blank(open.textFrom, source.length);
    templates.pop();
  };
  while (at < source.length) {
    const char = source[at];
    const next = source[at + 1];
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', at) === -1 ? source.length : source.indexOf('\n', at);
      comments.push({ start: at, end });
      blank(at, end);
      at = end;
      continue;
    }
    if (char === '/' && next === '*') {
      const close = source.indexOf('*/', at + 2);
      const end = close === -1 ? source.length : close + 2;
      comments.push({ start: at, end });
      blank(at, end);
      at = end;
      continue;
    }
    if (char === '\'' || char === '"') {
      let end = at + 1;
      while (end < source.length && source[end] !== char && source[end] !== '\n') end += source[end] === '\\' ? 2 : 1;
      strings.push({ start: at, end: end + 1, text: source.slice(at + 1, end) });
      blank(at + 1, end);
      at = end + 1;
      previous = char;
      continue;
    }
    if (char === '`') {
      templates.push({ start: at, textFrom: at + 1, depth: -1 });
      at += 1;
      templateText();
      continue;
    }
    if (char === '/' && regexAllowed(previous)) {
      let end = at + 1;
      let inClass = false;
      while (end < source.length && source[end] !== '\n') {
        if (source[end] === '\\') { end += 2; continue; }
        if (source[end] === '[') inClass = true;
        else if (source[end] === ']') inClass = false;
        else if (source[end] === '/' && !inClass) break;
        end += 1;
      }
      blank(at + 1, end);
      at = end + 1;
      previous = '/';
      continue;
    }
    const open = templates[templates.length - 1];
    if (open && open.depth >= 0) {
      if (char === '{') open.depth += 1;
      else if (char === '}') {
        if (open.depth === 0) {
          open.depth = -1;
          open.textFrom = at + 1;
          at += 1;
          templateText();
          continue;
        }
        open.depth -= 1;
      }
    }
    if (/[\w$]/u.test(char)) {
      let end = at;
      while (end < source.length && /[\w$]/u.test(source[end])) end += 1;
      previous = source.slice(at, end);
      at = end;
      continue;
    }
    if (!/\s/u.test(char)) previous = char;
    at += 1;
  }
  return { code: code.join(''), strings, comments };
}

/** True when a `/` after this token starts a regular expression rather than dividing. */
function regexAllowed(previous) {
  if (!previous) return true;
  if (/^[\w$]+$/u.test(previous)) return KEYWORDS.has(previous);
  return !/^[)\]'"`]$/u.test(previous) && previous !== '/';
}

/**
 * The 1-based line of an offset.
 *
 * @param {string} source
 * @param {number} offset
 * @returns {number}
 */
export function lineAt(source, offset) {
  let line = 1;
  for (let at = source.indexOf('\n'); at !== -1 && at < offset; at = source.indexOf('\n', at + 1)) line += 1;
  return line;
}

/** A test file, as the affected-test selection names one: `*.test.js` or `*.spec.js`, also .mjs and .cjs. */
export const TEST_FILE = /\.(?:test|spec)\.[cm]?js$/u;
