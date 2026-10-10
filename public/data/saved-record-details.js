const metadataKeys = ['id', 'orgId', 'version', 'createdAt', 'updatedAt'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const identifier = value => typeof value === 'string' && Boolean(value.trim());
export const isSavedRecordDetailsId = value => typeof value === 'string' && /^[a-f0-9-]+$/.test(value);

export function savedRecordDetailsIdentity(context) {
  return JSON.stringify([context?.user?.id ?? null, context?.organizationId ?? context?.orgId ?? null,
    context?.role ?? null, context?.user?.employeeId ?? null]);
}

function dataValue(value, key, reject, { required = true, enumerable = true } = {}) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) {
    if (required) reject();
    return { present: false };
  }
  if (!Object.hasOwn(descriptor, 'value') || (enumerable && !descriptor.enumerable)) reject();
  return { present: true, value: descriptor.value };
}

function exactData(value, keys, reject) {
  if (!plain(value)) reject();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) reject();
  return Object.fromEntries(keys.map(key => [key, dataValue(value, key, reject).value]));
}

function textProjection(saved) {
  if (!saved.present) return { kind: 'missing', text: '未保存' };
  if (saved.value === null) return { kind: 'null', text: '未提供（null）' };
  if (typeof saved.value === 'string') return {
    kind: saved.value === '' ? 'empty' : 'text', text: saved.value === '' ? '空白' : saved.value,
  };
  return { kind: 'non-text', text: `非文字值（${Array.isArray(saved.value) ? 'array' : typeof saved.value}）` };
}

/** Known descriptors only; a domain projection receives no raw record or unknown property. */
export function confirmSavedRecordDetails(response, requested, { fields, projectField, unconfirmed }) {
  try {
    const query = exactData(requested, ['id', 'orgId'], unconfirmed);
    const envelope = exactData(response, ['item'], unconfirmed);
    if (!isSavedRecordDetailsId(query.id) || !identifier(query.orgId) || !plain(envelope.item)) unconfirmed();
    const item = envelope.item;
    const metadata = Object.fromEntries(metadataKeys.map(key => [key, dataValue(item, key, unconfirmed).value]));
    if (metadata.id !== query.id || metadata.orgId !== query.orgId
      || !Number.isSafeInteger(metadata.version) || metadata.version < 1
      || typeof metadata.createdAt !== 'string' || typeof metadata.updatedAt !== 'string') unconfirmed();
    const projected = fields.map(field => {
      const saved = Object.freeze(dataValue(item, field.key, unconfirmed, { required: false, enumerable: false }));
      const fallback = Object.freeze(textProjection(saved));
      const projection = projectField ? projectField(field, saved, fallback, unconfirmed) : fallback;
      if (!projection || !['missing', 'empty', 'null', 'text', 'non-text'].includes(projection.kind)
        || typeof projection.text !== 'string') unconfirmed();
      return Object.freeze({ key: field.key, label: field.label, kind: projection.kind, text: projection.text });
    });
    return Object.freeze({ ...metadata, fields: Object.freeze(projected) });
  } catch { unconfirmed(); }
}
