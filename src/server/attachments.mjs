import { createHash, randomUUID } from 'node:crypto';

export const MAX_ATTACHMENT_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENT_BODY_BYTES = 8 * 1024 * 1024;
export const attachmentCategories = ['general', 'care', 'administrative', 'other'];
export const attachmentEntities = {
  'case-attachments': {
    fields: 'caseId title category note status',
    required: ['caseId', 'title'],
    statuses: ['active', 'inactive'],
    defaults: { category: 'general', status: 'active' },
  },
};
export const isAttachmentEntity = entity => Object.hasOwn(attachmentEntities, entity);

export function initAttachmentStorage(db) {
  db.exec([
    'CREATE TABLE IF NOT EXISTS attachment_files(',
    'id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),',
    'attachment_id TEXT NOT NULL REFERENCES records(id),case_id TEXT NOT NULL REFERENCES records(id),',
    'file_name TEXT NOT NULL,mime_type TEXT NOT NULL,',
    'size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND ' + MAX_ATTACHMENT_FILE_BYTES + '),',
    'sha256 TEXT NOT NULL,content BLOB NOT NULL CHECK(length(content)=size_bytes),created_at TEXT NOT NULL);',
    'CREATE INDEX IF NOT EXISTS attachment_files_scope ON attachment_files(org_id,attachment_id,case_id);',
    'CREATE TRIGGER IF NOT EXISTS attachment_files_no_update BEFORE UPDATE ON attachment_files ',
    "BEGIN SELECT RAISE(ABORT,'Attachment files are immutable'); END;",
    'CREATE TRIGGER IF NOT EXISTS attachment_files_no_delete BEFORE DELETE ON attachment_files ',
    "BEGIN SELECT RAISE(ABORT,'Attachment files are immutable'); END;",
  ].join(''));
}

export function guardAttachmentAccess(entity, ctx, readOnly, fail) {
  if (!isAttachmentEntity(entity)) return;
  const roles = readOnly ? ['admin', 'supervisor', 'caregiver', 'finance'] : ['admin', 'supervisor'];
  if (!roles.includes(ctx.role)) fail(403, 'ROLE_FORBIDDEN', '此角色無權變更或讀取個案附件');
}

export function normalizeAttachmentPayload(entity, payload) {
  if (!isAttachmentEntity(entity)) return payload;
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]));
}

export function validateAttachment(entity, data, old, fail) {
  if (!isAttachmentEntity(entity)) return;
  if (old && old.caseId !== data.caseId) fail(409, 'CASE_IMMUTABLE', '建立後不可更換附件所屬個案', { caseId: '不可變更' });
  if (typeof data.title !== 'string' || !data.title.trim() || data.title.length > 200) {
    fail(422, 'INVALID_FIELD', '附件標題須為1至200字', { title: '必填且最多200字' });
  }
  if (data.note !== undefined && (typeof data.note !== 'string' || data.note.length > 10000)) {
    fail(422, 'INVALID_FIELD', '附件備註最多10000字', { note: '最多10000字' });
  }
  if (!attachmentCategories.includes(data.category)) fail(422, 'INVALID_CATEGORY', '附件分類不合法', { category: '分類不合法' });
}

export function attachmentQuery(entity, searchParams, fail) {
  if (!isAttachmentEntity(entity)) return {};
  const categories = searchParams.getAll('category');
  if (categories.length > 1 || (categories.length === 1 && !attachmentCategories.includes(categories[0]))) {
    fail(422, 'INVALID_CATEGORY', 'category須為單一有效附件分類', { category: '分類不合法或重複' });
  }
  return { category: categories[0] };
}

function fileShapeValid(fileName, mimeType, bytes) {
  if (typeof fileName !== 'string' || !fileName || fileName.length > 180 || !fileName.isWellFormed() || /[\x00-\x1f\x7f/\\]/.test(fileName)) return false;
  const ext = fileName.toLowerCase().match(/\.(pdf|png|jpe?g)$/)?.[1];
  if (ext === 'pdf') return mimeType === 'application/pdf' && bytes.subarray(0, 5).equals(Buffer.from('%PDF-'));
  if (ext === 'png') return mimeType === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (ext === 'jpg' || ext === 'jpeg') return mimeType === 'image/jpeg' && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  return false;
}

export function validateAttachmentFile(payload, fail) {
  const { contentBase64 } = payload;
  const fileName = typeof payload.fileName === 'string' ? payload.fileName.trim() : payload.fileName;
  const mimeType = typeof payload.mimeType === 'string' ? payload.mimeType.trim() : payload.mimeType;
  const invalid = message => fail(422, 'INVALID_FILE', message, { file: message });
  if (typeof contentBase64 !== 'string' || !contentBase64.length) invalid('請選擇非空白檔案');
  if (contentBase64.length > 4 * Math.ceil(MAX_ATTACHMENT_FILE_BYTES / 3)) fail(413, 'FILE_TOO_LARGE', '檔案不可超過5 MiB', { file: '檔案不可超過5 MiB' });
  if (contentBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) invalid('檔案內容須為標準base64');
  const bytes = Buffer.from(contentBase64, 'base64');
  if (bytes.toString('base64') !== contentBase64 || !bytes.length) invalid('檔案內容須為非空白標準base64');
  if (bytes.length > MAX_ATTACHMENT_FILE_BYTES) fail(413, 'FILE_TOO_LARGE', '檔案不可超過5 MiB', { file: '檔案不可超過5 MiB' });
  if (!fileShapeValid(fileName, mimeType, bytes)) invalid('檔名、副檔名、格式或檔案簽章不符合PDF、PNG或JPEG規則');
  return { fileId: randomUUID(), fileName, mimeType, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), bytes };
}

export function attachmentFileMetadata(file) {
  return Object.fromEntries(['fileId', 'fileName', 'mimeType', 'sizeBytes', 'sha256'].map(key => [key, file[key]]));
}

export function insertAttachmentFile(db, ctx, item, file) {
  db.prepare('INSERT INTO attachment_files VALUES(?,?,?,?,?,?,?,?,?,?)').run(
    file.fileId, ctx.orgId, item.id, item.caseId, file.fileName, file.mimeType, file.sizeBytes, file.sha256, file.bytes, item.updatedAt,
  );
}

/** Parse a metadata version without selecting any storage or authorization scope. */
export function attachmentRecordVersion(searchParams, currentVersion, fail) {
  const versions = searchParams.getAll('recordVersion');
  if (versions.length > 1 || (versions.length === 1 && (!/^[1-9]\d*$/.test(versions[0]) || !Number.isSafeInteger(Number(versions[0]))))) {
    fail(422, 'INVALID_RECORD_VERSION', 'recordVersion須為單一正整數', { recordVersion: '版本不合法或重複' });
  }
  return versions.length ? Number(versions[0]) : currentVersion;
}

/** Pure file-integrity and response projection shared by fixed SQL adapters. */
export function attachmentFileResponse(snapshot, blob, fail) {
  const missing = () => fail(404, 'NOT_FOUND', '找不到可讀取的附件檔案');
  if (!blob || snapshot.fileName !== blob.file_name || snapshot.mimeType !== blob.mime_type || snapshot.sizeBytes !== blob.size_bytes || snapshot.sha256 !== blob.sha256) missing();
  const bytes = Buffer.from(blob.content);
  if (bytes.length !== blob.size_bytes || createHash('sha256').update(bytes).digest('hex') !== blob.sha256 || !fileShapeValid(blob.file_name, blob.mime_type, bytes)) missing();
  const extension = blob.mime_type === 'application/pdf' ? 'pdf' : blob.mime_type === 'image/png' ? 'png' : 'jpg';
  const encodedName = encodeURIComponent(blob.file_name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return {
    bytes,
    headers: {
      'Content-Type': blob.mime_type,
      'Content-Length': String(bytes.length),
      'Content-Disposition': 'attachment; filename="attachment.' + extension + '"; filename*=UTF-8\'\'' + encodedName,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  };
}

/** Caller must first authorize the current record and its parent case. */
export function readAttachmentFile(db, ctx, current, searchParams, fail) {
  const version = attachmentRecordVersion(searchParams, current.version, fail);
  const stored = db.prepare('SELECT snapshot FROM record_versions WHERE org_id=? AND entity=? AND record_id=? AND version=?')
    .get(ctx.orgId, 'case-attachments', current.id, version);
  const missing = () => fail(404, 'NOT_FOUND', '找不到可讀取的附件檔案');
  if (!stored) missing();
  let snapshot;
  try { snapshot = JSON.parse(stored.snapshot); } catch { missing(); }
  if (!snapshot || snapshot.id !== current.id || snapshot.orgId !== ctx.orgId || snapshot.version !== version || snapshot.caseId !== current.caseId || typeof snapshot.fileId !== 'string') missing();
  const blob = db.prepare('SELECT * FROM attachment_files WHERE id=? AND org_id=? AND attachment_id=? AND case_id=?')
    .get(snapshot.fileId, ctx.orgId, current.id, current.caseId);
  return attachmentFileResponse(snapshot, blob, fail);
}
