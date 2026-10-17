/** The default Items view gives finished work a clear next step [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { accept, build, chromeExecutable, machine, openSnapshotChrome, press, project, startView } from './fixture.js';

test('a board whose work is all verified shows it or says it is under All [N26]', async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'the real-Chrome empty-state check requires Chrome');
  const box = machine();
  const alpha = project(box, 'all-verified');
  box.run(alpha.repo, 'add', 'web', 'Finished item', '--specs', 'G1', '--criterion', 'shows the page');
  build(box, alpha, 1, 'finished.html');
  accept(box, alpha, 1);

  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-items-empty-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("document.querySelector('#chain .empty') || document.querySelector('#chain .row[data-item=\"1\"]')");
    const initial = JSON.parse(await chrome.stable(`JSON.stringify({
      state: view.state,
      visibleRows: [...document.querySelectorAll('#chain .row')].filter((row) => {
        const bounds = row.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 && getComputedStyle(row).visibility === 'visible';
      }).map((row) => row.dataset.item),
      empty: document.querySelector('#chain .empty')?.textContent.trim() ?? '',
      action: document.querySelector('#chain [data-filter-choice="state:all"]')?.textContent.trim() ?? '',
    })`));
    if (initial.visibleRows.includes('1')) return;

    assert.equal(initial.state, 'active', 'the explanatory state applies to the default Active filter');
    assert.doesNotMatch(initial.empty, /\n/, 'the finished-work explanation stays on one line');
    assert.match(initial.empty, /finished work is under All/i, 'the empty state explains where the accepted item went');
    assert.ok(initial.action, 'the message provides a one-click way to show the finished item');
    await press(chrome, "document.querySelector('#chain [data-filter-choice=\"state:all\"]')");
    await chrome.waitFor("view.state === 'all' && (() => { const row = document.querySelector('#chain .row[data-item=\"1\"]'); const bounds = row?.getBoundingClientRect(); return bounds?.width > 0 && bounds?.height > 0 && getComputedStyle(row).visibility === 'visible'; })()");
    assert.equal(await chrome.stable("document.querySelector('#chain .row[data-item=\"1\"]').getAttribute('title')"), 'Finished item',
      'the message action opens All and reveals the accepted work');
    assert.deepEqual(chrome.exceptions, [], 'the empty-state action produces no browser exceptions');
  } finally {
    if (chrome) await chrome.close();
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
