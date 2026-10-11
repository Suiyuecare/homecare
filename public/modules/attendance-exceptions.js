import { spanRecordText } from '../data/shift-span-editor.js';
const savedShiftText = item => Object.hasOwn(item, 'endDate') ? spanRecordText(item) : item.date + ' ' + item.startTime + '–' + item.endTime;
import { api, el, button, pageHeader, table, badge, openForm, openDetails, confirmAction, toast, today, getContext, pagination, errorState } from '../ui.js';
import { openRecordHistory } from './history.js';
import { ATTENDANCE_EXCEPTION_ENTITY, ATTENDANCE_EXCEPTION_STATUSES, ATTENDANCE_EXCEPTION_KINDS, isAttendanceYear, isAttendanceDate, assertAttendanceExceptionItem, attendanceExceptionReadModel } from '../data/attendance-exception-core.js';
import { createAttendanceExceptionEditor, confirmAttendanceExceptionSave } from '../data/attendance-exception-editor.js';
const entity = ATTENDANCE_EXCEPTION_ENTITY;
const identity = () => { const ctx = getContext(); return JSON.stringify([ctx.user?.id, ctx.organizationId || ctx.orgId, ctx.role, ctx.user?.employeeId]); };
const cancelled = () => { throw new DOMException('目前操作已失效，請重新讀取。', 'AbortError'); };
const safeButton = (label, action, variant = 'outline') => { let busy = false; const node = button(label, async () => { if (busy) return; busy = true; node.setAttribute('aria-busy', 'true'); node.setAttribute('aria-disabled', 'true'); try { await action(node); } catch (error) { if (node.isConnected && error.name !== 'AbortError') toast(error.message || '請重新讀取資料。', 'error'); } finally { busy = false; node.removeAttribute('aria-busy'); node.removeAttribute('aria-disabled'); } }, { variant }); return node; };
const actions = (...items) => el('div', { class: 'actions row-actions' }, ...items.filter(Boolean));
export async function mountAttendanceExceptions(container, { isCurrent = () => true } = {}) {
  const ctx = getContext(), orgId = ctx.organizationId || ctx.orgId, key = identity(), hash = location.hash, manages = ['admin', 'supervisor'].includes(ctx.role);
  const alive = () => container.isConnected && isCurrent() && getContext() === ctx && identity() === key && location.hash === hash;
  if (!manages && ctx.role !== 'caregiver') { const error = new Error('此角色無權使用人工出勤例外紀錄。'); error.status = 403; container.replaceChildren(errorState(error)); return; }
  let page = 1, sequence = 0, controller, filters = { year: today().slice(0, 4), date: '', kind: '', status: '', employeeId: ctx.role === 'caregiver' ? ctx.user.employeeId : '', q: '' }, confirmed = true;
  const writeKeys = new WeakMap(), content = el('section', { class: 'panel', 'aria-live': 'polite' }), footer = el('div', { class: 'list-footer' });
  const yearInput = el('input', { type: 'text', inputmode: 'numeric', maxlength: '4', value: filters.year, class: 'input', 'aria-label': '人工出勤例外年度' });
  const employeeSelect = el('select', { class: 'input', 'aria-label': '人工出勤例外員工', disabled: ctx.role === 'caregiver' }), statusSelect = el('select', { class: 'input', 'aria-label': '人工出勤例外狀態' }, el('option', { value: '' }, '全部狀態'), ...Object.entries(ATTENDANCE_EXCEPTION_STATUSES).map(([value, label]) => el('option', { value }, label)));
  const dateInput = el('input', { type: 'text', maxlength: '10', class: 'input', 'aria-label': '人工出勤例外日期', placeholder: 'YYYY-MM-DD（可留空）' }), kindSelect = el('select', { class: 'input', 'aria-label': '人工出勤例外種類' }, el('option', { value: '' }, '全部種類'), ...Object.entries(ATTENDANCE_EXCEPTION_KINDS).map(([value, label]) => el('option', { value }, label)));
  const searchInput = el('input', { type: 'search', maxlength: '200', class: 'input', 'aria-label': '搜尋人工原因或來源', placeholder: '搜尋人工原因或來源' }), filterError = el('p', { role: 'alert', class: 'field-error', hidden: true });
  const current = request => alive() && confirmed && sequence === request;
  async function employees(signal, owner) {
    const all = [], ids = new Set(); let total;
    for (let n = 1; n <= 100; n++) {
      const result = await api('/api/employees?page=' + n + '&pageSize=100', { signal }); if (!owner()) cancelled();
      if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0 || result.total > 10000 || result.page !== n || result.pageSize !== 100 || total !== undefined && total !== result.total || result.items.length !== Math.min(100, Math.max(0, result.total - (n - 1) * 100))) throw new Error('員工選取清單未完整讀取，請重新讀取。');
      total = result.total;
      for (const item of result.items) { if (item.orgId !== orgId || typeof item.id !== 'string' || !item.id || !Number.isSafeInteger(item.version) || item.version < 1 || ids.has(item.id) || typeof item.name !== 'string' || !item.name.trim() || !['active', 'inactive'].includes(item.status) || ctx.role === 'caregiver' && item.id !== ctx.user.employeeId) throw new Error('員工選取身份無法確認。'); ids.add(item.id); all.push(item); }
      if (all.length === total) return all;
    }
    throw new Error('員工清單超過10000筆，請縮小範圍。');
  }
  async function shifts(signal, owner) {
    const all = [], ids = new Set(); let total;
    for (let page = 1; page <= 100; page++) { const result = await api('/api/shifts?page=' + page + '&pageSize=100', { signal }); if (!owner()) cancelled();
      if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0 || result.total > 10000 || result.page !== page || result.pageSize !== 100 || total !== undefined && total !== result.total || result.items.length !== Math.min(100, Math.max(0, result.total - (page - 1) * 100))) throw new Error('班次選取清單未完整讀取，請重新讀取。'); total = result.total;
      for (const item of result.items) { if (item.orgId !== orgId || typeof item.id !== 'string' || !item.id || ids.has(item.id) || !Number.isSafeInteger(item.version) || item.version < 1 || !isAttendanceDate(item.date) || typeof item.employeeId !== 'string' || !item.employeeId || typeof item.startTime !== 'string' || typeof item.endTime !== 'string') throw new Error('班次選取身份無法確認。'); ids.add(item.id); all.push(item); } if (all.length === total) return all;
    } throw new Error('班次清單超過10000筆，請縮小範圍。');
  }
  async function shiftReference(item, signal, owner) { if (!item.shiftId) return undefined; try { const result = await api('/api/shifts/' + encodeURIComponent(item.shiftId), { signal }); if (!owner()) cancelled(); const parent = result.item; if (parent?.id !== item.shiftId || parent.orgId !== orgId || parent.employeeId !== item.employeeId || parent.date !== item.date || !Number.isSafeInteger(parent.version) || parent.version < 1 || typeof parent.startTime !== 'string' || typeof parent.endTime !== 'string') return undefined; return parent; } catch (error) { if (!owner() || error.name === 'AbortError') cancelled(); return undefined; } }

  const read = async (id, signal, owner) => { const result = await api('/api/' + entity + '/' + encodeURIComponent(id), { signal }); if (!owner()) cancelled(); return assertAttendanceExceptionItem(result.item, orgId); };
  const actionRead = async (trigger, action) => {
    const request = sequence, control = new AbortController(), owner = () => current(request) && (!trigger || trigger.isConnected), invalidate = () => { if (!owner()) control.abort(); }, observer = new MutationObserver(invalidate);
    observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] }); window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate);
    try { if (!owner()) return; await action(control.signal, owner); } finally { control.abort(); observer.disconnect(); window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate); }
  };
  const fresh = async (row, signal, owner) => { const item = await read(row.id, signal, owner); if (item.version !== row.version) throw new Error('紀錄已更新，請重新查詢後操作。'); return item; };
  async function save(original, payload, owner) {
    let headers;
    if (!original) { let keys = writeKeys.get(owner.signal); if (!keys) { keys = new Map(); writeKeys.set(owner.signal, keys); } const signature = JSON.stringify(payload); if (!keys.has(signature)) keys.set(signature, crypto.randomUUID()); headers = { 'Idempotency-Key': keys.get(signature) }; }
    const result = await api('/api/' + entity + (original ? '/' + encodeURIComponent(original.id) : ''), { method: original ? 'PATCH' : 'POST', body: original ? { ...payload, version: original.version } : payload, signal: owner.signal, headers });
    if (!owner.isCurrent()) cancelled(); return confirmAttendanceExceptionSave(result, { orgId, original, payload });
  }
  const afterSave = async value => { if (value && alive() && confirmed) { await load(); if (alive()) toast('已保存人工出勤例外紀錄', 'success'); } };
  const edit = (row, trigger) => actionRead(trigger, async (signal, owner) => {
    const original = row ? await fresh(row, signal, owner) : undefined, list = await employees(signal, owner);
    const shiftList = await shifts(signal, owner), editor = createAttendanceExceptionEditor({ existing: original, employees: list, shifts: shiftList, date: filters.date || (filters.year === today().slice(0, 4) ? today() : filters.year + '-01-01') });
    if (!original && filters.employeeId) editor.initial.employeeId = filters.employeeId;
    const saved = await openForm({ title: original ? '編輯人工出勤紀錄' : '新增人工出勤例外', fields: editor.fields, initial: editor.initial, isCurrent: owner, onChange: editor.onChange,
      onSubmit: async (values, formOwner) => { const payload = editor.build(values); if (Object.keys(payload).length) await save(original, payload, formOwner); } }); await afterSave(saved);
  });
  const transition = (row, target, trigger) => actionRead(trigger, async (signal, owner) => {
    const original = await fresh(row, signal, owner), verify = target === 'resolved'; if (original.status !== (verify ? 'recorded' : 'resolved')) throw new Error('此狀態不能執行本次操作。');
    const saved = await openForm({ title: verify ? '人工處理出勤例外' : '作廢人工出勤例外', isCurrent: owner,
      fields: verify ? [{ name: 'resolvedOn', label: '本次處理日期', type: 'date', required: true }, { name: 'resolution', label: '本次處理結果', type: 'textarea', required: true, maxLength: 10000, help: '填入本次人工處理所依文件或事實；不自動判斷法定認定。' }] : [{ name: 'voidedOn', label: '本次作廢日期', type: 'date', required: true }, { name: 'voidReason', label: '本次作廢原因', type: 'textarea', required: true, maxLength: 10000 }],
      initial: verify ? { resolvedOn: today(), resolution: '' } : { voidedOn: today(), voidReason: '' },
      onSubmit: async (values, formOwner) => {
        const agreed = await confirmAction({ title: verify ? '確認人工處理並鎖定？' : '確認作廢此紀錄？', message: ATTENDANCE_EXCEPTION_KINDS[original.kind] + (verify ? '：處理後原始原因與结果鎖定，不推算出勤時數或薪資。' : '：原處理內容與本次原因留存，作廢後不能改寫。'), confirmLabel: verify ? '處理並鎖定' : '作廢並鎖定', danger: !verify, signal: formOwner.signal, isCurrent: formOwner.isCurrent });
        if (!agreed) throw new Error('尚未執行，輸入仍保留。'); await save(original, { ...values, status: target }, formOwner);
      } }); await afterSave(saved);
  });
  const details = (row, trigger) => actionRead(trigger, async (signal, owner) => {
    await openDetails({ title: '人工出勤例外詳情', wide: true, guardedRead: true, isCurrent: owner, load: async (readSignal, readOwner) => {
      const item = await read(row.id, readSignal, readOwner.isCurrent), model = attendanceExceptionReadModel(item, orgId), parent = await api('/api/employees/' + encodeURIComponent(item.employeeId), { signal: readSignal }); if (!readOwner.isCurrent()) cancelled();
      if (parent.item?.id !== item.employeeId || parent.item.orgId !== orgId || typeof parent.item.name !== 'string' || !parent.item.name.trim() || !Number.isSafeInteger(parent.item.version) || parent.item.version < 1 || !['active', 'inactive'].includes(parent.item.status)) throw new Error('目前員工身份無法確認。');
      const shift = await shiftReference(item, readSignal, readOwner.isCurrent);
      return el('section', {}, el('p', { class: 'notice', role: 'note' }, model.warning), el('h3', {}, model.kindLabel),
        table([{ key: 'label', label: '欄位' }, { label: '人工保存內容', render: value => el('span', { class: 'pre-wrap' }, value.value || '未填寫') }], [
          { label: '目前員工', value: parent.item.name + ' · ' + item.employeeId }, { label: '人工記錄日期／年度', value: item.date + ' · ' + model.year }, { label: '保存班次參照快照', value: item.shiftSnapshot ? savedShiftText(item.shiftSnapshot) + ' · 第' + item.shiftVersion + '版 · ' + item.shiftId : '未參照班次' }, { label: '目前仍符合原員工日期的班次', value: shift ? savedShiftText(shift) : item.shiftId ? '目前班次已變更或無法取得，原保存參照仍保留' : '未參照班次' },
          { label: '人工原因／事實說明', value: item.reason }, { label: '人工來源依據', value: item.sourceReference }, { label: '備註', value: item.note },
          { label: '狀態／保存版次', value: ATTENDANCE_EXCEPTION_STATUSES[item.status] + ' · ' + item.version }, { label: '本次處理日期', value: item.resolvedOn }, { label: '本次處理結果', value: item.resolution }, { label: '本次作廢日期', value: item.voidedOn }, { label: '作廢原因', value: item.voidReason }], { caption: '逐筆人工出勤例外紀錄' }));
    } });
  });
  const add = manages && safeButton('新增人工出勤例外', trigger => edit(undefined, trigger), 'primary');
  const history = (row, trigger) => actionRead(trigger, async (signal, owner) => {
    const item = await read(row.id, signal, owner), result = await api('/api/employees/' + encodeURIComponent(item.employeeId), { signal }); if (!owner()) cancelled();
    const parent = result.item;
    if (parent?.id !== item.employeeId || parent.orgId !== orgId || typeof parent.name !== 'string' || !parent.name.trim() || !Number.isSafeInteger(parent.version) || parent.version < 1 || !['active', 'inactive'].includes(parent.status)) throw new Error('目前員工身份無法確認，請重新讀取歷程。');
    const shift = await shiftReference(item, signal, owner); await openRecordHistory({ entity, id: item.id, isCurrent: owner, lookups: { employees: new Map([[parent.id, parent]]), shifts: new Map(shift ? [[shift.id, shift]] : []) } });
  });
  async function load() {
    if (!alive() || !confirmed) return; const request = ++sequence; controller?.abort(); controller = new AbortController(); content.dataset.renderVersion = 'attendance-exceptions:' + request; content.replaceChildren(el('p', { role: 'status' }, '正在讀取人工出勤例外…')); footer.replaceChildren();
    const params = new URLSearchParams({ year: filters.year, page: String(page), pageSize: '25' }); for (const key of ['date', 'kind', 'employeeId', 'status', 'q']) if (filters[key]) params.set(key, filters[key]);
    try {
      const result = await api('/api/' + entity + '?' + params, { signal: controller.signal }); if (!current(request)) return;
      if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0 || result.page !== page || result.pageSize !== 25 || result.items.length !== Math.min(25, Math.max(0, result.total - (page - 1) * 25))) throw new Error('年度人工出勤紀錄清單未完整確認，請重試。');
      const ids = new Set(); for (const item of result.items) { assertAttendanceExceptionItem(item, orgId); if (ids.has(item.id) || item.date.slice(0, 4) !== filters.year || filters.date && item.date !== filters.date || filters.kind && item.kind !== filters.kind || filters.employeeId && item.employeeId !== filters.employeeId || filters.status && item.status !== filters.status || ctx.role === 'caregiver' && item.employeeId !== ctx.user.employeeId) throw new Error('年度、日期、種類、員工或狀態範圍未確認。'); ids.add(item.id); }
      content.replaceChildren(el('p', { class: 'notice', role: 'note' }, '人工原因與處理結果逐筆保存；不推算出勤時數、打卡、請假或薪資。'),
        table([{ key: 'date', label: '人工記錄日期' }, { label: '人工種類', render: item => ATTENDANCE_EXCEPTION_KINDS[item.kind] }, { label: '人工原因', render: item => el('span', { class: 'pre-wrap' }, item.reason) }, { label: '狀態', render: item => { const node = badge(item.status); node.textContent = ATTENDANCE_EXCEPTION_STATUSES[item.status]; return node; } },
          { label: '操作', render: item => actions(safeButton('詳情', trigger => details(item, trigger)), manages && item.status === 'recorded' && safeButton('編輯紀錄', trigger => edit(item, trigger)), manages && item.status === 'recorded' && safeButton('人工處理', trigger => transition(item, 'resolved', trigger), 'primary'), manages && item.status === 'resolved' && safeButton('作廢', trigger => transition(item, 'voided', trigger), 'danger'), safeButton('歷程', trigger => history(item, trigger))) }], result.items, { caption: filters.year + '年人工出勤例外逐筆明細', emptyText: '本年度尚無符合範圍的人工紀錄。' }));
      footer.append(pagination({ page, pageSize: 25, total: result.total, onChange: next => { page = next; void load(); } }));
    } catch (error) { if (current(request) && error.name !== 'AbortError') content.replaceChildren(errorState(error, load)); }
  }
  const invalidate = () => { confirmed = false; ++sequence; controller?.abort(); content.dataset.renderVersion = 'attendance-exceptions:draft:' + sequence; content.replaceChildren(el('p', { role: 'status' }, '查詢條件已修改，請執行年度查詢。')); footer.replaceChildren(); filterError.hidden = true; if (add) add.disabled = true; };
  for (const input of [yearInput, dateInput, kindSelect, employeeSelect, statusSelect, searchInput]) { input.addEventListener('input', invalidate); input.addEventListener('change', invalidate); }
  const apply = safeButton('查詢年度', async () => {
    if (!isAttendanceYear(yearInput.value)) { filterError.textContent = '請填入0001至9999的四位年度；尚未送出查詢。'; filterError.hidden = false; yearInput.focus(); return; }
    if (dateInput.value && (!isAttendanceDate(dateInput.value) || dateInput.value.slice(0, 4) !== yearInput.value)) { filterError.textContent = '日期須為有效 YYYY-MM-DD 且符合查詢年度；尚未送出查詢。'; filterError.hidden = false; dateInput.focus(); return; }
    filters = { year: yearInput.value, date: dateInput.value, kind: kindSelect.value, employeeId: ctx.role === 'caregiver' ? ctx.user.employeeId : employeeSelect.value, status: statusSelect.value, q: searchInput.value }; page = 1; confirmed = true; filterError.hidden = true; if (add) add.disabled = false; await load();
  }, 'primary');
  const filterField = (label, control) => el('label', { class: 'field' }, el('span', {}, label), control);
  container.replaceChildren(pageHeader('人工出勤例外', '人工記錄例外原因、來源與處理結果，保留原始內容及版本。', add), el('div', { class: 'toolbar' }, filterField('年度', yearInput), filterField('日期', dateInput), filterField('員工', employeeSelect), filterField('種類', kindSelect), filterField('狀態', statusSelect), filterField('原因或來源', searchInput), apply), filterError, content, footer);
  try { const start = sequence, control = new AbortController(), list = await employees(control.signal, () => alive() && sequence === start); if (!alive() || sequence !== start) return; employeeSelect.replaceChildren(...(manages ? [el('option', { value: '' }, '全部員工')] : []), ...list.map(item => el('option', { value: item.id }, item.name))); employeeSelect.value = filters.employeeId; await load(); }
  catch (error) { if (alive() && error.name !== 'AbortError') content.replaceChildren(errorState(error)); }
}
