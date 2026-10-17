/** Name a board this process cannot write, such as one inside a read-only agent sandbox [I1,P4]. */
import { dirname } from 'node:path';
import { Refused } from './refused.js';

/**
 * Turn SQLite's bare readonly or cannot-open error, or a file-system access error, into a named
 * refusal that says which folder to open up; any other error comes back unchanged.
 * Why: an agent shown the raw readonly-database trace tends to read board.sqlite directly instead
 * (blueprint trial, #738), so the refusal names the folder and the access that gets past it.
 *
 * @param {string} file the board file
 * @param {Error & { errcode?: number, code?: string }} error
 * @returns {Error}
 */
export function boardNotWritable(file, error) {
  const sqliteCode = Number.isInteger(error?.errcode) ? error.errcode & 0xff : null;
  if (sqliteCode !== 8 && sqliteCode !== 14 && !['EACCES', 'EPERM', 'EROFS'].includes(error?.code ?? '')) return error;
  return new Refused('BOARD_NOT_WRITABLE',
    `Cannot write the board in "${dirname(file)}". Give the agent write access to that folder, the repo's .git/pullboard, or run the command outside the sandbox.`);
}
