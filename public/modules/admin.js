import { openInterviewRecordDetails } from './interview-record-details.js';
import { openEmployeeRecordIndex } from './employee-record-index.js';
import {
  api, el, pageHeader, table, badge, button, openForm, confirmAction,
  toast, formatDate, formatMoney, today, getContext, fetchAll,
  searchBox, pagination, errorState, downloadCsv, refreshSession, openDetails,
} from '../ui.js';
import { setPersonnelEmployeeFilter } from './personnel.js';
import { openPersonalCalendarMonth } from './personal-calendar-month.js';
import { openPersonalCalendarYear } from './personal-calendar-year.js';
import { mountShiftReport } from './shift-report.js';
import { mountServiceReport } from './service-report.js';
import { mountCaseReport } from './case-report.js';
import { mountEmployeeReport } from './employee-report.js';
import { mountLeaveReport } from './leave-report.js';
import { mountTrainingReport } from './training-report.js';
import { mountCertificationReport } from './certification-report.js';
import { openRecordHistory } from './history.js';
import { openLeaveShiftConflicts } from './leave-shift-conflicts.js';
import { openAnnouncementRead, openAnnouncementReadReceipts } from './announcement-read-receipts.js';
import { createAssessmentEditor } from '../data/assessment-editor.js';
import { createAnnouncementEditor } from '../data/announcement-editor.js';
import { createServiceItemEditor } from '../data/service-item-editor.js';
import { createEmployeeEditor } from '../data/employee-editor.js';
import { createLeaveEditor } from '../data/leave-editor.js';
import { createInterviewApplicantEditor, INTERVIEW_STATUSES, confirmInterviewApplicantList,
  formatInterviewText, formatInterviewDate, formatInterviewStatus, isInterviewDate } from '../data/interview-applicant-editor.js';
import { createPersonalCalendarEditor, PERSONAL_CALENDAR_STATUSES, confirmPersonalCalendarList,
  personalCalendarIdentity, formatPersonalCalendarText, formatPersonalCalendarStatus, isPersonalCalendarDate } from '../data/personal-calendar-editor.js';
import { formatTrialPriceCents } from '../data/history-fields.js';
import { confirmFinancialReport } from '../data/financial-report-confirmation.js';
import { SUPERVISORY_VISIT_QUESTIONS, SUPERVISORY_VISIT_STATUSES, isSupervisoryVisitDate,
  confirmSupervisoryVisitList, confirmSupervisoryVisitItem, supervisoryVisitAnswerText,
  supervisoryVisitAnswerSummary, formatSupervisoryVisitStatus } from '../data/supervisory-visit-view.js';
import { NEEDS_ASSESSMENT_QUESTIONS, NEEDS_ASSESSMENT_STATUSES, isNeedsAssessmentDate,
  confirmNeedsAssessmentList, confirmNeedsAssessmentItem, needsAssessmentAnswerText,
  needsAssessmentAnswerSummary, formatNeedsAssessmentStatus, needsAssessmentIdentity } from '../data/needs-assessment-view.js';
import { confirmCalendarLookupPage, confirmCalendarLookups } from '../data/shift-calendar-person-filters.js';
import { CASE_FOLLOWUP_WORKLIST_FIELDS, CASE_FOLLOWUP_WORKLIST_KINDS, CASE_FOLLOWUP_WORKLIST_STATUSES,
  caseFollowupWorklistIdentity, isCaseFollowupWorklistDate, confirmCaseFollowupWorklistList,
  confirmCaseFollowupWorklistItem, caseFollowupWorklistFieldText, caseFollowupWorklistFieldSummary,
  formatCaseFollowupWorklistKind, formatCaseFollowupWorklistStatus } from '../data/case-followup-worklist-view.js';

const PAGE_SIZE = 25;
const STATUS = {
  active: '啟用', inactive: '停用', pending: '待審核', approved: '已核准',
  rejected: '已駁回', cancelled: '已取消', draft: '草稿', submitted: '已提交',
  published: '已發布',
};
const ROLE = { admin: '管理者', supervisor: '督導', caregiver: '居服員', finance: '財務' };
const AUDIENCE = { all: '全體同仁', caregiver: '居服員', supervisor: '督導', finance: '財務', admin: '管理者' };
const REPORTS = [
  { value: 'employees', label: '員工總表' },
  { value: 'leaves', label: '請假總表' },
  { value: 'trainings', label: '訓練總表' },
  { value: 'certifications', label: '證照總表' },
  { value: 'cases', label: '個案清冊' }, { value: 'shifts', label: '排班明細' },
  { value: 'services', label: '服務紀錄' }, { value: 'fees', label: '費用試算' },
  { value: 'payroll', label: '薪資試算' },
];
let generation = 0;
let templatesPromise;
const options = dictionary => Object.entries(dictionary).map(([value, label]) => ({ value, label }));
const writable = () => ['admin', 'supervisor'].includes(getContext().role);
const contextIdentity = () => {
  const context = getContext();
  return `${context.user?.id || ''}:${context.organizationId || context.orgId || ''}:${context.role || ''}:${context.user?.employeeId || ''}`;
};
const actions = (...children) => el('div', { class: 'actions row-actions' }, ...children.filter(Boolean));
const note = text => el('p', { class: 'muted' }, text);
const statusCell = value => { const node = badge(value); node.textContent = STATUS[value] || value || '—'; return node; };
const field = (name, label, type = 'text', extra = {}) => ({ name, label, type, ...extra });
const timestamp = value => value ? new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)) : '—';
const textValue = value => value === null || value === undefined || value === '' ? '—' : String(value);
const lookup = rows => new Map(rows.map(row => [row.id, row]));
const selectedOptions = (rows, labelKey = 'name') => rows.map(row => ({ value: row.id, label: `${row[labelKey]}${row.employeeNo || row.caseNo ? ` · ${row.employeeNo || row.caseNo}` : ''}` }));
function safeAction(action) {
  return async () => { try { await action(); } catch (error) { toast(error.message || '操作失敗，請重試。', 'error'); } };
}
function notice(title, message) {
  return el('aside', { class: 'notice', role: 'note' }, el('strong', {}, title), el('p', {}, message));
}
function selectControl(label, choices, value, onChange) {
  const select = el('select', { class: 'input', 'aria-label': label },
    ...choices.map(choice => el('option', { value: choice.value }, choice.label)));
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  return el('label', { class: 'filter-field' }, el('span', {}, label), select);
}
async function save(entity, values, existing, { signal } = {}) {
  return api(existing ? `/api/${entity}/${encodeURIComponent(existing.id)}` : `/api/${entity}`, {
    method: existing ? 'PATCH' : 'POST',
    body: existing ? { ...values, version: existing.version } : values,
    ...(signal ? { signal } : {}),
  });
}
function changeStatus(entity, row, status, refresh, message) {
  const verb = { active: '啟用', inactive: '停用', approved: '核准', rejected: '駁回', cancelled: '取消', draft: '撤回草稿' }[status] || STATUS[status];
  return confirmAction({
    title: `${verb}這筆資料`, message,
    confirmLabel: `確認${verb}`, danger: ['inactive', 'cancelled', 'rejected'].includes(status),
    onConfirm: async () => {
      await save(entity, { status }, row);
      toast(`已${verb}`, 'success');
      await refresh();
    },
  });
}

async function listPage(container, config, alive) {
  let page = 1;
  let query = '';
  let status = '';
  let kind = '';
  let date = '';
  let caseId = '';
  let caseControl, caseFieldError;
  let sequence = 0;
  let controller;
  const body = el('div', { class: 'list-content', 'aria-live': 'polite', 'aria-atomic': 'false' });
  const footer = el('div', { class: 'list-footer' });
  const load = async () => {
    if (config.confirmList && !alive()) return;
    const request = ++sequence;
    controller?.abort();
    controller = new AbortController();
    body.replaceChildren(el('p', { class: 'loading', role: 'status' }, '正在讀取資料…'));
    footer.replaceChildren();
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (query) params.set('q', query);
    if (status) params.set('status', status);
    if (config.kindFilter && kind) params.set('kind', kind);
    if (config.dateFilter && date) params.set(config.dateFilter.key, date);
    if (config.caseFilter && caseId) params.set(config.caseFilter.key, caseId);
    const requested = config.confirmList ? config.requested
      ? config.requested(params, { page, pageSize: PAGE_SIZE, orgId: getContext().organizationId || getContext().orgId })
      : { page, pageSize: PAGE_SIZE, orgId: getContext().organizationId || getContext().orgId,
        status: params.get('status') || '', interviewDate: params.get('interviewDate') || '' } : null;
    try {
      if (config.dateFilter && date && !config.dateFilter.valid(date)) throw new Error(config.dateFilter.errorMessage || '請選擇有效的面試日期。');
      if (config.caseFilter) {
        caseFieldError.hidden = true; caseControl.setAttribute('aria-invalid', 'false');
        const choices = await config.caseFilter.loadOptions(controller.signal);
        if (!alive() || request !== sequence) return;
        const selected = params.get(config.caseFilter.key) || '';
        const previous = [...caseControl.options].find(option => option.value === selected)?.textContent;
        caseControl.replaceChildren(el('option', { value: '' }, config.caseFilter.emptyLabel),
          ...choices.map(choice => el('option', { value: choice.value }, choice.label)));
        caseControl.disabled = false;
        if (selected && !choices.some(choice => choice.value === selected)) {
          caseControl.append(el('option', { value: selected }, previous || `原選擇個案 · ${selected}`));
          caseControl.value = selected;
          const error = new Error('原選擇個案已無法確認；請重新選擇個案或明確清除條件。');
          error.fields = { [config.caseFilter.key]: error.message }; throw error;
        }
        caseControl.value = selected;
      }
      const result = await api(`${config.endpoint || `/api/${config.entity}`}?${params}`, { signal: controller.signal });
      if (!alive() || request !== sequence) return;
      config.confirmList?.(result, requested);
      if (page > 1 && !result.items.length && result.total > 0) { page = Math.ceil(result.total / PAGE_SIZE); return load(); }
      body.replaceChildren(table(config.columns(load), result.items, {
        emptyText: query || status || kind || date || caseId ? '沒有符合條件的資料，請調整查詢。' : (config.emptyText || '目前尚無資料。'),
      }));
      footer.replaceChildren(pagination({ page: result.page ?? page, pageSize: result.pageSize ?? PAGE_SIZE, total: result.total, onChange: next => { page = next; void load(); } }));
    } catch (error) {
      if (!alive() || request !== sequence || error.name === 'AbortError') return;
      if (config.caseFilter && error.fields?.[config.caseFilter.key]) {
        caseControl.setAttribute('aria-invalid', 'true');
        caseFieldError.textContent = error.fields[config.caseFilter.key]; caseFieldError.hidden = false;
      }
      body.replaceChildren(errorState(error, load));
    }
  };
  const toolbar = el('div', { class: 'toolbar' }, searchBox({
    value: query, label: config.searchLabel || '搜尋資料', placeholder: config.placeholder || '輸入關鍵字',
    onSearch: value => { query = config.preserveSearchText ? toolbar.querySelector('input[type="search"]').value : value; page = 1; void load(); },
  }));
  if (config.statuses) toolbar.append(selectControl('狀態', [{ value: '', label: '全部狀態' }, ...options(config.statuses)], '', value => { status = value; page = 1; void load(); }));
  if (config.kindFilter) toolbar.append(selectControl(config.kindFilter.label,
    [{ value: '', label: config.kindFilter.emptyLabel }, ...config.kindFilter.choices], '', value => {
      if (!alive()) return; kind = value; page = 1; void load();
    }));
  if (config.confirmList) toolbar.querySelector('input[type="search"]').maxLength = 200;
  if (config.caseFilter) {
    const id = `case-filter-${crypto.randomUUID()}`, errorId = `${id}-error`;
    caseControl = el('select', { id, class: 'input', 'aria-label': config.caseFilter.label, 'aria-describedby': errorId, disabled: true },
      el('option', { value: '' }, config.caseFilter.emptyLabel));
    caseFieldError = el('p', { id: errorId, class: 'field-error', hidden: true });
    caseControl.addEventListener('change', () => { if (!alive()) return; caseId = caseControl.value; page = 1; void load(); });
    toolbar.append(el('div', { class: 'field' }, el('label', { class: 'filter-field', for: id }, el('span', {}, config.caseFilter.label), caseControl), caseFieldError),
      button(config.caseFilter.clearLabel, () => { if (!alive()) return; caseId = ''; caseControl.value = ''; page = 1; void load(); caseControl.focus(); }, { variant: 'ghost' }));
  }
  if (config.dateFilter) {
    const input = el('input', { class: 'input', type: 'date', 'aria-label': config.dateFilter.label });
    input.addEventListener('change', () => { if (!alive()) return; date = input.value; page = 1; void load(); });
    toolbar.append(el('label', { class: 'filter-field' }, el('span', {}, config.dateFilter.label), input),
      button(config.dateFilter.clearLabel, () => { if (!alive()) return; input.value = ''; date = ''; page = 1; void load(); input.focus(); }, { variant: 'ghost' }));
  }
  const headerActions = config.create ? [button(config.createLabel || '新增', () => config.create(load), { variant: 'primary' })] : [];
  container.replaceChildren(pageHeader(config.title, config.subtitle, headerActions), ...(config.before || []), toolbar, body, footer);
  if (config.confirmList) {
    let invalidated = false;
    const invalidate = () => {
      if (invalidated || alive()) return;
      invalidated = true; controller?.abort(); body.replaceChildren(); footer.replaceChildren();
      if (config.caseFilter) {
        caseControl.replaceChildren(el('option', { value: '' }, config.caseFilter.emptyLabel));
        caseControl.disabled = true; caseControl.setAttribute('aria-invalid', 'false');
        caseFieldError.textContent = ''; caseFieldError.hidden = true;
      }
      observer.disconnect(); window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate);
    };
    const observer = new MutationObserver(invalidate);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] });
    window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate);
  }
  await load();
}

async function caseFollowupWorklist(container, alive) {
  if (!writable()) throw Object.assign(new Error('目前角色無法使用人工追蹤查詢。'), { status: 403 });
  const startedContext = getContext(), identity = caseFollowupWorklistIdentity(startedContext);
  const orgId = startedContext.organizationId ?? startedContext.orgId;
  const current = () => alive() && getContext() === startedContext && caseFollowupWorklistIdentity(getContext()) === identity;
  let casesById = new Map();
  const loadCases = async signal => {
    const pages = []; let total;
    for (let page = 1; page <= 100; page++) {
      if (signal.aborted || !current()) throw new DOMException('操作已取消', 'AbortError');
      const response = await api(`/api/cases?page=${page}&pageSize=100`, { signal });
      if (signal.aborted || !current()) throw new DOMException('操作已取消', 'AbortError');
      const checked = confirmCalendarLookupPage(response, 'cases', orgId, page, total);
      pages.push(response); total = checked.total;
      if (page >= Math.max(1, Math.ceil(total / 100))) {
        const cases = confirmCalendarLookups(pages, 'cases', orgId);
        if (cases.some(item => !item.id.trim())) throw new Error('個案名單無法確認，請重新讀取。');
        casesById = new Map(cases.map(item => [item.id, { id: item.id, name: item.name, caseNo: item.number, status: item.status }]));
        return cases.map(item => ({ value: item.id, label: item.label }));
      }
    }
    throw new Error('個案名單超過可查詢範圍，請重新讀取。');
  };
  const parentLink = caseId => el('a', { class: 'btn btn-outline', href: `#/cases/${encodeURIComponent(caseId)}` }, '前往個案維護');
  const details = row => {
    if (!current()) return;
    const requested = { id: row.id, orgId, caseId: row.caseId };
    return openDetails({
      title: '人工追蹤保存內容', wide: true, guardedRead: true, isCurrent: current,
      loadingText: '正在重新讀取人工追蹤保存內容…',
      load: async (signal, { isCurrent }) => {
        const response = await api(`/api/case-followup-worklist/${encodeURIComponent(requested.id)}`, { signal });
        if (!isCurrent()) throw new DOMException('操作已取消', 'AbortError');
        const item = confirmCaseFollowupWorklistItem(response, requested);
        const metadata = el('dl', { class: 'detail-grid' }, [
          ['目前個案姓名', item.caseName || '未取得個案名稱'], ['目前案號', item.caseNo || '未填案號'],
          ['保存個案識別碼', item.caseId], ['紀錄識別碼', item.id], ['版次', String(item.version)],
        ].map(([label, value]) => el('div', {}, el('dt', {}, label), el('dd', { class: 'pre-wrap' }, value))));
        const fields = el('dl', { class: 'detail-grid' }, CASE_FOLLOWUP_WORKLIST_FIELDS.map(field =>
          el('div', {}, el('dt', {}, field.label), el('dd', { class: 'pre-wrap' }, field.key === 'kind'
            ? formatCaseFollowupWorklistKind(item.fields[field.key]) : field.key === 'status'
              ? formatCaseFollowupWorklistStatus(item.fields[field.key]) : caseFollowupWorklistFieldText(item.fields[field.key])))));
        return el('section', { 'aria-label': '人工追蹤完整保存內容' },
          el('p', { class: 'muted' }, '個案姓名與案號來自目前可讀個案；以下為八個原樣保存欄位，非文字內容只標示型別。'),
          metadata, el('h2', {}, '八個保存欄位'), fields,
          el('p', {}, parentLink(requested.caseId)),
          el('p', { class: 'muted' }, '前往既有個案區塊維護；不會自動定位某筆追蹤紀錄。'));
      },
    });
  };
  const fullText = (row, key) => el('span', { class: 'pre-wrap' }, caseFollowupWorklistFieldText(row.fields[key]));
  await listPage(container, {
    endpoint: '/api/case-followup-worklist', title: '人工追蹤查詢', subtitle: '跨個案閱讀已保存的暫停與結案追蹤；本頁只供查詢。',
    before: [notice('人工保存日期與結果', '日期條件只比對人工保存的追蹤日期；不推算到期、逾期或法定期限。追蹤狀態不改個案服務狀態、班次或收費。'),
      el('p', { class: 'muted' }, '「前往個案維護」開啟既有個案詳情，請在原追蹤區塊維護；不會自動定位某筆追蹤。')],
    searchLabel: '搜尋人工追蹤內容', placeholder: '搜尋原因、追蹤結果或備註', statuses: CASE_FOLLOWUP_WORKLIST_STATUSES,
    kindFilter: { label: '追蹤類型篩選', emptyLabel: '全部追蹤類型', choices: options(CASE_FOLLOWUP_WORKLIST_KINDS) },
    caseFilter: { key: 'caseId', label: '個案篩選', emptyLabel: '全部可讀個案', clearLabel: '清除個案條件', loadOptions: loadCases },
    dateFilter: { key: 'followUpDate', label: '人工追蹤日期篩選', clearLabel: '清除追蹤日期', valid: isCaseFollowupWorklistDate, errorMessage: '請選擇有效的人工追蹤日期。' },
    requested: (params, meta) => ({ ...meta, q: params.get('q') || '', kind: params.get('kind') || '',
      status: params.get('status') || '', followUpDate: params.get('followUpDate') || '', caseId: params.get('caseId') || '' }),
    confirmList: (result, requested) => {
      const checked = confirmCaseFollowupWorklistList(result, requested);
      if (checked.items.some(row => !casesById.has(row.caseId))) throw Object.assign(new Error('人工追蹤回應無法確認，請重新讀取。'), { code: 'FOLLOWUP_RESPONSE_UNCONFIRMED' });
      return checked;
    },
    emptyText: '尚無可讀取的人工追蹤保存紀錄。',
    columns: () => [
      { key: 'caseNo', label: '目前案號' }, { key: 'caseName', label: '目前個案姓名' },
      { label: '人工追蹤日期', render: row => fullText(row, 'followUpDate') },
      { label: '追蹤類型', render: row => el('span', { class: 'pre-wrap' }, formatCaseFollowupWorklistKind(row.fields.kind)) },
      { label: '開始日期', render: row => fullText(row, 'startDate') },
      { label: '追蹤狀態', render: row => el('span', { class: 'pre-wrap' }, formatCaseFollowupWorklistStatus(row.fields.status)) },
      { label: '原因摘要', render: row => el('span', { class: 'pre-wrap' }, caseFollowupWorklistFieldSummary(row.fields.reason)) },
      { key: 'version', label: '版次' }, { label: '操作', render: row => actions(
        button('查看完整內容', () => details(row), { variant: 'outline' }),
        button('版本歷程', () => {
          if (!current()) return;
          return openRecordHistory({ entity: 'case-status-followups', id: row.id, lookups: { cases: casesById }, isCurrent: current });
        }, { variant: 'ghost' }), parentLink(row.caseId),
      ) },
    ],
  }, current);
}

async function supervisoryVisits(container, alive) {
  if (!writable()) throw Object.assign(new Error('目前角色無法使用督導訪視查詢。'), { status: 403 });
  const identity = () => { const context = getContext(); return JSON.stringify([context.user?.id || '', context.organizationId || context.orgId || '', context.role || '', context.user?.employeeId || '']); };
  const initialIdentity = identity(), orgId = getContext().organizationId || getContext().orgId;
  const current = () => alive() && identity() === initialIdentity;
  const templates = await getTemplates();
  if (!current()) return;
  const templatesById = lookup(templates);
  let casesById = new Map();
  const loadCases = async signal => {
    const pages = []; let total;
    for (let page = 1; page <= 100; page++) {
      if (signal.aborted || !current()) throw new DOMException('操作已取消', 'AbortError');
      const response = await api(`/api/cases?page=${page}&pageSize=100`, { signal });
      if (signal.aborted || !current()) throw new DOMException('操作已取消', 'AbortError');
      const checked = confirmCalendarLookupPage(response, 'cases', orgId, page, total);
      pages.push(response); total = checked.total;
      if (page >= Math.max(1, Math.ceil(total / 100))) {
        const cases = confirmCalendarLookups(pages, 'cases', orgId);
        casesById = new Map(cases.map(item => [item.id, { id: item.id, name: item.name, caseNo: item.number, status: item.status }]));
        return cases.map(item => ({ value: item.id, label: item.label }));
      }
    }
    throw new Error('個案名單超過可查詢範圍，請重新讀取。');
  };
  const details = row => {
    if (!current()) return;
    return openDetails({
      title: '督導訪視保存內容', wide: true, guardedRead: true, isCurrent: current,
      loadingText: '正在重新讀取督導訪視保存內容…',
      load: async (signal, { isCurrent }) => {
        const response = await api(`/api/supervisory-visits/${encodeURIComponent(row.id)}`, { signal });
        if (!isCurrent()) throw new DOMException('操作已取消', 'AbortError');
        const item = confirmSupervisoryVisitItem(response, { id: row.id, orgId });
        const metadata = el('dl', { class: 'detail-grid' }, [
          ['目前個案姓名', item.caseName || '未取得個案名稱'], ['目前案號', item.caseNo || '未填案號'],
          ['保存個案識別碼', item.caseId], ['紀錄識別碼', item.id], ['填寫日期', item.date],
          ['儲存狀態', formatSupervisoryVisitStatus(item.status)], ['版次', String(item.version)],
        ].map(([label, value]) => el('div', {}, el('dt', {}, label), el('dd', { class: 'pre-wrap' }, value))));
        const answers = el('dl', { class: 'detail-grid' }, SUPERVISORY_VISIT_QUESTIONS.map(question =>
          el('div', {}, el('dt', {}, question.label), el('dd', { class: 'pre-wrap' }, supervisoryVisitAnswerText(item.answers[question.key])))));
        const kinds = { missing: '未保存', null: '空值', object: '物件', array: '清單', string: '文字', number: '數字', boolean: '布林值' };
        return el('section', { 'aria-label': '督導訪視完整保存內容' },
          el('p', { class: 'muted' }, '個案姓名與案號來自目前可讀個案；以下為督導訪視表單的十個保存答案，非文字值只標示型別。'), metadata,
          item.answerContainerKind !== 'object' ? notice('保存答案容器', `已保存${kinds[item.answerContainerKind]}容器；十個題項沒有可展示的文字。`) : null,
          item.hasUnknownAnswerKeys ? notice('其他保存題項', '白名單以外的保存題項不在此處展示；不列出未知題名或內容。') : null,
          el('h2', {}, '十個保存答案'), answers);
      },
    });
  };
  const summary = (row, key) => el('span', { class: 'pre-wrap' }, supervisoryVisitAnswerSummary(row.answers[key]));
  await listPage(container, {
    endpoint: '/api/supervisory-visits', title: '督導訪視查詢', subtitle: '跨個案閱讀已保存的督導訪視紀錄；本頁只供查詢。',
    before: [notice('填寫日期與訪視日期分開', '日期條件只比對紀錄的填寫日期，不使用答案中的訪視日期。版本歷程可能包含其他模板或個案的舊版，沿原逐版授權顯示。'),
      el('p', {}, el('a', { href: '#/assessments' }, '前往評估表單填寫'))],
    searchLabel: '搜尋督導訪視內容', placeholder: '搜尋十個保存文字答案', statuses: SUPERVISORY_VISIT_STATUSES,
    caseFilter: { key: 'caseId', label: '個案篩選', emptyLabel: '全部可讀個案', clearLabel: '清除個案條件', loadOptions: loadCases },
    dateFilter: { key: 'date', label: '填寫日期篩選', clearLabel: '清除填寫日期', valid: isSupervisoryVisitDate, errorMessage: '請選擇有效的填寫日期。' },
    requested: (params, meta) => ({ ...meta, q: params.get('q') || '', status: params.get('status') || '', date: params.get('date') || '', caseId: params.get('caseId') || '' }),
    confirmList: confirmSupervisoryVisitList, emptyText: '尚無可讀取的督導訪視保存紀錄。',
    columns: () => [
      { key: 'date', label: '填寫日期' }, { key: 'caseNo', label: '目前案號' }, { key: 'caseName', label: '目前個案姓名' },
      { label: '訪視日期保存文字', render: row => summary(row, 'q001') }, { label: '訪視內容摘要', render: row => summary(row, 'q007') },
      { label: '追蹤處理摘要', render: row => summary(row, 'q008') }, { label: '儲存狀態', render: row => formatSupervisoryVisitStatus(row.status) },
      { key: 'version', label: '版次' }, { label: '操作', render: row => actions(
        button('查看完整內容', () => details(row), { variant: 'outline' }),
        button('版本歷程', () => openRecordHistory({ entity: 'assessments', id: row.id, lookups: { cases: casesById, 'assessment-templates': templatesById }, isCurrent: current }), { variant: 'ghost' }),
      ) },
    ],
  }, current);
}

async function needsAssessments(container, alive) {
  if (!writable()) throw Object.assign(new Error('目前角色無法使用需求評估查詢。'), { status: 403 });
  const startedContext = getContext(), identity = needsAssessmentIdentity(startedContext);
  const orgId = startedContext.organizationId ?? startedContext.orgId;
  const current = () => alive() && getContext() === startedContext && needsAssessmentIdentity(getContext()) === identity;
  const templates = await getTemplates();
  if (!current()) return;
  const templatesById = lookup(templates);
  let casesById = new Map();
  const loadCases = async signal => {
    const pages = []; let total;
    for (let page = 1; page <= 100; page++) {
      if (signal.aborted || !current()) throw new DOMException('操作已取消', 'AbortError');
      const response = await api(`/api/cases?page=${page}&pageSize=100`, { signal });
      if (signal.aborted || !current()) throw new DOMException('操作已取消', 'AbortError');
      const checked = confirmCalendarLookupPage(response, 'cases', orgId, page, total);
      pages.push(response); total = checked.total;
      if (page >= Math.max(1, Math.ceil(total / 100))) {
        const cases = confirmCalendarLookups(pages, 'cases', orgId);
        casesById = new Map(cases.map(item => [item.id, { id: item.id, name: item.name, caseNo: item.number, status: item.status }]));
        return cases.map(item => ({ value: item.id, label: item.label }));
      }
    }
    throw new Error('個案名單超過可查詢範圍，請重新讀取。');
  };
  const details = row => {
    if (!current()) return;
    return openDetails({
      title: '需求評估保存內容', wide: true, guardedRead: true, isCurrent: current,
      loadingText: '正在重新讀取需求評估保存內容…',
      load: async (signal, { isCurrent }) => {
        const response = await api(`/api/needs-assessments/${encodeURIComponent(row.id)}`, { signal });
        if (!isCurrent()) throw new DOMException('操作已取消', 'AbortError');
        const item = confirmNeedsAssessmentItem(response, { id: row.id, orgId });
        const metadata = el('dl', { class: 'detail-grid' }, [
          ['目前個案姓名', item.caseName || '未取得個案名稱'], ['目前案號', item.caseNo || '未填案號'],
          ['保存個案識別碼', item.caseId], ['紀錄識別碼', item.id], ['紀錄填寫日期', item.date],
          ['儲存狀態', formatNeedsAssessmentStatus(item.status)], ['版次', String(item.version)],
        ].map(([label, value]) => el('div', {}, el('dt', {}, label), el('dd', { class: 'pre-wrap' }, value))));
        const answers = el('dl', { class: 'detail-grid' }, NEEDS_ASSESSMENT_QUESTIONS.map(question =>
          el('div', {}, el('dt', {}, question.label), el('dd', { class: 'pre-wrap' }, needsAssessmentAnswerText(item.answers[question.key])))));
        const kinds = { missing: '未保存', null: '空值', object: '物件', array: '清單', string: '文字', number: '數字', boolean: '布林值' };
        return el('section', { 'aria-label': '需求評估完整保存內容' },
          el('p', { class: 'muted' }, '目前個案姓名與案號來自可讀個案主檔；九項答案中的個案姓名是當時保存文字，兩者分開呈現。非文字值只標示型別。'), metadata,
          el('p', { class: 'muted' }, '訪視、審閱及填表日期保留保存原文；督導與主管文字不代表簽核，不推算分數、風險、資格或期限。'),
          item.answerContainerKind !== 'object' ? notice('保存答案容器', `已保存${kinds[item.answerContainerKind]}容器；九個題項沒有可展示的文字。`) : null,
          item.hasUnknownAnswerKeys ? notice('其他保存題項', '白名單以外的保存題項不在此處展示；不列出未知題名或內容。') : null,
          el('h2', {}, '九個保存答案'), answers);
      },
    });
  };
  const summary = (row, key) => el('span', { class: 'pre-wrap' }, needsAssessmentAnswerSummary(row.answers[key]));
  await listPage(container, {
    endpoint: '/api/needs-assessments', title: '需求評估查詢', subtitle: '跨個案閱讀已保存的需求評估紀錄；本頁只供查詢。',
    before: [notice('紀錄填寫日期與答案日期分開', '日期條件只比對紀錄的填寫日期，不使用答案中的訪視、審閱或填表日期。版本歷程可能包含其他模板或個案的舊版，沿原逐版授權顯示。'),
      el('p', {}, el('a', { href: '#/assessments' }, '前往評估表單填寫'))],
    searchLabel: '搜尋需求評估內容', placeholder: '搜尋九個保存文字答案', preserveSearchText: true, statuses: NEEDS_ASSESSMENT_STATUSES,
    caseFilter: { key: 'caseId', label: '個案篩選', emptyLabel: '全部可讀個案', clearLabel: '清除個案條件', loadOptions: loadCases },
    dateFilter: { key: 'date', label: '紀錄填寫日期篩選', clearLabel: '清除紀錄填寫日期', valid: isNeedsAssessmentDate, errorMessage: '請選擇有效的紀錄填寫日期。' },
    requested: (params, meta) => ({ ...meta, q: params.get('q') || '', status: params.get('status') || '', date: params.get('date') || '', caseId: params.get('caseId') || '' }),
    confirmList: (result, requested) => {
      const checked = confirmNeedsAssessmentList(result, requested);
      if (checked.items.some(row => !casesById.has(row.caseId))) throw Object.assign(new Error('需求評估回應無法確認，請重新讀取。'), { code: 'NEEDS_ASSESSMENT_RESPONSE_UNCONFIRMED' });
      return checked;
    },
    emptyText: '尚無可讀取的需求評估保存紀錄。',
    columns: () => [
      { key: 'date', label: '紀錄填寫日期' }, { key: 'caseNo', label: '目前案號' }, { key: 'caseName', label: '目前個案姓名' },
      { label: '保存個案姓名', render: row => summary(row, 'q001') }, { label: '訪視日期保存文字', render: row => summary(row, 'q003') },
      { label: '處遇情形摘要', render: row => summary(row, 'q004') }, { label: '儲存狀態', render: row => formatNeedsAssessmentStatus(row.status) },
      { key: 'version', label: '版次' }, { label: '操作', render: row => actions(
        button('查看完整內容', () => details(row), { variant: 'outline' }),
        button('版本歷程', () => {
          if (!current()) return;
          return openRecordHistory({ entity: 'assessments', id: row.id, lookups: { cases: casesById, 'assessment-templates': templatesById }, isCurrent: current });
        }, { variant: 'ghost' }),
      ) },
    ],
  }, current);
}

async function personalCalendar(container, alive) {
  const startedContext = getContext();
  if (!['admin', 'supervisor', 'caregiver', 'finance'].includes(startedContext.role))
    throw Object.assign(new Error('目前角色無法使用個人行事曆。'), { status: 403 });
  const identity = personalCalendarIdentity(startedContext);
  const current = () => alive() && getContext() === startedContext && personalCalendarIdentity(getContext()) === identity;
  const orgId = startedContext.organizationId ?? startedContext.orgId, ownerUserId = startedContext.user?.id;
  const saveEvent = (payload, row, signal, key) => api(row ? `/api/personal-calendar-events/${encodeURIComponent(row.id)}` : '/api/personal-calendar-events', {
    method: row ? 'PATCH' : 'POST', body: row ? { ...payload, version: row.version } : payload, signal,
    ...(!row ? { headers: { 'Idempotency-Key': key } } : {}),
  });
  const edit = (refresh, row) => {
    if (!current()) return;
    const editor = createPersonalCalendarEditor({ existing: row, ownerUserId, defaultDate: today() });
    const keys = new Map();
    return openForm({
      title: row ? '編輯個人事件' : '新增個人事件', fields: editor.fields, initial: editor.initial, isCurrent: current,
      onChange: (values, helpers) => { for (const descriptor of editor.fields) if (editor.needsIntent(descriptor.name)) helpers.setDisabled(descriptor.name, !editor.enabled(descriptor.name, values)); },
      onSubmit: async (values, { signal, isCurrent }) => {
        if (!isCurrent()) return;
        const payload = editor.buildPayload(values);
        if (row && !Object.keys(payload).length) { if (isCurrent()) toast('沒有變更內容。', 'info'); return; }
        const signature = JSON.stringify(payload);
        if (!row && !keys.has(signature)) keys.set(signature, crypto.randomUUID());
        const result = await saveEvent(payload, row, signal, keys.get(signature));
        if (!isCurrent()) return;
        editor.confirm(result?.item, orgId, payload);
        await refresh(); if (!isCurrent()) return;
        toast(row ? '個人事件已更新' : '個人事件已新增', 'success');
      },
    });
  };
  const setStatus = (refresh, row) => {
    if (!current()) return;
    const editor = createPersonalCalendarEditor({ existing: row, ownerUserId });
    const status = row.status === 'active' ? 'cancelled' : 'active', verb = status === 'cancelled' ? '取消' : '恢復';
    const payload = editor.buildStatusChange(status);
    return confirmAction({
      title: `${verb}這筆個人事件`, confirmLabel: `確認${verb}`, danger: status === 'cancelled', isCurrent: current,
      message: `將${verb}本人在目前機構的這筆人工事件；原內容與版本歷程保留，不會改動出勤、請假、班次或收費。`,
      onConfirm: async ({ signal, isCurrent }) => {
        if (!isCurrent()) return;
        const result = await saveEvent(payload, row, signal);
        if (!isCurrent()) return;
        editor.confirm(result?.item, orgId, payload);
        await refresh(); if (!isCurrent()) return;
        toast(`個人事件已${verb}`, 'success');
      },
    });
  };
  const display = (row, name, limit = 160) => {
    const text = formatPersonalCalendarText(row[name], Object.hasOwn(row, name));
    return el('span', { class: 'pre-wrap' }, text.length > limit ? text.slice(0, limit) + '…' : text);
  };
  await listPage(container, {
    entity: 'personal-calendar-events', title: '個人行事曆', subtitle: '保存本人在目前機構的人工日內事件；依建立順序顯示。',
    before: [notice('本人事件', '只有本人可讀寫；管理者也不能代看他人。事件日期與時間不代表出勤、請假或服務時段。完整保存內容可在版本歷程閱讀。'), button('月份檢視', () => { if (current()) return openPersonalCalendarMonth({ isCurrent: current }); }, { variant: 'outline' }), button('年度檢視', () => { if (current()) return openPersonalCalendarYear({ isCurrent: current }); }, { variant: 'outline' })],
    createLabel: '新增個人事件', create: refresh => edit(refresh), searchLabel: '搜尋個人事件', placeholder: '搜尋標題或備註', preserveSearchText: true,
    statuses: Object.fromEntries(PERSONAL_CALENDAR_STATUSES.map(item => [item.value, item.label])),
    dateFilter: { key: 'date', label: '事件日期篩選', clearLabel: '清除事件日期', valid: isPersonalCalendarDate, errorMessage: '請選擇有效的事件日期。' },
    requested: (params, { page, pageSize }) => ({ page, pageSize, orgId, ownerUserId, q: params.get('q') ?? '', status: params.get('status') ?? '', date: params.get('date') ?? '' }),
    confirmList: confirmPersonalCalendarList, emptyText: '尚未建立個人事件。',
    columns: refresh => [
      { label: '事件標題', render: row => display(row, 'title', 200) }, { label: '事件日期', render: row => display(row, 'date') },
      { label: '開始時間', render: row => display(row, 'startTime') }, { label: '結束時間', render: row => display(row, 'endTime') },
      { label: '備註', render: row => display(row, 'note') },
      { label: '事件狀態', render: row => { const known = PERSONAL_CALENDAR_STATUSES.some(item => item.value === row.status); const node = badge(known ? row.status : 'unknown'); node.textContent = formatPersonalCalendarStatus(row.status); return node; } },
      { label: '操作', render: row => actions(
        button('編輯', () => edit(refresh, row), { variant: 'outline' }),
        PERSONAL_CALENDAR_STATUSES.some(item => item.value === row.status) && button(row.status === 'active' ? '取消事件' : '恢復事件', () => setStatus(refresh, row), { variant: 'ghost' }),
        button('版本歷程', () => { if (current()) return openRecordHistory({ entity: 'personal-calendar-events', id: row.id, isCurrent: current }); }, { variant: 'ghost' }),
      ) },
    ],
  }, current);
}

async function interviews(container, alive) {
  if (!writable()) throw Object.assign(new Error('目前角色無法使用面試者登錄。'), { status: 403 });
  const identity = () => { const context = getContext(); return JSON.stringify([context.user?.id || '', context.organizationId || context.orgId || '', context.role || '', context.user?.employeeId || '']); };
  const initialIdentity = identity();
  const current = () => alive() && identity() === initialIdentity;
  const orgId = getContext().organizationId || getContext().orgId;
  const saveApplicant = (payload, row, signal, key) => api(row ? `/api/interview-applicants/${encodeURIComponent(row.id)}` : '/api/interview-applicants', {
    method: row ? 'PATCH' : 'POST', body: row ? { ...payload, version: row.version } : payload, signal,
    ...(!row ? { headers: { 'Idempotency-Key': key } } : {}),
  });
  const edit = (refresh, row) => {
    if (!current()) return;
    const editor = createInterviewApplicantEditor({ existing: row, defaultDate: today() });
    const keys = new Map();
    return openForm({
      title: row ? '編輯面試者' : '新增面試者', fields: editor.fields, initial: editor.initial, isCurrent: current,
      onChange: (values, helpers) => { for (const descriptor of editor.fields) if (editor.needsIntent(descriptor.name)) helpers.setDisabled(descriptor.name, !editor.enabled(descriptor.name, values)); },
      onSubmit: async (values, { signal, isCurrent }) => {
        if (!isCurrent()) return;
        const payload = editor.buildPayload(values);
        if (row && !Object.keys(payload).length) { if (isCurrent()) toast('沒有變更內容。', 'info'); return; }
        const signature = JSON.stringify(payload);
        if (!row && !keys.has(signature)) keys.set(signature, crypto.randomUUID());
        const result = await saveApplicant(payload, row, signal, keys.get(signature));
        if (!isCurrent()) return;
        editor.confirm(result?.item, orgId, payload);
        await refresh(); if (!isCurrent()) return;
        toast(row ? '面試紀錄已更新' : '面試者已新增', 'success');
      },
    });
  };
  const setStatus = (refresh, row) => {
    if (!current()) return;
    const editor = createInterviewApplicantEditor({ existing: row });
    const status = row.status === 'active' ? 'inactive' : 'active';
    const payload = editor.buildStatusChange(status), verb = formatInterviewStatus(status);
    return confirmAction({
      title: `${verb}這筆面試紀錄`, confirmLabel: `確認${verb}`, danger: status === 'inactive', isCurrent: current,
      message: `將${verb}這筆面試者名單紀錄；原面試內容與版本歷程保留。這不代表錄取、到職或薪資核定，也不會建立員工或帳號。`,
      onConfirm: async ({ signal, isCurrent }) => {
        if (!isCurrent()) return;
        const result = await saveApplicant(payload, row, signal);
        if (!isCurrent()) return;
        editor.confirm(result?.item, orgId, payload);
        await refresh(); if (!isCurrent()) return;
        toast(`面試紀錄已${verb}`, 'success');
      },
    });
  };
  const display = (value, limit = 200) => { const text = formatInterviewText(value); return el('span', { class: 'pre-wrap' }, text.length > limit ? text.slice(0, limit) + '…' : text); };
  await listPage(container, {
    entity: 'interview-applicants', title: '面試者登錄', subtitle: '保存人工面試紀錄；啟用或停用只代表名單狀態，不代表錄取或到職。',
    createLabel: '新增面試者', create: refresh => edit(refresh), searchLabel: '搜尋面試者', placeholder: '搜尋姓名、電話或面試內容',
    statuses: Object.fromEntries(INTERVIEW_STATUSES.map(item => [item.value, item.label])),
    dateFilter: { key: 'interviewDate', label: '面試日期篩選', clearLabel: '清除面試日期', valid: isInterviewDate },
    confirmList: confirmInterviewApplicantList,
    emptyText: '尚未建立面試者紀錄。',
    columns: refresh => [
      { label: '姓名', render: row => display(row.name) }, { label: '電話', render: row => display(row.phone) },
      { label: '面試日期', render: row => formatInterviewDate(row.interviewDate) },
      { label: '縣市', render: row => display(row.city) }, { label: '鄉鎮區', render: row => display(row.district) },
      { label: '面試內容', render: row => display(row.interviewContent, 160) }, { label: '備註', render: row => display(row.note, 160) },
      { label: '名單狀態', render: row => { const known = INTERVIEW_STATUSES.some(item => item.value === row.status); const node = badge(known ? row.status : 'unknown'); node.textContent = formatInterviewStatus(row.status); return node; } },
      { label: '操作', render: row => actions(
        button('查看紀錄', () => { if (current()) return openInterviewRecordDetails({ id: row.id, isCurrent: current }); }, { variant: 'outline' }),
        button('編輯', () => edit(refresh, row), { variant: 'outline' }),
        INTERVIEW_STATUSES.some(item => item.value === row.status) && button(row.status === 'active' ? '停用' : '啟用', () => setStatus(refresh, row), { variant: 'ghost' }),
        button('版本歷程', () => openRecordHistory({ entity: 'interview-applicants', id: row.id, isCurrent: current }), { variant: 'ghost' }),
      ) },
    ],
  }, current);
}

async function employees(container, alive) {
  const edit = (refresh, row) => {
    const editor = createEmployeeEditor({ existing: row });
    const orgId = getContext().organizationId || getContext().orgId;
    return openForm({
      title: row ? '編輯員工' : '新增員工',
      fields: editor.fields, initial: editor.initial, isCurrent: alive,
      onChange: (values, helpers) => {
        for (const descriptor of editor.fields) if (editor.needsIntent(descriptor.name)) {
          helpers.setDisabled(descriptor.name, !editor.enabled(descriptor.name, values));
        }
      },
      onSubmit: async (values, { signal, isCurrent }) => {
        const payload = editor.buildPayload(values);
        let result;
        try { result = await save('employees', payload, row, { signal }); }
        catch (error) {
          if (error.fields?.hourlyRateCents) {
            error.fields = { ...error.fields, hourlyRate: error.fields.hourlyRateCents };
            delete error.fields.hourlyRateCents;
          }
          throw error;
        }
        if (!isCurrent()) return;
        editor.confirm(result?.item, orgId, payload);
        toast(row ? '員工資料已更新' : '員工已新增', 'success'); await refresh();
      },
    });
  };
  const setStatus = (refresh, row) => {
    const editor = createEmployeeEditor({ existing: row });
    const orgId = getContext().organizationId || getContext().orgId;
    const status = row.status === 'active' ? 'inactive' : 'active';
    const verb = status === 'active' ? '啟用' : '停用';
    const name = typeof row.name === 'string' && !/[\r\n]/.test(row.name) ? row.name : '這筆員工資料';
    return confirmAction({
      title: `${verb}這筆資料`, confirmLabel: `確認${verb}`, danger: status === 'inactive', isCurrent: alive,
      message: `將變更「${name}」的員工狀態。停用後不能再指派新的排班或服務紀錄，連結此員工的居服員帳號亦暫不能使用受保護功能；既有紀錄與已核閱薪資快照保留。`,
      onConfirm: async ({ signal, isCurrent }) => {
        const payload = { status };
        const result = await save('employees', payload, row, { signal });
        if (!isCurrent()) return;
        editor.confirm(result?.item, orgId, payload);
        toast(`已${verb}`, 'success'); await refresh();
      },
    });
  };
  await listPage(container, {
    entity: 'employees', title: '員工管理', subtitle: '資格、服務區域與人員基本資料。',
    createLabel: '新增員工', create: writable() ? refresh => edit(refresh) : null,
    placeholder: '搜尋姓名、員工編號或資格', statuses: { active: '啟用', inactive: '停用' },
    columns: refresh => [
      { key: 'employeeNo', label: '員工編號' }, { key: 'name', label: '姓名' },
      { key: 'role', label: '職務' }, { key: 'qualification', label: '資格與證照', render: row => textValue(row.qualification) },
      { key: 'regions', label: '服務區域', render: row => Array.isArray(row.regions) ? row.regions.join('、') : textValue(row.regions) },
      { key: 'hourlyRateCents', label: '試算時薪', render: row => formatTrialPriceCents(row.hourlyRateCents) },
      { key: 'status', label: '狀態', render: row => statusCell(row.status) },
      ...(writable() ? [{ label: '操作', render: row => actions(
        button('編輯', () => edit(refresh, row), { variant: 'outline' }),
        el('a', { href: '#/certifications', class: 'btn btn-outline', onclick: () => setPersonnelEmployeeFilter('/certifications', row.id) }, '證照'),
        el('a', { href: '#/training', class: 'btn btn-outline', onclick: () => setPersonnelEmployeeFilter('/training', row.id) }, '訓練'),
        button(row.status === 'active' ? '停用' : '啟用', () => setStatus(refresh, row), { variant: 'ghost' }),
        button('保存紀錄', () => { if (alive()) openEmployeeRecordIndex({ employeeRecord: row, lookups: { employees: new Map([[row.id, row]]) }, isCurrent: alive }); }, { variant: 'outline' }),
        button('版本歷程', () => openRecordHistory({ entity: 'employees', id: row.id, isCurrent: alive }), { variant: 'ghost' }),
      ) }] : []),
    ],
  }, alive);
}

async function serviceItems(container, alive) {
  const edit = (refresh, row) => {
    const editor = createServiceItemEditor({ existing: row });
    const orgId = getContext().organizationId || getContext().orgId;
    return openForm({
    title: row ? '編輯服務項目' : '新增服務項目',
    fields: editor.fields, initial: editor.initial, isCurrent: alive,
    onChange: (values, helpers) => {
      for (const descriptor of editor.fields) if (editor.needsIntent(descriptor.name)) {
        helpers.setDisabled(descriptor.name, !editor.enabled(descriptor.name, values));
      }
    },
    onSubmit: async (values, { signal, isCurrent }) => {
      const payload = editor.buildPayload(values);
      let result;
      try { result = await save('service-items', payload, row, { signal }); }
      catch (error) {
        if (error.fields?.unitPriceCents) {
          error.fields = { ...error.fields, unitPrice: error.fields.unitPriceCents };
          delete error.fields.unitPriceCents;
        }
        throw error;
      }
      if (!isCurrent()) return;
      editor.confirm(result?.item, orgId, payload);
      toast('服務項目已儲存', 'success'); await refresh();
    },
    });
  };
  const setStatus = (refresh, row) => {
    const editor = createServiceItemEditor({ existing: row });
    const orgId = getContext().organizationId || getContext().orgId;
    const status = row.status === 'active' ? 'inactive' : 'active';
    const verb = status === 'active' ? '啟用' : '停用';
    const name = typeof row.name === 'string' && !/[\r\n]/.test(row.name) ? row.name : '這筆服務項目';
    return confirmAction({
      title: `${verb}這筆資料`, confirmLabel: `確認${verb}`, danger: status === 'inactive', isCurrent: alive,
      message: `將變更「${name}」的狀態。停用後不能再用於新的服務紀錄或排班；已核閱的計價快照不重算。`,
      onConfirm: async ({ signal, isCurrent }) => {
        const payload = { status };
        const result = await save('service-items', payload, row, { signal });
        if (!isCurrent()) return;
        editor.confirm(result?.item, orgId, payload);
        toast(`已${verb}`, 'success'); await refresh();
      },
    });
  };
  await listPage(container, {
    entity: 'service-items', title: '服務項目', subtitle: '維護服務時間、有效期間與測試單價。',
    before: [notice('合成測試價格', '本頁金額只供本機流程試算；正式支付碼、政策版本與核定單價仍待確認。')],
    createLabel: '新增服務項目', create: writable() ? refresh => edit(refresh) : null,
    placeholder: '搜尋代碼或服務名稱', statuses: { active: '啟用', inactive: '停用' },
    columns: refresh => [
      { key: 'code', label: '服務代碼' }, { key: 'name', label: '名稱' },
      { key: 'minutes', label: '分鐘' }, { key: 'unitPriceCents', label: '測試單價', render: row => formatTrialPriceCents(row.unitPriceCents) },
      { label: '有效期間', render: row => `${row.validFrom || '未設起日'} ～ ${row.validTo || '未設迄日'}` },
      { label: '狀態', render: row => statusCell(row.status) },
      ...(writable() ? [{ label: '操作', render: row => actions(
        button('編輯', () => edit(refresh, row), { variant: 'outline' }),
        button(row.status === 'active' ? '停用' : '啟用', () => setStatus(refresh, row), { variant: 'ghost' }),
        button('版本歷程', () => openRecordHistory({ entity: 'service-items', id: row.id, isCurrent: alive }), { variant: 'ghost' }),
      ) }] : []),
    ],
  }, alive);
}

async function leave(container, alive) {
  const people = await fetchAll('employees');
  if (!alive()) return;
  const byId = lookup(people);
  const edit = (refresh, row) => {
    const editor = createLeaveEditor({ existing: row, employees: people, defaultDate: today() });
    const orgId = getContext().organizationId || getContext().orgId;
    return openForm({
      title: row ? '編輯請假申請' : '新增請假申請',
      fields: editor.fields, initial: editor.initial, isCurrent: alive,
      onChange: (values, helpers) => {
        for (const descriptor of editor.fields) if (editor.needsIntent(descriptor.name)) {
          helpers.setDisabled(descriptor.name, !editor.enabled(descriptor.name, values));
        }
      },
      onSubmit: async (values, { signal, isCurrent }) => {
        const payload = editor.buildPayload(values);
        const result = await save('leave-requests', payload, row, { signal });
        if (!isCurrent()) return;
        editor.confirm(result?.item, orgId, payload);
        toast('請假申請已儲存', 'success'); await refresh();
      },
    });
  };
  const setStatus = (refresh, row, status, message) => {
    const editor = createLeaveEditor({ existing: row, employees: people });
    const orgId = getContext().organizationId || getContext().orgId;
    const verb = { approved: '核准', rejected: '駁回', cancelled: '取消' }[status];
    const person = byId.get(row.employeeId);
    const name = typeof person?.name === 'string' && person.name && !/[\r\n]/.test(person.name) ? person.name : '這筆請假申請';
    const savedText = (key, fallback) => typeof row[key] === 'string' && row[key] && !/[\r\n]/.test(row[key]) ? row[key] : fallback;
    return confirmAction({
      title: `${verb}這筆資料`, confirmLabel: `確認${verb}`,
      danger: ['rejected', 'cancelled'].includes(status), isCurrent: alive,
      message: `將${verb}「${name}」的請假。請假日期：${savedText('date', '未能確認日期')}；時段：${savedText('startTime', '未能確認開始時間')}–${savedText('endTime', '未能確認結束時間')}。${message}`,
      onConfirm: async ({ signal, isCurrent }) => {
        const payload = { status };
        const result = await save('leave-requests', payload, row, { signal });
        if (!isCurrent()) return;
        editor.confirm(result?.item, orgId, payload);
        toast(`已${verb}`, 'success'); await refresh();
      },
    });
  };
  await listPage(container, {
    entity: 'leave-requests', title: '請假管理', subtitle: '提交申請並處理審核；核准前會檢查既有排班衝突。',
    createLabel: '新增請假', create: writable() ? refresh => edit(refresh) : null,
    before: [notice('先調整重疊班次，再核准請假', '若員工同時段仍有排班，系統會拒絕核准並保留申請，請回排班管理處理後重試。')],
    statuses: { pending: '待審核', approved: '已核准', rejected: '已駁回', cancelled: '已取消' },
    columns: refresh => [
      { label: '員工', render: row => byId.get(row.employeeId)?.name || '未找到員工' },
      { key: 'date', label: '日期' }, { label: '時段', render: row => `${row.startTime}–${row.endTime}` },
      { key: 'type', label: '假別' }, { key: 'reason', label: '原因' }, { label: '狀態', render: row => statusCell(row.status) },
      ...(writable() ? [{ label: '操作', render: row => actions(
        row.status === 'pending' && button('編輯', () => edit(refresh, row), { variant: 'outline' }),
        row.status === 'pending' && button('核准', () => setStatus(refresh, row, 'approved', '核准後，此員工同時段將無法排入新的班次。系統會先檢查既有排班。'), { variant: 'primary' }),
        row.status === 'pending' && button('駁回', () => setStatus(refresh, row, 'rejected', '駁回後會保留這筆請假申請與版本歷程。'), { variant: 'ghost' }),
        ['pending', 'approved'].includes(row.status) && button('取消請假', () => setStatus(refresh, row, 'cancelled', '取消後會保留申請紀錄；原請假時段可再次安排服務。'), { variant: 'ghost' }),
        button('檢視衝突班次', () => openLeaveShiftConflicts({ id: row.id, isCurrent: alive }), { variant: 'outline' }),
        button('版本歷程', () => openRecordHistory({ entity: 'leave-requests', id: row.id, lookups: { employees: byId }, isCurrent: alive }), { variant: 'outline' }),
      ) }] : []),
    ],
  }, alive);
}

async function getTemplates() {
  if (!templatesPromise) templatesPromise = fetch('/data/assessment-templates.json', { credentials: 'same-origin' })
    .then(response => { if (!response.ok) throw new Error('無法讀取評鑑表模板。'); return response.json(); })
    .catch(error => { templatesPromise = null; throw error; });
  return templatesPromise;
}
async function assessments(container, alive) {
  const [templates, cases] = await Promise.all([getTemplates(), fetchAll('cases')]);
  if (!alive()) return;
  const casesById = lookup(cases);
  const templatesById = lookup(templates);
  const edit = (template, refresh, row) => {
    if (!alive()) return;
    const editor = createAssessmentEditor(template, row, today());
    const orgId = getContext().organizationId || getContext().orgId;
    const kinds = { null: '空值', number: '數字', boolean: '布林', array: '清單', object: '複合內容', string: '目前控制項無法原樣呈現的文字', unsupported: '無法判讀的型別' };
    return openForm({
      title: `${row ? '編輯' : '填寫'}｜${template.name}`,
      isCurrent: alive,
      fields: [
        field('caseId', '個案', 'select', { required: true, options: selectedOptions(cases), help: editor.editing && !editor.answersEditable ? '保存填答不是可編輯物件；此次僅修改個案、日期及狀態，原填答保持。' : editor.hasPreservedAnswers ? '未修改的保存答案與未知題項會保留；無法預填的題目需明確選擇取代或清除。' : '本版保存固定欄位填答；原表的選項、群組及計分尚待核定。' }),
        field('date', '填寫日期', 'date', { required: true }),
        field('status', '儲存狀態', 'select', { required: true, options: options({ draft: '草稿', submitted: '提交紀錄' }), help: '提交只表示完成本次紀錄，不代表評估或核銷通過。' }),
        ...editor.questions.flatMap(question => {
          const item = template.fields.find(candidate => candidate.name === question.name);
          const control = field(question.name, question.label, question.type, {
            help: question.requiresIntent ? `已保存${kinds[question.savedKind] || '無法原樣預填的內容'}，原內容保留。只有選擇「以本次輸入取代」才填新值；清除會保存空文字。` : item.help,
            wide: question.type === 'textarea' || question.label.length > 24,
            disabled: !editor.answersEditable || question.requiresIntent,
          });
          return question.requiresIntent ? [control, field(question.intentName, `保存方式｜${question.label}`, 'select', {
            options: options({ keep: '保留保存答案', replace: '以本次輸入取代', clear: '清除保存答案' }),
            help: '保留不轉型；取代使用本次輸入；清除保存空文字，不刪除題項。',
          })] : [control];
        }),
      ],
      initial: editor.initial,
      onChange: (values, helpers) => {
        for (const question of editor.questions) if (question.requiresIntent) helpers.setDisabled(question.name, values[question.intentName] !== 'replace');
      },
      onSubmit: async (values, { signal, isCurrent }) => {
        const payload = editor.buildPayload(values);
        const result = await save('assessments', payload, row, { signal });
        if (!isCurrent()) throw new DOMException('操作已取消，請重新讀取資料確認保存狀態。', 'AbortError');
        const item = result?.item;
        const expectedAnswers = Object.hasOwn(payload, 'answers') ? payload : row;
        if (!item || typeof item.id !== 'string' || !item.id || (row && item.id !== row.id) || item.orgId !== orgId
          || !Number.isSafeInteger(item.version) || item.version !== (row ? row.version + 1 : 1)
          || ['caseId', 'templateId', 'date', 'status'].some(name => item[name] !== payload[name])
          || Object.hasOwn(item, 'answers') !== Object.hasOwn(expectedAnswers, 'answers')
          || JSON.stringify(item.answers) !== JSON.stringify(expectedAnswers.answers)) {
          throw new Error('未取得相符的保存確認，請保留輸入內容，重新讀取紀錄確認後再操作。');
        }
        toast(payload.status === 'submitted' ? '評鑑紀錄已提交' : '評鑑草稿已儲存', 'success'); await refresh();
      },
    });
  };
  let refreshRecords = async () => {};
  const templateSection = el('section', { class: 'panel template-section', 'aria-label': '16 種評鑑表模板' },
    el('h2', {}, '16 種表單模板'),
    ...(!cases.length ? [notice('請先建立個案', '目前機構尚無可填寫的個案，請先到個案管理新增合成測試個案。')] : []),
    note('固定欄位依盤點整理；重複欄位依原表順序保留。未核定完整選項、群組、附件與計分，因此不產生總分或對外核銷檔。'),
    table([
      { key: 'name', label: '模板' },
      { label: '固定欄位', render: row => `${row.fields.length} 項` },
      { label: '規格狀態', render: () => '細項待核對' },
      ...(writable() ? [{ label: '操作', render: row => button('填寫表單', () => edit(row, refreshRecords), { variant: 'outline', disabled: !cases.length }) }] : []),
    ], templates, { emptyText: '尚無模板' }),
  );
  await listPage(container, {
    entity: 'assessments', title: '個案評鑑表', subtitle: '選擇模板與個案，保存填答草稿或提交紀錄。',
    before: [notice('尚未提供臨床計分與正式核銷', '量表分數、風險判定與核銷規則尚未核定。請由專業人員依正式表單核對，不以本版填答作自動判定。'), templateSection, el('h2', {}, '已填寫紀錄')],
    statuses: { draft: '草稿', submitted: '已提交' }, placeholder: '搜尋填答內容',
    columns: refresh => {
      refreshRecords = refresh;
      return [
        { label: '個案', render: row => casesById.get(row.caseId)?.name || '未找到個案' },
        { label: '模板', render: row => templatesById.get(row.templateId)?.name || row.templateId },
        { key: 'date', label: '填寫日期' }, { label: '狀態', render: row => statusCell(row.status) },
        { label: '更新時間', render: row => formatDate(row.updatedAt) },
        ...(writable() ? [{ label: '操作', render: row => actions(
          templatesById.has(row.templateId)
            ? button('開啟紀錄', () => edit(templatesById.get(row.templateId), refresh, row), { variant: 'outline' })
            : el('span', {}, '模板規格待補齊'),
          button('版本歷程', () => openRecordHistory({ entity: 'assessments', id: row.id,
            lookups: { cases: casesById, 'assessment-templates': templatesById }, isCurrent: alive }), { variant: 'ghost' }),
        ) }] : []),
      ];
    },
  }, alive);
}

async function announcements(container, alive) {
  const edit = (refresh, row) => {
    const editor = createAnnouncementEditor({ existing: row });
    const orgId = getContext().organizationId;
    return openForm({
      title: row ? '編輯內部公告' : '新增內部公告', isCurrent: alive,
      fields: editor.fields, initial: editor.initial,
      onChange: (values, helpers) => {
        for (const name of ['title', 'body', 'audience', 'status']) if (editor.needsIntent(name)) helpers.setDisabled(name, !editor.enabled(name, values));
      },
      onSubmit: async (values, { signal, isCurrent }) => {
        const payload = editor.buildPayload(values);
        const result = await save('announcements', payload, row, { signal });
        if (!isCurrent()) throw new DOMException('操作已取消，請重新讀取資料確認保存狀態。', 'AbortError');
        editor.confirm(result?.item, orgId, payload);
        toast('公告已儲存', 'success'); await refresh();
      },
    });
  };
  const withdraw = (refresh, row) => {
    const editor = createAnnouncementEditor({ existing: row });
    const orgId = getContext().organizationId;
    return confirmAction({
      title: '撤回公告至草稿？', message: '公告將撤回草稿並保留內容。居服員下次讀取時將無法取得此公告。',
      confirmLabel: '確認撤回草稿', danger: true, isCurrent: alive,
      onConfirm: async ({ signal, isCurrent }) => {
        const payload = { status: 'draft' };
        const result = await save('announcements', payload, row, { signal });
        if (!isCurrent()) throw new DOMException('操作已取消，請重新讀取資料確認保存狀態。', 'AbortError');
        editor.confirm(result?.item, orgId, payload);
        toast('公告已撤回草稿', 'success'); await refresh();
      },
    });
  };
  await listPage(container, {
    entity: 'announcements', title: '內部公告', subtitle: '於機構內分享服務與行政訊息。',
    createLabel: '新增公告', create: writable() ? refresh => edit(refresh) : null,
    statuses: { draft: '草稿', published: '已發布' }, placeholder: '搜尋公告標題與內容',
    columns: refresh => [
      { key: 'title', label: '標題' },
      { label: '內容', render: row => el('details', {}, el('summary', {}, '閱讀內容'), el('p', { class: 'pre-wrap' }, row.body)) },
      { label: '對象', render: row => Object.hasOwn(AUDIENCE, row.audience) ? AUDIENCE[row.audience] : row.audience },
      { label: '狀態', render: row => statusCell(row.status) },
      { label: '更新時間', render: row => formatDate(row.updatedAt) },
      { label: '操作', render: row => actions(
        writable() && button('編輯', () => edit(refresh, row), { variant: 'outline' }),
        writable() && row.status === 'published' && button('撤回草稿', () => withdraw(refresh, row), { variant: 'ghost' }),
        button('閱讀全文', () => openAnnouncementRead({ id: row.id, isCurrent: alive }), { variant: 'outline' }),
        writable() && button('閱讀紀錄', () => openAnnouncementReadReceipts({ id: row.id, isCurrent: alive }), { variant: 'ghost' }),
        button('版本歷程', () => openRecordHistory({ entity: 'announcements', id: row.id, isCurrent: alive }), { variant: 'ghost' }),
      ) },
    ],
  }, alive);
}

async function reports(container, alive) {
  let kind = 'cases';
  let month = today().slice(0, 7);
  let sequence = 0;
  let controller, exportController, advancedReport;
  const advancedReports = { cases: mountCaseReport, shifts: mountShiftReport, services: mountServiceReport, employees: mountEmployeeReport, leaves: mountLeaveReport, trainings: mountTrainingReport, certifications: mountCertificationReport };
  let legacyReady = false;
  const startedContext = getContext();
  const current = () => alive() && container.isConnected && getContext() === startedContext;
  const allowedReports = REPORTS.filter(item => (!['trainings', 'certifications'].includes(item.value) || ['admin', 'supervisor'].includes(getContext().role)) &&
    (!['fees', 'payroll'].includes(item.value) || ['admin', 'finance'].includes(getContext().role)));
  const body = el('div', { class: 'report-body', 'aria-live': 'polite' });
  const monthInput = el('input', { type: 'month', value: month, class: 'input', 'aria-label': '報表月份' });
  const download = button('下載 CSV', async () => {
    if (!current() || !legacyReady || Object.hasOwn(advancedReports, kind)) return;
    const capturedKind = kind, capturedMonth = month, request = sequence;
    exportController?.abort(); const active = new AbortController(); exportController = active;
    const outputCurrent = () => current() && request === sequence && kind === capturedKind && month === capturedMonth;
    download.disabled = true;
    try {
      await downloadCsv(`/api/reports/${encodeURIComponent(capturedKind)}.csv?month=${encodeURIComponent(capturedMonth)}`, {
        filename: `歲悅-${capturedKind}-${capturedMonth}.csv`, signal: active.signal, isCurrent: outputCurrent,
      });
      if (outputCurrent() && !active.signal.aborted) toast('報表下載已開始', 'success');
    } catch (error) {
      if (outputCurrent() && !active.signal.aborted && error.name !== 'AbortError') toast(error.message || '報表無法下載。', 'error');
    } finally { if (outputCurrent()) download.disabled = !legacyReady; }
  }, { variant: 'outline' });
  const monthField = el('label', { class: 'filter-field' }, el('span', {}, '月份'), monthInput);
  const reloadButton = button('重新查詢', () => load(), { variant: 'primary' });
  const load = async () => {
    if (!current()) return;
    const request = ++sequence;
    controller?.abort(); exportController?.abort(); advancedReport?.dispose(); advancedReport = null;
    download.disabled = true; legacyReady = false;
    const advanced = Object.hasOwn(advancedReports, kind);
    monthField.hidden = advanced; reloadButton.hidden = advanced; download.hidden = advanced;
    if (advanced) {
      const capturedKind = kind;
      body.replaceChildren();
      advancedReport = advancedReports[capturedKind](body, { isCurrent: () => current() && request === sequence && kind === capturedKind });
      return;
    }
    controller = new AbortController();
    const capturedKind = kind, capturedMonth = month;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      body.replaceChildren(notice('請選擇有效月份', '選擇月份後即可查詢報表。')); return;
    }
    body.replaceChildren(el('p', { role: 'status', class: 'loading' }, '正在整理報表…'));
    try {
      const result = await api(`/api/reports/${capturedKind}?month=${encodeURIComponent(capturedMonth)}`, { signal: controller.signal });
      if (!current() || request !== sequence) return;
      confirmFinancialReport(capturedKind, result, capturedMonth);
      const columns = result.columns.map(column => ({ ...column, label: /cents$/i.test(column.key) ? column.label.replace('（分）', '（元）') : column.label, render: row => /cents$/i.test(column.key)
        ? formatMoney(row[column.key] || 0) : textValue(row[column.key]) }));
      const totalColumns = Object.keys(result.totals || {}).map(key => ({ key, label: result.columns.find(column => column.key === key)?.label.replace('（分）', '（元）') || ({ count: '筆數', hours: '工時', total: '合計', quantity: '數量', minutes: '分鐘' })[key] || key,
        render: row => /cents$/i.test(key) ? formatMoney(row[key] || 0) : textValue(row[key]) }));
      body.replaceChildren(el('h2', {}, result.title), note(`${capturedMonth} · ${result.rows.length} 筆`),
        ...(result.note ? [notice(['fees', 'payroll'].includes(capturedKind) ? '試算，未核定規則' : '報表說明', result.note)] : []),
        table(columns, result.rows, { emptyText: '此月份沒有符合條件的資料。' }),
        ...(totalColumns.length ? [el('h3', {}, '合計'), table(totalColumns, [result.totals], {})] : []));
      legacyReady = true; download.disabled = false;
    } catch (error) {
      if (!current() || request !== sequence || error.name === 'AbortError') return;
      body.replaceChildren(errorState(error, load));
    }
  };
  monthInput.addEventListener('change', () => { month = monthInput.value; void load(); });
  container.replaceChildren(pageHeader('報表中心', `依本機已儲存資料查詢與匯出，目前可用 ${allowedReports.length} 種報表。`, []),
    notice('費用與薪資僅供試算', '金額依本機測試單價及時薪計算；尚未套用政府支付、加成、扣款、勞健保或正式核銷規則。'),
    el('div', { class: 'toolbar' },
      selectControl('報表類型', allowedReports, kind, value => { kind = value; void load(); }),
      monthField, reloadButton, download), body);
  await load();
}

async function settings(container, alive) {
  const context = getContext();
  const portalManaged = context.authMode === 'portal';
  const organization = context.organizations?.find(item => item.id === context.organizationId || item.id === context.orgId);
  const info = el('section', { class: 'panel' }, el('h2', {}, '目前帳號與機構'),
    table([{ label: '項目', key: 'label' }, { label: '內容', key: 'value' }], [
      { label: '機構', value: organization?.name || '目前機構' },
      { label: '使用者', value: context.user?.name || '—' }, { label: '電子郵件', value: context.user?.email || '—' },
      { label: '角色', value: ROLE[context.role] || context.role },
    ], {}));
  container.replaceChildren(pageHeader('機構與帳號設定', portalManaged ? '查看公司入口帳號與目前機構的存取角色。' : '管理本機測試版的機構、存取角色與示範資料。', []), info);
  if (context.role !== 'admin') { container.append(note('只有管理者可新增機構、帳號或示範資料。')); return; }
  const [users, employees] = await Promise.all([fetchAll('users'), fetchAll('employees')]);
  if (!alive()) return;
  const refresh = () => settings(container, alive);
  const newUser = () => openForm({
    title: '新增系統帳號',
    fields: [field('name', '使用者姓名', 'text', { required: true }), field('email', '登入電子郵件', 'email', { required: true }),
      field('password', '初始密碼', 'password', { required: true, minLength: 12, help: '至少 12 個字元。' }),
      field('role', '存取角色', 'select', { required: true, options: options(ROLE) }),
      field('employeeId', '連結員工', 'select', { options: [{ value: '', label: '不連結' }, ...selectedOptions(employees.filter(person => person.status === 'active'))], help: '居服員帳號必須連結本機構員工。' })],
    initial: { role: 'caregiver', employeeId: '' },
    onSubmit: async values => {
      if (values.password.length < 12) throw new Error('初始密碼至少需要 12 個字元。');
      if (values.role === 'caregiver' && !values.employeeId) throw new Error('居服員帳號必須選擇連結員工。');
      const data = { ...values }; if (!data.employeeId) delete data.employeeId;
      await api('/api/users', { method: 'POST', body: data });
      toast('系統帳號已新增', 'success'); await refresh();
    },
  });
  const newOrganization = () => openForm({
    title: '新增機構', fields: [field('name', '機構名稱', 'text', { required: true, wide: true })], initial: {},
    onSubmit: async values => {
      await api('/api/organizations', { method: 'POST', body: values });
      toast('機構已新增，正在更新機構選單', 'success');
      await refreshSession();
      if (alive()) await refresh();
    },
  });
  const peopleById = lookup(employees);
  container.append(el('section', { class: 'panel' },
    el('div', { class: 'section-heading' }, el('h2', {}, '機構帳號'), portalManaged
      ? el('p', { class: 'muted small' }, '公司帳號與機構由統一入口管理者開通。')
      : actions(button('新增帳號', newUser, { variant: 'primary' }), button('新增機構', newOrganization, { variant: 'outline' }))),
    table([{ key: 'name', label: '使用者' }, { key: 'email', label: '登入信箱' },
      { label: '角色', render: row => ROLE[row.role] || row.role },
      { label: '連結員工', render: row => peopleById.get(row.employeeId)?.name || '未連結' }], users, { emptyText: '目前沒有其他帳號。' })),
    el('section', { class: 'panel' }, el('h2', {}, '示範資料'),
      note('新增一組完全合成的個案、人員與作業資料，供測試流程。已有示範資料時不會重複建立。'),
      button('建立合成示範資料', () => confirmAction({
        title: '將示範資料加入目前機構',
        message: `將在「${organization?.name || '目前機構'}」加入合成測試資料。這些資料會保存在本機資料庫；確認此機構適合進行測試後再繼續。`,
        confirmLabel: '確認加入示範資料', danger: false,
        onConfirm: async () => { await api('/api/demo/seed', { method: 'POST', body: {} }); toast('示範資料已備妥', 'success'); await refresh(); },
      }), { variant: 'outline' })));
}

async function audit(container, alive) {
  if (getContext().role !== 'admin') {
    container.replaceChildren(pageHeader('操作紀錄', '追蹤本機系統內的資料變更。', []), notice('限管理者存取', '目前角色沒有讀取操作紀錄的權限。')); return;
  }
  await listPage(container, {
    entity: 'audit', title: '操作紀錄', subtitle: '依機構檢視資料變更事件；紀錄不提供編輯或刪除。', placeholder: '搜尋動作或資料類型',
    columns: () => [
      { label: '時間', render: row => timestamp(row.createdAt || row.created_at) },
      { label: '操作者', render: row => textValue(row.actor || row.userName || row.actorName || row.userId || row.user_id) },
      { key: 'action', label: '動作' }, { key: 'entity', label: '資料類型' },
      { label: '紀錄編號', render: row => textValue(row.recordId || row.record_id) },
      { label: '變更摘要', render: row => typeof row.detail === 'string' ? row.detail : JSON.stringify(row.detail || {}) },
    ],
  }, alive);
}

const routes = {
  '/personal-calendar': personalCalendar,
  '/case-followup-worklist': caseFollowupWorklist,
  '/supervisory-visits': supervisoryVisits,
  '/needs-assessments': needsAssessments,
  '/interviews': interviews,
  '/employees': employees, '/service-items': serviceItems, '/leave': leave,
  '/assessments': assessments, '/announcements': announcements, '/reports': reports,
  '/settings': settings, '/audit': audit,
};
export async function renderAdmin(route, container) {
  const render = routes[route];
  if (!render) return false;
  const token = ++generation;
  const identity = contextIdentity();
  const routeHash = window.location.hash;
  const stamp = `admin:${token}:${crypto.randomUUID()}`;
  container.dataset.renderVersion = stamp;
  const alive = () => window.location.hash === routeHash && token === generation && identity === contextIdentity()
    && container.isConnected && container.dataset.renderVersion === stamp;
  container.replaceChildren(el('p', { class: 'loading', role: 'status' }, '正在讀取頁面…'));
  try { await render(container, alive); }
  catch (error) { if (alive()) container.replaceChildren(errorState(error, () => renderAdmin(route, container))); }
  return true;
}
