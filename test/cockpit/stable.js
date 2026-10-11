/** One real-Chrome measurement and pointer boundary for all cockpit stories [N26,C7]. */
import assert from 'node:assert/strict';

const clients = new WeakMap();

/** Evaluate only inside the shared boundary; tests receive no raw page evaluator. */
async function rawChromeEvaluation(chrome, expression) {
  const result = await clients.get(chrome).send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

/**
 * Wait for the visible page and each required target to exist with nonzero boxes unchanged over two frames.
 * Sampling descendants includes SVG progress bars and Range containers, not just the control's outer box.
 * The deadline only bounds a missing or perpetually moving target; it is not a rendering speed assertion.
 */
export async function waitForStableBoxes(chrome, find = 'document.documentElement', timeoutMs = 10_000) {
  const result = await rawChromeEvaluation(chrome, `(async () => {
    /** Resolve targets afresh because a board refresh can replace a matching node. */
    const targets = () => { const found = (${find}); return found instanceof Element ? [found] : Array.from(found || []); };
    /** Retain rendered boxes while ignoring deliberate hidden-pane visibility probes. */
    const visible = element => { const style = getComputedStyle(element), box = element.getBoundingClientRect(); return !element.closest('[hidden]') && style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0; };
    /** Compare exact layout geometry without tolerances that hide movement. */
    const box = element => { const rect = element.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height]; };
    let lastSeen = 'no frame sampled';
    /** Capture required targets, descendants and page extents in one layout sample. */
    const sample = () => {
      const required = targets();
      lastSeen = required.length ? JSON.stringify(required.map(element => element instanceof Element
        ? { tag: element.tagName, id: element.id, connected: element.isConnected, hidden: !!element.closest('[hidden]'), box: box(element) }
        : { target: String(element) })) : 'no matching target';
      if (!required.length || !required.every(element => element instanceof Element && element.isConnected && visible(element))) return null;
      const elements = [...document.querySelectorAll('body, body *')].filter(visible);
      return { targets: required.map(box), page: [scrollX, scrollY, document.documentElement.clientWidth, document.documentElement.scrollWidth, document.documentElement.scrollHeight, ...elements.map(box)] };
    };
    return await new Promise((resolve, reject) => {
      let previous = '', unchanged = 0, frameId = 0;
      const timer = setTimeout(() => { cancelAnimationFrame(frameId); reject(Error('shared wait: target missing, zero-sized or moving: ' + ${JSON.stringify(find)} + '; last saw ' + lastSeen)); }, ${timeoutMs});
      /** Resolve only after two complete frame intervals have unchanged nonzero geometry. */
      const frame = () => {
        let current;
        try { current = sample(); } catch (error) { current = null; lastSeen = error.name + ': ' + error.message; }
        const signature = current ? JSON.stringify(current) : '';
        unchanged = signature && signature === previous ? unchanged + 1 : 0;
        previous = signature;
        if (unchanged >= 2) { clearTimeout(timer); resolve(current.targets); return; }
        frameId = requestAnimationFrame(frame);
      };
      // Sample synchronously before yielding so even an expired short timer has a real diagnostic.
      try { sample(); } catch (error) { lastSeen = error.name + ': ' + error.message; }
      frameId = requestAnimationFrame(frame);
    });
  })()`);
  assert.ok(Array.isArray(result) && result.length > 0, `shared wait finds a rendered target: ${find}`);
  return result;
}

/**
 * Press an uncovered, stable target through real Chrome input. A pointer move can change hover layout,
 * so wait again after it and refuse a changed point rather than retrying the action at another point.
 */
export async function press(chrome, find, { native = true } = {}) {
  await waitForStableBoxes(chrome, find);
  if (!native) return rawChromeEvaluation(chrome, `(${find}).click()`);
  await rawChromeEvaluation(chrome, `(${find}).scrollIntoView({ block: 'center', behavior: 'instant' })`);
  await waitForStableBoxes(chrome, find);
  const pointExpression = `(() => {
    const element = (${find}), rect = element.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!rect.width || !rect.height || !hit || (hit !== element && !element.contains(hit))) throw Error('shared press: target is hidden or covered: ' + ${JSON.stringify(find)});
    return { x, y, width: rect.width, height: rect.height, scrollX, scrollY };
  })()`;
  const point = await rawChromeEvaluation(chrome, pointExpression);
  const raw = clients.get(chrome);
  await raw.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await waitForStableBoxes(chrome, find);
  const underPointer = await rawChromeEvaluation(chrome, pointExpression);
  assert.deepEqual(underPointer, point, `shared press: target stays under the pointer: ${find}`);
  await rawChromeEvaluation(chrome, `(() => {
    const element = (${find});
    const name = node => node ? node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (typeof node.className === 'string' && node.className ? '.' + node.className.trim().split(/\\s+/).join('.') : '') : 'nothing';
    window.__pressed = { meant: name(element), at: ${Math.round(point.y)}, scrollY: Math.round(scrollY) };
    document.addEventListener('mousedown', event => Object.assign(window.__pressed, { landed: name(event.target), landedAt: Math.round(event.clientY), scrolledTo: Math.round(scrollY) }), { capture: true, once: true });
  })()`);
  await raw.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await raw.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

/** Tap a stable visible target with Chrome's real touch input path, so touch interactions are not simulated clicks. */
export async function tapTouch(chrome, find) {
  await waitForStableBoxes(chrome, find);
  await rawChromeEvaluation(chrome, `(${find}).scrollIntoView({ block: 'center', behavior: 'instant' })`);
  await waitForStableBoxes(chrome, find);
  const point = await rawChromeEvaluation(chrome, `(() => {
    const element = (${find}), rect = element.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!rect.width || !rect.height || !hit || (hit !== element && !element.contains(hit))) throw Error('shared touch: target is hidden or covered: ' + ${JSON.stringify(find)});
    return { x, y };
  })()`);
  const raw = clients.get(chrome);
  const touchPoint = { ...point, id: 1, radiusX: 1, radiusY: 1, force: 1 };
  await raw.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint] });
  await raw.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/**
 * Expose only waited page expressions. Every media override retains reduced motion, including the external
 * relay browser's pages. Polling observes readiness; it never retries a click or reruns an assertion.
 */
export async function stableChrome(raw) {
  const { evaluate: unusedEvaluate, waitFor: unusedWait, ...chrome } = raw;
  clients.set(chrome, raw);
  /** Send non-measuring protocol commands and retain reduced motion across colour-scheme changes. */
  chrome.send = async (method, params = {}) => {
    if (/^(?:Runtime\.(?:evaluate|callFunctionOn)|DOM\.(?:getBoxModel|getContentQuads)|Page\.getLayoutMetrics|Input\.dispatch(?:Mouse|Touch)Event)$/.test(method)) {
      throw new Error(`Use the shared stable wait or press instead of ${method}`);
    }
    if (method === 'Emulation.setEmulatedMedia') params = { ...params, features: [
      ...(params.features ?? []).filter(feature => feature.name !== 'prefers-reduced-motion'),
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ] };
    return raw.send(method, params);
  };
  /** Deliver a DOM click only after its actual target has a stable, nonzero box. */
  chrome.click = find => press(chrome, find, { native: false });
  /** Run one expression after the visible page and its explicit targets have stopped moving. */
  chrome.stable = async (expression, find = 'document.documentElement') => {
    await waitForStableBoxes(chrome, find);
    return rawChromeEvaluation(chrome, expression);
  };
  /** Poll readiness through the same measurement boundary, with the last page error on a bounded failure. */
  chrome.waitFor = async (expression, timeoutMs = 10_000) => {
    // budget: a bounded readiness wait fails a missing page, not a rendering speed requirement.
    const deadline = Date.now() + timeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
      try {
        if (await chrome.stable(expression)) return;
      } catch (error) { lastError = error.message; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Browser condition did not arrive: ${expression}${lastError ? `; it last threw: ${lastError}` : ''}`);
  };
  await chrome.send('Emulation.setEmulatedMedia', { features: [] });
  return chrome;
}

/** Assert the stress run delayed the real first board-state fetch, rather than merely delaying a test. */
export async function assertFirstStateDelay(chrome, t) {
  const expected = Number(process.env.PULLBOARD_CHROME_FIRST_STATE_DELAY_MS ?? 0);
  if (!Number.isSafeInteger(expected) || expected <= 0 || expected > 30_000) return;
  await chrome.waitFor('window.__pullboardFirstStateDelay?.ended !== null && !!window.__pullboardFirstStateDelay');
  const elapsed = await chrome.stable('window.__pullboardFirstStateDelay.ended - window.__pullboardFirstStateDelay.started');
  t.diagnostic(`first board-state request delayed ${Math.round(elapsed)}ms (requested ${expected}ms)`);
  // budget: declared first-state fetch delay is the opt-in stress input, not an operation speed limit.
  assert.ok(elapsed >= expected, `first board-state request waits at least ${expected}ms: ${elapsed}`);
}
