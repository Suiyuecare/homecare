import { api, el, button, pageHeader, table, badge, openForm, openDetails, confirmAction, toast, today, getContext, searchBox, pagination, errorState } from '../ui.js';
import { openRecordHistory } from './history.js';
import { FORM_TYPES, FORM_TEMPLATE_STATUSES, FORM_RECORD_STATUSES, assertFormDefinition, assertFormTemplateRecord, assertFormRecord, captureFormTemplate, assertFormAnswers, customFormValueText } from '../data/custom-form-engine.js';
import { confirmCustomFormSave, createCustomFormRecordEditor, customFormFieldEditor } from '../data/custom-form-editor.js';

const org = () => getContext().organizationId || getContext().orgId;
const contextKey = () => { const ctx = getContext(); return JSON.stringify([ctx.user?.id, org(), ctx.role, ctx.user?.employeeId]); };
const notice = text => el('p', { class: 'notice', role: 'note' }, text);
const actions = (...items) => el('div', { class: 'actions row-actions', 'data-no-print': true }, ...items.filter(Boolean));
const abort = () => { throw new DOMException('目前操作已失效，請重新讀取。', 'AbortError'); };
const copy = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const textBaseline = value => value.replace(/\r\n?/g, '\n');
const safeButton = (label, action, variant = 'outline') => {
  let busy = false;
  const node = button(label, async () => {
    if (busy) return; busy = true; node.setAttribute('aria-busy', 'true'); node.setAttribute('aria-disabled', 'true');
    try { await action(node); } catch (error) { if (node.isConnected && error.name !== 'AbortError') toast(error.message || '操作失敗，請重新讀取。', 'error'); }
    finally { busy = false; node.removeAttribute('aria-busy'); node.removeAttribute('aria-disabled'); }
  }, { variant }); return node;
};
function check(entity, item) { return (entity === 'form-templates' ? assertFormTemplateRecord : assertFormRecord)(item, org()); }
async function collection(entity, filters, { signal, current }, maximum = 10000) {
  const items = [], ids = new Set(); let total;
  for (let page = 1; page <= Math.ceil(maximum / 100); page++) {
    const params = new URLSearchParams({ ...filters, page: String(page), pageSize: '100' }); const result = await api(`/api/${entity}?${params}`, { signal });
    if (!current()) abort();
    if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0 || result.total > maximum || result.page !== page || result.pageSize !== 100 || result.items.length > 100 || total !== undefined && total !== result.total) throw new Error('選取清單未完整讀取或已變動，請重新讀取。');
    total = result.total;
    for (const item of result.items) {
      if (item.orgId !== org() || typeof item.id !== 'string' || !item.id || ids.has(item.id)) throw new Error('選取清單身份無法確認。');
      if (entity === 'form-templates') check(entity, item);
      else if (typeof item.name !== 'string' && entity === 'cases' || entity === 'case-attachments' && (item.caseId !== filters.caseId || item.status !== 'active' || typeof item.title !== 'string')) throw new Error('選取清單內容無法確認。');
      ids.add(item.id); items.push(item);
    }
    if (items.length === total) return items;
    if (!result.items.length || items.length > total) throw new Error('選取清單分頁不完整。');
  }
  throw new Error('選取清單超過10000筆，請縮小範圍。');
}
export async function mountCustomForms(container, { isCurrent = () => true } = {}) {
  const ctx = getContext(), identity = contextKey(), hash = location.hash;
  const alive = () => container.isConnected && isCurrent() && getContext() === ctx && contextKey() === identity && location.hash === hash;
  if (!['admin', 'supervisor'].includes(ctx.role)) { const error = new Error('只有管理者與督導可使用自訂表單。'); error.status = 403; container.replaceChildren(errorState(error)); return; }
  let entity = 'form-templates', page = 1, query = '', status = '', sequence = 0, controller;
  const writeKeys = new WeakMap();
  const content = el('section', { class: 'panel', 'aria-live': 'polite' }), footer = el('div', { class: 'list-footer' });
  const read = async (kind, id, signal, current) => { const result = await api(`/api/${kind}/${encodeURIComponent(id)}`, { signal }); if (!current()) abort(); return check(kind, result.item); };
  const actionRead = async (trigger, action) => {
    const request = sequence, control = new AbortController(), current = () => alive() && sequence === request && (!trigger || trigger.isConnected);
    const invalidate = () => { if (!current()) control.abort(); }, observer = new MutationObserver(invalidate);
    observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] });
    window.addEventListener('session-updated', invalidate); window.addEventListener('hashchange', invalidate);
    try { if (!current()) return; await action(control.signal, current); }
    finally { control.abort(); observer.disconnect(); window.removeEventListener('session-updated', invalidate); window.removeEventListener('hashchange', invalidate); }
  };
  const save = async (kind, original, payload, owner, snapshot) => {
    const sent = original ? { ...payload, version: original.version } : payload;
    let headers;
    if (!original) { let keys = writeKeys.get(owner.signal); if (!keys) { keys = new Map(); writeKeys.set(owner.signal, keys); } const signature = JSON.stringify([kind, sent]); if (!keys.has(signature)) keys.set(signature, crypto.randomUUID()); headers = { 'Idempotency-Key': keys.get(signature) }; }
    const result = await api(original ? `/api/${kind}/${encodeURIComponent(original.id)}` : `/api/${kind}`, { method: original ? 'PATCH' : 'POST', body: sent, signal: owner.signal, headers });
    if (!owner.isCurrent()) abort(); return confirmCustomFormSave(result, { entity: kind, orgId: org(), original, payload, snapshot });
  };
  const fresh = async (kind, row, signal, current) => { const item = await read(kind, row.id, signal, current); if (item.version !== row.version) throw new Error('內容已更新，請重新讀取後操作。'); return item; };
  const afterSave = async (saved, message) => { if (saved && alive()) { await load(); if (alive()) toast(message, 'success'); } };
  const createTemplate = (previous, trigger) => actionRead(trigger, async (signal, current) => {
    const prior = previous ? await fresh('form-templates', previous, signal, current) : undefined;
    if (prior && !['published', 'inactive'].includes(prior.status)) throw new Error('請先發布前版模板，再建立新版草稿。');
    const initial = { code: prior?.code || '', name: prior?.name || '', description: textBaseline(prior?.description || ''), note: textBaseline(prior?.note || ''), firstKey: '', firstLabel: '' };
    const fields = [{ name: 'code', label: '模板代碼', required: true, maxLength: 100, readOnly: !!prior }, { name: 'name', label: '模板名稱', required: true, maxLength: 200 },
      { name: 'description', label: '填寫說明', type: 'textarea', maxLength: 10000, wide: true }, { name: 'note', label: '模板備註', type: 'textarea', maxLength: 10000, wide: true },
      ...(!prior ? [{ name: 'firstKey', label: '第一題代碼', required: true, maxLength: 50, help: '英文字母開頭，可加數字與底線。' }, { name: 'firstLabel', label: '第一題名稱', required: true, maxLength: 200, help: '先建立短文字題；儲存草稿後可增加群組、題項及顯示條件。' }] : [])];
    const saved = await openForm({ title: prior ? `建立第${prior.revision + 1}版草稿` : '新增自訂模板草稿', fields, initial, isCurrent: current,
      onSubmit: async (values, owner) => {
        const payload = { code: prior?.code || values.code.trim(), name: values.name.trim(), description: prior && values.description === initial.description ? prior.description : values.description,
          note: prior && values.note === initial.note ? prior.note : values.note, revision: prior ? prior.revision + 1 : 1, previousTemplateId: prior?.id || '', status: 'draft', groups: prior ? copy(prior.groups) : [],
          fields: prior ? copy(prior.fields) : [{ key: values.firstKey.trim(), label: values.firstLabel.trim(), type: 'text', groupId: '', required: false, options: [], visibleIf: null }] };
        assertFormDefinition(payload.groups, payload.fields, (status, code, message) => { const error = new Error(message); Object.assign(error, { status, code, fields: { firstKey: message } }); throw error; }); await save('form-templates', undefined, payload, owner);
      } }); await afterSave(saved, '已建立模板草稿');
  });
  const editTemplate = (row, trigger) => actionRead(trigger, async (signal, current) => {
    const original = await fresh('form-templates', row, signal, current); if (original.status !== 'draft') throw new Error('已發布模板只能建立新版。');
    const initial = { name: original.name, description: textBaseline(original.description), note: textBaseline(original.note) };
    const saved = await openForm({ title: '編輯模板說明', fields: [{ name: 'name', label: '模板名稱', required: true, maxLength: 200 }, { name: 'description', label: '填寫說明', type: 'textarea', maxLength: 10000, wide: true }, { name: 'note', label: '模板備註', type: 'textarea', maxLength: 10000, wide: true }], initial, isCurrent: current,
      onSubmit: async (values, owner) => { const payload = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, key === 'name' ? value.trim() : value === initial[key] ? original[key] : value]).filter(([key, value]) => !same(value, original[key]))); if (Object.keys(payload).length) await save('form-templates', original, payload, owner); } });
    await afterSave(saved, '已儲存模板說明');
  });
  const changeTemplateState = (row, target, trigger) => actionRead(trigger, async (signal, current) => {
    const original = await fresh('form-templates', row, signal, current);
    const agreed = await confirmAction({ title: target === 'published' ? '發布並鎖定模板？' : '停用此模板版本？', message: `${original.name} · 第${original.revision}版。${target === 'published' ? '發布後可新增填答；模板內容將鎖定，修改須建立新版。' : '停用後不能新增或修改此版本的填答草稿；已提交填答保留原快照。'}`, confirmLabel: target === 'published' ? '發布並鎖定' : '停用此版本', danger: target === 'inactive', signal, isCurrent: current });
    if (!agreed || !current()) return;
    await save('form-templates', original, { status: target }, { signal, isCurrent: current }); await afterSave(true, target === 'published' ? '已發布並鎖定模板' : '已停用模板版本');
  });
  const editGroup = (row, group, trigger) => actionRead(trigger, async (signal, current) => {
    const original = await fresh('form-templates', row, signal, current); if (original.status !== 'draft') throw new Error('模板內容已鎖定。');
    const saved = await openForm({ title: group ? '編輯群組' : '新增群組', isCurrent: current, initial: group || { id: '', label: '' },
      fields: [{ name: 'id', label: '群組代碼', required: true, readOnly: !!group, maxLength: 50 }, { name: 'label', label: '群組名稱', required: true, maxLength: 200 }],
      onSubmit: async (values, owner) => {
        const groups = copy(original.groups), next = { id: group?.id || values.id.trim(), label: values.label };
        if (group) groups[groups.findIndex(item => item.id === group.id)] = next; else groups.push(next);
        assertFormDefinition(groups, original.fields, (status, code, message) => { const error = new Error(message); Object.assign(error, { status, code, fields: { id: message } }); throw error; }); await save('form-templates', original, { groups }, owner);
      } }); await afterSave(saved, '已儲存表單群組');
  });
  const editQuestion = (row, field, index, trigger) => actionRead(trigger, async (signal, current) => {
    const original = await fresh('form-templates', row, signal, current); if (original.status !== 'draft') throw new Error('模板內容已鎖定。');
    const editor = customFormFieldEditor(original, field, index ?? original.fields.length);
    const saved = await openForm({ title: field ? '編輯題項' : '新增題項', fields: editor.fields, initial: editor.initial, onChange: editor.onChange, isCurrent: current,
      onSubmit: async (values, owner) => { const fields = editor.build(values); await save('form-templates', original, { fields }, owner); } }); await afterSave(saved, '已儲存表單題項');
  });
  const removeQuestion = (row, field, trigger) => actionRead(trigger, async (signal, current) => {
    const original = await fresh('form-templates', row, signal, current);
    if (original.status !== 'draft' || original.fields.length < 2) throw new Error('只能移除草稿題項，且模板至少保留一題。');
    if (original.fields.some(item => item.visibleIf?.field === field.key)) throw new Error('其他題項仍引用此題作顯示條件，請先修改條件。');
    const agreed = await confirmAction({ title: '移除草稿題項？', message: `將移除「${field.label}」，其他题項保持。歷程保留原定義。`, confirmLabel: '移除此題', danger: true, signal, isCurrent: current });
    if (!agreed || !current()) return; await save('form-templates', original, { fields: original.fields.filter(item => item.key !== field.key) }, { signal, isCurrent: current }); await afterSave(true, '已移除草稿題項');
  });
  const editRecord = (row, trigger) => actionRead(trigger, async (signal, current) => {
    const existing = row ? await fresh('form-records', row, signal, current) : undefined;
    let template, caseId = existing?.caseId;
    if (existing) {
      if (existing.status !== 'draft') throw new Error('已提交填答不可改寫。');
      template = await read('form-templates', existing.templateId, signal, current);
      if (template.status !== 'published' || template.version !== existing.templateVersion) throw new Error('來源模板已停用或變更；原草稿保留，請改用有效新版建立新紀錄。');
    } else {
      const templates = await collection('form-templates', { status: 'published' }, { signal, current }), cases = await collection('cases', {}, { signal, current });
      if (!templates.length || !cases.length) throw new Error('請先建立個案並發布至少一份自訂模板。');
      const selection = await openForm({ title: '選擇個案與模板版本', isCurrent: current, fields: [{ name: 'caseId', label: '所屬個案', type: 'select', required: true, options: cases.map(item => ({ value: item.id, label: item.name })) },
        { name: 'templateId', label: '已發布模板', type: 'select', required: true, options: templates.map(item => ({ value: item.id, label: `${item.name} · 第${item.revision}版` })) }], onSubmit: async () => {} });
      if (!selection || !current()) return; caseId = selection.caseId; template = await read('form-templates', selection.templateId, signal, current);
      if (template.status !== 'published') throw new Error('模板已停用，請重新選擇有效版本。');
    }
    const attachments = await collection('case-attachments', { caseId, status: 'active' }, { signal, current });
    if (existing?.attachmentIds.some(id => !attachments.some(item => item.id === id))) throw new Error('原草稿引用的附件已停用或不可用；請先恢復同個案附件，或建立新的填答紀錄。');
    const editor = createCustomFormRecordEditor({ template, existing, caseId, attachments, date: today() });
    let previous, latestValues, generation = 0, checking = Promise.resolve();
    const updateVisibility = (values, helpers) => { const visible = editor.visibility(values); for (const field of editor.snapshot.fields) helpers.setHidden('answer_' + field.key, !visible.has(field.key)); };
    const onChange = (values, helpers) => {
      if (!previous) { previous = copy(values); latestValues = copy(values); updateVisibility(values, helpers); return; }
      if (same(values, latestValues)) return;
      const captured = copy(values), request = ++generation; latestValues = copy(captured);
      checking = checking.then(async () => {
        if (!current() || request !== generation) return;
        const before = copy(previous);
        const hidden = editor.conditionalChange(before, captured);
        if (hidden.length) {
          const labels = editor.snapshot.fields.filter(field => hidden.includes(field.key)).map(field => field.label).join('、');
          const agreed = await confirmAction({ title: '變更條件並清除不適用答案？', message: `「${labels}」將不再顯示。確認後明確清除此草稿答案；取消會回復原條件與原答案。`, confirmLabel: '變更並清除答案', danger: true, signal, isCurrent: current });
          if (!current() || request !== generation) return;
          if (!agreed) { for (const [name, value] of Object.entries(before)) helpers.setValue(name, value); previous = before; latestValues = copy(before); updateVisibility(before, helpers); return; }
          editor.confirmClear(hidden); for (const key of hidden) { helpers.setValue('answer_' + key, editor.clearValue(key)); captured['answer_' + key] = editor.clearValue(key); }
        }
        previous = copy(captured); latestValues = copy(captured);
        updateVisibility(captured, helpers);
      }).catch(error => { if (current() && error.name !== 'AbortError') toast(error.message, 'error'); });
    };
    const saved = await openForm({ title: `填寫：${template.name} · 第${template.revision}版`, fields: editor.fields, initial: editor.initial, isCurrent: current, onChange,
      onSubmit: async (values, owner) => { await checking; if (!owner.isCurrent()) abort(); if (!same(values, latestValues)) throw new Error('顯示條件剛更新，請確認目前答案後重新儲存。'); const payload = editor.buildPayload(values); if (!Object.keys(payload).length) return;
        if (payload.status === 'submitted') { const agreed = await confirmAction({ title: '提交並鎖定填答？', message: '提交後保留此模板版次與答案，不能改寫；修正須另建新紀錄。這不是官方申報或評分。', confirmLabel: '提交並鎖定', signal: owner.signal, isCurrent: owner.isCurrent }); if (!agreed) throw new Error('尚未提交，草稿輸入仍保留。'); }
        await save('form-records', existing, payload, owner, editor.snapshot);
      } }); await afterSave(saved, '已儲存自訂表單填答');
  });
  const details = (row, trigger) => actionRead(trigger, async (signal, current) => {
    const kind = entity;
    await openDetails({ title: kind === 'form-templates' ? '自訂模板詳情' : '自訂填答詳情與本機列印', wide: true, printable: kind === 'form-records', guardedRead: true, isCurrent: current,
      load: async (readSignal, owner) => {
        const item = await read(kind, row.id, readSignal, owner.isCurrent);
        if (kind === 'form-templates') return el('section', {}, notice('機構自訂模板，非原16份官方表單，不計分。發布後內容鎖定；修訂號與保存版次分開顯示。'),
          el('h3', {}, `${item.name} · 第${item.revision}版`), el('p', {}, `${item.code} · ${FORM_TEMPLATE_STATUSES[item.status]} · 保存版次 ${item.version}`), el('p', { class: 'pre-wrap' }, item.description),
          actions(item.status === 'draft' && safeButton('新增群組', trigger => editGroup(item, undefined, trigger)), item.status === 'draft' && safeButton('新增題項', trigger => editQuestion(item, undefined, undefined, trigger))),
          table([{ key: 'label', label: '群組' }, { label: '操作', render: group => item.status === 'draft' ? safeButton('編輯群組', trigger => editGroup(item, group, trigger)) : '內容鎖定' }], item.groups, { caption: '題項群組', emptyText: '尚未分組，題項歸於一般題項。' }),
          table([{ key: 'label', label: '題項' }, { key: 'type', label: '型別' }, { label: '提交時必填', render: field => field.required ? '必填' : '可略過' }, { label: '選項', render: field => field.options.map(option => `${option.label}（${option.value}）`).join('、') || '不適用' },
            { label: '顯示條件', render: field => field.visibleIf ? `${field.visibleIf.field} = ${String(field.visibleIf.equals)}` : '一律顯示' }, { label: '操作', render: (field, index) => item.status === 'draft' ? actions(safeButton('編輯題項', trigger => editQuestion(item, field, item.fields.findIndex(entry => entry.key === field.key), trigger)), safeButton('移除題項', trigger => removeQuestion(item, field, trigger), 'danger')) : '內容鎖定' }], item.fields, { caption: '模板題項定義' }));
        const snapshot = item.templateSnapshot, visible = assertFormAnswers(snapshot.groups, snapshot.fields, item.answers, { submitted: item.status === 'submitted' }), groups = new Map(snapshot.groups.map(group => [group.id, group.label]));
        const parent = await api(`/api/cases/${encodeURIComponent(item.caseId)}`, { signal: readSignal }); if (!owner.isCurrent()) abort();
        if (parent.item?.id !== item.caseId || parent.item.orgId !== org() || typeof parent.item.name !== 'string') throw new Error('所屬個案身份無法確認。');
        return el('section', {}, notice('機構自訂表單，非官方核定模板；不計分。列印前重新讀取此填答，内容沿已保存模板快照。'), el('h3', {}, snapshot.name),
          el('p', {}, `目前個案：${parent.item.name} · ${item.caseId}`), el('p', {}, `${item.date} · ${FORM_RECORD_STATUSES[item.status]} · 填答保存版次 ${item.version} · 模板第${snapshot.revision}版（保存版次 ${item.templateVersion}）`),
          el('p', { class: 'pre-wrap' }, snapshot.description), table([{ label: '群組', render: field => groups.get(field.groupId) || '一般題項' }, { key: 'label', label: '題項' }, { label: '保存答案', render: field => el('span', { class: 'pre-wrap' }, customFormValueText(field, item.answers[field.key])) }], snapshot.fields.filter(field => visible.has(field.key)), { caption: '依保存模板顯示的完整填答' }),
          el('p', { class: 'pre-wrap' }, `備註：${item.note || '未填寫'}`), el('p', {}, `引用附件識別碼：${item.attachmentIds.join('、') || '無'}。檔案仍由既有個案附件管理，不複製至表單。`));
      } });
  });
  const load = async () => {
    if (!alive()) return; const request = ++sequence; controller?.abort(); controller = new AbortController(); content.dataset.renderVersion = `forms:${request}`;
    content.replaceChildren(el('p', { class: 'loading', role: 'status' }, '正在讀取自訂表單…')); footer.replaceChildren();
    const params = new URLSearchParams({ page: String(page), pageSize: '25' }); if (query) params.set('q', query); if (status) params.set('status', status);
    try {
      const result = await api(`/api/${entity}?${params}`, { signal: controller.signal }); if (!alive() || request !== sequence) return;
      if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0 || result.page !== page || result.pageSize !== 25 || result.items.length > 25) throw new Error('自訂表單清單回應無法確認。');
      const ids = new Set(); for (const item of result.items) { check(entity, item); if (ids.has(item.id)) throw new Error('清單識別碼重複。'); ids.add(item.id); }
      if (page > 1 && !result.items.length && result.total) { page = Math.ceil(result.total / 25); return load(); }
      content.replaceChildren(table([{ label: entity === 'form-templates' ? '模板名稱' : '保存模板', render: row => entity === 'form-templates' ? `${row.name} · 第${row.revision}版` : `${row.templateSnapshot.name} · 第${row.templateSnapshot.revision}版` },
        { label: entity === 'form-templates' ? '模板代碼' : '個案識別碼', render: row => entity === 'form-templates' ? row.code : row.caseId }, { label: '狀態', render: row => { const tag = badge(row.status); tag.textContent = (entity === 'form-templates' ? FORM_TEMPLATE_STATUSES : FORM_RECORD_STATUSES)[row.status]; return tag; } },
        { label: '保存版次', render: row => String(row.version) }, { label: '操作', render: row => actions(safeButton('詳情', trigger => details(row, trigger)),
          row.status === 'draft' && safeButton(entity === 'form-templates' ? '編輯說明' : '編輯填答', trigger => entity === 'form-templates' ? editTemplate(row, trigger) : editRecord(row, trigger)),
          entity === 'form-templates' && row.status === 'draft' && safeButton('發布並鎖定', trigger => changeTemplateState(row, 'published', trigger), 'primary'),
          entity === 'form-templates' && row.status !== 'draft' && safeButton('建立新版', trigger => createTemplate(row, trigger)),
          entity === 'form-templates' && row.status === 'published' && safeButton('停用', trigger => changeTemplateState(row, 'inactive', trigger), 'danger'),
          safeButton('歷程', trigger => actionRead(trigger, async (signal, current) => openRecordHistory({ entity, id: row.id, isCurrent: current })))) }], result.items,
      { caption: entity === 'form-templates' ? '機構自訂模板' : '個案自訂填答', emptyText: entity === 'form-templates' ? '尚無自訂模板；請新增模板草稿。' : '尚無填答；請先發布模板後新增填答。' }));
      footer.append(pagination({ page, pageSize: 25, total: result.total, onChange: next => { page = next; void load(); } }));
    } catch (error) { if (alive() && request === sequence && error.name !== 'AbortError') content.replaceChildren(errorState(error, () => load())); }
  };
  const mode = el('select', { class: 'input', 'aria-label': '表單工作清單' }, el('option', { value: 'form-templates' }, '自訂模板'), el('option', { value: 'form-records' }, '個案填答'));
  const statusSelect = el('select', { class: 'input', 'aria-label': '表單狀態' });
  const setStatusOptions = () => statusSelect.replaceChildren(el('option', { value: '' }, '全部狀態'), ...Object.entries(entity === 'form-templates' ? FORM_TEMPLATE_STATUSES : FORM_RECORD_STATUSES).map(([value, label]) => el('option', { value }, label)));
  mode.addEventListener('change', () => { entity = mode.value; page = 1; status = ''; setStatusOptions(); void load(); }); statusSelect.addEventListener('change', () => { status = statusSelect.value; page = 1; void load(); }); setStatusOptions();
  container.replaceChildren(pageHeader('自訂表單', '依機構自訂題項保存填答；模板及填答發布／提交後鎖定，正式16種模板另行核定。', safeButton('新增', trigger => entity === 'form-templates' ? createTemplate(undefined, trigger) : editRecord(undefined, trigger), 'primary')),
    el('div', { class: 'filters' }, mode, statusSelect, searchBox({label:'搜尋自訂表單',placeholder:'搜尋模板名稱、代碼或備註',onSearch:value => { if(alive()){query = value; page = 1; void load();} }})), content, footer);
  await load();
}
