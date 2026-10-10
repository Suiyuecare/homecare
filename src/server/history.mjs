import { fail, publicRecord, scopedRows } from './model.mjs';
import { isPersonalCalendarEntity, personalCalendarOwned, assertPersonalCalendarItem, personalCalendarSqlVersion } from './personal-calendar.mjs';
import { isPersonnelEntity } from './personnel.mjs';
import { isContactEntity } from './contacts.mjs';
import { isCaseStatusFollowupEntity } from './case-status-followups.mjs';
import { isAttachmentEntity } from './attachments.mjs';
import { isCertificationAttachmentEntity, readableCertificationParents, certificationAttachmentVisible } from './certification-attachments.mjs';

const comparableEntities = new Set(['personal-calendar-events', 'interview-applicants', 'cases', 'care-plans', 'case-contacts', 'case-status-followups', 'case-attachments', 'certification-attachments', 'shifts', 'service-records', 'employee-certifications', 'employee-training', 'leave-requests', 'service-items', 'employees', 'assessments', 'announcements']);

/**
 * Resolve actual audit identities without using timestamp proximity, source,
 * current record ownership, or a neighboring version as a substitute.
 * Names are the users table's current display names, not historical names.
 */
function actorsByVersion(db, ctx, entity, recordId, visibleVersions) {
  const candidates = new Map();
  const events = db.prepare(`
    SELECT a.detail, a.user_id AS userId, u.id AS existingUserId, u.name AS name
    FROM audit a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.org_id = ? AND a.entity = ? AND a.record_id = ?
      AND (a.action IN ('record.create', 'record.update')
        OR (? = 'shifts' AND a.action = 'shift.complete')
        OR (? = 'service-records' AND a.action = 'service.review'))
  `).all(ctx.orgId, entity, recordId, entity, entity);

  for (const event of events) {
    let detail;
    try { detail = JSON.parse(event.detail); } catch { continue; }
    const version = detail?.version;
    if (!Number.isSafeInteger(version) || !visibleVersions.has(version)) continue;
    const identities = candidates.get(version) || [];
    identities.push(event.existingUserId && event.userId === event.existingUserId && typeof event.name === 'string'
      ? { id: event.existingUserId, name: event.name }
      : null);
    candidates.set(version, identities);
  }

  const result = new Map();
  for (const [version, identities] of candidates) {
    if (identities.some(identity => identity === null)) {
      result.set(version, null);
      continue;
    }
    const distinctIds = new Set(identities.map(identity => identity.id));
    result.set(version, distinctIds.size === 1 ? identities[0] : null);
  }
  return result;
}

/**
 * Return all authorized, projected history rows before pagination.
 * Comparisons only use exact previous versions within this same visible set.
 * The function is read-only, including actor resolution and comparison.
 */
export function readHistory(db, ctx, entity, recordId, { compare } = {}) {
  const current = scopedRows(db, ctx, entity).find(item => item.id === recordId);
  if (!current) {
    fail(404, 'NOT_FOUND', '找不到資料');
  }
  if (isPersonalCalendarEntity(entity)) assertPersonalCalendarItem(current, ctx, fail);
  if (compare !== undefined && (compare !== 'previous' || !comparableEntities.has(entity))) {
    fail(422, 'INVALID_COMPARE', '只有面試者、個案、照顧計畫、聯絡人、暫停與結案追蹤、附件、排班、服務紀錄、證照、訓練、請假、服務項目、員工、評鑑填答及公告歷程支援compare=previous', { compare: '比較方式不合法' });
  }

  const historyStatement = db.prepare(`
    SELECT version, snapshot, created_at AS createdAt, source
    FROM record_versions
    WHERE org_id = ? AND entity = ? AND record_id = ?
    ORDER BY version DESC
  `);
  if (isPersonalCalendarEntity(entity)) historyStatement.setReadBigInts(true);
  let history = historyStatement.all(ctx.orgId, entity, recordId).map(row => {
    let snapshot;
    if (isPersonalCalendarEntity(entity)) {
      // A snapshot that cannot establish an owner is invisible, not repaired.
      try { snapshot = JSON.parse(row.snapshot); } catch { snapshot = null; }
    } else snapshot = JSON.parse(row.snapshot);
    return { ...row, snapshot };
  });

  if (isPersonalCalendarEntity(entity)) {
    history = history.filter(row => personalCalendarOwned(row.snapshot, ctx) && row.snapshot.ownerUserId === current.ownerUserId)
      .map(row => {
        const version = personalCalendarSqlVersion(row.version);
        assertPersonalCalendarItem(row.snapshot, ctx, fail);
        if (!Number.isSafeInteger(version) || version < 1 || row.snapshot.id !== current.id || row.snapshot.version !== version)
          fail(409, 'CALENDAR_DATA_INVALID', '無法確認保存的行事事件歷程識別或版次');
        return { ...row, version };
      });
  }

  if (isCertificationAttachmentEntity(entity)) {
    const parents = readableCertificationParents(db, ctx, scopedRows);
    history = history.filter(row => row.snapshot.certificationId === current.certificationId && row.snapshot.employeeId === current.employeeId && certificationAttachmentVisible(row.snapshot, parents));
  }

  if (isPersonnelEntity(entity)) {
    // Personnel ownership is immutable. Authorize each saved parent without
    // adding a parent join to the existing current-record authorization above.
    const visibleEmployees = new Set(scopedRows(db, ctx, 'employees').map(item => item.id));
    history = history.filter(row => row.snapshot.employeeId === current.employeeId && visibleEmployees.has(row.snapshot.employeeId));
  }

  if (entity === 'leave-requests') {
    // Leave may legitimately change employees. Each saved employee must still
    // be readable, without requiring the current record's employee to match.
    const visibleEmployees = new Set(scopedRows(db, ctx, 'employees').map(item => item.id));
    history = history.filter(row => visibleEmployees.has(row.snapshot.employeeId));
  }

  if (isContactEntity(entity) || isAttachmentEntity(entity) || isCaseStatusFollowupEntity(entity)) {
    const visibleCases = new Set(scopedRows(db, ctx, 'cases').map(item => item.id));
    history = history.filter(row => row.snapshot.caseId === current.caseId && visibleCases.has(row.snapshot.caseId));
  }

  if (['shifts', 'service-records', 'assessments'].includes(entity)) {
    // These records may legitimately change cases. Authorize each saved case
    // against today's scope without requiring the current case or template.
    const visibleCases = new Set(scopedRows(db, ctx, 'cases').map(item => item.id));
    history = history.filter(row => visibleCases.has(row.snapshot.caseId));
  }

  if (ctx.role === 'caregiver') {
    if (entity === 'announcements') {
      history = history.filter(row => row.snapshot.status === 'published' && ['all', 'caregiver'].includes(row.snapshot.audience));
    }
    if (['shifts', 'service-records', 'leave-requests'].includes(entity) || isPersonnelEntity(entity)) {
      history = history.filter(row => row.snapshot.employeeId === ctx.employeeId);
    }
    if (entity === 'care-plans') {
      const visibleCases = new Set(scopedRows(db, ctx, 'cases').map(item => item.id));
      history = history.filter(row => visibleCases.has(row.snapshot.caseId));
    }
  }
  history = history.map(row => ({ ...row, snapshot: publicRecord(ctx, row.snapshot) }));
  if (compare === undefined) return history;

  const visible = new Map(history.map(row => [row.version, row]));
  const actors = actorsByVersion(db, ctx, entity, recordId, new Set(visible.keys()));
  return history.map(row => {
    let comparison;
    if (row.version === 1) {
      comparison = { status: 'initial', previousVersion: null, previousSnapshot: null };
    } else {
      const previous = visible.get(row.version - 1);
      comparison = previous
        ? { status: 'available', previousVersion: previous.version, previousSnapshot: previous.snapshot }
        : { status: 'unavailable', previousVersion: null, previousSnapshot: null };
    }
    return { ...row, actor: actors.get(row.version) || null, comparison };
  });
}
