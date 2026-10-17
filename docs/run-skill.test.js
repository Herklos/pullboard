/** The run skill tells coordinators to surface measured bottlenecks to the person [N31]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const skill = readFileSync(new URL('../skills/pullboard-run/SKILL.md', import.meta.url), 'utf8');

test('the run skill tells the person about bottlenecks [N31]', () => {
  assert.match(skill, /every coordinator cycle, check the flow/u, 'each coordinator cycle starts by checking flow');
  assert.match(skill, /`flow:` line in `pullboard resume`, or from `pullboard stats --json`/u,
    'the instruction names both supported flow sources');
  assert.match(skill, /`pullboard shout person "\.\.\."` to tell the person in one plain sentence/u,
    'a named bottleneck is sent to the person in one sentence');
  assert.match(skill, /what is slow, the reported numbers, and the action that would fix it/u,
    'the sentence names the delay, its numbers, and the remedy');
  assert.match(skill, /Use the reported values and recommendation; do not calculate new numbers/u,
    'the coordinator reports existing measurements without inventing them');
  assert.match(skill, /Ask for a decision only when the fix needs the person's choice or authorization/u,
    'a decision is requested only when a person must choose or authorize the fix');
});

test('the run skill reopens a red batch culprit only after a paired control proves it [I1]', () => {
  const start = skill.indexOf('\n## Land in batches\n');
  assert.notEqual(start, -1, 'the run skill has a Land in batches section');
  const end = skill.indexOf('\n## ', start + 1);
  const land = skill.slice(start, end < 0 ? skill.length : end).replace(/\s+/gu, ' ');
  const rule = land.indexOf('A red batch reopens only the item a paired control proves.');
  assert.notEqual(rule, -1, 'the rule names the paired control as the only proof that reopens a culprit');
  assert.match(land, /run the same failing test or command twice: once on the control, which is main or the batch without the candidate, and once on the candidate/u,
    'the pair runs one command on a control without the candidate and on the candidate');
  assert.match(land, /The control must pass and the candidate must reproduce the red\./u, 'a proof needs a green control and a red candidate');
  assert.match(land, /Keep both commands, both commits and both outputs as the evidence/u, 'the exact evidence is kept');
  assert.match(land, /When the pair does not prove it, keep the candidate held with `pullboard hold <id> "[^"]+"` and leave it unreopened/u,
    'an unproven culprit stays held');
  const reopen = land.indexOf('pullboard reopen <id>');
  assert.ok(reopen > rule, 'the paired control comes before the reopen it authorizes');
});
