import { api, el, button, table, openDetails, downloadCsv, toast, getContext } from '../ui.js';
import { confirmFinancialOutput, financialOutputPath, financialOutputMoney, FINANCIAL_OUTPUT_TITLES } from '../data/financial-output-editor.js';

const statuses = { billing: { draft: '草稿', issued: '已開立', voided: '已作廢' }, payroll: { draft: '草稿', reviewed: '已覆核', closed: '已關帳', voided: '已取消' } };
const identity = context => JSON.stringify([context.user?.id, context.organizationId || context.orgId, context.role, context.user?.employeeId || context.employeeId || '']);
const aborted = () => { throw new DOMException('操作已取消，請重新讀取目前資料。', 'AbortError'); };
const fields = values => el('dl', { class: 'detail-grid' }, values.map(([label, value]) => el('div', { class: ['人工核定依據（保存原文）', '備註／原因（保存原文）'].includes(label) ? 'field-wide' : '' }, el('dt', {}, label), el('dd', { class: 'pre-wrap' }, value))));

function renderOutput(output) {
  const item = output.record, payroll = output.kind === 'payroll', snapshot = payroll ? item.employeeSnapshot : item.caseSnapshot;
  const rows = payroll
    ? [{ label: '保存明細名稱', key: 'label' }, { label: '加項／減項', render: row => row.kind === 'earning' ? '加項' : '減項' }, { label: '保存金額', render: row => financialOutputMoney(row.amountCents) }]
    : [{ label: '保存明細名稱', key: 'label' }, { label: '保存數量', key: 'quantity' }, { label: '保存單價', render: row => financialOutputMoney(row.unitPriceCents) }];
  const summary = payroll ? [['保存加項合計', financialOutputMoney(item.summary.earningCents)], ['保存減項合計', financialOutputMoney(item.summary.deductionCents)], ['保存淨額', financialOutputMoney(item.summary.netCents)]] : [['文件保存總額', financialOutputMoney(item.summary.amountCents)]];
  return el('section', {}, el('h2', {}, output.title), el('p', { class: 'notice' }, output.note),
    fields([['目前授權機構名稱', output.organization.name], ['保存機構識別', item.orgId], ['保存編號', item.number], ['月份', item.month], ['保存狀態', statuses[output.kind][item.status]], ['保存版次', String(item.version)], [payroll ? '保存員工識別' : '保存個案識別', item[payroll ? 'employeeId' : 'caseId']], [payroll ? '建立時員工姓名' : '建立時個案姓名', snapshot.name], [payroll ? '建立時員編' : '建立時案號', snapshot[payroll ? 'employeeNo' : 'caseNo']], ['保存識別碼', item.id], ['建立時間', item.createdAt], ['更新時間', item.updatedAt]]),
    table(rows, item.lineItems, { caption: '本次保存版次完整明細' }), fields(summary),
    fields([['人工核定依據（保存原文）', item.sourceReference], ['備註／原因（保存原文）', item.note]]));
}

/** Existing detail owners provide lifetime/abort; shared UI owns all dialogs and printing. */
export function financialOutputActions({ kind, record, signal, isCurrent = () => true }) {
  const context = getContext(), fingerprint = identity(context), orgId = context.organizationId || context.orgId;
  const request = Object.freeze({ kind, id: record.id, orgId, version: record.version });
  financialOutputPath(request);
  const current = () => !signal?.aborted && isCurrent() && getContext() === context && identity(getContext()) === fingerprint && ['admin', 'finance'].includes(getContext().role);
  const group = el('div', { class: 'actions', 'data-no-print': true });
  const read = async (readSignal, alive) => {
    if (!alive()) aborted();
    const result = confirmFinancialOutput(await api(financialOutputPath(request), { signal: readSignal }), request);
    if (!alive()) aborted(); return result;
  };
  let downloading = false;
  const csv = button('匯出保存明細 CSV', async () => {
    if (downloading || !current() || !csv.isConnected) return;
    downloading = true; csv.disabled = true; csv.setAttribute('aria-busy', 'true');
    const alive = () => current() && csv.isConnected;
    try {
      await read(signal, alive);
      await downloadCsv(financialOutputPath(request, true), { signal, isCurrent: alive, filename: `${kind}-saved-v${request.version}.csv` });
    } catch (error) { if (alive() && error.name !== 'AbortError') toast(error.message, 'error'); }
    finally { downloading = false; if (csv.isConnected) { csv.disabled = false; csv.removeAttribute('aria-busy'); } }
  }, { variant: 'outline' });
  const print = button('列印保存明細', () => {
    const alive = () => current() && print.isConnected;
    if (!alive()) return;
    return openDetails({ title: FINANCIAL_OUTPUT_TITLES[kind], wide: true, printable: true, guardedRead: true, isCurrent: alive,
      loadingText: '正在重新核對保存版次與輸出權限…',
      load: async (readSignal, owner) => renderOutput(await read(readSignal, () => alive() && owner.isCurrent())) });
  }, { variant: 'outline' });
  group.append(csv, print, el('p', { class: 'small' }, 'CSV 會以安全文字格式處理可能被試算表執行的內容；保存原文與列印不變。')); return group;
}
