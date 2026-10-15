/** A real browser confirms the exact SSH relay board intent [P6,H5]. */
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { basename } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { relayClientFixture } from './relay-client-fixture.js';
import { findChromeExecutable, startChrome } from './relay-browser-fixture.js';

const CONFIRMATION_PROMPT = 'After sign-in, confirm the link in your browser: ';
const CONFIRMATION_POLL_INTERVAL_MS = 2000;

/** Count real browser status requests without retaining their tickets or request bodies. */
function confirmationStatusRequestCount(box) {
  return box.calls.filter(call => call.method === 'POST' && call.path === '/auth/device/confirmation/status').length;
}

/** Count linked boards through a read-only connection to the private relay database. */
function linkedBoardCount(database) {
  const db = new DatabaseSync(database, { readOnly: true });
  try { return db.prepare('SELECT COUNT(*) AS count FROM relay_boards').get().count; }
  finally { db.close(); }
}

/** Click a visible production confirmation button through real Chrome mouse input. */
async function clickConfirmationButton(chrome, selector, label) {
  const point = await chrome.evaluate(`(() => { const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
  await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, `move to ${label}`);
  await chrome.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 }, `press ${label}`);
  await chrome.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 }, `release ${label}`);
}

/** Exercise a real terminal decision while a pre-decision status request remains in flight. */
async function keepTerminalConfirmation(t, decision) {
  const box = await relayClientFixture(t);
  const heldStatus = box.holdNextConfirmationStatus();
  const chrome = await startChrome();
  let running;
  try {
    running = box.startCli(['relay', 'on', '--url', box.origin], {
      SSH_CONNECTION: '192.0.2.10 12345 192.0.2.20 22',
    });
    const output = await running.waitForOutput(CONFIRMATION_PROMPT);
    const line = output.split('\n').find((value) => value.includes(CONFIRMATION_PROMPT));
    const confirmationURL = line?.slice(line.indexOf(CONFIRMATION_PROMPT) + CONFIRMATION_PROMPT.length).trim();
    assert.ok(confirmationURL, 'SSH relay on prints the person confirmation address');
    assert.equal(new URL(confirmationURL).origin, box.origin, 'confirmation stays on the configured relay origin');
    await box.waitForResponse('/auth/device/poll');

    await chrome.navigate(confirmationURL);
    await heldStatus.started;
    await chrome.waitFor('document.querySelector("#confirm")?.hidden === false && document.querySelector("#decline")?.hidden === false',
      undefined, 'the real page enables the decision after GitHub sign-in');
    assert.equal(await chrome.evaluate('location.hash === ""'), true, 'the page removes the one-use nonce from browser history');
    assert.equal(await chrome.evaluate('document.querySelector("#intent").textContent'),
      `Link ${basename(box.root)} from ${hostname()}?`, 'the real page displays the bound board and machine');
    assert.equal(linkedBoardCount(box.authDatabase), 0, 'opening the browser confirmation does not link a board');

    await clickConfirmationButton(chrome, decision === 'confirm' ? '#confirm' : '#decline', `${decision} button`);
    const terminalText = decision === 'confirm'
      ? 'The board is linked. You can return to the terminal.'
      : 'You declined this board link. Nothing was linked.';
    await chrome.waitFor(`document.querySelector("#status")?.textContent === ${JSON.stringify(terminalText)}`,
      undefined, 'the real page reports the completed terminal decision');
    const completed = await running.closed;
    assert.equal(completed.signal, null);
    if (decision === 'confirm') {
      assert.equal(completed.code, 0, 'the SSH CLI receives the confirmed session');
      assert.equal(JSON.parse(completed.stdout).linked, true);
      assert.equal(linkedBoardCount(box.authDatabase), 1, 'the browser click links the displayed board');
    } else {
      assert.notEqual(completed.code, 0, 'the SSH CLI receives the declined-flow refusal');
      assert.equal(linkedBoardCount(box.authDatabase), 0, 'declining leaves the board unlinked');
    }

    heldStatus.release();
    const lateStatus = await heldStatus.finished;
    const lateResponse = JSON.parse(lateStatus.response.toString('utf8'));
    assert.equal(lateResponse.error?.code, 'OAUTH_EXPIRED', 'the in-flight request reaches the real handler after CLI flow consumption');
    const statusRequestsAfterLateResponse = confirmationStatusRequestCount(box);
    await chrome.evaluate(`new Promise(resolve => setTimeout(resolve, ${CONFIRMATION_POLL_INTERVAL_MS * 2}))`,
      'wait through one full confirmation polling cadence after CLI flow consumption');
    assert.equal(await chrome.evaluate('document.querySelector("#status").textContent'), terminalText,
      'a late expired-flow status response and later polling cadence preserve the terminal message');
    assert.equal(await chrome.evaluate('document.querySelector("#confirm").hidden && document.querySelector("#decline").hidden'), true,
      'terminal decisions leave both buttons hidden');
    assert.equal(confirmationStatusRequestCount(box), statusRequestsAfterLateResponse,
      'the terminal page sends no more status requests after the next polling cadence');
    for (const path of ['/auth/device/confirmation/open', '/auth/device/confirmation/status', '/auth/device/confirmation']) {
      assert.ok(box.calls.some((call) => call.path === path), `the real browser called ${path}`);
    }
  } finally {
    heldStatus.release();
    if (running && running.child.exitCode === null && running.child.signalCode === null) {
      running.child.kill('SIGKILL');
      await running.closed;
    }
    await chrome.close();
  }
}

/** Confirm from the real page and keep it alive after the CLI consumes its flow. */
async function confirmTerminalIntent(t) {
  await keepTerminalConfirmation(t, 'confirm');
}

/** Decline from the real page and keep it alive after the CLI consumes its flow. */
async function declineTerminalIntent(t) {
  await keepTerminalConfirmation(t, 'decline');
}

test('real Chrome confirms the displayed SSH board intent [P6,H5]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, confirmTerminalIntent);

test('real Chrome keeps a declined SSH board intent terminal after CLI consumption [P6,H5]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, declineTerminalIntent);
