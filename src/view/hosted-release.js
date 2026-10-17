/**
 * The hosted page's release facts for its update note (N26): which releases have shipped, and
 * how far a local install trails the release the page was built from. Kept out of src/cockpit.js
 * so the page module stays under its line cap; the page embeds hostedReleaseDistance as source.
 */
import { readFileSync } from 'node:fs';
import { VERSION } from '../help.js';

let shipped;

/**
 * Compare two dotted numeric versions.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number} Negative, zero or positive, as for Array.prototype.sort.
 */
function compareVersions(left, right) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

/**
 * Return every shipped numeric release heading through the package version, including releases
 * without headlines, so a count of releases behind matches the changelog a person reads.
 *
 * @param {string} changelog - Shipped changelog contents.
 * @param {string} [currentVersion] - Highest package release to include.
 * @returns {string[]} Numeric release versions in ascending order, without duplicates.
 */
export function releaseVersionsThrough(changelog, currentVersion = VERSION) {
  return [...new Set([...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\](?:\s|$)/gmu)].map((match) => match[1]))]
    .filter((version) => compareVersions(version, currentVersion) <= 0)
    .sort(compareVersions);
}

/**
 * Read and cache the shipped release ledger. Why read the packaged CHANGELOG: the hosted page's
 * current release is the one it was built from, so nothing is fetched to learn it.
 *
 * @returns {readonly string[]}
 */
export function shippedReleaseVersions() {
  if (!shipped) shipped = Object.freeze(releaseVersionsThrough(readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8')));
  return shipped;
}

/**
 * Count known, shipped release entries between the installed and hosted versions. An unknown
 * version gets 0, so the page shows no guessed count. Runs in the page as embedded source.
 *
 * @param {unknown} installed
 * @param {unknown} current
 * @param {unknown} releases
 * @returns {number}
 */
export function hostedReleaseDistance(installed, current, releases) {
  if (typeof installed !== 'string' || typeof current !== 'string' || !Array.isArray(releases)) return 0;
  const installedAt = releases.indexOf(installed), currentAt = releases.indexOf(current);
  return installedAt >= 0 && currentAt > installedAt ? currentAt - installedAt : 0;
}
