/** A doctrine rule can carry a check whose count only falls, held at submit [D1,D3]. */
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { project } = e2e;

const RULE = '- Q1 [approved, must] Web pages carry no TODO markers. | gate: check grep -rn TODO web';

/**
 * A project whose doctrine has one check rule with the given trailing fields, two problems on
 * main, a web worktree that carries main, and a claimed web item.
 */
function checkedProject(fields, extraRows = []) {
  const box = project();
  appendFileSync(join(box.repo, 'DOCTRINE.md'), `\n## Q · Quality\n${[`${RULE} | ${fields}`, ...extraRows].join('\n')}\n`);
  mkdirSync(join(box.repo, 'web'));
  writeFileSync(join(box.repo, 'web', 'a.html'), 'TODO one\nTODO two\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: add the quality doctrine');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  assert.equal(box.run(box.repo, 'add', 'web', 'Page', '--specs', 'G1').code, 0);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  return box;
}

/** Write web files in the worktree and commit them through its hooks. */
function commitWeb(box, files, message) {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(box.web, 'web', name), text);
  box.git(box.web, 'add', '-A');
  const committed = box.tryGit(box.web, 'commit', '-q', '-m', message);
  assert.equal(committed.status, 0, `${committed.stdout}${committed.stderr}`);
}

/** Replace the rule's committed fields on main and try to commit them through the hooks. */
function editRule(box, from, to) {
  const file = join(box.repo, 'DOCTRINE.md');
  const before = readFileSync(file, 'utf8');
  assert.ok(before.includes(from), `the doctrine holds ${from}`);
  writeFileSync(file, before.replace(from, to));
  box.git(box.repo, 'add', 'DOCTRINE.md');
  return box.tryGit(box.repo, 'commit', '-q', '-m', 'chore: change the quality count');
}

test("a doctrine rule's check holds its count [D1,D3]", () => {
  const box = checkedProject('count: 2');

  // A rise above the committed count is refused, naming the rule, the counts and the new line.
  commitWeb(box, { 'b.html': 'TODO three\n' }, 'feat(web): add a page [G1]');
  const rose = box.run(box.web, 'submit', '1');
  assert.equal(rose.code, 1, rose.out);
  assert.match(rose.err, /RATCHET_ROSE/);
  assert.match(rose.err, /Q1 Web pages carry no TODO markers\. rose to 3, was 2/);
  assert.match(rose.err, /web\/b\.html:1:TODO three/);
  assert.doesNotMatch(rose.err, /web\/a\.html:1:TODO one/, 'only the new problem lines are named');

  // A changed file that gains a problem is refused even when the total falls.
  commitWeb(box, { 'a.html': 'done\n' }, 'feat(web): clear the old markers [G1]');
  const gained = box.run(box.web, 'submit', '1');
  assert.equal(gained.code, 1, gained.out);
  assert.match(gained.err, /RATCHET_ROSE/);
  assert.match(gained.err, /web\/b\.html gains 1 problem/);
  assert.match(gained.err, /web\/b\.html:1:TODO three/);

  // A fall passes and is shown as N, was M.
  commitWeb(box, { 'a.html': 'TODO two\n', 'b.html': 'done\n' }, 'feat(web): finish the page [G1]');
  const fell = box.run(box.web, 'submit', '1');
  assert.equal(fell.code, 0, fell.err);
  assert.match(fell.out, /Q1 Web pages carry no TODO markers\. · 1, was 2 · holding/);
  const report = box.run(box.web, 'doctrine', 'check');
  assert.equal(report.code, 0, report.err);
  assert.equal(report.out.trim(), 'Q1 Web pages carry no TODO markers. · 1, was 2 · holding');
  const json = JSON.parse(box.run(box.web, 'doctrine', 'check', '--json').out);
  assert.deepEqual(json.rules.map(({ id, count, committed, holds }) => ({ id, count, committed, holds })),
    [{ id: 'Q1', count: 1, committed: 2, holds: true }]);
  assert.deepEqual(json.rules[0].problems, ['web/a.html:1:TODO two']);

  // Raising count: needs the person's signature; lowering it is a normal commit.
  const raised = editRule(box, 'count: 2', 'count: 3');
  assert.notEqual(raised.status, 0, 'an unsigned raise is refused');
  assert.match(raised.stderr, /Q1 raises count: from 2 to 3 without the person's signature/);
  const lowered = editRule(box, 'count: 3', 'count: 1');
  assert.equal(lowered.status, 0, `${lowered.stdout}${lowered.stderr}`);
  writeFileSync(join(box.repo, 'DOCTRINE.md'), readFileSync(join(box.repo, 'DOCTRINE.md'), 'utf8').replace('count: 1', 'count: 4'));
  const approved = box.run(box.repo, 'spec', 'approve', 'doctrine:Q1');
  assert.equal(approved.code, 0, approved.err);
  box.git(box.repo, 'add', 'DOCTRINE.md');
  const signed = box.tryGit(box.repo, 'commit', '-q', '-m', 'chore: the person raises the quality count');
  assert.equal(signed.status, 0, `a raise the person approved commits: ${signed.stdout}${signed.stderr}`);
});

test("a doctrine rule's check holds its count in watch mode and nightly [D1,D3]", () => {
  const box = checkedProject('count: 0 | mode: watch',
    ['- Q2 [approved, must] Web pages stay TODO-free overnight. | gate: check grep -rn TODO web | count: 3 | runs: nightly']);
  commitWeb(box, { 'b.html': 'TODO three\n' }, 'feat(web): add a page [G1]');
  const watched = box.run(box.web, 'submit', '1');
  assert.equal(watched.code, 0, watched.err);
  assert.match(watched.out, /Q1 Web pages carry no TODO markers\. · 3, was 0 · watching/);
  assert.doesNotMatch(watched.out, /Q2/, 'a nightly rule does not run at submit');
  const report = box.run(box.web, 'doctrine', 'check');
  assert.equal(report.code, 0, 'a watched rule never fails doctrine check');
  assert.match(report.out, /^Q1 Web pages carry no TODO markers\. · 3, was 0 · watching$/m);
  assert.match(report.out, /^Q2 Web pages stay TODO-free overnight\. · 3, was 3 · holding$/m, 'doctrine check runs the nightly rule');

  // doctrine check reports a rule that rose and exits 1, with no submit involved.
  commitWeb(box, { 'c.html': 'TODO four\n' }, 'feat(web): add another page [G1]');
  const rose = box.run(box.web, 'doctrine', 'check');
  assert.equal(rose.code, 1, 'a rule that rose fails doctrine check');
  assert.match(rose.out, /^Q2 Web pages stay TODO-free overnight\. · 4, was 3 · rose$/m);
});
