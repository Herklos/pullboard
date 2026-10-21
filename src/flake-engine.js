/** Coordinator allocation17419: typed Native flake observations start here [H16]. */
export const NATIVE_FLAKE_ENGINE = 61;

/** A flake observation imported from CI, with its run, job, runner and Node version and no host load, starts here (#918). */
export const CI_FLAKE_ENGINE = 65;

/** Recognize new landing receipt relationships without interpreting malformed batch input. */
export function carriesFlakeDiagnostics(batch) {
  return Boolean(batch && (Object.hasOwn(batch, 'flakeDiagnostics')
    || Array.isArray(batch.gateResults) && batch.gateResults.some(result => result && Object.hasOwn(result, 'flakeDiagnostics'))));
}
