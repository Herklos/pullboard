#!/usr/bin/env node
/**
 * Rigor check: a test that reads source files declares it [D1,C7,V4].
 *
 * Submit selects the tests a change affects through import edges (src/affected-tests.js). A test
 * that reads source as data, rather than importing it, is invisible to that graph unless its file
 * opens with the header line the selection reads: `/** @pullboard-test-input source-tree *\/`,
 * among the declaration lines at the very top of the file.
 *
 * A test reads source files when one line of its code (outside strings and comments) calls a
 * node:fs read (readFileSync, readFile, readdirSync, readdir, opendirSync, opendir or
 * createReadStream), anchors a path at this checkout through `import.meta` or a `ROOT` constant,
 * and holds a string or template literal naming the source tree: `src` as a whole path segment,
 * as in '../src/seal.js' or join(ROOT, 'src'). The anchor keeps out fixtures, which copy src into
 * a temporary repo and read that copy. A test file is `*.test.js` or `*.spec.js`, also .mjs and
 * .cjs. One problem per undeclared test file, at its first such line.
 */
import { lex, readText, runCheck, TEST_FILE, walk } from './scan.js';

const SOURCE_TREE_INPUT = '/** @pullboard-test-input source-tree */';
const DECLARATIONS = new Set([SOURCE_TREE_INPUT, '/** @pullboard-test-input test-tree */', '/** @pullboard-test-input docs-tree */']);
const READ = /\b(?:readFileSync|readFile|readdirSync|readdir|opendirSync|opendir|createReadStream)\s*\(/u;
const ANCHOR = /\bimport\s*\.\s*meta\b|(?<![\w$.])ROOT\b/u;
const SOURCE_PATH = /(?:^|\/)src(?:\/|$)/u;

/**
 * True when the file's leading declaration lines include the source-tree input, read as the
 * affected-test selection reads them.
 *
 * @param {string} source
 * @returns {boolean}
 */
export function declaresSource(source) {
  for (const line of source.split(/\r?\n/u)) {
    if (line === SOURCE_TREE_INPUT) return true;
    if (!DECLARATIONS.has(line)) return false;
  }
  return false;
}

/**
 * One problem per test file that reads source files without the declaration.
 *
 * @param {string} root
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function testInputProblems(root) {
  const problems = [];
  for (const path of walk(root, TEST_FILE)) {
    const source = readText(root, path);
    if (declaresSource(source)) continue;
    const { code, strings } = lex(source);
    const codeLines = code.split('\n');
    const lineStarts = [0];
    for (const line of codeLines) lineStarts.push(lineStarts[lineStarts.length - 1] + line.length + 1);
    const index = codeLines.findIndex((line, at) => READ.test(line) && ANCHOR.test(line)
      && strings.some((literal) => literal.start >= lineStarts[at] && literal.start < lineStarts[at + 1] && SOURCE_PATH.test(literal.text)));
    if (index !== -1) problems.push({ path, line: index + 1, text: `reads source files without ${SOURCE_TREE_INPUT} at the top` });
  }
  return problems;
}

runCheck(import.meta, testInputProblems);
