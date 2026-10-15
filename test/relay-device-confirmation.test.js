/** A real browser confirms the exact SSH relay board intent [P6,H5]. */
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { basename } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { relayClientFixture } from './relay-client-fixture.js';
import { findChromeExecutable, startChrome } from './relay-browser-fixture.js';

const CONFIRMATION_PROMPT = 'After sign-in, confirm the link in your browser: ';

/** Count linked boards through a read-only connection to the private relay database. */
function linkedBoardCount(database) {
  const db = new DatabaseSync(database, { readOnly: true });
  try { return db.prepare('SELECT COUNT(*) AS count FROM relay_boards').get().count; }
  finally { db.close(); }
}

/** Exercise the shipped page, cookie boundary and CLI session release in isolated Chrome. */
async function confirmDisplayedSshIntent(t) {
  const box = await relayClientFixture(t);
  const chrome = await startChrome();
  t.after(() => chrome.close());
  const running = box.startCli(['relay', 'on', '--url', box.origin], {
    SSH_CONNECTION: '192.0.2.10 12345 192.0.2.20 22',
  });
  const output = await running.waitForOutput(CONFIRMATION_PROMPT);
  const line = output.split('\n').find((value) => value.includes(CONFIRMATION_PROMPT));
  const confirmationURL = line?.slice(line.indexOf(CONFIRMATION_PROMPT) + CONFIRMATION_PROMPT.length).trim();
  assert.ok(confirmationURL, 'SSH relay on prints the person confirmation address');
  assert.equal(new URL(confirmationURL).origin, box.origin, 'confirmation stays on the configured relay origin');
  await box.waitForResponse('/auth/device/poll');

  await chrome.navigate(confirmationURL);
  await chrome.waitFor('document.querySelector("#confirm")?.hidden === false && document.querySelector("#decline")?.hidden === false',
    undefined, 'the real page enables the decision after GitHub sign-in');
  assert.equal(await chrome.evaluate('location.hash === ""'), true, 'the page removes the one-use nonce from browser history');
  assert.equal(await chrome.evaluate('document.querySelector("#intent").textContent'),
    `Link ${basename(box.root)} from ${hostname()}?`, 'the real page displays the bound board and machine');
  assert.equal(linkedBoardCount(box.authDatabase), 0, 'opening the browser confirmation does not link a board');

  await chrome.evaluate('document.querySelector("#confirm").click()');
  await chrome.waitFor('document.querySelector("#status")?.textContent.includes("The board is linked.")',
    undefined, 'the real confirmation page reports the completed approval');
  const completed = await running.closed;
  assert.equal(completed.signal, null);
  assert.equal(completed.code, 0, 'the SSH CLI receives the confirmed session');
  assert.equal(JSON.parse(completed.stdout).linked, true);
  assert.equal(linkedBoardCount(box.authDatabase), 1, 'the browser click links the displayed board');
  for (const path of ['/auth/device/confirmation/open', '/auth/device/confirmation/status', '/auth/device/confirmation']) {
    assert.ok(box.calls.some((call) => call.path === path), `the real browser called ${path}`);
  }
}

test('real Chrome confirms the displayed SSH board intent [P6,H5]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, confirmDisplayedSshIntent);
