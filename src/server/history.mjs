import { isStrictSpanHistory, readClosedSpanHistory } from './span-history.mjs';
import { isCaseHealthEntity } from './case-health.mjs';
import { isInternalNotificationEntity, internalNotificationHistoryVisible, publicInternalNotification } from './internal-notifications.mjs';
import { isSubstitutionEntity, substitutionHistoryVisible } from './shift-substitution.mjs';
import { isContractDeadlineEntity, contractDeadlineHistoryVisible } from './contract-deadlines.mjs';
import { isCaseContactFootprintEntity, caseContactFootprintHistoryVisible } from './case-contact-footprints.mjs';
import { isCaseFamilyEntity, caseFamilyHistoryVisible } from './case-family.mjs';
import { isAttendanceExceptionEntity, attendanceExceptionHistoryVisible } from './attendance-exceptions.mjs';
import { isInterviewExtensionEntity, interviewExtensionHistoryVisible, projectInterviewReadRecord } from './interview-extension.mjs';
import { isInstitutionHolidayEntity, institutionHolidayHistoryVisible } from './institution-holidays.mjs';
import { isTrainingCreditEntity, trainingCreditHistoryVisible } from './training-credits.mjs';
import { isGuardedStoredEntity } from './guarded-records.mjs';
import { isShiftSeriesEntity, shiftSeriesHistoryVisible } from './shift-series.mjs';
import { isCustomFormEntity, customFormHistoryVisible } from './custom-forms.mjs';
import { isContractsTasksEntity, contractsTasksHistoryVisible, contractsTasksVisible } from './contracts-tasks.mjs';
import { isClaimBatchEntity, claimBatchHistoryVisible } from './claim-batches.mjs';
import { isPayrollStatementEntity, payrollStatementHistoryVisible } from './payroll-statements.mjs';
import { isBillingDocumentEntity, billingDocumentHistoryVisible } from './billing-documents.mjs';
import { isCaseSupportEntity } from './case-support.mjs';
import { fail, publicRecord, scopedRows, get } from './model.mjs';
import { isPersonalCalendarEntity, personalCalendarOwned, assertPersonalCalendarItem, personalCalendarSqlVersion } from './personal-calendar.mjs';
import { isPersonnelEntity } from './personnel.mjs';
import { isContactEntity } from './contacts.mjs';
import { isCaseStatusFollowupEntity } from './case-status-followups.mjs';
import { isAttachmentEntity } from './attachments.mjs';
import { isCertificationAttachmentEntity, readableCertificationParents, certificationAttachmentVisible } from './certification-attachments.mjs';

const comparableEntities = new Set(['contract-deadline-reminders', 'shift-substitution-requests', 'internal-notifications', 'case-family-members', 'case-family-links', 'attendance-exceptions', 'case-contact-footprints', 'institution-holidays', 'employee-training-credits', 'shift-series', 'form-templates', 'form-records', 'case-contracts', 'internal-tasks', 'claim-batches', 'case-vaccinations', 'case-infection-records', 'case-vitals', 'billing-documents', 'payment-receipts', 'payroll-statements', 'business-rules', 'case-relationships', 'medical-opinions', 'institution-events', 'complaints', 'personal-calendar-events', 'interview-applicants', 'cases', 'care-plans', 'case-contacts', 'case-status-followups', 'case-attachments', 'certification-attachments', 'shifts', 'service-records', 'employee-certifications', 'employee-training', 'leave-requests', 'service-items', 'employees', 'assessments', 'announcements']);

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
      AND (a.action IN ('record.create', 'record.update', 'record.import')
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
  let current = scopedRows(db, ctx, entity).find(item => item.id === recordId);
  if (!current) {
    fail(404, 'NOT_FOUND', '找不到資料');
  }
  if(isInternalNotificationEntity(entity))current=get(db,ctx.orgId,entity,recordId);
  if (isPersonalCalendarEntity(entity)) assertPersonalCalendarItem(current, ctx, fail);
  if (compare !== undefined && (compare !== 'previous' || !comparableEntities.has(entity))) {
    fail(422, 'INVALID_COMPARE', '只有面試者、個案、照顧計畫、聯絡人、暫停與結案追蹤、附件、排班、服務紀錄、證照、訓練、請假、服務項目、員工、評鑑填答及公告歷程支援compare=previous', { compare: '比較方式不合法' });
  }

  const strictSpan = isStrictSpanHistory(db,ctx.orgId,entity);
  if(strictSpan)current=get(db,ctx.orgId,entity,recordId);
  const historyStatement = db.prepare(`
    SELECT version, snapshot, created_at AS createdAt, source
    FROM record_versions
    WHERE org_id = ? AND entity = ? AND record_id = ?
    ORDER BY version DESC
  `);
  if (isPersonalCalendarEntity(entity) || isGuardedStoredEntity(entity) || strictSpan) historyStatement.setReadBigInts(true);
  const rawHistory = historyStatement.all(ctx.orgId, entity, recordId);
  let history = strictSpan ? readClosedSpanHistory(rawHistory,entity,current,fail) : rawHistory.map(row => {
    let snapshot;
    if (isPersonalCalendarEntity(entity) || isBillingDocumentEntity(entity) || isPayrollStatementEntity(entity) || isCaseHealthEntity(entity) || isGuardedStoredEntity(entity)) {
      // A snapshot that cannot establish an owner is invisible, not repaired.
      try { snapshot = JSON.parse(row.snapshot); } catch { snapshot = null; }
    } else snapshot = JSON.parse(row.snapshot);
    return { ...row, snapshot };
  });

  if (isBillingDocumentEntity(entity) || isPayrollStatementEntity(entity) || isCaseHealthEntity(entity) || isGuardedStoredEntity(entity)) {
    history = history.filter(row => row.snapshot !== null && typeof row.snapshot === 'object' && !Array.isArray(row.snapshot));
  }

  if (isGuardedStoredEntity(entity)) {
    history = history.filter(row => row.version >= 1n && row.version <= BigInt(Number.MAX_SAFE_INTEGER))
      .map(row => ({ ...row, version: Number(row.version) }));
  }

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

  if (isBillingDocumentEntity(entity)) {
    history = history.filter(row => row.snapshot.version === row.version && billingDocumentHistoryVisible(db, ctx, entity, row.snapshot, current, get));
  }

  if (isClaimBatchEntity(entity)) {
    history = history.filter(row => row.snapshot.version === row.version && claimBatchHistoryVisible(db, ctx, entity, row.snapshot, current, get));
  }

  if (isCaseFamilyEntity(entity)) history = history.filter(row => row.snapshot.version === row.version && caseFamilyHistoryVisible(db,ctx,entity,row.snapshot,current,get));
  if (isContractDeadlineEntity(entity)) history = history.filter(row => row.snapshot.version === row.version && contractDeadlineHistoryVisible(db,ctx,entity,row.snapshot,current,get,contractsTasksVisible));
  if (isSubstitutionEntity(entity)) history = history.filter(row => row.snapshot.version === row.version && substitutionHistoryVisible(db,ctx,entity,row.snapshot,current,get));
  if (isInternalNotificationEntity(entity)) history = history.filter(row => row.snapshot.version === row.version && internalNotificationHistoryVisible(db,ctx,row.snapshot,current,get));
  if (isAttendanceExceptionEntity(entity)) history = history.filter(row => row.snapshot.version === row.version && attendanceExceptionHistoryVisible(db,ctx,entity,row.snapshot,current,get));
  if (isInterviewExtensionEntity(entity)) history = history.map(row => ({ ...row, snapshot: projectInterviewReadRecord(row.snapshot) })).filter(row => row.snapshot && row.snapshot.version === row.version && interviewExtensionHistoryVisible(db,ctx,entity,row.snapshot,current,get));
  if (isCaseContactFootprintEntity(entity)) history = history.filter(row => row.snapshot.version === row.version && caseContactFootprintHistoryVisible(db,ctx,row.snapshot,current,get));
  if (isInstitutionHolidayEntity(entity)) history = history.filter(row => row.snapshot.version === row.version && institutionHolidayHistoryVisible(db,ctx,entity,row.snapshot,current));
  if (isTrainingCreditEntity(entity)) history = history.filter(row => row.snapshot.version === row.version && trainingCreditHistoryVisible(db,ctx,entity,row.snapshot,current,get));
  if (isShiftSeriesEntity(entity)) history = history.filter(row => row.snapshot.version === row.version && shiftSeriesHistoryVisible(db,ctx,row.snapshot,current));
  if (isCustomFormEntity(entity)) history = history.filter(row => row.snapshot.version === row.version && customFormHistoryVisible(db,ctx,entity,row.snapshot,current,get));
  if (isContractsTasksEntity(entity)) history = history.filter(row => row.snapshot.version === row.version && contractsTasksHistoryVisible(db,ctx,entity,row.snapshot,current,get));

  if (isPayrollStatementEntity(entity)) {
    const visibleEmployees = new Set(scopedRows(db, ctx, 'employees').map(item => item.id));
    history = history.filter(row => row.snapshot.orgId === ctx.orgId && row.snapshot.id === current.id && row.snapshot.version === row.version
      && row.snapshot.employeeId === current.employeeId && row.snapshot.month === current.month && row.snapshot.number === current.number && visibleEmployees.has(row.snapshot.employeeId)
      && payrollStatementHistoryVisible(db,ctx,entity,row.snapshot,current,get));
  }

  if (entity === 'leave-requests') {
    // Leave may legitimately change employees. Each saved employee must still
    // be readable, without requiring the current record's employee to match.
    const visibleEmployees = new Set(scopedRows(db, ctx, 'employees').map(item => item.id));
    history = history.filter(row => visibleEmployees.has(row.snapshot.employeeId));
  }

  if (isContactEntity(entity) || isAttachmentEntity(entity) || isCaseStatusFollowupEntity(entity) || isCaseSupportEntity(entity) || isCaseHealthEntity(entity)) {
    const visibleCases = new Set(scopedRows(db, ctx, 'cases').map(item => item.id));
    history = history.filter(row => row.snapshot.caseId === current.caseId && visibleCases.has(row.snapshot.caseId)
      && (!isCaseHealthEntity(entity) || row.snapshot.id === current.id && row.snapshot.orgId === ctx.orgId && row.snapshot.version === row.version));
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
  history = history.map(row => ({ ...row, snapshot: isInternalNotificationEntity(entity)?publicInternalNotification(ctx,row.snapshot):publicRecord(ctx, row.snapshot) }));
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
