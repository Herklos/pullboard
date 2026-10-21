/** The pullboard publish command, in its own module so an item adding another command never edits these lines. */
import { publishTrunk } from '../publish.js';
import { COORDINATOR } from '../config.js';
import { mainPolicy } from '../trusted-policy.js';
import { Refused } from '../refused.js';
import {
  actOn,
  gateWaitReporter,
} from '../cli.js';

/** Run `pullboard publish` and return its exit code. */
export async function run(io, { first, second, rest }) {
  return actOn(io, async (ctx, board, me) => {
    if (me.id !== COORDINATOR || !ctx.info.isMain) throw new Refused('COORDINATOR_ONLY', 'only the coordinator publishes the trunk; ask your coordinator to run pullboard publish');
    if (first || second || rest.length) throw new Refused('USAGE', 'pullboard publish');
    const result = await publishTrunk({ root: ctx.info.root, board, config: mainPolicy(ctx.info.root).config, say: io.say, onWait: gateWaitReporter(io) });
    io.result?.(result);
    return result.published || result.waiting ? 0 : 1;
  });
}
