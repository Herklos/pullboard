/** The pullboard hook command, in its own module so an item adding another command never edits these lines. */
import {
  hookCommand,
} from '../cli.js';

/** Run `pullboard hook` and return its exit code. */
export async function run(io, args) {
  return await hookCommand(io, args);
}
