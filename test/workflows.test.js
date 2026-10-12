/** Check that main CI shards work without hiding failures or cancelling unrelated runs [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW = readFileSync(resolve(ROOT, '.github/workflows/gate.yml'), 'utf8');

/** Return the named workflow job's block so assertions apply to each job independently. */
function job(name) {
  const start = WORKFLOW.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `the workflow has a ${name} job`);
  const rest = WORKFLOW.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/u);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** Check that one runner job builds every shard for both supported Node versions. */
function checkRunner(name, system, shardList, total) {
  const text = job(name);
  assert.ok(text.includes(`\n    runs-on: ${system}\n`), `${name} uses ${system}`);
  assert.match(text, /\n {8}node: \['22\.13', '24'\]\n/u, `${name} covers both Node versions`);
  assert.ok(text.includes(`\n        shard: [${shardList}]\n`), `${name} declares shards ${shardList}`);
  assert.ok(text.includes(`\n        shards: [${total}]\n`), `${name} declares the shard count`);
  assert.ok(text.includes(`\n    name: ${name} (\${{ matrix.node }}) \${{ matrix.shard }}/\${{ matrix.shards }}\n`),
    `${name} job names show OS, Node and shard`);
  const specChecks = [...text.matchAll(/\n {6}- run: node bin\/pullboard\.js spec check(?=\n)/gu)];
  assert.equal(specChecks.length, 1, `${name} runs spec check exactly once in every matrix job`);
  assert.ok(text.includes('npm test -- --shard=${{ matrix.shard }}/${{ matrix.shards }}'),
    `${name} passes the native shard to the test runner`);
  assert.match(text, /\n {6}- uses: actions\/checkout@v4\n {8}with:\n {10}fetch-depth: 0\n/u,
    `${name} retains full history for spec check`);
  assert.match(text, /\n {4}strategy:\n {6}fail-fast: false\n/u, `${name} lets every shard report failures`);
}

/** Verify shard coverage, per-job checks, names, and cancellation scope from the checked-in workflow. */
function workflowShardsAndCancellation() {
  assert.match(WORKFLOW, /\non:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n {2}workflow_dispatch:\n/u,
    'the gate still runs for main pushes, pull requests and manual runs');
  checkRunner('linux', 'ubuntu-latest', '1, 2, 3', 3);
  checkRunner('macos', 'macos-latest', '1, 2', 2);
  assert.match(job('macos'), /\n {4}if: \$\{\{ !github\.event\.repository\.private \}\}\n/u,
    'macOS runs when the repository is public');
  assert.match(WORKFLOW,
    /\nconcurrency:\n {2}group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && github\.ref \|\| github\.run_id \}\}\n/u,
    'main pushes share their ref group while PR and manual runs get unique groups');
  assert.match(WORKFLOW,
    /\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' \}\}\n/u,
    'only a push to main cancels an in-progress run');
}

test('the gate workflow shards and cancels superseded main runs [C7]', workflowShardsAndCancellation);
