/** Durable work-health observations, separate from the person's decisions [A6,H16]. */
import { Refused } from './refused.js';

/** The allocated engine for ordered sentinel observations; earlier moves keep their meaning. */
export const HEALTH_SENTINEL_ENGINE = 42;

/** Validate and retain only the fields needed to identify and explain a health finding. */
export function normalizedHealthFindings(findings) {
  if (!Array.isArray(findings) || findings.length > 10_000) {
    throw new Refused('HEALTH_FINDINGS', 'a sentinel scan needs at most 10000 health findings; run pullboard health and retry the scan');
  }
  const seen = new Set();
  return findings.map(finding => {
    const text = key => typeof finding?.[key] === 'string' && finding[key].length > 0 && finding[key].length <= 8192;
    if (!['key', 'cause', 'subject', 'title', 'since', 'why', 'next'].every(text)
      || !/^[A-Z][A-Z0-9_]*$/u.test(finding.cause) || !Number.isFinite(Date.parse(finding.since))
      || finding.item !== null && (!Number.isSafeInteger(finding.item) || finding.item < 1)
      || seen.has(finding.key)) {
      throw new Refused('HEALTH_FINDINGS', 'a sentinel finding needs a unique key, cause, subject, time and next step; run pullboard health again');
    }
    const who = finding.owner?.who ?? finding.detail?.reviewer ?? finding.detail?.builder ?? finding.detail?.holder ?? null;
    if (who !== null && (typeof who !== 'string' || !who || who.length > 256)) {
      throw new Refused('HEALTH_FINDINGS', 'a sentinel finding needs its owner address; run pullboard health again');
    }
    seen.add(finding.key);
    return Object.fromEntries(['key', 'cause', 'item', 'subject', 'title', 'since', 'why', 'next'].map(key => [key, finding[key]]).concat([['owner', who]]));
  });
}

/** A new lease or owner is a new episode, even if no scan observed the intervening clear state. */
export function healthFindingIdentity(finding) {
  return JSON.stringify([finding.key, finding.since, finding.owner]);
}

/** Keep a whole owner address and the original cause and next step in each feed notice. */
export function healthFindingNotice(finding, resolved = false) {
  return `${resolved ? 'Resolved' : 'Stuck'}: ${finding.subject} ${finding.title} [${finding.cause}], since ${finding.since}. ${finding.why}. ${finding.owner ? `Owner: ${finding.owner}. ` : ''}Next: ${finding.next}.`;
}
