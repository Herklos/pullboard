import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { machine, project, startView, chromeExecutable, openSnapshotChrome, closeSnapshotChrome } from './fixture.js';
import { press, waitForStableBoxes } from './stable.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const COCKPIT = join(ROOT, 'test', 'cockpit');
const EXEMPT_FUNCTIONS = new Set(['rawChromeEvaluation', 'waitForStableBoxes', 'press']);

/** Find complete top-level exception bodies without exempting the rest of stable.js. */
function maskSharedChromeFunctions(source) {
  const lines = source.split('\n');
  for (let start = 0; start < lines.length; start += 1) {
    const declaration = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/.exec(lines[start]);
    if (!declaration || !EXEMPT_FUNCTIONS.has(declaration[1])) continue;
    let end = start + 1;
    while (end < lines.length && lines[end] !== '}') end += 1;
    if (end === lines.length) continue;
    for (let line = start; line <= end; line += 1) lines[line] = '';
    start = end;
  }
  return lines.join('\n');
}

/** Return every forbidden raw Chrome call with a cockpit-relative path and source line. */
function rawChromeBypasses(root = COCKPIT) {
  const patterns = [
    ['direct evaluate', new RegExp('(?<!Runtime)\\.\\s*' + 'evaluate' + '\\b')],
    ['computed evaluate', new RegExp('\\[\\s*[\'"]' + 'evaluate' + '[\'"]\\s*\\]')],
    ['unwaited DOM click', new RegExp('\\.\\s*' + 'click' + '\\s*\\(\\s*\\)')],
    ['raw protocol', new RegExp('[\'"](?:Runtime\\.(?:evaluate|callFunctionOn)|DOM\\.(?:getBoxModel|getContentQuads)|Page\\.getLayoutMetrics|Input\\.dispatch(?:Mouse|Touch)Event)[\'"]')],
  ];
  const files = [];
  /** Include future nested Chrome test files in the boundary check. */
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.(?:js|mjs)$/u.test(entry.name)) files.push(path);
    }
  }
  walk(root);
  const violations = [];
  for (const path of files) {
    let source = readFileSync(path, 'utf8');
    if (basename(path) === 'stable.js' && relative(root, path) === 'stable.js') {
      source = maskSharedChromeFunctions(source);
    }
    const lines = source.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      for (const [kind, pattern] of patterns) {
        if (pattern.test(lines[index])) violations.push({ file: relative(root, path), line: index + 1, kind });
      }
    }
  }
  return violations;
}

test('real Chrome tests measure and click only through the shared wait [N26,C7]', () => {
  assert.deepEqual(rawChromeBypasses(), [], 'every cockpit test uses the stable API; raw CDP plumbing stays in the three named helpers');
});

test('the shared-wait guard reports a synthetic direct Chrome evaluation by file and line [N26,C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-shared-wait-guard-'));
  try {
    mkdirSync(join(root, 'nested'));
    const directCall = ['chrome', '.', 'evaluate', '(', JSON.stringify(["document.querySelector('.card')", ".", "click", "()"].join("")), ')'].join('');
    const alias = ['chrome', '[', JSON.stringify('evaluate'), ']'].join('');
    writeFileSync(join(root, 'nested', 'direct.test.js'), `const ready = true;\n${directCall};\nconst saved = ${alias};\n`);
    assert.deepEqual(rawChromeBypasses(root), [{ file: 'nested/direct.test.js', line: 2, kind: 'direct evaluate' }, { file: 'nested/direct.test.js', line: 2, kind: 'unwaited DOM click' }, { file: 'nested/direct.test.js', line: 3, kind: 'computed evaluate' }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('raw protocol exceptions are limited to named stable helpers [N26,C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-shared-wait-scope-'));
  try {
    writeFileSync(join(root, 'stable.js'), [
      'export async function rawChromeEvaluation(chrome) {',
      '  return chrome.send(' + JSON.stringify(['Runtime', 'evaluate'].join('.')) + ', {});',
      '}',
      'export async function waitForStableBoxes(chrome) {',
      '  return chrome.send(' + JSON.stringify(['DOM', 'getBoxModel'].join('.')) + ', {});',
      '}',
      'export async function press(chrome) {',
      '  return chrome.send(' + JSON.stringify(['Input', 'dispatchMouseEvent'].join('.')) + ', {});',
      '}',
      'export async function accidentalBypass(chrome) {',
      `  return ${['chrome', '.', 'evaluate', '(', "'outside helper'", ')'].join('')};`,
      '}',
    ].join('\n') + '\n');
    assert.deepEqual(rawChromeBypasses(root), [{ file: 'stable.js', line: 11, kind: 'direct evaluate' }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the guard catches each low-level protocol bypass outside shared helpers [N26,C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-shared-wait-protocol-'));
  try {
    const forbiddenCalls = [
      ['Runtime', 'evaluate'], ['Runtime', 'callFunctionOn'], ['DOM', 'getBoxModel'],
      ['DOM', 'getContentQuads'], ['Page', 'getLayoutMetrics'], ['Input', 'dispatchMouseEvent'], ['Input', 'dispatchTouchEvent'],
    ].map(parts => `chrome.send(${JSON.stringify(parts.join('.'))}, {});`);
    writeFileSync(join(root, 'protocol.test.js'), forbiddenCalls.join('\n') + '\n');
    assert.deepEqual(rawChromeBypasses(root).map(({ file, line }) => [file, line]), forbiddenCalls.map((_, index) => ['protocol.test.js', index + 1]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('real Chrome retains reduced motion and jumps both detail panes without animation [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for motion checks.');
  const box = machine(), demo = project(box, 'motion-demo');
  box.run(demo.repo, 'add', 'web', 'Jump to this detail', '--specs', 'G1', '--criterion', 'visible');
  const view = await startView(box);
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, join(box.dir, 'motion-chrome'));
    await chrome.waitFor("typeof data === 'object' && !!data?.project");
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const scheme of ['light', 'dark']) {
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      assert.equal(await chrome.stable("matchMedia('(prefers-reduced-motion: reduce)').matches"), true, `${scheme}: a later media override keeps reduced motion`);
      assert.equal(await chrome.stable(`matchMedia('(prefers-color-scheme: ${scheme})').matches`), true);
    }
    await chrome.stable(`(() => {
      const probe = document.createElement('div'); probe.id = 'motion-proof';
      probe.style.cssText = 'position:fixed;width:10px;height:10px;transition:width 2s;animation:proof-motion 2s infinite;scroll-behavior:smooth';
      document.body.append(probe);
      window.__detailScrolls = [];
      const original = Element.prototype.scrollIntoView;
      /** Record the actual navigation scroll while retaining Chrome behavior. */
      Element.prototype.scrollIntoView = function(options) { window.__detailScrolls.push({id:this.id,behavior:options?.behavior}); return original.call(this, options); };
    })()`);
    assert.deepEqual(await chrome.stable(`(() => {const style=getComputedStyle(document.querySelector('#motion-proof'));return [style.transitionDuration,style.animationName,style.scrollBehavior];})()`), ['0s', 'none', 'auto'], 'reduced motion disables transitions, animations and CSS smooth scrolling');
    await press(chrome, "document.querySelector('#chain .row')");
    await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Jump to this detail')");
    await press(chrome, "document.querySelector('[data-tab=spec]')");
    await press(chrome, `document.querySelector('#spec-chips [data-rows="spec:all"]')`);
    await press(chrome, `document.querySelector('#spec-list [data-row="spec:G2"]')`);
    const scrolls = await chrome.stable('window.__detailScrolls');
    for (const id of ['detail', 'spec-detail']) assert.ok(scrolls.some(entry => entry.id === id && entry.behavior === 'instant'), `${id} jumps immediately: ${JSON.stringify(scrolls)}`);
    await chrome.stable(`(() => {
      const probe=document.createElement('div'); probe.id='zero-box-proof'; probe.style.cssText='position:fixed;width:0;height:0'; document.body.append(probe);
      let frame=0; const grow=()=>{frame++;probe.dataset.frames=String(frame);if(frame===20){probe.style.width='10px';probe.style.height='10px';}else requestAnimationFrame(grow);};requestAnimationFrame(grow);
    })()`);
    await waitForStableBoxes(chrome, "document.querySelector('#zero-box-proof')");
    assert.equal(Number(await chrome.stable("document.querySelector('#zero-box-proof').dataset.frames")), 20, 'the shared wait does not accept an existing zero-size target');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
  }
});
