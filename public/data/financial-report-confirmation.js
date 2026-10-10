// Confirms the existing saved-snapshot DTO without repairing data or calculating payroll.
const NOTE = '試算、未核定規則。僅計入已核閱服務，以核閱時保存的價格及時薪快照計算；未處理補助、自付額、加班、稅費或正式薪資/核銷規則，不可作正式申報。示範資料與價格均為合成測試值。';
const SCHEMAS = {
  fees: {
    title: '費用試算（未核定規則）',
    columns: [['date', '日期'], ['case', '個案'], ['serviceCode', '測試服務代碼'], ['service', '服務項目'], ['quantity', '數量'], ['unitPriceCents', '單價（分）'], ['amountCents', '試算金額（分）']],
    text: ['date', 'case', 'serviceCode', 'service'], totals: ['count', 'amountCents'],
  },
  payroll: {
    title: '薪資試算（未核定規則）',
    columns: [['employeeNo', '員工編號'], ['employee', '員工'], ['minutes', '核閱服務分鐘'], ['hourlyRateCents', '時薪（分）'], ['amountCents', '試算金額（分）']],
    text: ['employeeNo', 'employee'], totals: ['count', 'amountCents', 'minutes'],
  },
};
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const reject = () => {
  const error = new Error('未取得完整且一致的試算報表，請重新讀取。');
  error.code = 'REPORT_UNCONFIRMED';
  throw error;
};

export function confirmFinancialReport(kind, result, month) {
  const schema = typeof kind === 'string' && Object.hasOwn(SCHEMAS, kind) ? SCHEMAS[kind] : null;
  if (!schema || typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)
      || !exactKeys(result, ['title', 'columns', 'rows', 'totals', 'note'])
      || result.title !== schema.title || result.note !== NOTE
      || !Array.isArray(result.columns) || result.columns.length !== schema.columns.length
      || !schema.columns.every(([key, label], index) => exactKeys(result.columns[index], ['key', 'label'])
        && result.columns[index].key === key && result.columns[index].label === label)
      || !Array.isArray(result.rows) || !exactKeys(result.totals, schema.totals)
      || !schema.totals.every(key => integer(result.totals[key]))
      || result.totals.count !== result.rows.length) reject();

  let amount = 0n, minutes = 0n;
  const keys = schema.columns.map(([key]) => key);
  for (const row of result.rows) {
    if (!exactKeys(row, keys) || !schema.text.every(key => typeof row[key] === 'string')
        || !integer(row.amountCents)) reject();
    if (kind === 'fees') {
      // Preserve the legacy literal prefix rule, including imported ISO suffixes and year0000.
      if (!row.date.startsWith(month) || !integer(row.quantity, 1, 10000)
          || !integer(row.unitPriceCents, 0, 1e9)) reject();
    } else {
      // Payroll has no month/org echo; its grouping identity is not part of the visible DTO.
      if (!integer(row.minutes, 1) || !integer(row.hourlyRateCents, 0, 1e9)) reject();
      minutes += BigInt(row.minutes);
    }
    amount += BigInt(row.amountCents);
  }
  if (amount !== BigInt(result.totals.amountCents)
      || (kind === 'payroll' && minutes !== BigInt(result.totals.minutes))) reject();
  return result;
}
