/**
 * Refuse a check whose pipeline would hide a red proof's exit status [C7,V4]. Kept out of board.js,
 * which is already over the 1500-line cap (C9).
 */
import { Refused } from './refused.js';

/**
 * Keep only the check's top-level shell code, blanking everything inside quotes and $( ) substitutions while
 * keeping each offset. A $( ) inside double quotes opens its own code context, so "$(printf '%s' "$out" | grep x)"
 * stays one quoted word; a plain ( ) subshell is top-level code, since it exits with its last stage [C7,V4].
 *
 * @param {string} command
 * @returns {string}
 */
function topLevel(command) {
  const stack = ['code'];
  let out = '';
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const context = stack.at(-1);
    const top = stack.length === 1;
    if (context === "'") {
      if (char === "'") stack.pop();
      out += ' ';
    } else if (char === '\\') {
      out += i + 1 < command.length ? '  ' : ' ';
      i++;
    } else if (context === '"') {
      if (char === '"') stack.pop();
      else if (char === '$' && command[i + 1] === '(') { stack.push('$('); out += ' '; i++; }
      out += ' ';
    } else if (char === "'" || char === '"') { stack.push(char); out += top ? char : ' '; }
    else if (char === '$' && command[i + 1] === '(') { stack.push('$('); out += top ? '$(' : '  '; i++; }
    else if (char === '(' && context === '$(') { stack.push('$('); out += ' '; }
    else if (char === ')' && context === '$(') { stack.pop(); out += stack.length === 1 ? ')' : ' '; }
    else out += top ? char : ' ';
  }
  return out;
}

/**
 * Split a check into its pipelines at ;, &&, ||, &, newlines and ( ) group edges in its top-level code; pipes inside
 * quotes or a $( ) substitution are not the check's own [C7,V4].
 *
 * @param {string} command
 * @returns {{ start: number, end: number, pipes: number[] }[]}
 */
function pipelines(command) {
  const shell = topLevel(command);
  const found = [];
  let current = { start: 0, pipes: [] };
  const cut = (at, next) => { found.push({ ...current, end: at }); current = { start: next, pipes: [] }; };
  for (let i = 0; i < shell.length; i++) {
    const char = shell[i];
    if (char === '$' && shell[i + 1] === '(') { i = shell.indexOf(')', i); if (i < 0) break; }
    else if (char === '(' || char === ')') cut(i, i + 1);
    else if (char === '|' && shell[i + 1] === '|') { cut(i, i + 2); i++; }
    else if (char === '&' && shell[i + 1] === '&') { cut(i, i + 2); i++; }
    else if (char === '|') current.pipes.push(i);
    else if ((char === '&' && shell[i - 1] !== '>' && shell[i + 1] !== '>') || char === ';' || char === '\n') cut(i, i + 1);
  }
  cut(shell.length, shell.length);
  return found;
}

/**
 * Name the final stage of the first pipeline that would hide a check's exit status, or null when none does. A
 * pipeline is exempt only when the check sets pipefail as a real command (set -o pipefail or set -euo pipefail), or
 * when its first stage prints a value captured earlier with NAME=$(...), the out=$(...) form this board uses; an
 * untested capture excuses nothing [C7,V4].
 *
 * @param {string} command
 * @returns {string | null}
 */
function maskingStage(command) {
  if (/(?:^|[;&(\n])\s*set\s+(?:-\S+\s+)*-\S*o\s+pipefail\b/u.test(topLevel(command))) return null;
  const captured = new Set();
  for (const pipeline of pipelines(command)) {
    const text = command.slice(pipeline.start, pipeline.end);
    const assignment = /^\s*(\w+)="?\$\(/u.exec(text);
    if (assignment) captured.add(assignment[1]);
    if (!pipeline.pipes.length) continue;
    const first = command.slice(pipeline.start, pipeline.pipes[0]);
    const tested = /^\s*(?:printf|echo)\b/u.test(first)
      && [...first.matchAll(/\$\{?(\w+)\}?/gu)].some((match) => captured.has(match[1]));
    if (tested) continue;
    return /^\s*([^\s;&|)]+)/u.exec(command.slice(pipeline.pipes.at(-1) + 1))?.[1] ?? 'a later stage';
  }
  return null;
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
