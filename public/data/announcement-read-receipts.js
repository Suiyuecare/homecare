// Fixed public projections only. No nested imported content becomes display text.
const announcementKeys = ['id', 'orgId', 'version', 'createdAt', 'updatedAt', 'title', 'body', 'audience', 'status'];
const receiptKeys = ['id', 'orgId', 'announcementId', 'announcementVersion', 'userId', 'userName', 'role', 'readAt'];
const roles = ['admin', 'supervisor', 'finance', 'caregiver'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const keys = (value, expected) => plain(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const text = value => typeof value === 'string' && value.length > 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
function unconfirmed() {
  const error = new Error('閱讀結果未確認；請重新讀取，或重試記錄本版閱讀。');
  error.code = 'ANNOUNCEMENT_READ_UNCONFIRMED';
  throw error;
}
function json(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return true;
  if ((!plain(value) && !Array.isArray(value)) || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Object.keys(value).every(key => json(value[key], ancestors));
  ancestors.delete(value);
  return valid;
}
export function canonicalReadTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}
export function savedAnnouncementText(value) {
  if (typeof value === 'string') return value === '' ? '空文字' : value;
  if (value === null) return '保存類型：空值';
  if (Array.isArray(value)) return '保存類型：清單';
  return `保存類型：${{ number: '數字', boolean: '布林值', object: '物件' }[typeof value] || '其他類型'}`;
}
export function parseAnnouncementVersion(value) {
  if (!positive(value)) { const error = new Error('請輸入正整數公告版次。'); error.fields = { version: error.message }; throw error; }
  return value;
}
export async function announcementReadId({ orgId, announcementId, announcementVersion, userId }) {
  if (!text(orgId) || !text(announcementId) || !positive(announcementVersion) || !text(userId)) unconfirmed();
  const tuple = JSON.stringify(['suiyue-announcement-read-v1', orgId, announcementId, announcementVersion, userId]);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(tuple));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function announcement(value, expected) {
  if (!keys(value, announcementKeys) || value.id !== expected.id || value.orgId !== expected.orgId || !positive(value.version)
    || !text(value.createdAt) || !text(value.updatedAt) || !['title', 'body', 'audience', 'status'].every(key => json(value[key]))
    || (expected.version !== undefined && value.version !== expected.version)) unconfirmed();
  return value;
}
export async function confirmAnnouncementReceipt(value, expected) {
  if (!keys(value, receiptKeys) || !text(value.orgId) || !text(value.announcementId) || !positive(value.announcementVersion)
    || !text(value.userId) || typeof value.userName !== 'string' || !roles.includes(value.role) || !canonicalReadTime(value.readAt)
    || value.orgId !== expected.orgId || value.announcementId !== expected.id || value.announcementVersion !== expected.version
    || (expected.userId !== undefined && value.userId !== expected.userId)
    || (expected.role !== undefined && value.role !== expected.role)
    || (expected.userName !== undefined && value.userName !== expected.userName)
    || value.id !== await announcementReadId(value)) unconfirmed();
  return value;
}
export async function confirmAnnouncementReadState(value, expected) {
  if (!keys(value, ['announcement', 'currentVersion', 'canAcknowledge', 'receipt']) || !positive(value.currentVersion) || typeof value.canAcknowledge !== 'boolean') unconfirmed();
  const item = announcement(value.announcement, expected);
  if (expected.version === undefined && item.version !== value.currentVersion) unconfirmed();
  const eligible = item.version === value.currentVersion && item.status === 'published' && text(item.title) && text(item.body);
  if (value.canAcknowledge !== eligible) unconfirmed();
  if (value.receipt !== null) await confirmAnnouncementReceipt(value.receipt, { ...expected, version: item.version });
  return value;
}
export async function confirmAnnouncementReadResult(value, expected) {
  if (!keys(value, ['receipt'])) unconfirmed();
  await confirmAnnouncementReceipt(value.receipt, expected);
  return value;
}
export async function confirmAnnouncementReadRoster(value, expected) {
  if (!keys(value, ['announcement', 'currentVersion', 'items', 'total', 'page', 'pageSize']) || !positive(value.currentVersion)
    || !Array.isArray(value.items) || !Number.isSafeInteger(value.total) || value.total < 0
    || !positive(value.page) || !positive(value.pageSize) || value.pageSize > 100
    || value.page !== expected.page || value.pageSize !== expected.pageSize) unconfirmed();
  const item = announcement(value.announcement, expected);
  if (expected.version === undefined && item.version !== value.currentVersion) unconfirmed();
  const offset = (value.page - 1) * value.pageSize;
  if (!Number.isSafeInteger(offset) || offset < 0 || value.items.length !== Math.min(value.pageSize, Math.max(0, value.total - offset))) unconfirmed();
  const ids = new Set(), users = new Set();
  let previous;
  for (const receipt of value.items) {
    await confirmAnnouncementReceipt(receipt, { id: expected.id, orgId: expected.orgId, version: item.version });
    if (ids.has(receipt.id) || users.has(receipt.userId) || (previous && (previous.readAt < receipt.readAt || (previous.readAt === receipt.readAt && previous.id > receipt.id)))) unconfirmed();
    ids.add(receipt.id); users.add(receipt.userId); previous = receipt;
  }
  return value;
}
