/** The pullboard takeover command, in its own module so an item adding another command never edits these lines. */
import {
  context,
  ordered,
  whoAmI,
  withBoard,
} from '../cli.js';
import { COORDINATOR } from '../config.js';
import { relayLinked } from '../relay.js';
import { relayMachineContext } from '../relay.js';

/**
 * Run `pullboard takeover` and return its exit code. In an agent worktree it rebinds the checkout to this agent
 * session. In the main checkout of a linked board it also takes the board's coordinator for this checkout, as an
 * ordered move, so another machine's or person's main checkout stops acting as coordinator (#347).
 */
export async function run(io) {
  const ctx = context(io);
  const me = withBoard(ctx, (board) => whoAmI(ctx, board));
  if (ctx.info.isMain && relayLinked(ctx.info.root)) {
    const machine = relayMachineContext(ctx.info.root)?.machine;
    const taken = await withBoard(ctx, (board) => ordered(ctx, board, 'takeCoordinator', [{ agentId: COORDINATOR, ...(typeof machine === 'string' ? { machine } : {}) }]));
    io.result?.({ agent: me.id, path: ctx.info.root, coordinator: taken.holder, previous: taken.previous });
    io.say(`${me.displayName} now coordinates this board from ${taken.holder}${taken.previous && taken.previous !== taken.holder ? `, taking over from ${taken.previous}` : ''}`);
    return 0;
  }
  io.result?.({ agent: me.id, path: ctx.info.root });
  io.say(`${me.displayName} took over this checkout for the current agent session`);
  return 0;
}
