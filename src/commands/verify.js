/** The pullboard verify command, in its own module so an item adding another command never edits these lines. */
import {
  context,
  idArg,
  verifyHere,
} from '../cli.js';

/** Run `pullboard verify` and return its exit code. */
export function run(io, args) {
  const { first } = args;
  return verifyHere(context(io), idArg(first), args);
}
