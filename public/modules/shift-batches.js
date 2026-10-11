import { shiftSpan } from '../data/shift-span.js';
import { assertSpanData, spanRecordText } from '../data/shift-span-editor.js';
import { api, el, table, openForm, toast, today, getContext } from '../ui.js';
import { formatShiftDate, formatShiftTime } from '../data/shift-editor.js';

const MAX_ITEMS = 50, MAX_CHOICES = 100;
const names = ['caseId', 'employeeId', 'carePlanId', 'date', 'startTime', 'endTime', 'services', 'status', 'note', 'endDate'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => Object.hasOwn(value, key);
const identity = value => typeof value === 'string' && Boolean(value.trim()) && value === value.trim() && value.length <= 500;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fail = (field, message) => { const error = new Error(message); error.fields = { [field]: message }; throw error; };
const unconfirmed = () => fail('items', '整批排班回應未確認；請保留輸入並重新讀取目前班表。');
const fingerprint = () => { const ctx = getContext(); return JSON.stringify([ctx.user?.id, ctx.organizationId || ctx.orgId, ctx.role, ctx.user?.employeeId]); };
function assertShift(item, orgId, { metadata = true, scheduled = false } = {}) {
  assertSpanData(item);
  if (Object.hasOwn(item, 'endDate')) { try { shiftSpan({ date: item.date, startTime: item.startTime, endTime: item.endTime, endDate: item.endDate }); } catch { unconfirmed(); } }
  if (!plain(item) || metadata && (!identity(item.id) || item.orgId !== orgId || !Number.isSafeInteger(item.version) || item.version < 1)) unconfirmed();
  const allowed = new Set([...names, ...(metadata ? ['id', 'orgId', 'version', 'createdAt', 'updatedAt'] : [])]);
  if (Object.keys(item).some(key => !allowed.has(key))) unconfirmed();
  for (const key of ['caseId', 'employeeId', 'carePlanId']) if (!identity(item[key])) unconfirmed();
  for (const key of ['date', 'startTime', 'endTime', 'status']) if (typeof item[key] !== 'string') unconfirmed();
  if (formatShiftDate(item.date) === '日期未取得' || formatShiftTime(item.startTime) === '時間未取得' || formatShiftTime(item.endTime) === '時間未取得'
    || !['scheduled', 'cancelled', 'completed'].includes(item.status) || scheduled && item.status !== 'scheduled') unconfirmed();
  if (own(item, 'note') && (typeof item.note !== 'string' || item.note.length > 10000)) unconfirmed();
  if (!Array.isArray(item.services) || !item.services.length || item.services.length > 100 || new Set(item.services.map(line => line?.serviceItemId)).size !== item.services.length) unconfirmed();
  for (const line of item.services) if (!plain(line) || Object.keys(line).length !== 2 || Object.keys(line).some(key => !['serviceItemId', 'quantity'].includes(key)) || !identity(line.serviceItemId) || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 10000) unconfirmed();
  for (const key of ['createdAt', 'updatedAt']) if (metadata && own(item, key) && typeof item[key] !== 'string') unconfirmed();
  return item;
}
function assertDefinition(definition) {
  if (!plain(definition) || Object.keys(definition).some(key => !['action', 'items', 'employeeId', 'reason'].includes(key)) || !['reassign', 'cancel'].includes(definition.action)
    || !Array.isArray(definition.items) || !definition.items.length || definition.items.length > MAX_ITEMS || typeof definition.reason !== 'string' || !definition.reason.trim() || definition.reason.length > 2000
    || (definition.action === 'reassign' ? !identity(definition.employeeId) : own(definition, 'employeeId'))) unconfirmed();
  const seen = new Set();
  for (const item of definition.items) { if (!plain(item) || Object.keys(item).length !== 2 || !identity(item.id) || !Number.isSafeInteger(item.version) || item.version < 1 || seen.has(item.id)) unconfirmed(); seen.add(item.id); }
  return definition;
}
const signature = definition => JSON.stringify([definition.action, definition.items.map(item => [item.id, item.version]), definition.employeeId, definition.reason]);
export function shiftBatchFormDefinition(values, candidates, orgId) {
  assertSpanData(values); assertSpanData(candidates);
  const allowed = ['selectionDate', 'selectionSearch', 'selectionState', 'action', 'employeeId', 'items', 'reason'];
  if (!plain(values) || Object.keys(values).some(key => !allowed.includes(key))) fail('items', '批次表單含未知欄位。');
  if (!Array.isArray(values.items) || !values.items.length || values.items.length > MAX_ITEMS || new Set(values.items).size !== values.items.length) fail('items', '請明確選取1至50筆且不重複的班次。');
  if (!['reassign', 'cancel'].includes(values.action)) fail('action', '請選擇改派或取消。');
  if (typeof values.reason !== 'string' || !values.reason.trim() || values.reason.length > 2000) fail('reason', '本次原因必填且最多2000字。');
  if (values.action === 'reassign' && !identity(values.employeeId)) fail('employeeId', '請選擇本機構使用中的服務人員。');
  const items = values.items.map(selected => { const item = candidates.find(item => item.id === selected); if (!item) fail('items', '選取班次已不在目前清單，請重新讀取。'); assertShift(item, orgId, { scheduled: true }); return { id: item.id, version: item.version }; });
  return { action: values.action, items, ...(values.action === 'reassign' ? { employeeId: values.employeeId } : {}), reason: values.reason };
}
export function confirmShiftBatchChoices(response, orgId, date) {
  assertSpanData(response);
  if (!plain(response) || response.page !== 1 || response.pageSize !== MAX_CHOICES || !Number.isSafeInteger(response.total) || response.total < 0 || response.total > MAX_CHOICES
    || !Array.isArray(response.items) || response.items.length !== response.total) fail('items', response?.total > MAX_CHOICES ? '符合條件的班次超過100筆，請選日期或縮小搜尋後重新讀取；沒有截斷選取清單。' : '班次選取清單未完整讀取。');
  const seen = new Set();
  for (const item of response.items) { assertShift(item, orgId, { scheduled: true }); if (seen.has(item.id) || date && item.date !== date) unconfirmed(); seen.add(item.id); }
  return response.items;
}
export function confirmShiftBatchPreview(result, definition, orgId) {
  assertSpanData(result); assertSpanData(definition);
  assertDefinition(definition);
  if (!plain(result) || Object.keys(result).some(key => !['definition', 'items', 'total', 'readyCount', 'conflictCount', 'canCommit'].includes(key))) unconfirmed();
  assertDefinition(result.definition);
  if (signature(result.definition) !== signature(definition) || result.total !== definition.items.length || !Array.isArray(result.items) || result.items.length !== result.total) unconfirmed();
  let ready = 0, conflicts = 0;
  for (let index = 0; index < result.items.length; index++) {
    const item = result.items[index], selected = definition.items[index];
    if (!plain(item) || Object.keys(item).some(key => !['id', 'version', 'status', 'before', 'after', 'conflicts'].includes(key)) || item.id !== selected.id || item.version !== selected.version || !Array.isArray(item.conflicts)) unconfirmed();
    for (const conflict of item.conflicts) if (!plain(conflict) || Object.keys(conflict).some(key => !['code', 'message', 'fields'].includes(key)) || typeof conflict.code !== 'string' || !conflict.code || typeof conflict.message !== 'string' || !conflict.message
      || own(conflict, 'fields') && (!plain(conflict.fields) || Object.values(conflict.fields).some(value => typeof value !== 'string'))) unconfirmed();
    if (own(item, 'before') || own(item, 'after')) {
      if (!own(item, 'before') || !own(item, 'after')) unconfirmed();
      assertShift(item.before, orgId, { scheduled: true }); assertShift(item.after, orgId, { metadata: false });
      if (item.before.id !== item.id || item.before.version !== item.version) unconfirmed();
      for (const key of names) { const expected = key === 'employeeId' && definition.action === 'reassign' ? definition.employeeId : key === 'status' && definition.action === 'cancel' ? 'cancelled' : item.before[key];
        if (own(item.after, key) !== own(item.before, key) || !same(item.after[key], expected)) unconfirmed(); }
    }
    if (item.status === 'ready' && item.conflicts.length === 0 && own(item, 'before')) ready++;
    else if (item.status === 'conflict' && item.conflicts.length > 0) conflicts++; else unconfirmed();
  }
  if (result.readyCount !== ready || result.conflictCount !== conflicts || result.canCommit !== (conflicts === 0)) unconfirmed(); return result;
}
export function confirmShiftBatchCommit(result, preview, definition, orgId) {
  assertSpanData(result);
  confirmShiftBatchPreview(preview, definition, orgId);
  if (!preview.canCommit || !plain(result) || Object.keys(result).some(key => !['batchId', 'action', 'reason', 'items', 'total'].includes(key)) || !identity(result.batchId)
    || result.action !== definition.action || result.reason !== definition.reason || result.total !== preview.total || !Array.isArray(result.items) || result.items.length !== preview.total) unconfirmed();
  for (let index = 0; index < result.items.length; index++) {
    const item = assertShift(result.items[index], orgId), row = preview.items[index];
    if (item.id !== row.id || item.version !== row.version + 1 || own(item, 'createdAt') !== own(row.before, 'createdAt') || item.createdAt !== row.before.createdAt) unconfirmed();
    for (const key of names) if (own(item, key) !== own(row.after, key) || !same(item[key], row.after[key])) unconfirmed();
  }
  return result;
}
function previewContent(preview, data) {
  const cases = new Map((data.cases || []).map(item => [item.id, item])), employees = new Map((data.employees || []).map(item => [item.id, item]));
  const name = (lookup, id) => typeof lookup.get(id)?.name === 'string' ? lookup.get(id).name : '名稱未取得';
  return el('div', {}, el('h3', {}, '整批調整預覽'), el('p', { class: 'notice', role: 'status' }, `選取 ${preview.total} 筆，可操作 ${preview.readyCount} 筆，有衝突 ${preview.conflictCount} 筆。${preview.canCommit ? '請確認內容後套用，保存時會再次檢查全部班次。' : '請處理所有衝突後重新預覽，整批不會略過失敗班次。'}`),
    table([{ label: '日期與時段', render: row => row.before ? spanRecordText(row.before) : '目前內容不可用' },
      { label: '個案', render: row => row.before ? name(cases, row.before.caseId) : '未確認' }, { label: '目前人員', render: row => row.before ? name(employees, row.before.employeeId) : '未確認' },
      { label: '預定調整', render: row => row.after ? preview.definition.action === 'reassign' ? '改派給 ' + name(employees, row.after.employeeId) : '取消班次' : '不能操作' },
      { label: '檢查結果', render: row => row.status === 'ready' ? '目前可操作' : row.conflicts.map(conflict => conflict.message).join('；') }], preview.items, { caption: '明確選取班次的預覽結果' }));
}
/** One shared form: bounded explicit selection → read-only preview → atomic save. */
export function openShiftBatch({ data, refresh = () => {}, isCurrent = () => true }) {
  const ctx = getContext(), orgId = ctx.organizationId || ctx.orgId, captured = fingerprint(), hash = window.location.hash;
  let active = true, revision = 0, choices = [], choiceSignature, choiceError = null, controller, pending, confirmed = null;
  const current = () => active && isCurrent() && getContext() === ctx && fingerprint() === captured && window.location.hash === hash;
  if (!['admin', 'supervisor'].includes(ctx.role) || !current()) return Promise.resolve(false);
  const employees = (data.employees || []).filter(item => item.orgId === orgId && item.status === 'active' && identity(item.id) && typeof item.name === 'string' && typeof item.employeeNo === 'string');
  const ensure = () => { if (!current()) throw new DOMException('目前操作已失效，請重新讀取。', 'AbortError'); };
  const keys = new Map();
  function loadChoices(values, helpers) {
    const selectedDate = values.selectionDate, query = values.selectionSearch;
    const next = JSON.stringify([selectedDate, query]); if (next === choiceSignature) return;
    choiceSignature = next; choiceError = null; choices = []; confirmed = null; controller?.abort(); controller = new AbortController(); const signal = controller.signal;
    helpers.setOptions('items', []); helpers.setValue('items', []); helpers.setValue('selectionState', '正在讀取可選班次…');
    const params = new URLSearchParams({ status: 'scheduled', page: '1', pageSize: String(MAX_CHOICES) }); if (selectedDate) params.set('date', selectedDate); if (query) params.set('q', query);
    pending = (async () => {
      try {
        const response = await api('/api/shifts?' + params, { signal }); if (!current() || signal.aborted || next !== choiceSignature) return;
        choices = confirmShiftBatchChoices(response, orgId, selectedDate);
        const cases = new Map((data.cases || []).map(item => [item.id, item]));
        helpers.setOptions('items', choices.map(item => ({ value: item.id, label: `${spanRecordText(item)}｜${typeof cases.get(item.caseId)?.name === 'string' ? cases.get(item.caseId).name : '個案名稱未取得'}｜版次 ${item.version}` })));
        helpers.setValue('selectionState', choices.length ? `已讀取 ${choices.length} 筆排定班次，請明確勾選最多50筆；預覽會檢查服務紀錄。` : '沒有符合條件的排定班次，請調整日期或搜尋。');
      } catch (error) { if (error.name === 'AbortError' || !current() || signal.aborted || next !== choiceSignature) return; choiceError = error; helpers.setValue('selectionState', error.message); }
    })();
  }
  const outcome = openForm({ title: '批次改派與取消班次', previewLabel: '預覽整批調整', submitLabel: '確認套用整批調整', isCurrent: current,
    initial: { selectionDate: today(), selectionSearch: '', selectionState: '正在讀取可選班次…', action: 'reassign', employeeId: '', items: [], reason: '' },
    fields: [{ name: 'selectionDate', label: '選取清單日期', type: 'date', help: '可清空查看跨日班次。更改篩選時原選取會清除，不會自動選取新結果。' },
      { name: 'selectionSearch', label: '選取清單搜尋', type: 'text', maxLength: 200, help: '符合條件最多100筆；超過時請縮小日期或文字搜尋。' },
      { name: 'selectionState', label: '選取清單狀態', type: 'text', disabled: true },
      { name: 'items', label: '本次明確選取的班次', type: 'checkbox-group', required: true, wide: true, options: [], help: '1至50筆，僅排定且沒有任何服務紀錄的班次可以保存。' },
      { name: 'action', label: '本次操作', type: 'select', required: true, options: [{ value: 'reassign', label: '改派服務人員' }, { value: 'cancel', label: '取消班次' }] },
      { name: 'employeeId', label: '改派服務人員', type: 'select', options: employees.map(item => ({ value: item.id, label: `${item.employeeNo} ${item.name}` })) },
      { name: 'reason', label: '本次批次操作原因', type: 'textarea', required: true, maxLength: 2000, wide: true, help: '原因保存在稽核紀錄；原交班備註、日期、時段及服務明細保持。' }],
    onChange: (values, helpers) => { revision++; confirmed = null; helpers.setDisabled('employeeId', values.action !== 'reassign'); loadChoices(values, helpers); },
    onPreview: async (values, { signal }) => {
      ensure(); await pending; ensure(); if (choiceError) throw choiceError;
      const definition = shiftBatchFormDefinition(values, choices, orgId), requested = revision;
      const result = await api('/api/shift-batches/preview', { method: 'POST', body: definition, signal }); ensure();
      if (signal.aborted || requested !== revision) throw new DOMException('預覽已失效。', 'AbortError');
      const preview = confirmShiftBatchPreview(result, definition, orgId); confirmed = { definition, preview, revision };
      return { content: previewContent(preview, data), canSubmit: preview.canCommit };
    },
    onSubmit: async (values, { signal, isCurrent: formCurrent }) => {
      ensure(); const definition = shiftBatchFormDefinition(values, choices, orgId), accepted = confirmed;
      if (!accepted || accepted.revision !== revision || !accepted.preview.canCommit || signature(accepted.definition) !== signature(definition)) { const error = new Error('請重新預覽目前選取的全部班次。'); error.invalidatePreview = true; throw error; }
      const serialized = signature(definition); if (!keys.has(serialized)) keys.set(serialized, crypto.randomUUID());
      let result;
      try { result = await api('/api/shift-batches/commit', { method: 'POST', body: definition, headers: { 'Idempotency-Key': keys.get(serialized) }, signal }); }
      catch (error) {
        if (error.code === 'BATCH_CONFLICT' || error.code === 'IDEMPOTENCY_CONFLICT') {
          error.invalidatePreview = true; confirmed = null;
          if (current() && error.details?.preview) { try { error.previewContent = previewContent(confirmShiftBatchPreview(error.details.preview, definition, orgId), data); } catch { /* Keep the server's failure without displaying an unconfirmed preview. */ } }
        }
        throw error;
      }
      if (!formCurrent()) return;
      confirmShiftBatchCommit(result, accepted.preview, definition, orgId); toast(`已${definition.action === 'reassign' ? '改派' : '取消'} ${result.total} 筆班次。`, 'success');
    },
  });
  outcome.then(saved => { active = false; controller?.abort(); if (saved && isCurrent() && getContext() === ctx && fingerprint() === captured && window.location.hash === hash) void refresh(); });
  return outcome;
}
