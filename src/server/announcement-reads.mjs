import { createHash } from 'node:crypto';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import { audit, fail, now, scopedRows } from './model.mjs';
import { readHistory } from './history.mjs';

const receiptEntity = 'announcement-reads';
const receiptSource = 'announcement.read';
const roles = new Set(['admin', 'supervisor', 'caregiver', 'finance']);
const announcementKeys = ['id', 'orgId', 'version', 'createdAt', 'updatedAt', 'title', 'body', 'audience', 'status'];
const receiptKeys = ['id', 'orgId', 'announcementId', 'announcementVersion', 'userId', 'userName', 'role', 'readAt'];
const snapshotKeys = ['id', 'orgId', 'version', 'createdAt', 'updatedAt', 'announcementId', 'announcementVersion', 'userId', 'userName', 'role', 'readAt'];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonempty = value => typeof value === 'string' && value.length > 0;
const project = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => own(value, key));
const invalidVersion = () => fail(409, 'ANNOUNCEMENT_VERSION_INVALID', '公告保存版本不完整，無法確認閱讀狀態');
const invalidReceipt = () => fail(409, 'ANNOUNCEMENT_RECEIPT_INVALID', '公告閱讀回執不完整，無法確認閱讀狀態');
const fullTextDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const locatorTextColumns = ['id', 'org_id', 'entity', 'created_at', 'updated_at'];
const versionTextColumns = ['org_id', 'entity', 'record_id', 'snapshot', 'created_at', 'source'];
const currentTextColumns = [...locatorTextColumns, 'data'];

// These column arrays are private constants; no caller can supply SQL identifiers.
function fullTextProjection(columns) {
  return columns.map(column => `typeof("${column}") AS "${column}Type", hex(CAST("${column}" AS BLOB)) AS "${column}Hex"`).join(', ');
}

function fullTextRow(row, columns, invalid) {
  if (!row) return null;
  const decoded = { ...row };
  for (const column of columns) {
    const hex = row[column + 'Hex'];
    if (row[column + 'Type'] !== 'text' || typeof hex !== 'string' || !/^(?:[0-9A-F]{2})*$/.test(hex)) invalid();
    try { decoded[column] = fullTextDecoder.decode(Buffer.from(hex, 'hex')); } catch { invalid(); }
  }
  return decoded;
}

function fullTextGet(db, sql, parameters, columns, invalid) {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  return fullTextRow(statement.get(...parameters), columns, invalid);
}

function parseVersionSnapshot(raw) {
  try { return JSON.parse(raw); } catch { invalidVersion(); }
}

function parseReceiptSnapshot(raw) {
  try { return JSON.parse(raw); } catch { invalidReceipt(); }
}

function announcementProjection(snapshot, ctx, recordId, version, rowCreatedAt) {
  if (!object(snapshot) || !announcementKeys.every(key => own(snapshot, key))
      || snapshot.id !== recordId || snapshot.orgId !== ctx.orgId || snapshot.version !== version
      || !positive(snapshot.version) || typeof snapshot.createdAt !== 'string' || typeof snapshot.updatedAt !== 'string'
      || rowCreatedAt !== snapshot.updatedAt) invalidVersion();
  return project(snapshot, announcementKeys);
}

/** Current authorization follows the existing announcement scope before any new integrity checks. */
function currentAnnouncement(db, ctx, recordId) {
  let current;
  try { current = scopedRows(db, ctx, 'announcements').find(item => item.id === recordId); }
  catch (error) { if (error instanceof SyntaxError || error instanceof RangeError) invalidVersion(); throw error; }
  if (!current) fail(404, 'NOT_FOUND', '找不到公告');
  if (!positive(current.version)) invalidVersion();
  const raw = fullTextGet(db, `SELECT version, ${fullTextProjection(currentTextColumns)} FROM records WHERE id = ?`,
    [recordId], currentTextColumns, invalidVersion);
  if (!raw || raw.id !== recordId || raw.org_id !== ctx.orgId || raw.entity !== 'announcements'
      || raw.version !== BigInt(current.version)) invalidVersion();
  const data = parseVersionSnapshot(raw.data);
  if (!object(data)) invalidVersion();
  const persistedCurrent = {
    ...data, id: raw.id, orgId: raw.org_id, version: current.version, createdAt: raw.created_at, updatedAt: raw.updated_at
  };
  const head = fullTextGet(db, `
    SELECT version, ${fullTextProjection(versionTextColumns)}
    FROM record_versions WHERE record_id = ? AND version = ?
  `, [recordId, current.version], versionTextColumns, invalidVersion);
  if (!head || head.org_id !== ctx.orgId || head.entity !== 'announcements'
      || head.record_id !== recordId || head.version !== BigInt(current.version)) invalidVersion();
  const saved = announcementProjection(parseVersionSnapshot(head.snapshot), ctx, recordId, current.version, head.created_at);
  if (!announcementKeys.every(key => own(current, key) && own(persistedCurrent, key)
      && isDeepStrictEqual(current[key], saved[key]) && isDeepStrictEqual(persistedCurrent[key], saved[key]))) invalidVersion();
  return saved;
}

function selectedAnnouncement(db, ctx, recordId, version) {
  const current = currentAnnouncement(db, ctx, recordId);
  if (version === undefined || version === current.version) return { announcement: current, currentVersion: current.version };
  let history;
  try { history = readHistory(db, ctx, 'announcements', recordId); }
  catch (error) { if (error instanceof SyntaxError || error instanceof RangeError) invalidVersion(); throw error; }
  const selected = history.find(row => row.version === version);
  if (!selected) fail(404, 'NOT_FOUND', '找不到可讀取的公告版本');
  const raw = fullTextGet(db, `SELECT version, ${fullTextProjection(versionTextColumns)}
    FROM record_versions WHERE record_id = ? AND version = ?`,
  [recordId, version], versionTextColumns, invalidVersion);
  if (!raw || raw.org_id !== ctx.orgId || raw.entity !== 'announcements'
      || raw.record_id !== recordId || raw.version !== BigInt(version)) invalidVersion();
  const announcement = announcementProjection(parseVersionSnapshot(raw.snapshot), ctx, recordId, version, raw.created_at);
  if (!announcementKeys.every(key => own(selected.snapshot, key) && isDeepStrictEqual(selected.snapshot[key], announcement[key]))) invalidVersion();
  return {
    announcement,
    currentVersion: current.version
  };
}

function eligible(announcement, currentVersion) {
  return announcement.version === currentVersion && announcement.status === 'published'
    && nonempty(announcement.title) && nonempty(announcement.body);
}

function receiptId(orgId, announcementId, announcementVersion, userId) {
  return createHash('sha256').update(JSON.stringify([
    'suiyue-announcement-read-v1', orgId, announcementId, announcementVersion, userId
  ]), 'utf8').digest('hex');
}

function canonicalTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

/** Locator data is intentionally never parsed. Only the protected version1 snapshot is receipt truth. */
function receiptById(db, ctx, id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) invalidReceipt();
  const locator = fullTextGet(db, `SELECT version, ${fullTextProjection(locatorTextColumns)} FROM records WHERE id = ?`,
    [id], locatorTextColumns, invalidReceipt);
  const statement = db.prepare(`SELECT version, ${fullTextProjection(versionTextColumns)} FROM record_versions WHERE record_id = ?`);
  statement.setReadBigInts(true);
  const versions = statement.all(id);
  if (!locator && versions.length === 0) return null;
  if (!locator || versions.length !== 1) invalidReceipt();
  const row = fullTextRow(versions[0], versionTextColumns, invalidReceipt);
  if (locator.id !== id || locator.org_id !== ctx.orgId || locator.entity !== receiptEntity || locator.version !== 1n
      || row.org_id !== ctx.orgId || row.entity !== receiptEntity || row.record_id !== id || row.version !== 1n
      || row.source !== receiptSource) invalidReceipt();
  const snapshot = parseReceiptSnapshot(row.snapshot);
  if (!exactKeys(snapshot, snapshotKeys) || snapshot.id !== id || snapshot.orgId !== ctx.orgId || snapshot.version !== 1
      || !/^[a-f0-9]{64}$/.test(snapshot.id) || !nonempty(snapshot.orgId) || !nonempty(snapshot.announcementId)
      || !positive(snapshot.announcementVersion) || !nonempty(snapshot.userId) || typeof snapshot.userName !== 'string'
      || !roles.has(snapshot.role) || !canonicalTime(snapshot.readAt)
      || snapshot.createdAt !== snapshot.readAt || snapshot.updatedAt !== snapshot.readAt
      || row.created_at !== snapshot.readAt || locator.created_at !== snapshot.readAt || locator.updated_at !== snapshot.readAt
      || receiptId(snapshot.orgId, snapshot.announcementId, snapshot.announcementVersion, snapshot.userId) !== id) invalidReceipt();
  return project(snapshot, receiptKeys);
}

function ownReceipt(db, ctx, announcement) {
  const id = receiptId(ctx.orgId, announcement.id, announcement.version, ctx.user.id);
  const receipt = receiptById(db, ctx, id);
  if (receipt && (receipt.announcementId !== announcement.id || receipt.announcementVersion !== announcement.version
      || receipt.userId !== ctx.user.id)) invalidReceipt();
  return receipt;
}

function queryNumber(searchParams, key, fallback, code) {
  const values = searchParams.getAll(key);
  if (values.length === 0) return fallback;
  if (values.length !== 1 || !/^[1-9][0-9]*$/.test(values[0]) || !positive(Number(values[0]))) {
    fail(422, code, code === 'PAGINATION' ? '公告閱讀名單分頁格式錯誤' : '公告閱讀版本查詢格式錯誤');
  }
  return Number(values[0]);
}

export function validateAnnouncementReadQuery(searchParams, { roster = false, post = false } = {}) {
  const allowed = post ? [] : roster ? ['version', 'page', 'pageSize'] : ['version'];
  for (const key of searchParams.keys()) {
    if (!allowed.includes(key)) fail(422, 'ANNOUNCEMENT_READ_QUERY', '公告閱讀查詢含不支援的欄位');
  }
  if (post) return {};
  const version = queryNumber(searchParams, 'version', undefined, 'ANNOUNCEMENT_READ_QUERY');
  if (!roster) return { version };
  const page = queryNumber(searchParams, 'page', 1, 'PAGINATION');
  const pageSize = queryNumber(searchParams, 'pageSize', 25, 'PAGINATION');
  if (pageSize > 100 || !Number.isSafeInteger((page - 1) * pageSize)) fail(422, 'PAGINATION', 'page須為正整數，pageSize介於1至100且頁面位置須為安全整數');
  return { version, page, pageSize };
}

export function validateAnnouncementReadPayload(payload) {
  if (!object(payload)) fail(400, 'INVALID_BODY', '請提供JSON物件');
  if (Object.keys(payload).some(key => key !== 'version')) fail(422, 'UNKNOWN_FIELD', '公告閱讀確認只接受version');
  if (!positive(payload.version)) fail(422, 'VERSION_REQUIRED', '公告閱讀確認必須提供正整數version');
  return payload.version;
}

export function readAnnouncementReadState(db, ctx, recordId, searchParams) {
  const { version } = validateAnnouncementReadQuery(searchParams);
  const selected = selectedAnnouncement(db, ctx, recordId, version);
  return {
    ...selected,
    canAcknowledge: eligible(selected.announcement, selected.currentVersion),
    receipt: ownReceipt(db, ctx, selected.announcement)
  };
}

export function readAnnouncementReadReceipts(db, ctx, recordId, searchParams) {
  if (!['admin', 'supervisor'].includes(ctx.role)) fail(403, 'ROLE_FORBIDDEN', '僅管理者或督導可讀取公告閱讀名單');
  const { version, page, pageSize } = validateAnnouncementReadQuery(searchParams, { roster: true });
  const selected = selectedAnnouncement(db, ctx, recordId, version);
  // The local JSON storage requires an organization scan. Pagination only bounds the response.
  const ids = db.prepare(`
    SELECT typeof(id) AS idType, hex(CAST(id AS BLOB)) AS idHex FROM records WHERE org_id = ? AND entity = ?
    UNION SELECT typeof(record_id) AS idType, hex(CAST(record_id AS BLOB)) AS idHex FROM record_versions WHERE org_id = ? AND entity = ?
  `).all(ctx.orgId, receiptEntity, ctx.orgId, receiptEntity);
  const receipts = ids.map(row => {
    const { id } = fullTextRow(row, ['id'], invalidReceipt);
    const receipt = receiptById(db, ctx, id);
    if (!receipt) invalidReceipt();
    return receipt;
  }).filter(receipt =>
    receipt.announcementId === selected.announcement.id && receipt.announcementVersion === selected.announcement.version);
  receipts.sort((a, b) => a.readAt === b.readAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : (a.readAt > b.readAt ? -1 : 1));
  const offset = (page - 1) * pageSize;
  return { ...selected, items: receipts.slice(offset).slice(0, pageSize), total: receipts.length, page, pageSize };
}

/** Called inside the opt-in idempotency transaction, before saved-response lookup. */
export function preflightAnnouncementRead(db, ctx, recordId, version) {
  const announcement = currentAnnouncement(db, ctx, recordId);
  if (announcement.version !== version) fail(409, 'VERSION_CONFLICT', '公告已更新，請重新閱讀目前版本');
  if (announcement.status !== 'published') fail(422, 'ANNOUNCEMENT_NOT_PUBLISHED', '只有目前已發布的公告可確認閱讀');
  if (!nonempty(announcement.title) || !nonempty(announcement.body)) fail(422, 'ANNOUNCEMENT_NOT_READABLE', '公告全文不是可完整閱讀的文字，無法確認閱讀');
  if (!roles.has(ctx.role) || !nonempty(ctx.user?.id) || typeof ctx.user?.name !== 'string') fail(403, 'ROLE_FORBIDDEN', '此帳號無法提交公告閱讀回執');
  ownReceipt(db, ctx, announcement);
  return announcement;
}

/** The caller owns BEGIN IMMEDIATE; this function never starts or commits a transaction. */
export function acknowledgeAnnouncementRead(db, ctx, recordId, version) {
  const announcement = preflightAnnouncementRead(db, ctx, recordId, version);
  const existing = ownReceipt(db, ctx, announcement);
  if (existing) return { status: 200, value: { receipt: existing } };
  const readAt = now();
  const snapshot = {
    id: receiptId(ctx.orgId, recordId, version, ctx.user.id), orgId: ctx.orgId, version: 1,
    createdAt: readAt, updatedAt: readAt, announcementId: recordId, announcementVersion: version,
    userId: ctx.user.id, userName: ctx.user.name, role: ctx.role, readAt
  };
  db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(snapshot.id, ctx.orgId, receiptEntity, '{}', 1, readAt, readAt);
  db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(ctx.orgId, receiptEntity, snapshot.id, 1, JSON.stringify(snapshot), readAt, receiptSource);
  audit(db, ctx, receiptSource, 'announcements', recordId, { version, receiptId: snapshot.id });
  return { status: 201, value: { receipt: project(snapshot, receiptKeys) } };
}

/** A saved idempotency response can confirm a receipt only when it equals immutable receipt truth. */
export function confirmAnnouncementReadResponse(db, ctx, recordId, version, value, status, key) {
  const expected = ownReceipt(db, ctx, { id: recordId, version });
  if (![200, 201].includes(status) || !expected || !exactKeys(value, ['receipt']) || !exactKeys(value.receipt, receiptKeys)
      || !isDeepStrictEqual(value.receipt, expected)) invalidReceipt();
  if (key) {
    const cached = fullTextGet(db, `SELECT status, ${fullTextProjection(['response'])}
      FROM idempotency WHERE org_id = ? AND user_id = ? AND key = ?`,
    [ctx.orgId, ctx.user.id, key], ['response'], invalidReceipt);
    if (!cached || cached.status !== BigInt(status)) invalidReceipt();
    const cachedValue = parseReceiptSnapshot(cached.response);
    if (!exactKeys(cachedValue, ['receipt']) || !exactKeys(cachedValue.receipt, receiptKeys)
        || !isDeepStrictEqual(cachedValue.receipt, expected) || !isDeepStrictEqual(cachedValue, value)) invalidReceipt();
  }
  return { receipt: expected };
}
