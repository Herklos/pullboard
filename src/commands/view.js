/** The pullboard view command, in its own module so an item adding another command never edits these lines. */
import {
  viewHere,
} from '../cli.js';

/** Run `pullboard view` and return its exit code. */
export async function run(io, { values }) {
  return await viewHere(io, values);
}
