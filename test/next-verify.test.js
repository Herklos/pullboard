/** A reviewer who starts before the builder submits is told the builder is still working [C7,P4]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { main } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { runFixtureGit } from './fixture-child.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const HOUR = 3_600_000;

/** Run the actual CLI in one worktree with the fixture's board clock. */
async function run(box, cwd, args) {
  let stdout = '';
  let stderr = '';
  const code = await main(args, { cwd, clock: box.clock,
    stdout: { isTTY: false, write: (part) => { stdout += part; } },
    stderr: { write: (part) => { stderr += part; } } });
  return { code, stdout, stderr };
}

/** A real repo with a builder and a reviewer worktree, each joined to the board. */
async function project(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-next-verify-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  const bin = join(dir, 'bin');
  mkdirSync(root); mkdirSync(bin);
  // The repo's hooks call pullboard; this private shim runs this checkout's CLI for them.
  /** Quote a literal path for the shim's shell line. */
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  Object.assign(env, { PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Verify fixture', GIT_AUTHOR_EMAIL: 'verify@example.invalid',
    GIT_COMMITTER_NAME: 'Verify fixture', GIT_COMMITTER_EMAIL: 'verify@example.invalid' });
  /** Git in the fixture, with a synthetic identity and no inherited GIT_* variables. */
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env, stdio: 'pipe', encoding: 'utf8' });
  let at = Date.parse('2026-10-17T12:00:00.000Z');
  const clock = { now: () => new Date(at) };
  const box = { root, clock };
  git(root, 'init', '-q', '-b', 'main');
  const initialized = await run(box, root, ['init']);
  assert.equal(initialized.code, 0, initialized.stderr);
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true',
    lanes: { web: { owns: ['web/'], specs: ['G1'] }, review: { owns: [], specs: ['G1'] } }, shared: [] }));
  writeFileSync(join(root, 'SPEC.md'), '# Verify fixture\n## G\n- G1 [approved, must] Every move keeps its evidence. | gate: true\n');
  writeFileSync(join(root, loadConfig(root).practice), '');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'chore: initialize verify fixture');
  box.builder = join(dir, 'builder'); box.reviewer = join(dir, 'reviewer');
  git(root, 'worktree', 'add', '-q', box.builder, '-b', 'web/one');
  git(root, 'worktree', 'add', '-q', box.reviewer, '-b', 'review/one');
  box.board = store.openBoard(join(root, '.git', 'pullboard', 'board.sqlite'), clock);
  t.after(() => store.closeBoard(box.board));
  box.builderId = store.register(box.board, { lane: 'web', path: box.builder });
  box.reviewerId = store.register(box.board, { lane: 'review', path: box.reviewer });
  return box;
}

/** File an item and have the builder claim it, with a frozen criterion as a real claim has. */
function claimed(box) {
  const id = store.addItem(box.board, { by: 'coordinator', lane: 'web', title: 'Being built', specs: 'G1', criterion: 'The move keeps evidence.', check: 'true' });
  const text = JSON.stringify({ rows: [{ id: 'G1', text: 'Every move keeps its evidence.', gate: 'true' }] });
  store.claim(box.board, id, { agentId: box.builderId, lane: 'web', leaseMs: HOUR,
    freeze: () => ({ text, digest: createHash('sha256').update(text).digest('hex') }) });
  return id;
}

test('[C7,P4] next --verify with nothing submitted yet says the builder is still working', async (t) => {
  const box = await project(t);
  const id = claimed(box);
  const early = await run(box, box.reviewer, ['next', '--verify']);
  assert.equal(early.code, 1, 'nothing is reserved, so the command still exits 1');
  const said = early.stdout + early.stderr;
  assert.match(said, new RegExp(`nothing to review yet; the builder is still working on #${id}`, 'u'));
  assert.match(said, /pullboard watch/u, 'the next step names pullboard watch');
  assert.match(said, /check back: pullboard next --verify/u, 'or check back with the same command');
  assert.doesNotMatch(said, /NOTHING_FREE/u, 'no NOTHING_FREE when work is in progress');
  assert.equal(store.getItem(box.board, id).item_review_by, null, 'nothing is reserved');

  store.submit(box.board, id, { agentId: box.builderId, commit: String(id).padStart(40, 'a'), tree: String(id).padStart(40, 'b') });
  const ready = await run(box, box.reviewer, ['next', '--verify']);
  assert.equal(ready.code, 0, ready.stderr);
  assert.match(ready.stdout, new RegExp(`next to verify: #${id} Being built`, 'u'));
  assert.equal(store.getItem(box.board, id).item_review_by, box.reviewerId, 'a submitted item is reserved as before');
});
