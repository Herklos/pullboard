/** Cockpit roadmap checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { tapTarget, SPEC, machine, project, build, sendBack, fetchLive, startView, target, accept, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, press, travel, pressedInto, settled, roadmapRow, showing, readRoadmap, openRoadmapParts, tabBar, proofShot, pickProject, chooseFilter } from './fixture.js';


/** Expand a real roadmap row, then use its explicit link to leave for Items. */
async function openRoadmapItem(chrome, id) {
  const row = roadmapRow(id);
  if (await chrome.stable(row + ".getAttribute('aria-expanded')") !== 'true') await press(chrome, row);
  await chrome.waitFor(row + ".getAttribute('aria-expanded') === 'true'");
  await press(chrome, row + ".parentElement.querySelector('.milestone-why a[data-go]')");
}

test('Roadmap references stay inline and rows expand before opening Items [N26,N38]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for prose-reference checks.');
  const box = machine();
  const demo = project(box, 'a-inline-prose', `${SPEC}- G3 [approved, must] Follow #1 first. | gate: review\n`, { practice: 'ways.md' });
  writeFileSync(join(demo.repo, 'ways.md'), '# Local rules\n\n## Team\n- R1 [approved, must] Review #1 first. | gate: review\n');
  box.run(demo.repo, 'add', 'web', 'Local target', '--specs', 'G1', '--criterion', 'target');
  box.run(demo.repo, 'add', 'web', 'Local title links to #1', '--specs', 'G1', '--criterion', 'title');
  build(box, demo, 2, 'title.txt');
  sendBack(box, demo, 2, 'Review #1 before accepting.');
  const other = project(box, 'beacon-prose');
  box.run(other.repo, 'add', 'web', 'Remote target', '--specs', 'G1', '--criterion', 'target');
  box.run(other.repo, 'add', 'web', 'Remote title links to #1', '--specs', 'G1', '--criterion', 'title');
  box.run(demo.repo, 'milestone', 'add', 'Choose #1', '--note', 'Review #1 next.', '--items', '2,beacon-prose#2');
  box.run(demo.repo, 'shout', 'person', 'Choose #1 before shipping.', '--decision');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-prose-references-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("document.querySelector('#chain .row[data-item=\"2\"]')");
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const contexts = [
        ['roadmap', '#roadmap .milestone h2 .ref', 'Local target'],
        ['roadmap', '#roadmap .milestone-note .ref', 'Local target'],
        ['roadmap', '#roadmap .milestone-item[data-roadmap-key="i:#2"]:not([data-board]) .t .ref', 'Local target', true],
        ['roadmap', '#roadmap .milestone-item[data-board] .t .ref', 'Remote target', true],
        ['spec', '#spec-list [data-row="spec:G3"] .ref', 'Local target'],
        ['doctrine', '#doctrine-list [data-row="doctrine:R1"] .ref', 'Local target'],
      ];
      for (const [tab, selector, target, expands] of contexts) {
        await pickProject(chrome, `document.querySelector('[data-root=${JSON.stringify(demo.repo)}]')`);
        await chrome.waitFor("data?.project?.root === view.root && !document.body.classList.contains('switching') && document.querySelector('#proj-name').textContent === 'a-inline-prose'");
        await chrome.click(`document.querySelector('[data-tab="${tab}"]')`);
        if (tab !== 'roadmap') await chrome.click(`document.querySelector('[data-rows="${tab}:all"]')`);
        const metrics = JSON.parse(await chrome.stable(`JSON.stringify((() => {
          const ref = document.querySelector(${JSON.stringify(selector)});
          const row = ref?.closest('.milestone-item');
          const style = ref && getComputedStyle(ref);
          return { present:!!ref, title:ref?.title, border:style?.borderWidth, height:ref?.getBoundingClientRect().height,
            line:style && parseFloat(style.lineHeight), nested:!!ref?.parentElement.closest('button'),
            rowHeight:row?.getBoundingClientRect().height };
        })())`));
        assert.ok(metrics.present, `${width}: ${selector} contains its inline reference`);
        assert.equal(metrics.title, target, `${width}: the reference tooltip names the target on its own board`);
        assert.equal(metrics.border, '0px', `${width}: ${selector} has no box`);
        assert.ok(Math.abs(metrics.height - metrics.line) < 1, `${width}: ${selector} keeps the text line height`);
        assert.equal(metrics.nested, false, `${width}: ${selector} never nests buttons`);
        if (metrics.rowHeight !== undefined) assert.ok(metrics.rowHeight >= tapTarget(width), `${width}: the containing Roadmap control keeps its target`);
        if (expands) {
          const ref = `document.querySelector(${JSON.stringify(selector)})`;
          const row = ref + ".closest('.milestone-item')";
          if (await chrome.stable(row + ".getAttribute('aria-expanded')") === 'true') await chrome.click(ref);
          const address = await chrome.stable('location.href');
          await chrome.click(ref);
          await chrome.waitFor(row + ".getAttribute('aria-expanded') === 'true'");
          assert.equal(await chrome.stable('location.href'), address, 'inline title text expands without leaving Roadmap');
          assert.equal(await chrome.stable('view.tab'), 'roadmap');
          await chrome.click(row + ".parentElement.querySelector('.milestone-why a[data-go]')");
          await chrome.waitFor("document.querySelector('[data-tab=items].on') && document.querySelector('#detail h2 > span')?.textContent === '#2'");
          assert.equal(await chrome.stable('view.root'), target === 'Remote target' ? other.repo : demo.repo);
          continue;
        }
        await chrome.click(`document.querySelector(${JSON.stringify(selector)})`);
        await chrome.waitFor("!document.body.classList.contains('switching') && document.querySelector('[data-tab=items].on') && document.querySelector('#detail h2 > span')?.textContent === '#1'");
        assert.ok((await chrome.stable("document.querySelector('#detail h2').textContent")).includes(target), 'the reference opens its target title');
        assert.equal(await chrome.stable('view.root'), target === 'Remote target' ? other.repo : demo.repo, 'duplicate item numbers stay bound to their own board');
      }
      await chrome.click(`document.querySelector('[data-tab="items"]')`); await chrome.click(`document.querySelector('#chain .row[data-item="2"]')`);
      await chrome.waitFor("document.querySelector('#detail .verdict .note')");
      assert.equal(await chrome.stable("document.querySelectorAll('#detail .verdict .note .ref').length"), 1, 'verdict prose keeps its item reference');
      await chrome.click("document.querySelector('#detail .verdict .note .ref')");
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Local target')");
      await chooseFilter(chrome, 'state:active');
      await chrome.click("document.querySelector('#needs .row[data-go^=\"decide:\"]')");
      assert.equal(await chrome.stable("document.querySelectorAll('#answering-q .ref').length"), 1, 'the answering question keeps its inline item reference');
      await chrome.click("document.querySelector('#answering-q .ref')");
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Local target') && document.querySelector('[data-tab=items].on')");
      await chrome.click("document.querySelector('[data-tab=roadmap]')");
      const keyboardRow = "document.querySelector('#roadmap .milestone-item[role=button]:not([data-board])')";
      if (await chrome.stable(keyboardRow + ".getAttribute('aria-expanded')") === 'true') await chrome.click(keyboardRow);
      await chrome.stable(keyboardRow + ".dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true}))");
      await chrome.waitFor(keyboardRow + ".getAttribute('aria-expanded') === 'true' && view.tab === 'roadmap'");
      await openRoadmapItem(chrome, '#2');
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Local title links to #1') && document.querySelector('[data-tab=items].on')");
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('the roadmap reads every item as the Items tab does, opens each one, another repo\'s too, and keeps its own address [N26,N38]', { timeout: 150_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for roadmap browser checks.');
  const box = machine();
  const alpha = project(box, 'roadmap-demo');
  const beacon = project(box, 'beacon');
  const long = 'A deliberately long title that runs past the width of a phone and keeps going, far enough to be cut on a wide desktop card as well';
  const titles = ['Merged greeting page', 'Verified farewell page', 'Session timeout banner', 'Upload progress bar', 'Live search results', long, 'Withdrawn experiment'];
  for (const title of titles) box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  // One item in each state: verified and merged, verified, sent back, to verify, building, open, withdrawn.
  build(box, alpha, 1, 'one.txt');
  accept(box, alpha, 1);
  const itemCommit = box.git(alpha.repo, 'rev-parse', alpha.branch);
  box.git(alpha.repo, 'merge', '--no-ff', '--no-edit', alpha.branch);
  const trunkCommit = box.git(alpha.repo, 'rev-parse', 'HEAD');
  assert.notEqual(trunkCommit, itemCommit, 'the Roadmap receipt names the trunk merge commit');
  box.run(alpha.repo, 'merged', '1', trunkCommit);
  build(box, alpha, 2, 'two.txt');
  accept(box, alpha, 2);
  build(box, alpha, 3, 'three.txt');
  sendBack(box, alpha, 3, 'the banner does not time out yet');
  build(box, alpha, 4, 'four.txt');
  box.run(alpha.web, 'claim', '5');
  box.run(alpha.repo, 'withdraw', '7', 'no longer needed');
  // Another repo's item, sent back on its own board.
  box.run(beacon.repo, 'add', 'web', 'Billing webhook retries', '--specs', 'G1', '--criterion', 'retries');
  build(box, beacon, 1, 'retry.txt');
  sendBack(box, beacon, 1, 'retry twice before failing');
  box.run(alpha.repo, 'milestone', 'add', 'Launch', '--note', 'Ships when the review lands; your call on the name.', '--items', '1,2,3,4,beacon#1');
  box.run(alpha.repo, 'milestone', 'add', 'Next', '--note', 'Queued behind Launch.', '--items', '5,6,7');
  box.run(alpha.repo, 'milestone', 'add', 'Later', '--note', 'Ideas not filed yet.');
  // What the person reads on each row: the Items tab's word for the item's state, and its colour's class.
  const words = [
    { id: '#3', label: 'sent back', tone: 'no' },
    { id: '#4', label: 'to verify', tone: 'warn' },
    { id: 'beacon#1', label: 'sent back', tone: 'no' },
    { id: '#1', label: 'verified', tone: 'ok' },
    { id: '#2', label: 'verified', tone: 'ok' },
    { id: '#5', label: 'building', tone: 'busy' },
    { id: '#6', label: 'unclaimed', tone: 'free' },
  ];
  const view = await startView(box);
  const roadmapPath = '/roadmap-demo/roadmap';
  const roadmap = `${roadmapPath}${view.link.search}`;
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-chrome-'));
  let chrome;
  try {
    const direct = await fetchLive(new URL(roadmap, view.link));
    assert.equal(direct.status, 200, 'the view serves its page at /roadmap, behind its secret');
    assert.equal((await fetchLive(new URL('/roadmap', view.link))).status, 403, 'and nothing there without the secret');
    chrome = await openSnapshotChrome(executable, new URL(roadmap, view.link).href, profile);
    const consoleErrors = [];
    chrome.socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') consoleErrors.push(message.params.entry.text);
    });
    await chrome.send('Log.enable');
    await settled(chrome, `!!data?.project && ${showing('roadmap', roadmapPath)} && document.querySelectorAll('#roadmap .milestone').length === 3`);
    // This story reads every release; open the later cards through their actual controls.
    await openRoadmapParts(chrome);

    let seen;
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width} && ${showing('roadmap', roadmapPath)}`);
      seen = await readRoadmap(chrome);
      assert.deepEqual([seen.address, seen.shown, seen.tab], [roadmap, ['roadmap'], 'roadmap'], `${width}: the direct address shows the Roadmap tab, and only it`);
      assert.ok(seen.document <= seen.client && seen.body <= seen.client, `${width}: no sideways scroll: ${JSON.stringify(seen)}`);
      assert.deepEqual(seen.cards.map((card) => card.name), ['Launch', 'Next', 'Later'], `${width}: a card for each milestone, in order`);
      assert.deepEqual(seen.cards.map((card) => card.note), ['Ships when the review lands; your call on the name.', 'Queued behind Launch.', 'Ideas not filed yet.'], `${width}: each card's note`);
      assert.deepEqual(seen.cards.map((card) => [card.count, card.progress, card.filled]), [['2/5 done', [2, 5], 0.4], ['0/2 done', [0, 2], 0], [null, null, null]], `${width}: counts and bars say how many visible items are verified`);
      assert.deepEqual([seen.cards[2].empty, seen.cards[2].rows.length], ['No items yet.', 0], `${width}: an empty milestone says so, with no bar or count`);
      const rows = seen.cards.flatMap((card) => card.rows);
      assert.deepEqual(rows.map(({ id, label, tone }) => ({ id, label, tone })), words, `${width}: each chip shows the word and colour the Items tab gives its item's state`);
      assert.ok(rows.every((row) => row.seen), `${width}: every chip is on screen`);
      assert.deepEqual(rows.map((row) => row.title), [titles[2], titles[3], 'Billing webhook retries', titles[0], titles[1], titles[4], titles[5]], `${width}: unfinished work precedes verified items in each milestone`);
      assert.deepEqual(rows.map((row) => row.tip), rows.map((row) => row.title), `${width}: each row's tooltip is its whole title`);
      assert.ok(rows.every((row) => row.lines === 1 && row.ellipsis), `${width}: every title holds one line, set to end in an ellipsis: ${JSON.stringify(rows)}`);
      assert.ok(rows.find((row) => row.id === '#6').cut, `${width}: the long title is cut, so its ellipsis shows`);
      assert.ok(rows.every((row) => row.button), `${width}: every item opens, another repo's included`);

      const bar = await tabBar(chrome);
      for (const layout of bar.layouts) {
        const place = `${width} with ${layout.on} picked`;
        assert.equal(layout.tabs.length, 6, `${place}: six tabs`);
        for (const tab of layout.tabs) assert.ok(tab.labelLeft >= tab.left + 2 && tab.labelRight <= tab.right - 2, `${place}: ${tab.tab}'s label sits inside its highlight: ${JSON.stringify(tab)}`);
        layout.tabs.forEach((tab, n) => { if (n) assert.ok(tab.left >= layout.tabs[n - 1].right - 0.5, `${place}: ${tab.tab} starts after the tab before it ends`); });
        assert.ok(layout.tabs[0].left >= layout.bar[0] - 0.5 && layout.tabs.at(-1).right <= layout.bar[1] + 0.5 && layout.bar[1] <= bar.client, `${place}: the tab bar fits on screen: ${JSON.stringify(layout)}`);
      }
      await proofShot(chrome, 'roadmap', width);

      // An item opens on the Items tab; Back shows the Roadmap at its address again, Forward the item.
      await openRoadmapItem(chrome, '#3');
      await pressedInto(chrome, `${showing('items', '/roadmap-demo/items/3')} && document.querySelector('#detail h2')?.innerText.includes('Session timeout banner')`);
      assert.equal(await chrome.stable('location.search'), view.link.search, `${width}: the address keeps the rest of itself`);
      await travel(chrome, -1);
      await settled(chrome, `${showing('roadmap', roadmapPath)} && document.querySelector('.tab.on')?.dataset.tab === 'roadmap'`);
      await travel(chrome, 1);
      await settled(chrome, `${showing('items', '/roadmap-demo/items/3')} && document.querySelector('.tab.on')?.dataset.tab === 'items' && document.querySelector('#detail h2')?.innerText.includes('Session timeout banner')`);
      await press(chrome, `document.querySelector('[data-tab="roadmap"]')`);
      await pressedInto(chrome, `${showing('roadmap', roadmapPath)} && location.search === ${JSON.stringify(view.link.search)}`);
    }

    // Another repo's item opens on its own board, and Back and Forward move between the two boards.
    await openRoadmapItem(chrome, 'beacon#1');
    await chrome.waitFor(`document.querySelector('#proj-name').textContent === 'beacon' && ${showing('items', '/beacon/items/1')} && document.querySelector('#detail h2')?.innerText.includes('Billing webhook retries')`);
    const there = JSON.parse(await chrome.stable(`JSON.stringify((() => { const chip = document.querySelector('#detail .meta .chip'); return {
      id: document.querySelector('#detail h2 span').innerText, label: chip.innerText, chip: getComputedStyle(chip).color + ' on ' + getComputedStyle(chip).backgroundColor,
      dot: getComputedStyle(document.querySelector('#chain [data-item="1"] .dot')).backgroundColor }; })())`));
    const crossed = seen.cards[0].rows.find((row) => row.id === 'beacon#1');
    assert.deepEqual(there, { id: '#1', label: crossed.label, chip: crossed.chip, dot: crossed.dot }, "the other repo's Items tab shows that item with the Roadmap's word and colours");
    await travel(chrome, -1);
    await settled(chrome, `document.querySelector('#proj-name').textContent === 'roadmap-demo' && ${showing('roadmap', roadmapPath)} && !!${roadmapRow('beacon#1')}`);
    await travel(chrome, 1);
    await settled(chrome, `document.querySelector('#proj-name').textContent === 'beacon' && ${showing('items', '/beacon/items/1')} && document.querySelector('#detail h2')?.innerText.includes('Billing webhook retries')`);
    await travel(chrome, -1);
    await settled(chrome, `document.querySelector('#proj-name').textContent === 'roadmap-demo' && ${showing('roadmap', roadmapPath)} && !!${roadmapRow('#1')}`);

    // Each of this board's rows opens its item on the Items tab, which gives it the same word and
    // colours, its list dot included; a withdrawn item is left out of the list while browsing.
    for (const row of seen.cards.flatMap((card) => card.rows).filter((each) => each.id.startsWith('#'))) {
      await openRoadmapItem(chrome, row.id);
      await chrome.waitFor(`${showing('items', '/roadmap-demo/items/' + row.id.slice(1))} && document.querySelector('#detail h2 span')?.innerText === ${JSON.stringify(row.id)}`);
      const here = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const chip = document.querySelector('#detail .meta .chip'), dot = document.querySelector('#chain [data-item="${row.id.slice(1)}"] .dot');
        return { label: chip.innerText, chip: getComputedStyle(chip).color + ' on ' + getComputedStyle(chip).backgroundColor, dot: dot ? getComputedStyle(dot).backgroundColor : 'not listed' };
      })())`));
      assert.deepEqual(here, { label: row.label, chip: row.chip, dot: row.label === 'withdrawn' ? 'not listed' : row.dot }, `${row.id}: the Items tab shows it with the Roadmap's word and colours`);
      await travel(chrome, -1);
      await settled(chrome, `${showing('roadmap', roadmapPath)} && !!${roadmapRow(row.id)}`);
    }

    // It updates live as items move, here and on the other repo's board.
    accept(box, alpha, 4);
    await chrome.waitFor(`${roadmapRow('#4')}?.querySelector('.chip').innerText === 'verified' && document.querySelector('#roadmap .milestone-count').innerText === '3/5 done'`, 15_000); // budget: hang ceiling for the verified item and milestone count to refresh; no throughput claim.
    box.run(beacon.web, 'claim', '1');
    await chrome.waitFor(`${roadmapRow('beacon#1')}?.querySelector('.chip').innerText === 'building'`, 15_000); // budget: hang ceiling for the claimed external item to refresh; no throughput claim.

    // A board with no milestones says how one starts; the address stays the Roadmap's.
    await press(chrome, `document.querySelector('[data-root=${JSON.stringify(beacon.repo)}]')`);
    await chrome.waitFor(`document.querySelector('#proj-name').textContent === 'beacon' && ${showing('roadmap', '/beacon/roadmap')} && document.querySelector('#roadmap').innerText.startsWith('No milestones yet.')`);
    await press(chrome, `document.querySelector('[data-root=${JSON.stringify(alpha.repo)}]')`);
    await chrome.waitFor(`document.querySelector('#proj-name').textContent === 'roadmap-demo' && !!${roadmapRow('#1')}`);

    // A reload keeps the Roadmap. The board's own address shows the tab last picked there, never the
    // Roadmap, even when the Roadmap was picked last.
    await chrome.send('Page.reload');
    await settled(chrome, `!!data?.project && ${showing('roadmap', roadmapPath)} && !!${roadmapRow('#1')}`);
    await press(chrome, `document.querySelector('[data-tab="shouts"]')`);
    await chrome.waitFor(showing('shouts', '/roadmap-demo/shouts'));
    await press(chrome, `document.querySelector('[data-tab="roadmap"]')`);
    await chrome.waitFor(showing('roadmap', roadmapPath));
    await chrome.send('Page.navigate', { url: view.link.href });
    await settled(chrome, `!!data?.project && ${showing('shouts', '/roadmap-demo/shouts')} && document.querySelector('.tab.on')?.dataset.tab === 'shouts'`);
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught page exceptions');
    assert.deepEqual(consoleErrors, [], 'Chrome reports no console errors');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a milestone lists work to ship first, shipped below, and no withdrawn items [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for shipping-order checks.');
  const box = machine();
  const alpha = project(box, 'shipping-rows');
  for (const title of ['First verified', 'First open', 'Second verified', 'Dropped idea', 'Second open']) {
    box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  }
  for (const id of [1, 3]) { build(box, alpha, id, `page-${id}.html`); accept(box, alpha, id); }
  box.run(alpha.repo, 'withdraw', '4', 'not needed');
  box.run(alpha.repo, 'milestone', 'add', 'Next', '--items', '3,2,4,1,5');
  box.run(alpha.repo, 'milestone', 'add', 'Shipped', '--items', '1,4,3');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-shipping-rows-chrome-'));
  let chrome;
  /** Read the actual row order and every visible-count consumer, including folded history. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const next = document.querySelector('#roadmap-list > [data-key="m:Next"]');
    const progress = next.querySelector('[role=progressbar]');
    const shipped = document.querySelector('#roadmap .shipped-one[data-key="m:Shipped"]');
    return {
      rows: [...next.querySelectorAll(':scope > .milestone-body > ul .milestone-item .id')].map(id => id.textContent),
      count: next.querySelector('.milestone-count').textContent,
      progress: [progress.getAttribute('aria-valuenow'), progress.getAttribute('aria-valuemax')],
      index: document.querySelector('#roadmap-panel [data-roadmap-jump="m:Next"] b').textContent,
      status: document.querySelector('[data-status=release]').textContent.replace(/\\s+/g, ' ').trim(),
      openCounts: [...document.querySelectorAll('[data-shipping-stage=open] dd')].map(count => count.textContent),
      shippedCount: shipped.querySelector('.milestone-count').textContent,
      shippedRows: [...shipped.querySelectorAll(':scope > .milestone-body > ul .milestone-item .id')].map(id => id.textContent),
      allIds: [...document.querySelectorAll('#roadmap .milestone-item .id')].map(id => id.textContent),
    };
  })())`));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.milestones?.length === 2');
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor("!document.querySelector('[data-pane=roadmap]').hidden && document.querySelector('#roadmap-list > [data-key=\"m:Next\"]')");
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      const seen = await read();
      assert.deepEqual(seen.rows, ['#2', '#5', '#3', '#1'], `${width}: each group keeps milestone order, with work to ship before verified items`);
      assert.equal(seen.count, '2/4 done', `${width}: withdrawn work is absent from the card count`);
      assert.deepEqual(seen.progress, ['2', '4'], `${width}: progress counts only retained items`);
      assert.equal(seen.index, '2/4', `${width}: the release index uses the same count`);
      assert.equal(seen.status, 'Next 2/4', `${width}: the status bar names the same next release and count`);
      assert.deepEqual(seen.openCounts, ['2', '2'], `${width}: desktop and mobile shipping counts include both open items`);
      assert.equal(seen.shippedCount, '2 items', `${width}: folded history excludes withdrawn work from its total`);
      assert.equal(seen.allIds.includes('#4'), false, `${width}: no withdrawn row is rendered, including folded history`);
      await press(chrome, "document.querySelector('#roadmap-list > [data-key=shipped] > .milestone-head')");
      await press(chrome, "document.querySelector('#roadmap .shipped-one[data-key=\"m:Shipped\"] > .milestone-head')");
      await chrome.waitFor("document.querySelector('#roadmap .shipped-one[data-key=\"m:Shipped\"] > .milestone-head').getAttribute('aria-expanded') === 'true'");
      assert.deepEqual((await read()).shippedRows, ['#1', '#3'], `${width}: verified history remains available below the work to ship`);
      await press(chrome, "document.querySelector('#roadmap .shipped-one[data-key=\"m:Shipped\"] > .milestone-head')");
      await press(chrome, "document.querySelector('#roadmap-list > [data-key=shipped] > .milestone-head')");
    }
    assert.deepEqual(chrome.exceptions, [], 'the shipping roadmap raises no uncaught page exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('the roadmap leads with the next release and folds shipped ones [N26]', { timeout: 150_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for roadmap browser checks.');
  const box = machine();
  const alpha = project(box, 'releases');
  for (const title of ['First page', 'Second page', 'Third page', 'Fourth page', 'Fifth page', 'Dropped idea']) box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  for (const id of [1, 2, 4]) { build(box, alpha, id, `page-${id}.html`); accept(box, alpha, id); }
  box.run(alpha.repo, 'withdraw', '6', 'not needed');
  // In the board's order: two releases shipped (one with a withdrawn item, which does not hold it back), the next one
  // part done, and one queued after it.
  box.run(alpha.repo, 'milestone', 'add', '0.1', '--note', 'The first page.', '--items', '1');
  box.run(alpha.repo, 'milestone', 'add', '0.2', '--note', 'Shipped on Tuesday.\nA second line the shipped row leaves out.', '--items', '2,6');
  box.run(alpha.repo, 'milestone', 'add', '0.3', '--note', 'Next out.', '--items', '3,4');
  box.run(alpha.repo, 'milestone', 'add', '0.4', '--note', 'Queued behind 0.3.', '--items', '5');
  box.run(alpha.repo, 'milestone', 'add', 'Later', '--note', 'Work not filed yet.');
  box.run(alpha.repo, 'milestone', 'move', 'Later', '--before', '0.1');
  const other = project(box, 'other-releases');
  box.run(other.repo, 'add', 'web', 'Other next page', '--specs', 'G1', '--criterion', 'renders');
  box.run(other.repo, 'milestone', 'add', '0.3', '--items', '1');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-releases-chrome-'));
  let chrome;
  /** The Roadmap as it reads: each part in order, open or closed, with what its summary says. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    /** Read header columns without the decorative caret. */
    const words = (e) => [...e.children].filter((c) => !c.classList.contains('caret')).map((c) => c.textContent.replace(/\\s+/g, ' ').trim()).join(' | ');
    /** Measure the rendered header target. */
    const box = (e) => { const r = e.getBoundingClientRect(); return { width: r.width, height: r.height }; };
    /** Find the direct disclosure control. */
    const head = (part) => part.querySelector(':scope > .milestone-head');
    /** Find the direct disclosure contents. */
    const body = (part) => part.querySelector(':scope > .milestone-body');
    /** Read the accessible expanded state. */
    const open = (part) => head(part)?.getAttribute('aria-expanded') === 'true';
    /** Read only visible item rows from an expanded release. */
    const rows = (part) => open(part) ? [...body(part).querySelectorAll(':scope > ul .milestone-item')].filter((row) => row.getBoundingClientRect().height > 0).map((row) => row.querySelector('.id').textContent) : [];
    return {
      statusRelease: document.querySelector('[data-status=release]')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
      page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth },
      parts: [...document.querySelectorAll('#roadmap-list > [data-key]')].map((d) => ({ key: d.dataset.key, open: open(d), summary: words(head(d)), height: box(head(d)).height,
        rows: rows(d), empty: body(d).querySelector('.milestone-empty')?.textContent ?? null, note: body(d).querySelector('.milestone-note')?.textContent ?? null,
        shipped: [...body(d).querySelectorAll(':scope > .shipped-one[data-key]')].map((one) => ({ key: one.dataset.key, open: open(one), summary: words(head(one)), height: box(head(one)).height,
          rows: rows(one) })) })),
    };
  })())`));
  /** Activate a disclosure or item through the shared native pointer helper. */
  const click = (selector) => press(chrome, `document.querySelector(${JSON.stringify(selector)})`);
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && data?.project?.milestones?.length === 5");
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor("!document.querySelector('[data-pane=roadmap]').hidden && document.querySelectorAll('#roadmap-list > [data-key]').length > 0");
    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await chrome.stable("delete document.documentElement.dataset.theme");
        await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
        const at = `${width}px ${scheme}`;
        const r = await read();
        assert.equal(r.statusRelease, '0.3 1/2', at + ': the status bar names the same next release');
        assert.ok(r.page.scroll <= r.page.width && r.page.body <= r.page.width, `${at}: no sideways scroll`);
        // Every release with work ahead stays open; the shipped ones fold into one part at the end.
        assert.deepEqual(r.parts.map((part) => [part.key, part.open, part.summary]), [
          ['m:0.3', true, '0.3 | 1/2 done'],
          ['m:0.4', true, '0.4 | 0/1 done'],
          ['m:Later', true, 'Later'],
          ['shipped', false, 'Shipped | 2 releases'],
        ], `${at}: every upcoming milestone opens in order, with Shipped folded last`);
        assert.deepEqual(r.parts[0].rows, ['#3', '#4'], `${at}: the next release shows its items`);
        assert.deepEqual([r.parts[2].empty, r.parts[2].note], ['No items yet.', 'Work not filed yet.'], `${at}: the open empty milestone shows its note and empty state`);
        assert.ok(r.parts.every((part) => part.height >= 44), `${at}: each part opens from a 44px target`);
        await click('#roadmap-list > [data-key="shipped"] > .milestone-head');
        const expanded = await read();
        const history = expanded.parts.find((part) => part.key === 'shipped');
        assert.deepEqual(history.shipped.map((one) => [one.key, one.open, one.summary]), [
          ['m:0.2', false, '0.2 | Shipped on Tuesday. | 1 item'],
          ['m:0.1', false, '0.1 | The first page. | 1 item'],
        ], at + ': shipped names, first note line and counts in reverse roadmap order');
        assert.ok(history.shipped.every((one) => one.height >= 44), at + ': shipped targets are at least 44px');
        assert.ok(expanded.page.scroll <= expanded.page.width && expanded.page.body <= expanded.page.width, at + ': expanded history has no sideways scroll');
        await click('#roadmap .shipped-one[data-key="m:0.2"] > .milestone-head');
        assert.deepEqual((await read()).parts.find((part) => part.key === 'shipped').shipped[0].rows, ['#2'], at + ': verified items remain readable and withdrawn work is absent');
        await proofShot(chrome, 'releases', width);
        await click('#roadmap .shipped-one[data-key="m:0.2"] > .milestone-head');
        await click('#roadmap-list > [data-key="shipped"] > .milestone-head');
      }
    }

    // Opened, Shipped lists the releases newest first: each its name, its note's first line and its item count; one
    // opens to its items as before.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 1280');
    await press(chrome, "document.querySelector('[data-status=release]')");
    assert.deepEqual((await read()).parts.map(part => part.key), ['m:0.3'], 'the status-bar release link opens only the same next release');
    await press(chrome, "document.querySelector('[data-roadmap-all]')");
    assert.deepEqual((await read()).parts.map(part => part.key), ['m:0.3', 'm:0.4', 'm:Later', 'shipped'], 'show all restores upcoming and shipped history');
    await click('#roadmap-list > [data-key="shipped"] > .milestone-head');
    let r = await read();
    const shipped = r.parts.find((part) => part.key === 'shipped');
    assert.deepEqual(shipped.shipped.map((one) => [one.key, one.open, one.summary]), [
      ['m:0.2', false, '0.2 | Shipped on Tuesday. | 1 item'],
      ['m:0.1', false, '0.1 | The first page. | 1 item'],
    ], 'newest first, each one line, closed');
    assert.ok(shipped.shipped.every((one) => one.height >= 44), 'each a 44px target');
    await click('#roadmap .shipped-one[data-key="m:0.2"] > .milestone-head');
    r = await read();
    assert.deepEqual(r.parts.find((part) => part.key === 'shipped').shipped.find((one) => one.key === 'm:0.2').rows, ['#2'], 'a shipped release opens to its verified items');
    await click('#roadmap .shipped-one[data-key="m:0.2"] .milestone-item');
    await click('#roadmap .shipped-one[data-key="m:0.2"] .milestone-why a[data-go="item:2"]');
    await chrome.waitFor("view.tab === 'items' && document.querySelector('#detail h2')?.textContent.includes('Second page')");

    // The parts stay as the person left them when the board redraws: close the next release, then change the board.
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor("!document.querySelector('[data-pane=roadmap]').hidden");
    await click('#roadmap-list > [data-key="m:0.3"] > .milestone-head');
    box.run(alpha.web, 'claim', '3');
    await chrome.waitFor("data.project.items.find((i) => i.id === 3)?.status === 'claimed'", 15_000); // budget: hang ceiling for the native claim to reach the open roadmap; no throughput claim.
    r = await read();
    assert.deepEqual(r.parts.map((part) => [part.key, part.open]), [['m:0.3', false], ['m:0.4', true], ['m:Later', true], ['shipped', true]], 'a redraw keeps each part as it was left');
    await pickProject(chrome, `[...document.querySelectorAll('[data-root]')].find((e) => e.dataset.root === ${JSON.stringify(other.repo)})`);
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    assert.deepEqual((await read()).parts.map((part) => [part.key, part.open]), [['m:0.3', true]], 'another board starts with its own next release open');
    await pickProject(chrome, `[...document.querySelectorAll('[data-root]')].find((e) => e.dataset.root === ${JSON.stringify(alpha.repo)})`);
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    assert.deepEqual((await read()).parts.map((part) => [part.key, part.open]), [['m:0.3', false], ['m:0.4', true], ['m:Later', true], ['shipped', true]], 'returning to the board preserves this visit\'s disclosure choices');
    await chrome.send('Page.reload');
    await settled(chrome, "typeof data === 'object' && data?.project?.milestones?.length === 5 && !document.querySelector('[data-pane=roadmap]').hidden");
    assert.deepEqual((await read()).parts.map((part) => [part.key, part.open]), [['m:0.3', true], ['m:0.4', true], ['m:Later', true], ['shipped', false]], 'a new visit opens every upcoming milestone and folds Shipped again');
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('the roadmap keeps every upcoming release open [N26]', {
  timeout: 90_000, //budget: real Chrome startup, two viewport layouts, and reload; test assertions bound each state.
}, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for roadmap disclosure checks.');
  const box = machine();
  const alpha = project(box, 'all-upcoming-open');
  for (const title of ['Shipped one', 'Shipped two', 'Next release', 'Later release']) box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  for (const id of [1, 2]) { build(box, alpha, id, `page-${id}.html`); accept(box, alpha, id); }
  box.run(alpha.repo, 'milestone', 'add', '0.1', '--items', '1');
  box.run(alpha.repo, 'milestone', 'add', '0.2', '--items', '2');
  box.run(alpha.repo, 'milestone', 'add', '0.3', '--note', 'Next out.', '--items', '3');
  box.run(alpha.repo, 'milestone', 'add', '0.4', '--note', 'Queued next.', '--items', '4');
  box.run(alpha.repo, 'milestone', 'add', 'Later', '--note', 'No work filed yet.');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-all-upcoming-open-chrome-'));
  let chrome;
  /** Read default disclosures, their visible content, status label, and viewport overflow. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const parts=[...document.querySelectorAll('#roadmap-list > [data-key]')];
    const readPart=part=>{const head=part.querySelector(':scope > .milestone-head'),body=part.querySelector(':scope > .milestone-body');
      const rows=[...body.querySelectorAll(':scope > ul .milestone-item')];
      return {key:part.dataset.key,open:head.getAttribute('aria-expanded')==='true',rows:rows.map(row=>row.querySelector('.id').textContent),visibleRows:rows.filter(row=>row.getBoundingClientRect().height>0).length,
        empty:body.querySelector('.milestone-empty')?.textContent??null,note:body.querySelector('.milestone-note')?.textContent??null,
        shipped:[...body.querySelectorAll(':scope > .shipped-one')].map(readPart)};};
    return {parts:parts.map(readPart),status:document.querySelector('[data-status=release]')?.textContent.replace(/\\s+/g,' ').trim()??null,
      viewport:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,body:document.body.scrollWidth};
  })())`));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("data?.project?.milestones?.length === 5");
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: width === 375 ? 812 : 800, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      const initial = await read();
      assert.deepEqual(initial.parts.map(({ key, open }) => [key, open]), [['m:0.3', true], ['m:0.4', true], ['m:Later', true], ['shipped', false]], `${width}: every upcoming release opens while Shipped stays folded`);
      assert.deepEqual(initial.parts.slice(0, 2).map((part) => [part.rows, part.visibleRows]), [[['#3'], 1], [['#4'], 1]], `${width}: both upcoming item lists are visible`);
      assert.deepEqual([initial.parts[2].empty, initial.parts[2].note], ['No items yet.', 'No work filed yet.'], `${width}: the empty upcoming release shows its note`);
      assert.equal(initial.parts[3].shipped.length, 2, `${width}: both shipped releases are present`);
      assert.equal(initial.parts[3].shipped.every((part) => !part.open && part.visibleRows === 0), true, `${width}: both shipped releases remain folded`);
      assert.equal(initial.status, '0.3 0/1', `${width}: the status bar still names the next release`);
      assert.ok(initial.scroll <= initial.viewport && initial.body <= initial.viewport, `${width}: no sideways scrolling`);
      await proofShot(chrome, 'roadmap-upcoming-open', width);
      if (width === 375) {
        await press(chrome, "document.querySelector('[data-roadmap-key=\"m:0.4\"]')");
        await chrome.waitFor("document.querySelector('[data-roadmap-key=\"m:0.4\"]').getAttribute('aria-expanded') === 'false'");
        assert.equal((await read()).parts[1].open, false, 'the person can fold an upcoming release for this visit');
        await chrome.send('Page.reload');
        await settled(chrome, "data?.project?.milestones?.length === 5 && !document.querySelector('[data-pane=roadmap]').hidden");
        assert.deepEqual((await read()).parts.map(({ key, open }) => [key, open]), [['m:0.3', true], ['m:0.4', true], ['m:Later', true], ['shipped', false]], 'the next visit reopens upcoming releases and folds Shipped');
      }
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

/** Record target identity, geometry and native events without changing the Roadmap's input path. */
async function watchRoadmapPress(chrome, key) {
  await chrome.stable(`(() => {
    const selector = '#roadmap-panel [data-roadmap-jump=' + CSS.escape(${JSON.stringify(key)}) + ']';
    let original = document.querySelector(selector);
    const originalRender = window.render;
    const nodeIds = new WeakMap(); let nextNodeId = 0;
    const nodeId = node => { if (!node) return null; if (!nodeIds.has(node)) nodeIds.set(node, ++nextNodeId); return nodeIds.get(node); };
    const trace = window.__roadmapPress = { original, originalRender, samples:[], events:[] };
    /** Keep bounded observations of the live target and its original node. */
    const record = phase => {
      const current = document.querySelector(selector), box = current?.getBoundingClientRect();
      const panel = document.querySelector('#roadmap-panel'), list = document.querySelector('#roadmap-list');
      trace.samples.push({ phase, at:performance.now(), connected:original.isConnected, same:current === original,
        box:box ? [box.x,box.y,box.width,box.height] : null, scroll:[scrollX,scrollY],
        panelId:nodeId(panel), panelCount:panel?.querySelectorAll('[data-roadmap-jump]').length,
        listId:nodeId(list), listCount:list?.querySelectorAll(':scope > [data-key]').length,
        panelScroll:panel?.scrollTop, count:current?.querySelector('b')?.textContent, deferred:deferredClickRender });
      if (trace.samples.length > 8) trace.samples.shift();
    };
    trace.record = record;
    window.render = function(...args) { record('before render'); const result = originalRender.apply(this,args); record('after render'); return result; };
    trace.listeners = ['pointermove','pointerdown','pointerup','click'].map(type => {
      const listener = event => {
        const button = event.target.closest?.('[data-roadmap-jump]');
        if (type === 'pointerdown' && button?.dataset.roadmapJump === ${JSON.stringify(key)}) { original = button; trace.original = button; }
        record(type); trace.events.push({ type, key:button?.dataset.roadmapJump || null });
        if(trace.events.length > 8) trace.events.shift();
      };
      document.addEventListener(type, listener, true); return [type,listener];
    });
    record('watch');
  })()`);
  return {
    /** Read only bounded samples and event keys, never retain DOM objects in the host. */
    async snapshot() {
      return JSON.parse(await chrome.stable(`JSON.stringify((() => { const t=window.__roadmapPress; t.record('snapshot'); return {samples:t.samples,events:t.events}; })())`));
    },
    /** Restore the actual renderer and remove only this observer's event listeners. */
    async dispose() {
      await chrome.stable(`(() => { const t=window.__roadmapPress; if(!t)return; window.render=t.originalRender; for(const [type,listener] of t.listeners)document.removeEventListener(type,listener,true); delete window.__roadmapPress; })()`);
    },
  };
}

test('the roadmap panel jumps to each release [N26]', {
  timeout: 150_000, //budget: hang ceiling for real Chrome startup, fourteen jumps at two widths, and panel scrolling.
}, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for Roadmap panel navigation.');
  const box = machine();
  const alpha = project(box, 'roadmap-panel-jumps');
  for (const title of ['Shipped release item', 'Next release item']) box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  build(box, alpha, 1, 'shipped.html');
  accept(box, alpha, 1);
  const shippedBranch = alpha.itemBranches.get(`${alpha.baseBranch}:1`);
  box.git(alpha.repo, 'merge', '--no-ff', '--no-edit', shippedBranch);
  box.run(alpha.repo, 'merged', '1', box.git(alpha.repo, 'rev-parse', 'HEAD'));
  box.run(alpha.repo, 'milestone', 'add', '0.8.6', '--note', 'Shipped first line.\nThis line stays in the expanded history.', '--items', '1');
  box.run(alpha.repo, 'milestone', 'add', '0.8.7', '--note', 'The next release.', '--items', '2');
  for (const name of ['0.8.8', '0.8.9', '0.8.10', '0.8.11', '0.8.12', '0.8.13', '0.8.14', '0.8.15', '0.8.16', '0.8.17', '0.8.18', '0.8.19']) {
    box.run(alpha.repo, 'milestone', 'add', name, '--note', 'Queued after the next release.');
  }
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-panel-jumps-'));
  let chrome;
  /** Read panel selection, list targets, and page overflow after the shared Chrome wait. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const panel = document.querySelector('#roadmap-panel'), list = document.querySelector('#roadmap-list');
    const buttons = [...panel.querySelectorAll('[data-roadmap-jump]')];
    const targets = [...list.querySelectorAll(':scope > [data-key]')];
    const rect = element => { const r = element.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,height:r.height}; };
    const bar = document.querySelector('.top').getBoundingClientRect();
    return {buttons:buttons.map(b=>({key:b.dataset.roadmapJump,name:b.querySelector('span').textContent,count:b.querySelector('b').textContent,current:b.getAttribute('aria-current'),height:rect(b).height})),
      targets:targets.map(e=>({key:e.dataset.key,rect:rect(e),arrival:e.classList.contains('roadmap-arrival'),expanded:e.querySelector(':scope > .milestone-head')?.getAttribute('aria-expanded')})),
      panel:rect(panel),bar:{top:bar.top,bottom:bar.bottom},strip:rect(panel.querySelector('.roadmap-releases')),
      stripWidth:panel.querySelector('.roadmap-releases').scrollWidth,stripClient:panel.querySelector('.roadmap-releases').clientWidth,
      viewport:document.documentElement.clientWidth,scrollY:window.scrollY,pageWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)};
  })())`));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.milestones?.length === 14');
    // The panel's breakpoint is below 900px, not at it: at 900 the panel stays on the right, sticky, with its own
    // Shipping; at 899 it is the chip row above the list, and the counts sit under the next release.
    for (const scheme of ['light', 'dark']) {
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await chrome.waitFor(`document.documentElement.dataset.scheme === '${scheme}'`);
      for (const width of [900, 899]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.waitFor(`innerWidth === ${width}`);
        await press(chrome, "document.querySelector('[data-tab=roadmap]')");
        const edge = JSON.parse(await chrome.stable(`JSON.stringify((() => {
          const panel = document.querySelector('#roadmap-panel'), list = document.querySelector('#roadmap-list');
          const shown = (e) => !!e && e.getClientRects().length > 0 && e.getBoundingClientRect().height > 0;
          return { position: getComputedStyle(panel).position, beside: panel.getBoundingClientRect().left >= list.getBoundingClientRect().right,
            chips: getComputedStyle(document.querySelector('#roadmap-releases')).display, desk: shown(panel.querySelector('.roadmap-desktop-shipping')), phone: shown(list.querySelector('.roadmap-mobile-shipping')),
            page: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) };
        })())`));
        const at = `${width}/${scheme}`;
        if (width === 900) assert.deepEqual([edge.position, edge.beside, edge.desk, edge.phone], ['sticky', true, true, false], `${at}: the panel stays on the right with its Shipping: ${JSON.stringify(edge)}`);
        else assert.deepEqual([edge.position, edge.beside, edge.chips, edge.desk, edge.phone], ['static', false, 'flex', false, true], `${at}: the chip row above the list, Shipping under the next release: ${JSON.stringify(edge)}`);
        assert.ok(edge.page <= width, `${at}: no sideways scroll: ${JSON.stringify(edge)}`);
      }
    }
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      await press(chrome, "document.querySelector('[data-tab=roadmap]')");
      const initial = await read();
      if (width >= 900) {
        assert.ok(initial.buttons.every((button) => button.height >= tapTarget(width)), 'wide fine-pointer release jumps meet the 32px target');
        // Touch is turned off again below, and the wait is for the pointer the page started with, as demo.test.js
        // does: a Chrome with no mouse, as on Linux CI, starts at none, not fine (#453).
        const originalPointer = JSON.parse(await chrome.stable(`JSON.stringify({ fine:matchMedia('(pointer: fine)').matches, coarse:matchMedia('(pointer: coarse)').matches, none:matchMedia('(pointer: none)').matches })`));
        await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        await chrome.waitFor("matchMedia('(pointer: coarse)').matches");
        const coarse = await read();
        assert.ok(coarse.buttons.every((button) => button.height >= 44), 'wide coarse-pointer release jumps meet the 44px target');
        await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await chrome.waitFor(`matchMedia('(pointer: fine)').matches === ${originalPointer.fine} && matchMedia('(pointer: coarse)').matches === ${originalPointer.coarse} && matchMedia('(pointer: none)').matches === ${originalPointer.none}`);
      }
      const keys = ['m:0.8.7', 'm:0.8.8', 'm:0.8.9', 'm:0.8.10', 'm:0.8.11', 'm:0.8.12', 'm:0.8.13', 'm:0.8.14', 'm:0.8.15', 'm:0.8.16', 'm:0.8.17', 'm:0.8.18', 'm:0.8.19', 'shipped'];
      assert.deepEqual(initial.buttons.map((button) => button.key), keys, `${width}: each upcoming release in order and one Shipped jump`);
      assert.deepEqual(initial.buttons.map(({ name, count }) => [name, count]), [['0.8.7', '0/1'], ...keys.slice(1, -1).map((key) => [key.slice(2), '0/0']), ['Shipped', '1']], `${width}: release names and done counts are visible`);
      assert.ok(initial.buttons.every((button) => button.height >= tapTarget(width)), `${width}: every release jump meets the target size`);
      assert.ok(initial.pageWidth <= initial.viewport, `${width}: the page never scrolls sideways`);
      if (width < 900) {
        assert.ok(initial.stripWidth > initial.stripClient, 'phone release chips scroll inside their own row');
        assert.ok(initial.panel.bottom <= initial.targets[0].rect.top, 'the phone panel sits above the release list');
        // A board refresh redraws the Roadmap; the chips stay where the person scrolled them.
        const kept = JSON.parse(await chrome.stable("(() => { const row = document.querySelector('#roadmap-releases'); row.scrollLeft = row.scrollWidth; const before = row.scrollLeft; render(); return JSON.stringify([before, document.querySelector('#roadmap-releases').scrollLeft]); })()"));
        assert.ok(kept[0] > 0 && kept[1] === kept[0], `375: a redraw keeps the chips where they were scrolled: ${JSON.stringify(kept)}`);
        await chrome.stable("(() => { document.querySelector('#roadmap-releases').scrollLeft = 0; return true; })()");
      }
      await proofShot(chrome, 'roadmap-panel-jumps', width);
      // The page marks a release it jumps to for a moment, then clears the mark. Record each mark as it is set,
      // so a busy machine that reads late still sees it (a fixed window is the #400 class of red). The list is redrawn
      // when the board refreshes, so the watch is on the document.
      await chrome.stable("(() => { window.__arrivals = []; if (!window.__arrivalWatch) { window.__arrivalWatch = new MutationObserver((changes) => { for (const change of changes) if (change.target.classList?.contains('roadmap-arrival') && change.target.closest('#roadmap-list')) window.__arrivals.push(change.target.dataset.key); }); window.__arrivalWatch.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] }); } return true; })()");
      for (const key of keys.slice(0, -1)) {
        await press(chrome, `document.querySelector('#roadmap-panel [data-roadmap-jump="${key}"]')`);
        const moved = await read();
        const target = moved.targets.find((entry) => entry.key === key);
        const marked = JSON.parse(await chrome.stable('JSON.stringify(window.__arrivals)')).includes(key);
        assert.ok(marked && target.rect.bottom > moved.bar.bottom && target.rect.top < 900, `${width}: selecting ${key} scrolls it into view and marks it: ${JSON.stringify({ ...target, marked })}`);
        const atTop = moved.targets.find((entry) => entry.rect.bottom > moved.bar.bottom + 8)?.key || moved.targets.at(-1).key;
        assert.equal(moved.buttons.find((button) => button.key === atTop).current, 'location', `${width}: the panel marks the release actually at the top of the list`);
      }
      await press(chrome, "document.querySelector('#roadmap-panel [data-roadmap-jump=shipped]')");
      assert.equal((await read()).targets.at(-1).expanded, 'true', `${width}: selecting Shipped opens it`);
      const beforeListScroll = await read();
      await chrome.stable("document.querySelector('#roadmap-list [data-key=\"m:0.8.12\"]').scrollIntoView({block:'start',behavior:'instant'})");
      const scrolled = await read();
      const atTop = scrolled.targets.find((entry) => entry.rect.bottom > scrolled.bar.bottom + 8)?.key || scrolled.targets.at(-1).key;
      assert.notEqual(scrolled.scrollY, beforeListScroll.scrollY, `${width}: scrolling to a middle release moves the list`);
      assert.notEqual(scrolled.buttons.find((button) => button.current === 'location')?.key, beforeListScroll.buttons.find((button) => button.current === 'location')?.key, `${width}: scrolling changes the active release`);
      assert.equal(scrolled.buttons.find((button) => button.key === atTop).current, 'location', `${width}: scrolling the list updates the marker for the release actually at the top`);
      assert.ok(scrolled.pageWidth <= scrolled.viewport, `${width}: navigation keeps the page within its width`);
      if (width >= 900) assert.ok(scrolled.panel.top >= scrolled.bar.bottom + 8 && scrolled.panel.top <= scrolled.bar.bottom + 24, `desktop panel stays beside the list while scrolling: ${JSON.stringify(scrolled.panel)}`);
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('a refresh between pointer down and up preserves a roadmap release click [N26,C7]', {
  timeout: 90_000, // budget: hang ceiling for real board setup, Chrome and two pointer-held board refreshes.
}, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the Roadmap refresh control.');
  const box = machine(), demo = project(box, 'roadmap-refresh-press');
  for (const name of ['0.8.7','0.8.8','0.8.9','0.8.10','0.8.11','0.8.12','0.8.13','0.8.14']) {
    box.run(demo.repo, 'milestone', 'add', name, '--note', 'Release navigation control.');
  }
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-refresh-press-'));
  let chrome, trace;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.milestones?.length === 8');
    for (const width of [375,1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height:900, deviceScaleFactor:1, mobile:false });
      await press(chrome, "document.querySelector('[data-tab=roadmap]')");
      const key = 'm:0.8.7';
      trace = await watchRoadmapPress(chrome, key);
      const message = `roadmap refresh while pointer held ${width}`;
      let held;
      await press(chrome, `document.querySelector('#roadmap-panel [data-roadmap-jump="${key}"]')`, {
        afterMouseDown: async () => {
          box.run(demo.repo, 'shout', 'person', message);
          await chrome.waitFor(`data.project.shouts.some(shout => shout.shout_text === ${JSON.stringify(message)})`);
          held = await trace.snapshot();
          t.diagnostic(`${width}: held refresh: ${JSON.stringify(held)}`);
        },
      });
      await chrome.waitFor(`document.querySelector('#feed')?.textContent.includes(${JSON.stringify(message)})`);
      const released = await trace.snapshot();
      t.diagnostic(`${width}: released: ${JSON.stringify(released)}`);
      assert.ok(held.samples.some(sample => sample.phase === 'after render'), `${width}: the real board refresh attempted a render while held`);
      assert.ok(held.samples.at(-1).connected && held.samples.at(-1).same, `${width}: the pressed button survives the refresh`);
      assert.ok(held.samples.at(-1).deferred, `${width}: the render waits until the pointer release`);
      assert.ok(released.events.some(event => event.type === 'click' && event.key === key), `${width}: the release produces the intended native click`);
      const reached = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const target=document.querySelector('#roadmap-list [data-key="${key}"]'), r=target.getBoundingClientRect();
        return {top:r.top,bottom:r.bottom,bar:document.querySelector('.top').getBoundingClientRect().bottom,
          current:document.querySelector('#roadmap-panel [data-roadmap-jump="${key}"]').getAttribute('aria-current')};
      })())`));
      assert.ok(reached.bottom > reached.bar && reached.top < 900, `${width}: the selected release is visible: ${JSON.stringify(reached)}`);
      assert.equal(reached.current, 'location', `${width}: the panel marks the selected release`);
      await trace.dispose(); trace = null;
    }
  } finally {
    try { if (trace) await trace.dispose(); }
    finally {
      try { if(chrome) await closeSnapshotChrome(chrome); }
      finally { try { await view.stop(); } finally { rmSync(profile,{recursive:true,force:true}); } }
    }
  }
});

test('the roadmap chips keep their scroll through a redraw with wide fonts [N26]', async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the Roadmap chip row.');
  const box = machine();
  const alpha = project(box, 'roadmap-chips-wide');
  box.run(alpha.repo, 'add', 'web', 'Next release item', '--specs', 'G1', '--criterion', 'renders');
  box.run(alpha.repo, 'milestone', 'add', '0.8.7', '--note', 'The next release.', '--items', '1');
  for (const name of ['0.8.8', '0.8.9', '0.8.10', '0.8.11', '0.8.12', '0.8.13', '0.8.14', '0.8.15', '0.8.16', '0.8.17', '0.8.18', '0.8.19']) {
    box.run(alpha.repo, 'milestone', 'add', name, '--note', 'Queued after the next release.');
  }
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-chips-wide-'));
  let chrome;
  /** The chips' release names by their text's own width, measured from the glyphs, not the boxes. */
  const labels = async () => JSON.parse(await chrome.stable("JSON.stringify([...document.querySelectorAll('#roadmap-releases .roadmap-release > span')].map((e) => { const r = document.createRange(); r.selectNodeContents(e); return [e.textContent, r.getBoundingClientRect().width]; }))"));
  const widths = (list) => JSON.stringify(list.map(([name, width]) => [name, Math.round(width * 100) / 100]));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.milestones?.length === 13');
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 375');
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor("document.querySelector('#roadmap-releases [aria-current=location]')");
    const before = await labels();
    // The current release's chip is bold, so it is wider than when it is not marked, by an amount that depends on
    // the face: 2px on macOS, 4px on Linux CI (#452). A letter-spacing in em widens every label by the same share of its
    // face on every runner, as the toolbar's test does (#445); the forced face, where a machine has it, adds a wider bold.
    for (const face of ['', 'font-family: Verdana, "DejaVu Sans", "Bitstream Vera Sans", sans-serif !important; ']) {
      const at = `375/${face ? 'forced face' : 'own face'}`;
      await chrome.stable(`(() => { const sheet = document.styleSheets[0]; sheet.insertRule('.roadmap-release, .roadmap-release * { ${face}letter-spacing: .12em !important; }', sheet.cssRules.length); return true; })()`);
      const after = await labels();
      assert.deepEqual(after.map(([name]) => name), before.map(([name]) => name), `${at}: the same chips, widened`);
      assert.ok(after.every(([, width], i) => width >= before[i][1] * 1.1), `${at}: every chip's name is at least 10% wider: ${widths(before)} to ${widths(after)}`);
      // A board refresh redraws the Roadmap with the chips scrolled to their end, where a shorter row would clamp them.
      const kept = JSON.parse(await chrome.stable("(() => { const row = document.querySelector('#roadmap-releases'); row.scrollLeft = row.scrollWidth; const before = [row.scrollLeft, row.querySelector('[aria-current]')?.dataset.roadmapJump]; render(); const now = document.querySelector('#roadmap-releases'); return JSON.stringify([before, [now.scrollLeft, now.querySelector('[aria-current]')?.dataset.roadmapJump]]); })()"));
      assert.ok(kept[0][0] > 0 && kept[1][0] === kept[0][0], `${at}: a redraw keeps the chips exactly where they were scrolled: ${JSON.stringify(kept)}`);
      assert.equal(kept[1][1], kept[0][1], `${at}: the redraw keeps the same chip marked`);
      await chrome.stable("(() => { const sheet = document.styleSheets[0]; sheet.deleteRule(sheet.cssRules.length - 1); document.querySelector('#roadmap-releases').scrollLeft = 0; return true; })()");
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('the roadmap panel counts the next release by stage [N26]', {
  timeout: 180_000, //budget: hang ceiling for six real item lifecycles and merged receipts before four viewport/theme checks.
}, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for Roadmap shipping counts.');
  const box = machine();
  const alpha = project(box, 'roadmap-panel-counts');
  for (const title of ['Open', 'Building', 'In review', 'Accepted', 'Verified', 'Shipped']) box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  build(box, alpha, 3, 'submitted.html');
  build(box, alpha, 4, 'accepted.html');
  accept(box, alpha, 4);
  build(box, alpha, 5, 'verified.html');
  accept(box, alpha, 5);
  const mergedBranch = alpha.itemBranches.get(`${alpha.baseBranch}:5`);
  box.git(alpha.repo, 'merge', '--no-ff', '--no-edit', mergedBranch);
  box.run(alpha.repo, 'merged', '5', box.git(alpha.repo, 'rev-parse', 'HEAD'));
  build(box, alpha, 6, 'last-shipped.html');
  accept(box, alpha, 6);
  const shippedBranch = alpha.itemBranches.get(`${alpha.baseBranch}:6`);
  box.git(alpha.repo, 'merge', '--no-ff', '--no-edit', shippedBranch);
  box.run(alpha.repo, 'merged', '6', box.git(alpha.repo, 'rev-parse', 'HEAD'));
  box.run(alpha.web, 'claim', '2');
  box.run(alpha.repo, 'milestone', 'add', '0.8.6', '--note', 'The last shipped note.\nA second detail line.', '--items', '6');
  box.run(alpha.repo, 'milestone', 'add', '0.8.7', '--note', 'Shipping next.', '--items', '1,2,3,4,5');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-panel-counts-'));
  let chrome;
  /** Read the visible stage counts and the bounded last-shipped summary. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const card=document.querySelector('#roadmap-panel'), rect=e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height};};
    const last=[...document.querySelectorAll('#roadmap .roadmap-last-shipped')].find(e=>e.getBoundingClientRect().height>0);
    return {next:document.querySelector('#roadmap-list > .milestone > .milestone-head h2').textContent,
      counts:[...document.querySelectorAll('#roadmap [data-shipping-stage]')].filter(e=>e.getBoundingClientRect().height>0).map(e=>[e.dataset.shippingStage,e.querySelector('dd').textContent]),
      shipped:last ? [...last.children].map(e=>e.textContent) : null,
      panel:rect(card),desktop:rect(card.querySelector('.roadmap-desktop-shipping')),mobile:rect(document.querySelector('.roadmap-list .roadmap-mobile-shipping')),
      heading:rect(document.querySelector('#roadmap-list > .milestone > .milestone-head h2')),
      mobileCounts:rect(document.querySelector('#roadmap-list > .milestone > .roadmap-mobile-shipping .roadmap-stage-counts')),
      documentWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),viewport:document.documentElement.clientWidth,viewportHeight:document.documentElement.clientHeight};
  })())`));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.milestones?.length === 2');
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      for (const scheme of ['light', 'dark']) {
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await chrome.waitFor(`matchMedia('(prefers-color-scheme: ${scheme})').matches`);
        const counts = await read();
        assert.equal(counts.next, '0.8.7', `${width}/${scheme}: the panel names the next release`);
        assert.deepEqual(counts.counts, [['open', '1'], ['claimed', '1'], ['submitted', '1'], ['accepted', '1'], ['merged', '1']], `${width}/${scheme}: each state uses the board's held item data`);
        assert.deepEqual(counts.shipped, ['Last shipped', '0.8.6', 'The last shipped note.'], `${width}/${scheme}: the last shipped row includes only the note's first line`);
        assert.ok(counts.documentWidth <= counts.viewport, `${width}/${scheme}: the page never scrolls sideways`);
        if (width < 900) assert.ok(counts.heading.top < counts.mobileCounts.top && counts.mobile.height > 0 && counts.desktop.height === 0, `${width}/${scheme}: counts sit under the actual next release heading on the phone`);
        else assert.ok(counts.desktop.height > 0 && counts.mobile.height === 0, `${width}/${scheme}: desktop shipping counts stay in the right panel`);
      }
      await proofShot(chrome, 'roadmap-panel-counts', width);
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('a blocked roadmap item shows its dot and expands to say why [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the roadmap blocker check.');
  const box = machine();
  const alpha = project(box, 'blocked-roadmap');
  box.run(alpha.repo, 'add', 'web', 'Base work', '--specs', 'G1', '--criterion', 'renders');
  box.run(alpha.repo, 'add', 'web', 'Waits on base', '--specs', 'G1', '--criterion', 'renders', '--after', '1');
  box.run(alpha.repo, 'add', 'web', 'Free work', '--specs', 'G1', '--criterion', 'renders');
  // A sent-back item that waits on #1: built once by web-1, whose claim ended with the reject (#605 review).
  box.run(alpha.repo, 'add', 'web', 'Sent back once', '--specs', 'G1', '--criterion', 'renders');
  build(box, alpha, 4, 'sent-back.html');
  sendBack(box, alpha, 4, 'the heading is missing');
  box.run(alpha.repo, 'edit', '4', '--after', '1', '--reason', 'it waits on the base work');
  box.run(alpha.repo, 'add', 'web', 'Verified work', '--specs', 'G1', '--criterion', 'renders');
  build(box, alpha, 5, 'verified.html'); accept(box, alpha, 5);
  box.run(alpha.repo, 'add', 'web', 'Building work', '--specs', 'G1', '--criterion', 'renders');
  box.run(alpha.web, 'claim', '6');
  const other = project(box, 'blocked-roadmap-other');
  box.run(other.repo, 'add', 'web', 'Remote base', '--specs', 'G1', '--criterion', 'renders');
  box.run(other.repo, 'add', 'web', 'Remote sent-back work', '--specs', 'G1', '--criterion', 'renders');
  build(box, other, 2, 'remote-sent-back.html');
  sendBack(box, other, 2, 'Remote latest finding\nMore detail stays in Items');
  box.run(other.repo, 'edit', '2', '--after', '1', '--reason', 'it waits on the remote base');
  box.run(other.repo, 'hold', 'web', '--reason', 'Review the remote dependency');
  box.run(alpha.repo, 'milestone', 'add', 'Next', '--items', '1,2,3,4,5,6,blocked-roadmap-other#2');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-blocked-roadmap-chrome-'));
  let chrome;
  /** Read the rows: their state dot, blocker dot and unfolded reason. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#roadmap-list > [data-key="m:Next"] .milestone-body > ul > li')].map((li) => ({
    id: li.querySelector('.milestone-item .id').textContent,
    dot: Boolean(li.querySelector('.milestone-item > .dot')),
    blocker: li.querySelector('.block-dot')?.getAttribute('aria-label') || null,
    why: li.querySelector('.milestone-why')?.hidden === false ? li.querySelector('.milestone-why').textContent : null,
  })))`));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.milestones?.length === 1');
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor("!document.querySelector('[data-pane=roadmap]').hidden && document.querySelector('#roadmap-list > [data-key=\"m:Next\"]')");
    const folded = await read();
    const byId = Object.fromEntries(folded.map((row) => [row.id, row]));
    assert.equal(byId['#2'].blocker, 'Blocked: waits on #1 (open)', 'the gated item has a blocker dot naming what it waits on');
    assert.equal(byId['#3'].dot, true, 'an unblocked item keeps its state dot');
    assert.equal(byId['#3'].blocker, null, 'an unblocked item has no blocker dot');
    assert.equal(byId['#1'].blocker, null, 'the item others wait on is not itself blocked');
    assert.equal(byId['blocked-roadmap-other#2'].blocker, 'Blocked: waits on #1 (open); lane web held',
      'a remote row uses its own dependency and lane-hold summaries');
    assert.ok(folded.every((row) => row.why === null), 'every row starts folded');
    // From here on, record every request the page makes: unfolding must not fetch an item's detail.
    await chrome.stable("window.__requests = []; window.__fetch = window.__fetch || window.fetch; window.fetch = (url, options) => { window.__requests.push(String(url)); return window.__fetch(url, options); }; true");
    const roadmapAddress = await chrome.stable('location.href');
    for (const [id, state] of [[5, 'verified'], [6, 'claimed']]) {
      const row = "[...document.querySelectorAll('#roadmap .milestone-item')].find((entry) => entry.querySelector('.id').textContent === '#" + id + "')";
      assert.equal(await chrome.stable(row + ".getAttribute('aria-expanded')"), 'false', 'every status starts as an in-place disclosure');
      await press(chrome, row);
      await chrome.waitFor(row + ".getAttribute('aria-expanded') === 'true'");
      assert.equal(await chrome.stable('location.href'), roadmapAddress, 'click keeps the Roadmap address');
      assert.equal(await chrome.stable("view.tab"), 'roadmap');
      assert.match(await chrome.stable(row + ".parentElement.querySelector('.milestone-why').textContent"), new RegExp('state.*' + state));
      if (state === 'claimed') assert.match(await chrome.stable(row + ".parentElement.querySelector('.milestone-why').textContent"), /held by/u);
      await press(chrome, row);
      await chrome.waitFor(row + ".getAttribute('aria-expanded') === 'false'");
      await chrome.stable(row + '.focus(); true');
      await chrome.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await chrome.waitFor(row + ".getAttribute('aria-expanded') === 'true'");
      assert.equal(await chrome.stable('location.href'), roadmapAddress, 'Enter keeps the Roadmap address');
      assert.equal(await chrome.stable("view.tab"), 'roadmap');
      await press(chrome, row);
      await chrome.waitFor(row + ".getAttribute('aria-expanded') === 'false'");
    }
    assert.deepEqual(JSON.parse(await chrome.stable('JSON.stringify(window.__requests)')).filter(url => /\/items\/\d/.test(url)), [], 'verified and building expansion needs no item detail request');
    await press(chrome, "[...document.querySelectorAll('#roadmap .milestone-item.blocked')].find((row) => row.querySelector('.id').textContent === '#2')");
    await chrome.waitFor("document.querySelector('#roadmap .milestone-why:not([hidden])')");
    const open = Object.fromEntries((await read()).map((row) => [row.id, row]));
    assert.match(open['#2'].why, /waits on#1 open/, 'the unfolded row names the item it waits on and that item\'s state');
    assert.match(open['#2'].why, /state.*open, nobody holds it/, 'the unfolded row says its own state and who holds it');
    assert.equal(open['#3'].why, null, 'unblocked rows stay as they were');
    const requests = JSON.parse(await chrome.stable('JSON.stringify(window.__requests)'));
    assert.deepEqual(requests.filter((url) => /\/items\/\d/.test(url)), [], 'unfolding reads the summaries already held and makes no detail request');
    await press(chrome, "document.querySelector('#roadmap .milestone-why:not([hidden]) a.ref')");
    await chrome.waitFor("!document.querySelector('[data-pane=items]').hidden && document.querySelector('#detail h2')?.textContent.includes('Waits on base')");
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor("!document.querySelector('[data-pane=roadmap]').hidden");
    await press(chrome, "[...document.querySelectorAll('#roadmap .milestone-item.blocked')].find((row) => row.querySelector('.id').textContent === '#2')");
    await chrome.waitFor("!document.querySelector('#roadmap .milestone-why:not([hidden])')");
    // The sent-back item: nobody holds it now, though web-1 built it; its latest send-back note shows.
    await press(chrome, "[...document.querySelectorAll('#roadmap .milestone-item.blocked')].find((row) => row.querySelector('.id').textContent === '#4')");
    await chrome.waitFor("document.querySelector('#roadmap .milestone-why:not([hidden])')");
    const sent = Object.fromEntries((await read()).map((row) => [row.id, row]));
    assert.match(sent['#4'].why, /state.*open, nobody holds it/, `a sent-back item names no holder: ${sent['#4'].why}`);
    assert.doesNotMatch(sent['#4'].why, /held by/, 'its past builder is never shown as holding it');
    assert.match(sent['#4'].why, /the heading is missing/, 'its latest send-back note shows');
    await press(chrome, "[...document.querySelectorAll('#roadmap .milestone-item.blocked')].find((row) => row.querySelector('.id').textContent === '#4')");
    await chrome.waitFor("!document.querySelector('#roadmap .milestone-why:not([hidden])')");
    await chrome.stable('window.__requests = []; true');
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await press(chrome, "[...document.querySelectorAll('#roadmap .milestone-item.blocked')].find((row) => row.querySelector('.id').textContent === 'blocked-roadmap-other#2')");
    await chrome.waitFor("document.querySelector('#roadmap .milestone-why:not([hidden])')");
    const marker = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const row = [...document.querySelectorAll('#roadmap .milestone-item.blocked')].find((entry) => entry.querySelector('.id').textContent === 'blocked-roadmap-other#2');
      const text = row.querySelector('.t').getBoundingClientRect(), dot = row.querySelector('.block-dot').getBoundingClientRect();
      return { visible: dot.width > 0 && dot.left >= text.left && dot.right <= text.right };
    })())`));
    assert.equal(marker.visible, true, 'the remote blocker dot stays visible when its long title is clipped on a phone');
    const remote = Object.fromEntries((await read()).map((row) => [row.id, row]))['blocked-roadmap-other#2'];
    assert.match(remote.why, /state.*open, nobody holds it/, 'the remote item has no current holder');
    assert.match(remote.why, /waits on#1 open/, 'the remote dependency has its own state');
    assert.match(remote.why, /lane heldweb: Review the remote dependency/, 'the remote lane hold keeps its reason');
    assert.match(remote.why, /sent backRemote latest finding/, 'the remote send-back note keeps its first line');
    assert.doesNotMatch(remote.why, /More detail stays in Items/, 'the expansion stays compact');
    const remoteRequests = JSON.parse(await chrome.stable('JSON.stringify(window.__requests)'));
    assert.deepEqual(remoteRequests.filter((url) => /\/items\/\d/.test(url)), [], 'remote expansion also needs no detail request');
    await press(chrome, "document.querySelector('#roadmap .milestone-why:not([hidden]) a.ref')");
    await chrome.waitFor("!document.querySelector('[data-pane=items]').hidden && document.querySelector('#detail h2')?.textContent.includes('Remote sent-back work')");
    assert.equal(await chrome.stable("document.querySelector('#proj-name').textContent"), 'blocked-roadmap-other',
      'the link opens the remote item, even though the local board has the same item id');
    assert.deepEqual(chrome.exceptions, [], 'the blocked roadmap raises no uncaught page exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
