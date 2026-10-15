/** The shipped view port and its optional per-process override [N26]. */
import { Refused } from './refused.js';

export const DEFAULT_VIEW_PORT = 4890;

/** Resolve an omitted --port; explicit command-line ports take precedence over this setting. */
export function defaultViewPort(env = process.env) {
  const value = env.PULLBOARD_VIEW_PORT;
  if (value === undefined) return DEFAULT_VIEW_PORT;
  if (!/^\d+$/u.test(value) || Number(value) > 65535) {
    throw new Refused('USAGE', 'PULLBOARD_VIEW_PORT is a number from 0 to 65535; unset it to use the default port');
  }
  return Number(value);
}
