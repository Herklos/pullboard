/** The pullboard spec command, in its own module so an item adding another command never edits these lines. */
import {
  specCommand,
} from '../cli.js';

/** Run `pullboard spec` and return its exit code. */
export async function run(io, args) {
  return await specCommand(io, args);
}
