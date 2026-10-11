/** Manually approved organization rules. No statutory defaults or external execution. */
export const RULE_KINDS = Object.freeze({ pricing: '計價與自付', payroll: '薪資與拆帳', attendance: '差勤', assessment: '評估計分', claims: '核銷格式', closing: '結算與關帳' });
export const RULE_STATUSES = Object.freeze({ draft: '待核定', approved: '機構已核定', inactive: '已停用' });
export const RULE_PARAMETERS = Object.freeze({
  pricing: [{ key: 'unitPriceCents', label: '每單位金額（分）', max: 100000000 }, { key: 'copayBasisPoints', label: '自付比例（萬分比）', max: 10000 }, { key: 'monthlyCapCents', label: '月額度（分）', max: 1000000000 }],
  payroll: [{ key: 'baseCents', label: '核定基準金額（分）', max: 1000000000 }, { key: 'shareBasisPoints', label: '拆帳比例（萬分比）', max: 10000 }],
  attendance: [{ key: 'graceMinutes', label: '寬限分鐘', max: 1440 }, { key: 'roundingMinutes', label: '折算單位（分鐘）', min: 1, max: 1440 }],
  assessment: [{ key: 'minimumScore', label: '最低分數', max: 1000000 }, { key: 'maximumScore', label: '最高分數', max: 1000000 }],
  claims: [{ key: 'formatVersion', label: '核定格式版本', type: 'text', maxLength: 100 }],
  closing: [{ key: 'reopenWindowDays', label: '允許申請重開的天數', max: 366 }],
});
export function confirmRule(item, { orgId, id, version, expected } = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || item.orgId !== orgId
      || !Number.isSafeInteger(item.version) || item.version < 1 || (id && item.id !== id) || (version && item.version !== version)
      || !Object.hasOwn(RULE_KINDS, item.kind) || !Object.hasOwn(RULE_STATUSES, item.status)) throw new Error('無法確認規則保存結果，請重新讀取。');
  for (const key of ['code', 'name', 'validFrom', 'validTo', 'sourceReference', 'note']) if (typeof item[key] !== 'string') throw new Error('規則資料格式無法確認。');
  const definitions = RULE_PARAMETERS[item.kind];
  if (!item.parameters || typeof item.parameters !== 'object' || Array.isArray(item.parameters)
      || Object.keys(item.parameters).length !== definitions.length) throw new Error('規則參數無法確認。');
  for (const d of definitions) {
    const v = item.parameters[d.key];
    if (d.type === 'text' ? typeof v !== 'string' || !v.trim() || v.length > d.maxLength
      : !Number.isSafeInteger(v) || v < (d.min || 0) || v > d.max) throw new Error('規則參數格式無法確認。');
  }
  for (const [key, value] of Object.entries(expected || {})) if (JSON.stringify(item[key]) !== JSON.stringify(value)) throw new Error('保存內容未確認，請保留輸入並重新讀取。');
  return item;
}
