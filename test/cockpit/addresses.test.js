/** Real-input addresses, rendered places and browser history [N38,N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stableChrome } from './stable.js';
import { relayClientFixture } from '../relay-client-fixture.js';
import { startChrome, relayWorkBudgetMs } from '../relay-browser-fixture.js';
import { SPEC, machine, project, startView, boardOf, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, press, travel, settled } from './fixture.js';

const SCRIPT = "typeof view === 'object' && typeof data === 'object' && !!data?.project && data.root === view.root && !document.body.classList.contains('loading')";
/** Read the actual rendered place without waiting for the expected answer. */
async function observed(chrome) {
  return JSON.parse(await chrome.stable(`JSON.stringify({ address:location.pathname + location.hash, root:view.root, tab:document.querySelector('.tab.on')?.dataset.tab, panes:[...document.querySelectorAll('[data-pane]')].filter(node => !node.hidden).map(node => node.dataset.pane) })`));
}
/** Check the address, repo and visible pane independently of internal selection state. */
async function assertPlace(chrome, address, pane, root) {
  assert.deepEqual(await observed(chrome), { address, root, tab: pane, panes: [pane] });
}
/** Navigate from a blank page and wait for the new document's script before reading its board. */
async function openAddress(chrome, server, address) {
  await chrome.send('Page.navigate', { url: 'about:blank' });
  await settled(chrome, "location.href === 'about:blank'");
  const target = new URL(address, server.link);
  target.search = server.link.search;
  await chrome.send('Page.navigate', { url: target.href });
  await settled(chrome, SCRIPT);
}
/** Assert the detail itself, so suppressing row rendering produces an assertion failure. */
async function assertHeading(chrome, selector, id, text) {
  const heading = await chrome.stable(`document.querySelector(${JSON.stringify(selector + ' h2')})?.textContent ?? null`);
  assert.ok(heading?.includes(id) && heading.includes(text), `detail heading names ${id} ${text}: ${heading}`);
}
/** Read the real browser stack, including same-document pushState entries. */
async function history(chrome) {
  const { currentIndex, entries } = await chrome.send('Page.getNavigationHistory');
  return { currentIndex, length: entries.length };
}
/** Click once, await the normal rendering boundary, then assert exactly one new place entry. */
async function onePlace(chrome, selector, address, pane, root) {
  const before = await history(chrome);
  await press(chrome, selector);
  await settled(chrome, SCRIPT);
  await assertPlace(chrome, address, pane, root);
  const after = await history(chrome);
  assert.deepEqual(after, { currentIndex: before.currentIndex + 1, length: before.length + 1 }, `${address}: one entry per change`);
  return { address, pane, root };
}
/** Create distinct real rows without duplicate identifiers, and two real items. */
function addressBoard(box, name, group) {
  const spec = SPEC.replace(/^- G2 .*$/m, `- G2 [pending, must] ${name} distinct specification row. | gate: review`);
  const p = project(box, name, spec, { practice: 'DOCTRINE.md', ...(group ? { project: group } : {}) });
  writeFileSync(join(p.repo, 'DOCTRINE.md'), `# Local rules\n\n## Team\n- PB1 [approved, must] ${name} distinct practice rule. | gate: review\n`);
  box.run(p.repo, 'add', 'web', `${name} first address item`, '--specs', 'G1');
  box.run(p.repo, 'add', 'web', `${name} second address item`, '--specs', 'G1');
  box.run(p.repo, 'milestone', 'add', `${name} address milestone`, '--items', '1,2');
  return p;
}
/** Own one browser and server, with cleanup even if an assertion fails. */
async function withBrowser(box, run) {
  const executable = chromeExecutable();
  assert.ok(executable, 'real Chrome is required for address checks');
  const server = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-addresses-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, server.link.href, profile);
    await settled(chrome, SCRIPT);
    await run(chrome, server);
    assert.deepEqual(chrome.exceptions, [], 'new-document navigation causes no page exceptions');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await server.stop();
    rmSync(profile, { recursive: true, force: true });
  }
}
/** Wait only for the addressed lookup to finish, then inspect the real target and its viewport box. */
async function assertShout(chrome, id, text) {
  await settled(chrome, `${SCRIPT} && !document.querySelector('#shout-address-status')?.textContent.startsWith('Loading')`);
  const result = JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const node=document.getElementById('shout-${id}'), rect=node?.getBoundingClientRect();
    return { text:node?.querySelector('.text')?.textContent ?? null, heading:node?.querySelector('h2')?.textContent ?? null, marked:node?.classList.contains('found') ?? false, top:rect?.top, bottom:rect?.bottom, bar:document.querySelector('.top').getBoundingClientRect().bottom, height:innerHeight };
  })())`));
  assert.equal(result.text, text, 'the addressed shout body is rendered');
  assert.equal(result.heading, `Shout #${id}`, 'the addressed shout has its own heading');
  assert.equal(result.marked, true, 'the addressed shout stays marked');
  assert.ok(result.top >= result.bar && result.bottom <= result.height, `the shout is visible below the tab bar: ${JSON.stringify(result)}`);
}

test('every place in the view has its own address [N38,N26]', { timeout: 180_000 }, async () => { // budget: hang-only ceiling for the complete direct-address matrix.
  const box = machine(), alpha = addressBoard(box, 'alpha');
  box.run(alpha.repo, 'shout', 'person', 'Address target shout.');
  await withBrowser(box, async (chrome, server) => {
    const shout = (await boardOf(server, alpha.repo)).shouts.find(one => one.shout_text === 'Address target shout.');
    assert.ok(shout?.shout_id);
    const direct = [
      ['/items/1', 'items', '#detail', '#1', 'alpha first address item'],
      ['/items/pipeline', 'items'], ['/shouts', 'shouts'], [`/shouts/${shout.shout_id}`, 'shouts'],
      ['/spec', 'spec'], ['/spec/G2', 'spec', '#spec-detail', 'G2', 'alpha distinct specification row'],
      ['/doctrine', 'doctrine'], ['/doctrine/PB1', 'doctrine', '#doctrine-detail', 'PB1', 'alpha distinct practice rule'],
      ['/activity', 'activity'], ['/roadmap', 'roadmap'],
    ];
    for (const [address, pane, selector, id, text] of direct) {
      await openAddress(chrome, server, address);
      await assertPlace(chrome, address, pane, alpha.repo);
      if (selector) await assertHeading(chrome, selector, id, text);
      if (address === '/items/pipeline') assert.equal(await chrome.stable("document.querySelector('#pipeline').hidden"), false);
      if (address.startsWith('/shouts/')) await assertShout(chrome, shout.shout_id, 'Address target shout.');
      assert.equal((await history(chrome)).length > 0, true);
    }
    for (const [address, pane, selector, id] of [
      ['/items/9999', 'items', '#detail', '9999'], ['/spec/NO_SUCH_ROW', 'spec', '#spec-detail', 'NO_SUCH_ROW'],
      ['/doctrine/NO_SUCH_ROW', 'doctrine', '#doctrine-detail', 'NO_SUCH_ROW'], ['/shouts/999999', 'shouts', '#feed', '999999'],
    ]) {
      await openAddress(chrome, server, address);
      await assertPlace(chrome, address, pane, alpha.repo);
      if (pane === 'shouts') await settled(chrome, "!document.querySelector('#shout-address-status')?.textContent.startsWith('Loading')");
      const text = await chrome.stable(`document.querySelector(${JSON.stringify(selector)}).innerText`);
      assert.match(text, /No (?:item|shout|Spec row|Doctrine row).*exists here/i, 'missing targets say so');
      assert.ok(text.includes(id), 'missing-target message identifies the target');
      assert.equal(await chrome.stable(`!!document.querySelector(${JSON.stringify(selector + ' h2')})`), false, 'no unrelated default detail');
    }
    await openAddress(chrome, server, '/#items/pipeline');
    await assertPlace(chrome, '/items/pipeline', 'items', alpha.repo);
    assert.equal(await chrome.stable("document.querySelector('#pipeline').hidden"), false, 'the legacy Pipeline fragment still opens Pipeline');
    await openAddress(chrome, server, '/#roadmap');
    await assertPlace(chrome, '/roadmap', 'roadmap', alpha.repo);
    assert.equal((await fetch(new URL('/items/1', server.link))).status, 403, 'direct places retain the secret boundary');
  });
});

test('back, forward and reload keep the place [N38,N26]', { timeout: 180_000 }, async () => { // budget: hang-only ceiling for real clicks, stack traversal and fresh-document reloads.
  const box = machine(), alpha = addressBoard(box, 'history-alpha');
  box.run(alpha.repo, 'shout', 'person', 'History journey shout.');
  await withBrowser(box, async (chrome, server) => {
    const shout = (await boardOf(server, alpha.repo)).shouts.find(one => one.shout_text === 'History journey shout.');
    await openAddress(chrome, server, '/items');
    const journey = [{ address: '/items', pane: 'items', root: alpha.repo }];
    const steps = [
      ['#chain .row[data-item="1"]', '/items/1', 'items'], ['[data-items-view="pipeline"]', '/items/pipeline', 'items'],
      ['[data-tab="shouts"]', '/shouts', 'shouts'], [`#feed #shout-${shout.shout_id} .text`, `/shouts/${shout.shout_id}`, 'shouts'],
      ['[data-tab="spec"]', '/spec', 'spec'], ['[data-row="spec:G2"]', '/spec/G2', 'spec'],
      ['[data-tab="doctrine"]', '/doctrine', 'doctrine'], ['[data-row="doctrine:PB1"]', '/doctrine/PB1', 'doctrine'],
      ['[data-tab="activity"]', '/activity', 'activity'], ['[data-tab="roadmap"]', '/roadmap', 'roadmap'],
      ['[data-tab="items"]', '/items/pipeline', 'items'], ['[data-items-view="list"]', '/items', 'items'],
      ['#chain .row[data-item="2"]', '/items/2', 'items'],
    ];
    for (const [selector, address, pane] of steps) journey.push(await onePlace(chrome, `document.querySelector(${JSON.stringify(selector)})`, address, pane, alpha.repo));
    const unchanged = await history(chrome);
    await press(chrome, 'document.querySelector(\'#chain .row[data-item="2"]\')');
    await settled(chrome, SCRIPT);
    assert.deepEqual(await history(chrome), unchanged, 'selecting the same item never pushes a duplicate');
    await onePlace(chrome, 'document.querySelector(\'[data-tab="shouts"]\')', '/shouts', 'shouts', alpha.repo);
    const sameTab = await history(chrome);
    for (let repeat = 0; repeat < 2; repeat += 1) {
      await press(chrome, 'document.querySelector(\'[data-tab="shouts"]\')');
      await settled(chrome, SCRIPT);
      assert.deepEqual(await history(chrome), sameTab, 'selecting the current tab never pushes a duplicate');
    }
    await travel(chrome, -1);
    await settled(chrome, SCRIPT);
    for (const direction of [-1, 1]) {
      const indices = direction < 0 ? Array.from({ length: journey.length - 1 }, (_, index) => journey.length - 2 - index) : Array.from({ length: journey.length - 1 }, (_, index) => index + 1);
      for (const index of indices) {
        await travel(chrome, direction);
        await settled(chrome, SCRIPT);
        const step = journey[index];
        await assertPlace(chrome, step.address, step.pane, step.root);
        if (step.address === '/spec/G2') await assertHeading(chrome, '#spec-detail', 'G2', 'history-alpha distinct specification row');
        if (step.address === '/doctrine/PB1') await assertHeading(chrome, '#doctrine-detail', 'PB1', 'history-alpha distinct practice rule');
        if (/\/items\/\d+$/.test(step.address)) await assertHeading(chrome, '#detail', `#${step.address.split('/').at(-1)}`, 'address item');
        if (step.address.startsWith('/shouts/')) await assertShout(chrome, shout.shout_id, 'History journey shout.');
      }
    }
    for (const step of journey.slice(0, -2)) {
      await openAddress(chrome, server, step.address);
      const before = await chrome.stable('performance.timeOrigin');
      await chrome.send('Page.reload');
      await settled(chrome, `performance.timeOrigin !== ${before} && ${SCRIPT}`);
      await assertPlace(chrome, step.address, step.pane, alpha.repo);
      if (step.address === '/spec/G2') await assertHeading(chrome, '#spec-detail', 'G2', 'history-alpha distinct specification row');
      if (step.address === '/doctrine/PB1') await assertHeading(chrome, '#doctrine-detail', 'PB1', 'history-alpha distinct practice rule');
      if (step.address === '/items/1') await assertHeading(chrome, '#detail', '#1', 'history-alpha first address item');
      if (step.address.startsWith('/shouts/')) await assertShout(chrome, shout.shout_id, 'History journey shout.');
    }
  });
});

test('a shout address opens an old shout [N38,N26]', { timeout: 180_000 }, async () => { // budget: hang-only ceiling for real writes and both viewport journeys.
  const box = machine(), alpha = addressBoard(box, 'old-shout-alpha');
  box.run(alpha.repo, 'shout', 'person', 'OLD ADDRESSED SHOUT, unique body.');
  await withBrowser(box, async (chrome, server) => {
    const target = (await boardOf(server, alpha.repo)).shouts.find(one => one.shout_text === 'OLD ADDRESSED SHOUT, unique body.');
    assert.ok(target?.shout_id);
    for (let index = 0; index < 46; index += 1) box.run(alpha.repo, 'shout', 'person', `Later shout ${index + 1}.`);
    const state = await boardOf(server, alpha.repo);
    assert.equal(state.shouts.length, 40);
    assert.equal(state.shouts.some(one => one.shout_id === target.shout_id), false, 'the target is outside the actual public state window');
    for (const width of [1280, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await openAddress(chrome, server, `/shouts/${target.shout_id}`);
      await assertPlace(chrome, `/shouts/${target.shout_id}`, 'shouts', alpha.repo);
      await assertShout(chrome, target.shout_id, 'OLD ADDRESSED SHOUT, unique body.');
    }
  });
});

test('grouped repos each get their own address [N38,N26]', { timeout: 180_000 }, async () => { // budget: hang-only ceiling for grouped repo switching and a separate one-repo machine.
  const box = machine(), alpha = addressBoard(box, 'alpha', 'same-suite'), beta = addressBoard(box, 'beta', 'same-suite');
  await withBrowser(box, async (chrome, server) => {
    for (const [repo, name] of [[alpha, 'alpha'], [beta, 'beta']]) {
      for (const [suffix, pane, selector, id, text] of [
        ['/items/1', 'items', '#detail', '#1', `${name} first address item`],
        ['/spec/G2', 'spec', '#spec-detail', 'G2', `${name} distinct specification row`],
        ['/doctrine/PB1', 'doctrine', '#doctrine-detail', 'PB1', `${name} distinct practice rule`],
      ]) {
        await openAddress(chrome, server, `/${name}${suffix}`);
        await assertPlace(chrome, `/${name}${suffix}`, pane, repo.repo);
        await assertHeading(chrome, selector, id, text);
      }
      await onePlace(chrome, 'document.querySelector(\'[data-tab="shouts"]\')', `/${name}/shouts`, 'shouts', repo.repo);
    }
    await openAddress(chrome, server, '/alpha/items/1');
    if (await chrome.stable("getComputedStyle(document.querySelector('#side .side-body')).display === 'none'")) await press(chrome, "document.querySelector('#proj-switch')");
    await onePlace(chrome, 'document.querySelector(\'[data-root="' + beta.repo + '"]\')', '/beta/items', 'items', beta.repo);
    await travel(chrome, -1);
    await settled(chrome, `${SCRIPT} && view.root === ${JSON.stringify(alpha.repo)}`);
    await assertPlace(chrome, '/alpha/items/1', 'items', alpha.repo);
    await assertHeading(chrome, '#detail', '#1', 'alpha first address item');
  });
  const singleBox = machine(), single = addressBoard(singleBox, 'single');
  await withBrowser(singleBox, async (chrome, server) => {
    await openAddress(chrome, server, '/items/1');
    await assertPlace(chrome, '/items/1', 'items', single.repo);
    await assertHeading(chrome, '#detail', '#1', 'single first address item');
    await onePlace(chrome, 'document.querySelector(\'[data-tab="spec"]\')', '/spec', 'spec', single.repo);
    await onePlace(chrome, 'document.querySelector(\'[data-row="spec:G2"]\')', '/spec/G2', 'spec', single.repo);
    await assertHeading(chrome, '#spec-detail', 'G2', 'single distinct specification row');
  });
});


test('an older relay shout keeps its address and explains retained history [N38,H5]', {
  // budget: three fixture work ceilings bound setup, browser pairing and the addressed read; no speed assertion.
  timeout: relayWorkBudgetMs() * 3,
}, async t => {
  const box = await relayClientFixture(t);
  const text = 'OLD RELAY ADDRESS TARGET 187';
  for (let index = 0; index < 46; index += 1) {
    const reply = await box.cli('shout', 'person', index === 0 ? text : `Later relay address shout ${index}`);
    assert.equal(reply.code, 0, 'real CLI appends each fixture shout');
  }
  const exported = await box.cli('export');
  assert.equal(exported.code, 0);
  const target = exported.document.tables.shout.find(one => one.shout_text === text);
  assert.ok(target?.shout_id);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const encoded = readFileSync(box.keyFile, 'utf8').trim();
  const chrome = await stableChrome(await startChrome());
  t.after(() => chrome.close());
  assert.equal((await chrome.send('Network.setCookie', {
    name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  })).success, true, 'the actual paired person session authenticates this browser');
  await chrome.send('Page.navigate', { url: box.origin + '/#board=' + link.board + '&key=' + encoded });
  await settled(chrome, SCRIPT);
  assert.equal(await chrome.stable('location.hash.includes("key=")'), false, 'pairing removes its secret before ordinary address navigation');
  assert.equal(await chrome.stable(`data.project.shouts.some(one => one.shout_id === ${target.shout_id})`), false, 'the old shout is absent from the actual relay state projection');
  const address = '/#shouts/' + target.shout_id;
  await chrome.send('Page.navigate', { url: box.origin + address });
  await settled(chrome, SCRIPT);
  for (let visit = 0; visit < 2; visit += 1) {
    await settled(chrome, `${SCRIPT} && !document.querySelector('#shout-address-status')?.textContent.startsWith('Loading')`);
    await assertPlace(chrome, address, 'shouts', link.board);
    const body = await chrome.stable(`document.querySelector('#feed #shout-${target.shout_id} .text')?.textContent ?? null`);
    if (body === text) await assertShout(chrome, target.shout_id, text);
    else assert.match(await chrome.stable("document.querySelector('#shout-address-status')?.textContent ?? ''"), /older than the relay holds/i,
      'an unsupported old read explains the relay retention limit in the Shouts pane');
    if (visit === 0) {
      const before = await chrome.stable('performance.timeOrigin');
      await chrome.send('Page.reload');
      await settled(chrome, `performance.timeOrigin !== ${before} && ${SCRIPT}`);
    }
  }
});
