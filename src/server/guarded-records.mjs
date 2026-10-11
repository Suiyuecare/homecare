// Narrow reader for the new closed record types. Corrupt imported rows are
// invisible; this never repairs, rewrites or expands an unknown JSON value.
const guarded = new Set(['contract-deadline-reminders', 'shift-substitution-requests', 'internal-notifications', 'internal-notification-receipts', 'case-family-members', 'case-family-links', 'attendance-exceptions', 'interview-applicants', 'claim-batches', 'shift-series', 'shift-series-occurrences', 'case-contracts', 'internal-tasks', 'form-templates', 'form-records', 'case-contact-footprints', 'institution-holidays', 'employee-training-credits']);
const metadata = ['id', 'orgId', 'version', 'createdAt', 'updatedAt'];
export const isGuardedStoredEntity = entity => guarded.has(entity);
function projected(row, orgId, entity) {
  if (!row || row.org_id !== orgId || row.entity !== entity || typeof row.id !== 'string'
    || row.version < 1n || row.version > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  let data; try { data = JSON.parse(row.data); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data) || metadata.some(key => Object.hasOwn(data, key))) return null;
  return { ...data, id: row.id, orgId: row.org_id, version: Number(row.version), createdAt: row.created_at, updatedAt: row.updated_at };
}
export function guardedStoredRows(db, orgId, entity) {
  const statement = db.prepare('SELECT * FROM records WHERE org_id=? AND entity=? ORDER BY created_at DESC,id');
  statement.setReadBigInts(true);
  return statement.all(orgId, entity).map(row => projected(row, orgId, entity)).filter(Boolean);
}
export function guardedStoredGet(db, orgId, entity, recordId) {
  const statement = db.prepare('SELECT * FROM records WHERE org_id=? AND entity=? AND id=?');
  statement.setReadBigInts(true);
  return projected(statement.get(orgId, entity, recordId), orgId, entity);
}
