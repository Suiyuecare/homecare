import { confirmAnnouncementReadState, savedAnnouncementText } from './announcement-read-receipts.js';

const PAGE_SIZE = 25;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = value => typeof value === 'string' && value.length > 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const routeId = value => typeof value === 'string' && /^[a-f0-9-]+$/.test(value);

function unconfirmed() {
  const error = new Error('本頁本人回執資料無法確認；請重新查詢。');
  error.code = 'ANNOUNCEMENT_PAGE_RECEIPTS_UNCONFIRMED';
  throw error;
}

function data(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) unconfirmed();
  return descriptor.value;
}

function exact(value, names) {
  if (!plain(value)) unconfirmed();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || keys.some(key => !names.includes(key))) unconfirmed();
  return names.map(key => data(value, key));
}

function dense(value, maximum = Infinity) {
  if (!Array.isArray(value)) unconfirmed();
  const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || !Number.isSafeInteger(descriptor.value)
    || descriptor.value < 0 || descriptor.value > maximum) unconfirmed();
  const length = descriptor.value;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes('length')) unconfirmed();
  return Array.from({ length }, (_, index) => data(value, String(index)));
}

function pagination(page, pageSize, total) {
  if (!positive(page) || pageSize !== PAGE_SIZE || !Number.isSafeInteger(total) || total < 0) unconfirmed();
  const offset = (page - 1) * PAGE_SIZE;
  if (!Number.isSafeInteger(offset) || offset < 0) unconfirmed();
  return Math.min(PAGE_SIZE, Math.max(0, total - offset));
}

function ids(values, expectedLength) {
  const copied = dense(values, PAGE_SIZE);
  if (copied.length > PAGE_SIZE || copied.length !== expectedLength
    || !copied.every(routeId) || new Set(copied).size !== copied.length) unconfirmed();
  return Object.freeze(copied);
}

function identityValue(value, key) {
  if (value === null || value === undefined) return undefined;
  if (!plain(value)) unconfirmed();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) unconfirmed();
  return descriptor.value;
}

function primitive(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) return value;
  unconfirmed();
}

export function announcementPageIdentity(context) {
  const user = identityValue(context, 'user');
  const organizationId = identityValue(context, 'organizationId');
  return JSON.stringify([
    primitive(identityValue(user, 'id')),
    primitive(organizationId ?? identityValue(context, 'orgId')),
    primitive(identityValue(context, 'role')),
    primitive(identityValue(user, 'employeeId')),
  ]);
}

export function captureAnnouncementPage(result, requested) {
  const [requestedPage, requestedSize, orgId] = exact(requested, ['page', 'pageSize', 'orgId']);
  if (!text(orgId) || !positive(requestedPage) || requestedSize !== PAGE_SIZE) unconfirmed();
  const [items, total, page, pageSize] = exact(result, ['items', 'total', 'page', 'pageSize']);
  const expectedLength = pagination(page, pageSize, total);
  if (page !== requestedPage || pageSize !== requestedSize) unconfirmed();
  const rows = dense(items, PAGE_SIZE);
  if (rows.length > PAGE_SIZE || rows.length !== expectedLength) unconfirmed();
  const captured = rows.map(row => {
    if (!plain(row)) unconfirmed();
    const id = data(row, 'id');
    if (!routeId(id) || data(row, 'orgId') !== orgId || !positive(data(row, 'version'))
      || !text(data(row, 'createdAt')) || !text(data(row, 'updatedAt'))) unconfirmed();
    return id;
  });
  return Object.freeze({ orgId, page, pageSize, total, ids: ids(captured, expectedLength) });
}

export function confirmAnnouncementPageSnapshot(snapshot, expected) {
  const [expectedOrg] = exact(expected, ['orgId']);
  const [orgId, page, pageSize, total, captured] = exact(snapshot, ['orgId', 'page', 'pageSize', 'total', 'ids']);
  if (!text(expectedOrg) || orgId !== expectedOrg) unconfirmed();
  return Object.freeze({ orgId, page, pageSize, total, ids: ids(captured, pagination(page, pageSize, total)) });
}

// The original confirmation reads JSON values directly. Copy through descriptors first
// so it cannot execute an imported getter or observe later mutation during its digest.
function jsonData(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) return value;
  if ((!plain(value) && !Array.isArray(value)) || ancestors.has(value)) unconfirmed();
  ancestors.add(value);
  let copied;
  if (Array.isArray(value)) copied = dense(value).map(item => jsonData(item, ancestors));
  else {
    copied = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') unconfirmed();
      Object.defineProperty(copied, key, {
        value: jsonData(data(value, key), ancestors), enumerable: true, configurable: true, writable: true,
      });
    }
  }
  ancestors.delete(value);
  return copied;
}

export async function projectAnnouncementPageReadState(response, expected) {
  const [id, orgId, userId] = exact(expected, ['id', 'orgId', 'userId']);
  if (!routeId(id) || !text(orgId) || !text(userId)) unconfirmed();
  const confirmed = await confirmAnnouncementReadState(jsonData(response), { id, orgId, userId });
  return Object.freeze({
    id: confirmed.announcement.id,
    title: savedAnnouncementText(confirmed.announcement.title),
    version: confirmed.currentVersion,
    receiptState: confirmed.receipt === null ? 'absent' : 'saved',
    readAt: confirmed.receipt === null ? null : confirmed.receipt.readAt,
    canAcknowledge: confirmed.canAcknowledge,
  });
}
