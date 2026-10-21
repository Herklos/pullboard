/** The pullboard runner command, in its own module so an item adding another command never edits these lines. */
import {
  runnerCommand,
} from '../cli.js';

/** Run `pullboard runner` and return its exit code. */
export function run(io, args) {
  return runnerCommand(io, args);
}
