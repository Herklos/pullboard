/** Snapshot health without keeping a board write lock across Git's merge checks [A6]. */
import { existsSync } from 'node:fs';
import { openBoardReadOnly } from './board.js';
import { healthReport } from './health.js';
import { healthSentinelEnabled } from './settings.js';
import { healthFindingIdentity, normalizedHealthFindings } from './health-receipts.js';

/** A missing board or an explicitly disabled sentinel has no observation to publish. */
export function scanHealthSentinel(file, { root, config, now }) {
  if (!healthSentinelEnabled(config) || !existsSync(file)) return null;
  const db = openBoardReadOnly(file);
  try {
    db.exec('BEGIN');
    const observedRevision = db.prepare('SELECT COALESCE(MAX(event_id), 0) AS revision FROM event').get().revision;
    const report = healthReport({ db, root, config, now });
    const last = db.prepare("SELECT event_detail FROM event WHERE event_kind = 'health-scan' ORDER BY event_id DESC LIMIT 1").get();
    const before = (last ? JSON.parse(last.event_detail).active : []).map(healthFindingIdentity).sort();
    const after = normalizedHealthFindings(report.stuck).map(healthFindingIdentity).sort();
    db.exec('COMMIT');
    if (JSON.stringify(before) === JSON.stringify(after)) return null;
    return { observedRevision, findings: report.stuck };
  } finally { db.close(); }
}
