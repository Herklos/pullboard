/** The pullboard submit command, in its own module so an item adding another command never edits these lines. */
import {
  context,
  idArg,
  submitHere,
} from '../cli.js';

/** Run `pullboard submit` and return its exit code. */
export async function run(io, { first, values }) {
  return submitHere(context(io), idArg(first), values.infra);
}
