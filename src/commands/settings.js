/** The pullboard settings command, in its own module so an item adding another command never edits these lines. */
import {
  settingsCommand,
} from '../cli.js';

/** Run `pullboard settings` and return its exit code. */
export function run(io, args) {
  return settingsCommand(io, args);
}
