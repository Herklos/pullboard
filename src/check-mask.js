/**
 * Refuse a check whose pipeline would hide a red proof's exit status [C7,V4]. Kept out of board.js,
 * which is already over the 1500-line cap (C9).
 */
import { Refused } from './refused.js';

/**
 * Blank out the text inside quotes, keeping its length and the quote marks, so a pipe, a word or
 * the pipefail option inside quotes is never read as shell syntax [C7,V4].
 *
 * @param {string} command
 * @returns {string}
 */
function unquoted(command) {
  let out = '';
  let quote = null;
  for (const char of command) {
    if (quote) {
      if (char === quote) { quote = null; out += char; } else out += ' ';
    } else if (char === '"' || char === "'") { quote = char; out += char; } else out += char;
  }
  return out;
}

/**
 * Name the final pipeline stage that would hide a check's exit status, or null when none does. Any
 * top-level pipe is masking unless the check sets pipefail as a real command (set -o pipefail or
 * set -euo pipefail) or captures its proof first with out=$(...), the approved forms [C7,V4]. Pipes
 * inside $( ) and || are not pipelines.
 *
 * @param {string} command
 * @returns {string | null}
 */
function maskingStage(command) {
  const shell = unquoted(command);
  if (/(?:^|[\s;&(])\w+=\$\(/u.test(shell)) return null;
  if (/(?:^|[;&(\n])\s*set\s+(?:-\S+\s+)*-\S*o\s+pipefail\b/u.test(shell)) return null;
  let depth = 0;
  let lastPipe = -1;
  for (let i = 0; i < shell.length; i++) {
    const char = shell[i];
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === '|' && shell[i + 1] === '|') i++;
    else if (char === '|' && depth === 0) lastPipe = i;
  }
  if (lastPipe < 0) return null;
  return /^\s*([^\s;&|)]+)/u.exec(command.slice(lastPipe + 1))?.[1] ?? 'a later stage';
}

/**
 * Refuse a check whose pipeline would hide a red proof, naming the fix (CHECK_MASKS_EXIT) [C7,V4].
 * Without the refusal the board records a failing command as passed.
 *
 * @param {string} check
 */
export function refuseMaskedExit(check) {
  const stage = maskingStage(check ?? '');
  if (stage === null) return;
  throw new Refused('CHECK_MASKS_EXIT', `the check pipes its proof into ${stage}, so a failing proof still exits 0; set pipefail (set -o pipefail), run the proof alone, or capture the output first and test it: out=$(<proof>); printf '%s\\n' "$out" | grep -Eq '<expected>'`);
}
