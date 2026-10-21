/** The pullboard serve command, in its own module so an item adding another command never edits these lines. */
import {
  serveHere,
} from '../cli.js';

/** Run `pullboard serve` and return its exit code. */
export async function run(io, { values }) {
  return await serveHere(io, values);
}
