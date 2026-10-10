import { api, el, badge, openForm, toast, formatDate, today, getContext } from '../ui.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const weekdayOptions = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'].map((label, index) => ({ value: index + 1, label }));
const contextIdentity = () => {
  const context = getContext();
  return `${context.user?.id || ''}:${context.organizationId || context.orgId || ''}:${context.role || ''}`;
};
const field = (name, label, type = 'text', extra = {}) => ({ name, label, type, ...extra });
const failure = (name, message) => { const error = new Error(message); error.fields = { [name]: message }; return error; };
const cancelled = () => new DOMException('操作已取消', 'AbortError');
const calendarDay = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date.getTime() / DAY_MS : NaN;
};
const weekdayLabel = date => {
  const index = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekdayOptions[(index + 6) % 7]?.label || '';
};
const serviceSignature = services => JSON.stringify((Array.isArray(services) ? services : [])
  .map(item => ({ serviceItemId: item.serviceItemId, quantity: item.quantity }))
  .sort((a, b) => String(a.serviceItemId).localeCompare(String(b.serviceItemId))));
const definitionSignature = definition => JSON.stringify([
  definition?.caseId, definition?.employeeId, definition?.carePlanId, definition?.startDate, definition?.endDate,
  definition?.intervalWeeks, Array.isArray(definition?.weekdays) ? [...definition.weekdays].sort((a, b) => a - b) : null,
  definition?.startTime, definition?.endTime, serviceSignature(definition?.services), definition?.note || '',
]);

function confirmPreview(result, definition) {
  const invalid = () => { throw new Error('未取得完整的排班預覽，請保留輸入後重試。'); };
  if (!result || definitionSignature(result.definition) !== definitionSignature(definition)
    || !Number.isSafeInteger(result.total) || result.total < 1 || result.total > 93
    || !Array.isArray(result.items) || result.items.length !== result.total) invalid();
  let previous = '', ready = 0, conflicts = 0;
  for (const item of result.items) {
    if (!Number.isFinite(calendarDay(item?.date)) || item.date < definition.startDate || item.date > definition.endDate || item.date <= previous
      || item.startTime !== definition.startTime || item.endTime !== definition.endTime || !Array.isArray(item.conflicts)) invalid();
    previous = item.date;
    if (item.status === 'ready' && item.conflicts.length === 0) ready++;
    else if (item.status === 'conflict' && item.conflicts.length > 0 && item.conflicts.every(conflict => typeof conflict.message === 'string' && conflict.message)) conflicts++;
    else invalid();
  }
  if (result.readyCount !== ready || result.conflictCount !== conflicts || result.canCommit !== (conflicts === 0)) invalid();
  return result;
}

function previewContent(preview) {
  return el('section', { class: 'recurring-preview', 'aria-label': '排班預覽' },
    el('h3', {}, '排班預覽'),
    el('div', { class: 'recurring-summary', role: 'status' },
      el('strong', {}, `共 ${preview.total} 個日期`), el('span', {}, `可建立 ${preview.readyCount} 筆`), el('span', {}, `有衝突 ${preview.conflictCount} 筆`)),
    el('p', { class: 'notice' }, preview.canCommit ? '所有日期目前均可建立；提交時會再次核對整批班次。' : '請先調整有衝突的條件並重新預覽；不會略過衝突日期建立其餘班次。'),
    el('div', { class: 'recurring-dates' }, preview.items.map(item => {
      const state = badge(item.status === 'ready' ? 'active' : 'returned'); state.textContent = item.status === 'ready' ? '可建立' : '有衝突';
      return el('article', { class: 'recurring-date-card', 'aria-label': `${formatDate(item.date)} ${weekdayLabel(item.date)}` },
        el('div', { class: 'section-heading' }, el('strong', {}, el('time', { datetime: item.date }, formatDate(item.date)), ` ${weekdayLabel(item.date)}`), state),
        el('p', {}, `${item.startTime}–${item.endTime}`),
        item.conflicts.length > 0 && el('ul', { class: 'recurring-conflicts' }, item.conflicts.map(conflict => el('li', {}, conflict.message))),
      );
    })),
  );
}

function confirmBatch(result, preview, definition) {
  const invalid = () => { throw new Error('未取得完整的整批排班儲存確認，請保留輸入並使用原表單重試。'); };
  if (typeof result?.batchId !== 'string' || !result.batchId.trim() || result.total !== preview.total
    || !Array.isArray(result.items) || result.items.length !== preview.total) invalid();
  const dates = new Set(preview.items.map(item => item.date)), ids = new Set();
  for (const item of result.items) {
    if (typeof item?.id !== 'string' || !item.id.trim() || ids.has(item.id) || !Number.isSafeInteger(item.version) || item.version < 1
      || !dates.has(item.date) || item.caseId !== definition.caseId || item.employeeId !== definition.employeeId || item.carePlanId !== definition.carePlanId
      || item.startTime !== definition.startTime || item.endTime !== definition.endTime || item.status !== 'scheduled'
      || serviceSignature(item.services) !== serviceSignature(definition.services) || (item.note || '') !== definition.note) invalid();
    ids.add(item.id); dates.delete(item.date);
  }
  if (dates.size > 0) invalid();
}

/** One bounded batch, with server preview and an atomic commit; no persistent schedule rule. */
export function openRecurringShifts({ data, refresh, isCurrent = () => true }) {
  const identity = contextIdentity(), hash = window.location.hash;
  const current = () => identity === contextIdentity() && hash === window.location.hash && isCurrent();
  const ensureCurrent = () => { if (!current()) throw cancelled(); };
  if (!['admin', 'supervisor'].includes(getContext().role) || !current()) return;
  const cases = new Map(data.cases.map(item => [item.id, item]));
  const plans = data['care-plans'].filter(item => item.status === 'active' && cases.get(item.caseId)?.status === 'active');
  const employees = data.employees.filter(item => item.status === 'active');
  const serviceItems = data['service-items'].filter(item => item.status === 'active');
  if (!plans.length) { toast('請先建立並啟用個案的照顧計畫，再安排週期排班。', 'info'); return; }
  if (!employees.length) { toast('請先建立使用中的服務人員，再安排週期排班。', 'info'); return; }
  const allowedFor = planId => new Set(plans.find(item => item.id === planId)?.services?.map(item => item.serviceItemId) || []);
  const serviceOptions = planId => serviceItems.filter(item => allowedFor(planId).has(item.id)).map(item => ({ value: item.id, label: `${item.code} ${item.name}` }));
  const startDate = today(), endDate = new Date((calendarDay(startDate) + 27) * DAY_MS).toISOString().slice(0, 10);
  let selectedPlanId = plans[0].id, revision = 0, confirmedPreview = null;
  const headers = { 'Idempotency-Key': crypto.randomUUID() };

  function definitionFor(values) {
    const plan = plans.find(item => item.id === values.carePlanId);
    if (!plan) throw failure('carePlanId', '請選擇有效的照顧計畫。');
    if (!employees.some(item => item.id === values.employeeId)) throw failure('employeeId', '請選擇使用中的服務人員。');
    const first = calendarDay(values.startDate), last = calendarDay(values.endDate);
    if (!Number.isFinite(first)) throw failure('startDate', '請填寫有效的開始日期。');
    if (!Number.isFinite(last)) throw failure('endDate', '請填寫有效的結束日期。');
    if (last < first) throw failure('endDate', '結束日期不能早於開始日期。');
    if (last - first + 1 > 93) throw failure('endDate', '起訖日期含兩端最多 93 個日曆日。');
    const intervalWeeks = Number(values.intervalWeeks);
    if (!Number.isInteger(intervalWeeks) || intervalWeeks < 1 || intervalWeeks > 4) throw failure('intervalWeeks', '請選擇每隔 1 至 4 週。');
    if (!Array.isArray(values.weekdays) || !values.weekdays.length || values.weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7) || new Set(values.weekdays).size !== values.weekdays.length) throw failure('weekdays', '請至少選擇一個服務星期。');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(values.startTime)) throw failure('startTime', '請填寫有效的開始時間。');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(values.endTime) || values.endTime <= values.startTime) throw failure('endTime', '結束時間必須晚於開始時間；本次不接受跨夜班次。');
    const allowed = new Set(serviceOptions(plan.id).map(item => item.value));
    if (!Array.isArray(values.services) || !values.services.length || values.services.length > 100
      || values.services.some(item => !allowed.has(item.serviceItemId) || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 10000)
      || new Set(values.services.map(item => item.serviceItemId)).size !== values.services.length) throw failure('services', '請選擇計畫允許且使用中的服務，數量須為 1 至 10000 的整數。');
    const note = String(values.note || '').trim();
    if (note.length > 10000) throw failure('note', '交班備註最多可填寫 10000 個字元。');
    return {
      caseId: plan.caseId, employeeId: values.employeeId, carePlanId: plan.id,
      startDate: values.startDate, endDate: values.endDate, intervalWeeks, weekdays: [...values.weekdays].sort((a, b) => a - b),
      startTime: values.startTime, endTime: values.endTime,
      services: values.services.map(item => ({ serviceItemId: item.serviceItemId, quantity: item.quantity })), note,
    };
  }

  return openForm({
    title: '週期排班', previewLabel: '預覽排班', submitLabel: '建立全部班次',
    initial: { carePlanId: selectedPlanId, employeeId: '', startDate, endDate, intervalWeeks: 1, weekdays: [], startTime: '09:00', endTime: '10:00', services: [], note: '' },
    fields: [
      field('carePlanId', '個案與照顧計畫', 'select', { required: true, options: plans.map(plan => ({ value: plan.id, label: `${cases.get(plan.caseId).name}｜${plan.validFrom} 起${plan.validTo ? `至 ${plan.validTo}` : ''}` })), help: '服務項目隨計畫調整；更換計畫後須重新填寫服務數量。' }),
      field('employeeId', '服務人員', 'select', { required: true, placeholder: '請選擇服務人員', options: employees.map(item => ({ value: item.id, label: `${item.employeeNo || ''} ${item.name}`.trim() })) }),
      field('startDate', '開始日期', 'date', { required: true, help: '開始日期所在週的週一為第 1 週。' }),
      field('endDate', '結束日期', 'date', { required: true, help: '含起訖日期，最多 93 個日曆日；不自動跳過假日。只建立所選區間，不會持續自動排班。' }),
      field('intervalWeeks', '每隔幾週', 'select', { required: true, options: [1, 2, 3, 4].map(value => ({ value, label: `每 ${value} 週` })), help: '以週一至週日為同一週，從第 1 週起依間隔選週。' }),
      field('weekdays', '服務星期', 'checkbox-group', { required: true, wide: true, options: weekdayOptions, help: '至少選一天；每個符合的日期建立一班。' }),
      field('startTime', '開始時間', 'time', { required: true }), field('endTime', '結束時間', 'time', { required: true }),
      field('services', '本次服務與數量', 'services', { required: true, wide: true, options: serviceOptions(selectedPlanId), help: '此服務與數量套用至每一筆班次。' }),
      field('note', '交班備註', 'textarea', { wide: true, maxLength: 10000, help: '此備註套用至每一筆班次；預覽不會建立班次。' }),
    ],
    onChange: (values, controls) => {
      revision++; confirmedPreview = null;
      if (values.carePlanId !== selectedPlanId) {
        selectedPlanId = values.carePlanId;
        controls.setOptions('services', serviceOptions(selectedPlanId));
        controls.setValue('services', []);
      }
    },
    onPreview: async (values, { signal }) => {
      ensureCurrent();
      const definition = definitionFor(values), requestedRevision = revision;
      confirmedPreview = null;
      const result = await api('/api/recurring-shifts/preview', { method: 'POST', body: definition, signal });
      ensureCurrent();
      if (signal.aborted || requestedRevision !== revision) throw cancelled();
      const preview = confirmPreview(result, definition);
      confirmedPreview = { definition, preview, revision };
      return { content: previewContent(preview), canSubmit: preview.canCommit };
    },
    onSubmit: async values => {
      ensureCurrent();
      const definition = definitionFor(values), confirmed = confirmedPreview;
      if (!confirmed || confirmed.revision !== revision || !confirmed.preview.canCommit || definitionSignature(confirmed.definition) !== definitionSignature(definition)) {
        const error = new Error('輸入已變更或尚無可提交的預覽，請重新預覽排班。'); error.invalidatePreview = true; throw error;
      }
      let result;
      try {
        result = await api('/api/recurring-shifts/commit', { method: 'POST', body: definition, headers });
      } catch (error) {
        if (error.code === 'BATCH_CONFLICT') {
          error.invalidatePreview = true; confirmedPreview = null;
          if (current()) {
            try { error.previewContent = previewContent(confirmPreview(error.details?.preview, definition)); }
            catch { /* Keep the server's conflict message if its preview cannot be confirmed. */ }
          }
        } else if (error.code === 'IDEMPOTENCY_CONFLICT') {
          error.invalidatePreview = true; confirmedPreview = null;
          error.message = '這份表單已有不同內容的提交紀錄。請先核對班表，再關閉並重新開啟週期排班。';
        }
        throw error;
      }
      if (!current()) return;
      confirmBatch(result, confirmed.preview, definition);
      await refresh();
      if (current()) toast(`已建立 ${result.total} 筆班次。`, 'success');
    },
  });
}
