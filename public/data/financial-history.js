// Read only known saved fields. Unknown properties and accessors are never read.
const invalid = '[欄位格式無法判讀]';
function own(value, key) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const d = Object.getOwnPropertyDescriptor(value, key);
  return d && Object.hasOwn(d, 'value') ? d.value : undefined;
}
const text = value => typeof value === 'string' ? value : invalid;
const cents = value => Number.isSafeInteger(value) && value >= 0 ? value : invalid;
export function financialHistoryLines(value, payroll = false) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) return invalid;
  const output = [];
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !Object.hasOwn(d, 'value')) return invalid;
    const row = d.value;
    output.push(payroll ? { label: text(own(row, 'label')), kind: text(own(row, 'kind')), amountCents: cents(own(row, 'amountCents')) }
      : { label: text(own(row, 'label')), quantity: Number.isSafeInteger(own(row, 'quantity')) && own(row, 'quantity') > 0 ? own(row, 'quantity') : invalid,
        unitPriceCents: cents(own(row, 'unitPriceCents')) });
  }
  return output;
}
export function financialHistorySummary(value, payroll = false) {
  const fields = payroll ? [['earningCents', '加項合計'], ['deductionCents', '減項合計'], ['netCents', '淨額']] : [['amountCents', '帳單金額']];
  return fields.map(([key, label]) => ({ label, value: cents(own(value, key)) }));
}
export function financialHistoryParty(source, payroll = false) {
  const value = own(source, payroll ? 'employeeSnapshot' : 'caseSnapshot');
  const parent = own(source, payroll ? 'employeeId' : 'caseId');
  if (typeof parent !== 'string' || !parent.trim() || own(value, 'id') !== parent) return invalid;
  return [{ label: '保存姓名', value: text(own(value, 'name')) },
    { label: payroll ? '保存員工編號' : '保存個案案號', value: text(own(value, payroll ? 'employeeNo' : 'caseNo')) }];
}
