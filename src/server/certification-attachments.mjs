import { MAX_ATTACHMENT_FILE_BYTES, attachmentRecordVersion, attachmentFileResponse } from './attachments.mjs';

export const certificationAttachmentEntities = {
  'certification-attachments': {
    fields: 'certificationId title note status',
    required: ['certificationId', 'title'],
    statuses: ['active', 'inactive'],
    defaults: { status: 'active' },
  },
};
export const isCertificationAttachmentEntity = entity => Object.hasOwn(certificationAttachmentEntities, entity);

export function initCertificationAttachmentStorage(db) {
  db.exec([
    'CREATE TABLE IF NOT EXISTS certification_attachment_files(',
    'id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),',
    'attachment_id TEXT NOT NULL REFERENCES records(id),certification_id TEXT NOT NULL REFERENCES records(id),',
    'employee_id TEXT NOT NULL REFERENCES records(id),file_name TEXT NOT NULL,mime_type TEXT NOT NULL,',
    'size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND ' + MAX_ATTACHMENT_FILE_BYTES + '),',
    'sha256 TEXT NOT NULL,content BLOB NOT NULL CHECK(length(content)=size_bytes),created_at TEXT NOT NULL);',
    'CREATE INDEX IF NOT EXISTS certification_attachment_files_scope ON certification_attachment_files(org_id,attachment_id,certification_id,employee_id);',
    'CREATE TRIGGER IF NOT EXISTS certification_attachment_files_no_update BEFORE UPDATE ON certification_attachment_files ',
    "BEGIN SELECT RAISE(ABORT,'Certification attachment files are immutable'); END;",
    'CREATE TRIGGER IF NOT EXISTS certification_attachment_files_no_delete BEFORE DELETE ON certification_attachment_files ',
    "BEGIN SELECT RAISE(ABORT,'Certification attachment files are immutable'); END;",
  ].join(''));
}

export function guardCertificationAttachmentAccess(entity, ctx, readOnly, fail) {
  if (!isCertificationAttachmentEntity(entity)) return;
  const roles = readOnly ? ['admin', 'supervisor', 'caregiver'] : ['admin', 'supervisor'];
  if (!roles.includes(ctx.role)) fail(403, 'ROLE_FORBIDDEN', '此角色無權存取或變更證照附件');
}

export function normalizeCertificationAttachmentPayload(entity, payload) {
  if (!isCertificationAttachmentEntity(entity)) return payload;
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]));
}

export function validateCertificationAttachment(entity, data, old, fail) {
  if (!isCertificationAttachmentEntity(entity)) return;
  if (old && old.certificationId !== data.certificationId) fail(409, 'CERTIFICATION_IMMUTABLE', '建立後不可更換附件所屬證照', { certificationId: '不可變更' });
  if (typeof data.certificationId !== 'string' || !data.certificationId) fail(422, 'REQUIRED', '請指定所屬證照', { certificationId: '必填' });
  if (typeof data.title !== 'string' || !data.title.trim() || data.title.length > 200) fail(422, 'INVALID_FIELD', '附件標題須為1至200字', { title: '必填且最多200字' });
  if (data.note !== undefined && (typeof data.note !== 'string' || data.note.length > 10000)) fail(422, 'INVALID_FIELD', '附件備註最多10000字', { note: '最多10000字' });
}

// Model primitives are injected so this adapter cannot create a model import cycle.
export function readableCertificationParents(db, ctx, scopedRows) {
  const employeeIds = new Set(scopedRows(db, ctx, 'employees').map(item => item.id));
  return new Map(scopedRows(db, ctx, 'employee-certifications').filter(item => employeeIds.has(item.employeeId)).map(item => [item.id, item]));
}

export function certificationAttachmentVisible(item, parents) {
  const parent = parents.get(item.certificationId);
  return Boolean(parent && item.employeeId === parent.employeeId);
}

export function requireCertificationParent(db, ctx, certificationId, scopedRows, fail) {
  const parent = readableCertificationParents(db, ctx, scopedRows).get(certificationId);
  if (!parent) fail(404, 'NOT_FOUND', '找不到可讀取的證照或員工');
  return parent;
}

export function certificationAttachmentQuery(entity, searchParams, fail) {
  if (!isCertificationAttachmentEntity(entity)) return {};
  const values = searchParams.getAll('certificationId');
  if (values.length > 1 || (values.length === 1 && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(values[0]))) {
    fail(422, 'INVALID_CERTIFICATION_ID', 'certificationId須為單一有效識別碼', { certificationId: '識別碼不合法或重複' });
  }
  return { certificationId: values[0] };
}

export function insertCertificationAttachmentFile(db, ctx, item, file) {
  db.prepare('INSERT INTO certification_attachment_files VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
    file.fileId, ctx.orgId, item.id, item.certificationId, item.employeeId,
    file.fileName, file.mimeType, file.sizeBytes, file.sha256, file.bytes, item.updatedAt,
  );
}

/** Caller first authorizes the current attachment, its certificate and employee. */
export function readCertificationAttachmentFile(db, ctx, current, searchParams, fail) {
  const version = attachmentRecordVersion(searchParams, current.version, fail);
  const stored = db.prepare('SELECT snapshot FROM record_versions WHERE org_id=? AND entity=? AND record_id=? AND version=?')
    .get(ctx.orgId, 'certification-attachments', current.id, version);
  const missing = () => fail(404, 'NOT_FOUND', '找不到可讀取的附件檔案');
  if (!stored) missing();
  let snapshot;
  try { snapshot = JSON.parse(stored.snapshot); } catch { missing(); }
  if (!snapshot || snapshot.id !== current.id || snapshot.orgId !== ctx.orgId || snapshot.version !== version || snapshot.certificationId !== current.certificationId || snapshot.employeeId !== current.employeeId || typeof snapshot.fileId !== 'string') missing();
  const blob = db.prepare('SELECT * FROM certification_attachment_files WHERE id=? AND org_id=? AND attachment_id=? AND certification_id=? AND employee_id=?')
    .get(snapshot.fileId, ctx.orgId, current.id, current.certificationId, current.employeeId);
  return attachmentFileResponse(snapshot, blob, fail);
}
