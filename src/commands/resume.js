/** The pullboard resume command, in its own module so an item adding another command never edits these lines. */
import {
  keepViewRunning,
} from '../background-view.js';
import {
  repoInfo,
} from '../git.js';
import {
  resumeHere,
} from '../cli.js';

/** Run `pullboard resume` and return its exit code. */
export async function run(io) {
  repoInfo(io.cwd);
  return resumeHere(io, await keepViewRunning());
}
