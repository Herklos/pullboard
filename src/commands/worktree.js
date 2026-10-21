/** The pullboard worktree command, in its own module so an item adding another command never edits these lines. */
import {
  worktreeFor,
} from '../cli.js';

/** Run `pullboard worktree` and return its exit code. */
export function run(io, { first, values }) {
  return worktreeFor(io, first, values.route ?? 'strong', values.family ?? null, values.model);
}
