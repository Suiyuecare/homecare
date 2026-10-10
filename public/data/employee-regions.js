const INVALID_REGIONS = Object.freeze({ invalid: true });
const isStringList = value => Array.isArray(value) && Array.from(value).every(item => typeof item === 'string');

/** Keeps saved region types and list order; malformed source values never escape. */
export function normalizeEmployeeRegions(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') return value;
  if (isStringList(value)) return [...value];
  return INVALID_REGIONS;
}

export function isNormalizedEmployeeRegions(value) {
  return value === null || typeof value === 'string' || isStringList(value)
    || (typeof value === 'object' && !Array.isArray(value) && value !== null
      && Object.keys(value).length === 1 && Object.hasOwn(value, 'invalid') && value.invalid === true);
}

export function formatEmployeeRegions(value) {
  const saved = normalizeEmployeeRegions(value);
  if (saved === null) return '未提供';
  if (typeof saved === 'string') return `保存文字：${saved}`;
  if (!Array.isArray(saved)) return '[欄位格式無法判讀]';
  if (!saved.length) return '空清單（0 項）';
  return `保存清單（${saved.length} 項）\n${saved.map((item, index) => `${index + 1}. ${item === '' ? '空字串' : `「${item}」`}`).join('\n')}`;
}

export function serializeEmployeeRegions(value) {
  const saved = normalizeEmployeeRegions(value);
  if (saved === null) return '未提供';
  if (typeof saved === 'string') return `保存文字：${JSON.stringify(saved)}`;
  if (!Array.isArray(saved)) return '[欄位格式無法判讀]';
  return `${saved.length ? `保存清單（${saved.length} 項）` : '空清單（0 項）'}：${JSON.stringify(saved)}`;
}
