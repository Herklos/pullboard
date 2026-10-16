/** One person-facing obligation builder across sessions and transports [N26,A9]. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { main } from '../src/cli.js';
import { serveMcp } from '../src/mcp.js';
import { createE2eHelpers } from './e2e-helpers.js';

test('one builder lists what needs the person [N26,A9]', async (t) => {
  const source = new URL('../src/needs.js', import.meta.url);
  assert.ok(existsSync(source), 'the shared personNeeds builder exists');
  const { personNeeds } = await import(source.href);
  assert.equal(typeof personNeeds, 'function');
  assert.doesNotMatch(readFileSync(source, 'utf8'), /^\s*import\b/mu, 'the browser builder has no imports');
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const spec = readFileSync(join(box.repo, 'SPEC.md'), 'utf8') + `
- G3 [pending, aim] Which storage backend?
- G4 [pending, aim] Keep the decided backend.
- G5 [pending, aim] Do not resurrect the declined proposal.
- G6 [draft, aim] Review the proposed retry policy.
`;
  writeFileSync(join(box.repo, 'SPEC.md'), spec);
  box.git(box.repo, 'add', 'SPEC.md');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: describe person needs fixture');
  // Copy only the fixture spec into its agent worktree; every decision stays on the shared real board.
  writeFileSync(join(box.web, 'SPEC.md'), spec);
  for (const args of [
    ['spec', 'approve', 'G4'],
    ['spec', 'decline', 'G5', '--reason', 'The person rejected this design.'],
    ['shout', 'person', 'Which public interface should we keep?', '--decision'],
    ['hold', 'web', '--reason', 'Await the interface decision.'],
  ]) {
    const result = box.run(box.repo, ...args);
    assert.equal(result.code, 0, result.err || result.out);
  }
  // A real resume reads the same pending, unapplied decisions as the MCP tool.
  const resumed = box.run(box.repo, 'resume', '--json');
  assert.equal(resumed.code, 0, resumed.err || resumed.out);
  const card = JSON.parse(resumed.out);
  assert.ok(Array.isArray(card.needsYou), 'resume exposes the shared person needs list');
  const expected = card.needsYou;
  assert.deepEqual(expected.map(need => need.kind).sort(), ['decision', 'draft', 'hold', 'pending']);
  assert.equal(expected.find(need => need.kind === 'pending').id, 'G3');
  assert.equal(expected.find(need => need.kind === 'draft').count, 1);
  assert.equal(expected.find(need => need.kind === 'hold').id, 'web');
  assert.equal(expected.find(need => need.kind === 'decision').text, 'Which public interface should we keep?');
  assert.ok(!expected.some(need => ['G4', 'G5'].includes(need.id)), 'approved and declined unapplied rows stay out');
  const { personNeedsState } = await import('../src/needs-state.js');
  const state = personNeedsState(box.repo);
  assert.deepEqual(personNeeds(state), expected);
  const before = JSON.stringify(state);
  const browserBuilder = runInNewContext(`(${personNeeds.toString()})`);
  assert.deepEqual(JSON.parse(JSON.stringify(browserBuilder(state))), expected,
    'the standalone source evaluates in an empty VM with no closure or imports');
  assert.equal(JSON.stringify(state), before, 'the builder changes no input');
  assert.deepEqual(personNeeds({}), [], 'an empty projection has no obligations');
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'board_status', arguments: {} } };
  let output = '';
  let diagnostics = '';
  const status = await serveMcp({ cwd: box.repo, input: Readable.from([JSON.stringify(request) + '\n']),
    output: { write: text => { output += text; } }, log: { write: text => { diagnostics += text; } }, runCommand: main });
  assert.equal(status, 0, diagnostics);
  const reply = JSON.parse(output);
  assert.equal(reply.result?.isError, false, JSON.stringify(reply));
  assert.deepEqual(reply.result.structuredContent.needsYou, expected, 'MCP uses the same complete list');
});
