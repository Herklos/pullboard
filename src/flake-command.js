/** Read durable observations or opt this board into one diagnostic pair, never into retry acceptance [C7,H16]. */
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILE } from './config.js';
import { flakeLedger } from './flakes.js';
import { Refused } from './refused.js';

/** List actual flake sightings separately from unknown failures and candidate regressions. */
export function flakesCommand(ctx, { first, second, rest }, withBoard) {
  if (first === 'rerun' && ['on', 'off'].includes(second) && !rest.length) {
    if (!ctx.info.isMain) throw new Refused('NOT_MAIN', 'only the coordinator sets this board’s diagnostic policy; ask it to run pullboard flakes rerun on or off');
    const file = join(ctx.info.root, CONFIG_FILE);
    const config = JSON.parse(readFileSync(file, 'utf8'));
    config.flakes = { rerun: second === 'on' };
    writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
    ctx.io.result?.({ flakes: config.flakes, file: CONFIG_FILE });
    ctx.io.say(`paired flake diagnostics ${second}; commit ${CONFIG_FILE} to apply this board policy. The original red remains red.`);
    return 0;
  }
  if (first || second || rest.length) throw new Refused('USAGE', 'pullboard flakes lists observations; pullboard flakes rerun on|off sets the coordinator’s opt-in policy');
  return withBoard(ctx, board => {
    const rows = flakeLedger(board);
    const flakes = rows.filter(row => row.count > 0);
    const unclassified = rows.filter(row => row.count === 0 && row.classification === 'unclassified');
    const regressions = rows.filter(row => row.count === 0 && row.classification === 'possible-regression');
    const stable = rows.filter(row => row.count === 0 && row.classification === 'stable-red');
    ctx.io.result?.({ flakes, unclassified, regressions, stable });
    for (const row of rows) ctx.io.say(`${row.status}: ${row.file ?? '(unclassified gate)'}${row.name ? ' :: ' + row.name : ''}; count ${row.count}; first ${row.firstSeen}; last ${row.lastSeen}${row.item ? '; repair #' + row.item : ''}`);
    if (!rows.length) ctx.io.say('no recorded test failures; paired diagnostics are off unless this board opts in with pullboard flakes rerun on');
    return 0;
  });
}
