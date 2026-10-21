/** The pullboard next command, in its own module so an item adding another command never edits these lines. */
import {
  nextHere,
} from '../cli.js';

/** Run `pullboard next` and return its exit code. */
export function run(io, { first, values }) {
  return nextHere(io, { ...values, verifyId: first });
}
