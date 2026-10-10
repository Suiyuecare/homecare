import {
  api, el, button, badge, openForm, confirmAction, toast, getContext, searchBox, pagination, errorState,
  MAX_ATTACHMENT_FILE_BYTES, ATTACHMENT_FILE_ACCEPT, formatFileSize, attachmentFilePayload, downloadAttachment,
} from '../ui.js';
import { ATTACHMENT_CATEGORIES, ATTACHMENT_STATUSES } from '../data/history-fields.js';
import {
  createAttachmentMetadataEditor, confirmAttachmentMetadataList, attachmentMetadataIdentity,
  formatAttachmentMetadataText, formatAttachmentMetadataCategory, formatAttachmentMetadataStatus, formatAttachmentMetadataMime,
} from '../data/attachment-metadata-editor.js';
import { openRecordHistory } from './history.js';

const PAGE_SIZE = 25;
const contextIdentity = () => {
  const context = getContext();
  return attachmentMetadataIdentity(context);
};
const entityConfig = Object.freeze({
  'case-attachments': Object.freeze({ parentKey: 'caseId', parentLabel: '個案', title: '個案附件', category: true }),
  'certification-attachments': Object.freeze({ parentKey: 'certificationId', parentLabel: '證照', title: '證照附件', category: false }),
});
const labelOf = (choices, value) => choices.find(item => item.value === value)?.label || value || '未提供';
const text = value => value === undefined || value === null || value === '' ? '未提供' : String(value);
const field = (name, label, type = 'text', extra = {}) => ({ name, label, type, ...extra });
const fileType = formatAttachmentMetadataMime;

function filter(label, choices, onChange) {
  const select = el('select', { 'aria-label': label }, choices.map(item => el('option', { value: item.value }, item.label)));
  select.addEventListener('change', () => onChange(select.value));
  return el('label', { class: 'field' }, el('span', {}, label), select);
}

function mutationError(error, { metadataOnly = false } = {}) {
  if (error.status === 409) error.message = `${error.message} 請保留本次${metadataOnly ? '輸入' : '輸入與選檔'}，關閉表單並重新讀取附件後再修改。`;
  return error;
}

function metadata(values, withCategory) {
  const result = { title: String(values.title || '').trim(), note: String(values.note || '').trim() };
  if (withCategory) result.category = values.category;
  const fields = {};
  if (!result.title) fields.title = '請填寫附件標題。';
  else if (result.title.length > 200) fields.title = '附件標題最多可填寫 200 個字元。';
  if (result.note.length > 10000) fields.note = '備註最多可填寫 10000 個字元。';
  if (Object.keys(fields).length) { const error = new Error('請修正附件資料。'); error.fields = fields; throw error; }
  return result;
}

/** Only the attachment island reloads; metadata and file operations remain separate. */
export function createAttachmentsPanel({ caseRecord, entity = 'case-attachments', parentRecord = caseRecord, employees = new Map(), onClose, isCurrent = () => true }) {
  if (!Object.hasOwn(entityConfig, entity)) throw new Error('附件資料類型不合法。');
  const config = entityConfig[entity];
  if (!parentRecord?.id) throw new Error('附件所屬資料無法取得。');
  const lookups = config.category ? { cases: new Map([[parentRecord.id, parentRecord]]) }
    : { 'employee-certifications': new Map([[parentRecord.id, parentRecord]]), employees };
  const startedContext = getContext(), identity = contextIdentity(), hash = window.location.hash;
  const orgId = startedContext.organizationId ?? startedContext.orgId;
  const mayWrite = ['admin', 'supervisor'].includes(getContext().role);
  const state = { q: '', category: '', status: '', page: 1 };
  const lifetime = new AbortController();
  const titleId = `attachments-${crypto.randomUUID()}`;
  const results = el('div', { class: 'attachments-list', 'aria-busy': 'true' });
  const footer = el('div');
  const actions = el('div', { class: 'actions' });
  const element = el('section', { class: 'panel', 'aria-labelledby': titleId },
    el('div', { class: 'section-heading' }, el('h2', { id: titleId, tabindex: '-1' }, config.title), actions),
    !config.category && el('p', { class: 'pre-wrap' }, `證照：${text(parentRecord.name)}\n員工：${text(employees.get(parentRecord.employeeId)?.name)}`),
    el('p', { class: 'muted small' }, '每次可上傳一份 PDF、PNG 或 JPEG，最大 5 MiB。更換檔案後仍可從版本歷程下載舊版。'),
  );
  const current = () => !lifetime.signal.aborted && isCurrent() && element.isConnected && getContext() === startedContext && identity === contextIdentity() && hash === window.location.hash;
  const ensureCurrent = () => {
    if (!current()) throw new Error(`${config.parentLabel}、頁面或機構已切換，請關閉表單後重新開啟。`);
    if (!mayWrite) throw new Error('您只有附件資料的讀取權限。');
  };
  let request = 0, controller, observer;
  const invalidate = () => { if (!current()) destroy(); };
  function destroy() {
    if (lifetime.signal.aborted) return;
    lifetime.abort(); controller?.abort(); observer?.disconnect();
    window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate);
    element.replaceChildren(); element.remove();
  }
  function observe() {
    if (observer || !current()) return;
    observer = new MutationObserver(invalidate);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] });
    window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate);
  }

  function metadataFields() {
    return [
      field('title', '附件標題', 'text', { required: true, maxLength: 200, help: `所屬${config.parentLabel}：${text(parentRecord.name)}。建立後不能更換${config.parentLabel}。` }),
      ...(config.category ? [field('category', '附件分類', 'select', { required: true, options: ATTACHMENT_CATEGORIES })] : []),
      field('note', '備註', 'textarea', { maxLength: 10000, help: '最多 10000 個字元。' }),
    ];
  }

  async function attachmentForm(mode, item) {
    if (!current() || !mayWrite) return;
    if (mode === 'edit') return editMetadata(item);
    const upload = mode === 'upload', replace = mode === 'replace';
    const needsFile = upload || replace;
    const headers = { 'Idempotency-Key': crypto.randomUUID() };
    const fields = replace ? [] : metadataFields();
    if (needsFile) fields.push(field('file', replace ? '替換檔案' : '附件檔案', 'file', {
      required: true, accept: ATTACHMENT_FILE_ACCEPT, maxFileBytes: MAX_ATTACHMENT_FILE_BYTES, wide: true,
      help: replace ? `目前檔案：${item.fileName}。選擇新檔案會建立新版本，原檔案仍會保留。` : '一次選擇一份 PDF、PNG 或 JPEG，最大 5 MiB。',
    }));
    await openForm({
      title: upload ? '新增附件' : replace ? '更換檔案' : '編輯附件資料',
      initial: replace ? {} : item ? { title: item.title, category: item.category, note: item.note } : { title: '', category: 'general', note: '' },
      fields,
      onSubmit: async values => {
        ensureCurrent();
        const payload = replace ? { version: item.version } : metadata(values, config.category);
        if (upload) { payload[config.parentKey] = parentRecord.id; payload.status = 'active'; }
        else payload.version = item.version;
        if (needsFile) {
          ensureCurrent();
          const file = await attachmentFilePayload(values.file, { signal: lifetime.signal });
          ensureCurrent();
          Object.assign(payload, file);
        }
        ensureCurrent();
        const path = upload ? `/api/${entity}/upload` : `/api/${entity}/${encodeURIComponent(item.id)}${replace ? '/replace-file' : ''}`;
        try {
          const response = await api(path, { method: needsFile ? 'POST' : 'PATCH', body: payload, headers });
          const confirmed = response?.item;
          if (typeof confirmed?.id !== 'string' || !confirmed.id.trim() || !Number.isSafeInteger(confirmed.version) || confirmed.version < 1 || (!upload && confirmed.id !== item.id)) {
            throw new Error('未取得附件儲存確認，請保留輸入與選檔後重試。');
          }
        } catch (error) { throw mutationError(error); }
        if (!current()) return;
        await load();
        if (current()) toast(upload ? '附件已新增。' : replace ? '檔案已更換，舊版仍保留於歷程。' : '附件資料已更新。', 'success');
      },
    });
  }

  function editMetadata(item) {
    if (!current() || !mayWrite) return;
    const editor = createAttachmentMetadataEditor({
      entity, existing: item, parentId: parentRecord.id, employeeId: parentRecord.employeeId,
    });
    const id = item.id, version = item.version;
    return openForm({
      title: '編輯附件資料', initial: editor.initial, fields: editor.fields, isCurrent: current,
      onChange: (values, helpers) => {
        for (const descriptor of editor.fields) if (editor.needsIntent(descriptor.name))
          helpers.setDisabled(descriptor.name, !editor.enabled(descriptor.name, values));
      },
      onSubmit: async (values, { signal, isCurrent: formCurrent }) => {
        if (!formCurrent()) return;
        const payload = editor.buildPayload(values);
        if (!Object.keys(payload).length) { if (formCurrent()) toast('附件資料沒有變更。', 'info'); return; }
        let response;
        try {
          response = await api(`/api/${entity}/${encodeURIComponent(id)}`, {
            method: 'PATCH', body: { ...payload, version }, signal,
          });
        } catch (error) { throw mutationError(error, { metadataOnly: true }); }
        if (!formCurrent()) return;
        editor.confirm(response?.item, orgId, payload);
        await load();
        if (formCurrent()) toast('附件資料已更新。', 'success');
      },
    });
  }

  function changeStatus(item) {
    if (!current() || !mayWrite || !ATTACHMENT_STATUSES.some(status => status.value === item.status)) return;
    const active = item.status === 'inactive', verb = active ? '恢復使用' : '停用';
    const editor = createAttachmentMetadataEditor({ entity, existing: item, parentId: parentRecord.id, employeeId: parentRecord.employeeId });
    const id = item.id, version = item.version;
    return confirmAction({
      title: `${verb}附件？`,
      message: `將「${formatAttachmentMetadataText(item.title)}」改為${active ? '使用中' : '已停用'}。檔案與版本歷程會保留，有此${config.parentLabel}讀取權限的人仍可下載。`,
      confirmLabel: `確認${verb}`, danger: !active, signal: lifetime.signal, isCurrent: current,
      onConfirm: async ({ signal, isCurrent: actionCurrent }) => {
        if (!actionCurrent()) return;
        const payload = editor.buildStatusChange(active ? 'active' : 'inactive');
        let response;
        try {
          response = await api(`/api/${entity}/${encodeURIComponent(id)}`, { method: 'PATCH', body: { version, ...payload }, signal });
        } catch (error) { throw mutationError(error, { metadataOnly: true }); }
        if (!actionCurrent()) return;
        editor.confirm(response?.item, orgId, payload);
        await load();
        if (actionCurrent()) toast(`附件已${verb}。`, 'success');
      },
    });
  }

  function downloadControl(id, recordVersion, label, { signal, isCurrent: actionCurrent = current } = {}) {
    const downloadSignal = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
    const status = el('p', { class: 'small', role: 'status', hidden: true });
    const alive = () => current() && actionCurrent() && !downloadSignal.aborted;
    const download = button(label, async () => {
      if (!alive()) return;
      download.disabled = true; download.setAttribute('aria-busy', 'true'); status.hidden = true;
      try {
        await downloadAttachment(id, { entity, recordVersion, signal: downloadSignal, isCurrent: alive });
        if (alive()) { status.textContent = '檔案已開始下載。'; status.className = 'muted small'; status.setAttribute('role', 'status'); status.hidden = false; }
      } catch (error) {
        if (!alive() || error.name === 'AbortError') return;
        status.textContent = error.message; status.className = 'field-error'; status.setAttribute('role', 'alert'); status.hidden = false;
      } finally { download.disabled = false; download.removeAttribute('aria-busy'); }
    }, { variant: 'secondary' });
    return el('div', { class: 'attachment-download' }, download, status);
  }

  function card(item) {
    const knownStatus = ATTACHMENT_STATUSES.some(status => status.value === item.status);
    const status = badge(knownStatus ? item.status : ''); status.textContent = formatAttachmentMetadataStatus(item.status);
    const fields = [
      ...(config.category ? [['附件分類', formatAttachmentMetadataCategory(item.category)]] : []),
      ['檔案名稱', formatAttachmentMetadataText(item.fileName)],
      ['檔案格式', typeof item.mimeType === 'string' ? fileType(item.mimeType) : formatAttachmentMetadataText(item.mimeType)],
      ['檔案大小', Number.isSafeInteger(item.sizeBytes) && item.sizeBytes >= 0 ? formatFileSize(item.sizeBytes) : formatAttachmentMetadataText(item.sizeBytes)],
      ['備註', formatAttachmentMetadataText(item.note, Object.hasOwn(item, 'note'))],
    ];
    const controls = el('div', { class: 'actions' },
      downloadControl(item.id, undefined, '下載目前版本'),
      button('版本歷程', () => openRecordHistory({
        entity, id: item.id, lookups, isCurrent: current,
        versionActions: ({ version, signal, isCurrent }) => downloadControl(item.id, version, '下載此版本', { signal, isCurrent }),
      }), { variant: 'secondary' }),
      mayWrite && button('編輯資料', () => attachmentForm('edit', item), { variant: 'secondary' }),
      mayWrite && button('更換檔案', () => attachmentForm('replace', item), { variant: 'secondary' }),
      mayWrite && knownStatus && button(item.status === 'inactive' ? '恢復使用' : '停用', () => changeStatus(item), { variant: 'secondary' }),
    );
    return el('article', { class: 'attachment-card', 'data-attachment-id': item.id, 'aria-label': `附件：${formatAttachmentMetadataText(item.title, Object.hasOwn(item, 'title'))}` },
      el('div', { class: 'section-heading' }, el('h3', { class: 'pre-wrap' }, formatAttachmentMetadataText(item.title, Object.hasOwn(item, 'title'))), status),
      el('dl', { class: 'attachment-fields' }, fields.map(([label, value]) => el('div', { class: label === '備註' ? 'attachment-note' : undefined }, el('dt', {}, label), el('dd', { class: 'pre-wrap' }, value)))), controls,
    );
  }

  const changed = (key, value) => {
    if (!current()) return;
    state[key] = value; state.page = 1; void load();
  };
  const toolbar = el('div', { class: 'toolbar' },
    searchBox({ label: '附件搜尋', placeholder: '搜尋附件標題、檔名或備註', onSearch: value => changed('q', value) }),
    config.category && filter('附件分類篩選', [{ value: '', label: '全部分類' }, ...ATTACHMENT_CATEGORIES], value => changed('category', value)),
    filter('附件狀態篩選', [{ value: '', label: '全部狀態' }, ...ATTACHMENT_STATUSES], value => changed('status', value)),
  );
  if (mayWrite) actions.append(button('新增附件', () => attachmentForm('upload', null)));
  actions.append(button('重新讀取附件', () => load(), { variant: 'secondary' }));
  if (onClose) actions.append(button(`關閉${config.title}`, () => { destroy(); onClose(); }, { variant: 'outline' }));
  element.append(toolbar, results, footer);

  async function load() {
    if (!current()) return;
    observe();
    controller?.abort(); controller = new AbortController();
    const sequence = ++request, page = state.page;
    const requested = { entity, orgId, parentId: parentRecord.id, employeeId: parentRecord.employeeId, page, pageSize: PAGE_SIZE, category: state.category, status: state.status };
    results.setAttribute('aria-busy', 'true');
    results.replaceChildren(el('p', { class: 'loading', role: 'status' }, '正在讀取附件…')); footer.replaceChildren();
    const params = new URLSearchParams({ [config.parentKey]: parentRecord.id, page: String(page), pageSize: String(PAGE_SIZE) });
    for (const key of ['q', ...(config.category ? ['category'] : []), 'status']) if (state[key]) params.set(key, state[key]);
    try {
      const result = await api(`/api/${entity}?${params}`, { signal: controller.signal });
      if (!current() || sequence !== request) return;
      const response = confirmAttachmentMetadataList(result, requested);
      const lastPage = Math.max(1, Math.ceil(response.total / PAGE_SIZE));
      if (page > lastPage) { state.page = lastPage; return load(); }
      results.replaceChildren(...(response.items.length ? response.items.map(card) : [el('div', { class: 'empty-state', role: 'status' },
        state.q || state.category || state.status ? '找不到符合條件的附件，請調整搜尋或篩選。' : `尚未建立${config.title}。`,
      )]));
      results.setAttribute('aria-busy', 'false');
      footer.replaceChildren(pagination({ page, pageSize: PAGE_SIZE, total: response.total, onChange: page => { if (!current()) return; state.page = page; void load(); } }));
    } catch (error) {
      if (error.name === 'AbortError' || !current() || sequence !== request) return;
      results.setAttribute('aria-busy', 'false');
      results.replaceChildren(errorState(error, load));
    }
  }

  return { element, load, destroy };
}
