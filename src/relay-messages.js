/**
 * The relay's bounded, credential-free wording (H1, H10): how a request failed before any answer, why a
 * baseline upload or checkpoint paused, and the safe next step. Pure text, so the relay client and
 * the CLI print the same lines without either holding a link or a credential.
 */
import { Refused } from './refused.js';

/**
 * Name how a relay request failed before any response, from the error's own fields only.
 * Why: a bare "did not answer" hid whether a request timed out, was refused or lost its socket,
 * so load-dependent relay failures could not be attributed (#512).
 */
export function transportFailure(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timed out';
  const code = error?.cause?.code ?? error?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/u.test(code) ? code : 'no connection';
}

/** Format a shared status line for an oversized sealed snapshot. */
export function formatSnapshotLimit(problem, { paused = false } = {}) {
  const size = `${(problem.sealedBytes / 1_000_000).toFixed(1)} MB`;
  const limit = `${(problem.limit / 1_000_000).toFixed(1)} MB`;
  if (paused) return `relay paused for ${problem.board}: snapshot ${size} over the relay limit ${limit}; it resumes on its own once a snapshot fits`;
  return `relay snapshot for ${problem.board}: sealed snapshot ${size} over the relay limit ${limit}`;
}

/** Keep a permanent refusal only as a bounded, credential-free diagnostic. */
export function safePauseMessage(error) {
  const message = String(error.relayMessage ?? error.message ?? 'the relay refused the baseline upload')
    .replace(/https?:\/\/[^\s]+/gu, '[relay]')
    .replace(/\b(?:Bearer\s+)?(?:ps|pa|pm|pg)_[A-Za-z0-9_-]{20,}\b/gu, '[credential]')
    .replace(/[\r\n\t\x00-\x1f\x7f]+/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
  return message.slice(0, 240) || 'the relay refused the baseline upload';
}

/** Preserve the ordered-move refusal while naming this board and both recovery choices. */
export function expiredSignInMoveRefusal(state, error) {
  const reason = safePauseMessage(error);
  if (process.env.PULLBOARD_RELAY_TOKEN !== undefined) {
    return new Refused('AUTH_REQUIRED', `the supplied PULLBOARD_RELAY_TOKEN was refused for board ${state.board}: ${reason}; unset PULLBOARD_RELAY_TOKEN to use this machine credential or supply a current PULLBOARD_RELAY_TOKEN`);
  }
  return new Refused('AUTH_REQUIRED', `relay sign-in expired or was revoked for board ${state.board}: ${reason}; run pullboard relay on to give this machine a credential or pullboard relay off to stop syncing`);
}

/** Pause only definitive baseline 4xx refusals; throttling and transient errors retain retries. */
export function permanentBaselineRefusal(error) {
  return Number.isInteger(error?.httpStatus) && error.httpStatus >= 400 && error.httpStatus < 500 &&
    ![408, 425, 429].includes(error.httpStatus);
}

/** Name the safe next step for the saved permanent refusal. */
function pauseFix(state) {
  const pause = state.baselinePause;
  if (pause.size || /(?:exceeds?|over|larger than|too large).{0,40}(?:bytes|snapshot|limit)|(?:snapshot|limit).{0,40}(?:exceeds?|over|too large)/iu.test(pause.message)) {
    return 'it resumes automatically once a snapshot fits';
  }
  if ([401, 403].includes(pause.status) || pause.code === 'AUTH_REQUIRED') return 'run pullboard relay on to sign in again';
  return 'upgrade Pullboard or run pullboard relay on again, then report the refusal if it persists';
}

/** Render one bounded line with board, safe refusal reason and recovery step. */
export function baselinePauseLine(state) {
  const pause = state.baselinePause;
  const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(pause.code) ? pause.code : 'RELAY_REFUSED';
  const size = pause.size && Number.isSafeInteger(pause.size.sealedBytes) && Number.isSafeInteger(pause.size.limit)
    ? formatSnapshotLimit({ board: state.board, ...pause.size }, { paused: true }) : `relay paused for ${state.board} before its baseline upload`;
  return `pullboard: [${code}] ${size}: ${pause.message}; ${pauseFix(state)}`;
}

/** Persist only a stable refusal code, never arbitrary relay text masquerading as a code. */
export function safePauseCode(error) {
  const code = error.relayCode ?? error.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'RELAY_REFUSED';
}
