import { icon } from './icons.js';

let context = { user: null, organizationId: null, orgId: null, role: null, organizations: [], csrfToken: null };
let sessionExpired = () => {};
let submissionKey = null;
export const getContext = () => context;
export function setContext(session, orgId) {
  const organizations = session.organizations || [];
  const organization = organizations.find(x => x.id === orgId) || organizations[0];
  const role = organization?.role || session.user?.role;
  context = { ...session, user: session.user ? { ...session.user, role, employeeId: organization?.employeeId || null } : null, organizations, organizationId: organization?.id, orgId: organization?.id, role };
}
export function onSessionExpired(handler) { sessionExpired = handler; }
export async function refreshSession() {
  const session = await api('/api/session');
  setContext(session, context.organizationId);
  window.dispatchEvent(new Event('session-updated'));
  return session;
}
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class' || key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (['value', 'checked', 'disabled', 'selected', 'hidden', 'noValidate'].includes(key)) node[key] = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child !== undefined && child !== null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
export function button(label, handler, { variant = 'primary', ...attrs } = {}) {
  return el('button', { type: 'button', class: `btn btn-${variant}`, onclick: handler, ...attrs }, label);
}
export function navigate(route) { location.hash = route; }
export const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date());
export function formatDate(value) { return value ? String(value).slice(0, 10).replaceAll('-', '/') : '—'; }
export function formatMoney(cents) {
  const formatter = new Intl.NumberFormat('zh-TW', { style: 'currency', currency: 'TWD', maximumFractionDigits: 2 });
  if (Number.isSafeInteger(cents)) {
    const integerCents = BigInt(cents);
    const whole = integerCents / 100n;
    const fraction = String((integerCents < 0n ? -integerCents : integerCents) % 100n).padStart(2, '0');
    const signedWhole = cents < 0 && whole === 0n ? -0 : whole;
    return formatter.formatToParts(signedWhole).map(part => part.type === 'fraction' ? fraction : part.value).join('');
  }
  return formatter.format(Number(cents || 0) / 100);
}
export const MAX_ATTACHMENT_FILE_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_FILE_ACCEPT = '.pdf,.png,.jpg,.jpeg';
const attachmentTypes = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
export function formatFileSize(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  return `${new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 }).format(bytes / (bytes < 1024 * 1024 ? 1024 : 1024 * 1024))} ${bytes < 1024 * 1024 ? 'KiB' : 'MiB'}`;
}
function pickedFileError(file, { accept = ATTACHMENT_FILE_ACCEPT, maxFileBytes = MAX_ATTACHMENT_FILE_BYTES, filePolicy = 'attachment' } = {}) {
  if (!file) return null;
  if (!file.size) return '不能上傳空白檔案，請重新選檔。';
  if (file.size > maxFileBytes) return `檔案超過 ${formatFileSize(maxFileBytes)}，請重新選檔。`;
  const name = file.name.trim(), extension = name.split('.').at(-1).toLowerCase();
  if (!name || name.length > 180 || /[\x00-\x1f\x7f/\\]/.test(name)) return '檔名須為 1 至 180 字，且不能包含路徑或控制字元。';
  const allowed = accept.split(',').map(x => x.trim().toLowerCase());
  if (filePolicy === 'local-import-csv') {
    if (extension !== 'csv' || !allowed.includes('.csv')) return '請選擇 CSV 檔案。';
    if (file.type && !['text/csv','application/csv','text/plain','application/vnd.ms-excel'].includes(file.type)) return 'CSV檔案格式無法確認，請重新選檔。';
    return null;
  }
  if (filePolicy === 'custom-form-package-json') {
    if (extension !== 'json' || !allowed.includes('.json')) return '請選擇 JSON 模板套件。';
    if (file.type && !['application/json', 'text/json', 'text/plain'].includes(file.type)) return '模板套件格式無法確認，請重新選檔。';
    return null;
  }
  if (!attachmentTypes[extension] || !allowed.includes(`.${extension}`)) return '請選擇 PDF、PNG 或 JPEG 檔案。';
  if (file.type && file.type !== attachmentTypes[extension]) return '檔案格式與副檔名不一致，請重新選檔。';
  return null;
}
export async function attachmentFilePayload(file, { signal } = {}) {
  const message = pickedFileError(file) || (!file ? '請選擇附件檔案。' : null);
  if (message) { const error = new Error(message); error.fields = { file: message }; throw error; }
  if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
  const contentBase64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => reader.abort();
    const timeout = setTimeout(() => { reader.abort(); }, 15000);
    const finish = (error, value) => {
      clearTimeout(timeout); signal?.removeEventListener('abort', abort);
      reader.onload = reader.onerror = reader.onabort = null;
      if (error) reject(error); else resolve(value);
    };
    reader.onload = () => finish(null, String(reader.result).split(',')[1]);
    reader.onerror = () => finish(new Error('無法讀取檔案，請保留輸入內容並重新選檔。'));
    reader.onabort = () => finish(signal?.aborted ? new DOMException('操作已取消', 'AbortError') : new Error('讀取檔案逾時，請保留輸入內容並重試。'));
    signal?.addEventListener('abort', abort, { once: true });
    reader.readAsDataURL(file);
  });
  if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
  return { fileName: file.name.trim(), mimeType: file.type || attachmentTypes[file.name.trim().split('.').at(-1).toLowerCase()], contentBase64 };
}
export async function downloadAttachment(id, { entity = 'case-attachments', recordVersion, signal, isCurrent = () => true } = {}) {
  if (!['case-attachments', 'certification-attachments'].includes(entity)) throw new Error('附件資料類型不合法。');
  const startedContext = context;
  const guard = () => {
    if (signal?.aborted || context !== startedContext || !isCurrent()) throw new DOMException('操作已取消', 'AbortError');
  };
  guard();
  if (recordVersion !== undefined && (!Number.isSafeInteger(recordVersion) || recordVersion < 1)) throw new Error('附件版本不合法。');
  const controller = new AbortController(), externalAbort = () => controller.abort();
  signal?.addEventListener('abort', externalAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const query = recordVersion === undefined ? '' : `?recordVersion=${recordVersion}`;
    const response = await fetch(`/api/${entity}/${encodeURIComponent(id)}/download${query}`, {
      credentials: 'same-origin', signal: controller.signal, headers: { 'X-Org-Id': startedContext.organizationId }
    });
    guard();
    if (!response.ok) {
      const data = await response.json().catch(() => ({})); guard();
      const error = new Error(data.error?.message || `附件無法下載（${response.status}）`);
      error.status = response.status; error.code = data.error?.code;
      if (response.status === 401) sessionExpired();
      throw error;
    }
    const blob = await response.blob(); guard();
    const disposition = response.headers.get('Content-Disposition') || '';
    let fileName = disposition.match(/filename="([^"\r\n]*)"/i)?.[1] || '附件';
    const encodedName = disposition.match(/filename\*=UTF-8''([^;\r\n]*)/i)?.[1];
    if (encodedName) { try { fileName = decodeURIComponent(encodedName); } catch { /* Use the server's ASCII fallback. */ } }
    fileName = fileName.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 180) || '附件';
    const url = URL.createObjectURL(blob);
    try {
      guard();
      const link = el('a', { href: url, download: fileName });
      document.body.append(link); link.click(); link.remove();
    } finally { setTimeout(() => URL.revokeObjectURL(url), 2000); }
  } catch (error) {
    if (error.name === 'AbortError' && (signal?.aborted || context !== startedContext || !isCurrent())) throw error;
    if (error.name === 'AbortError') throw new Error('附件下載逾時，請重試。');
    if (error instanceof TypeError) throw new Error('目前無法連線，請確認網路後重試。');
    throw error;
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', externalAbort); }
}
export async function downloadCsv(path, { filename = '報表.csv', signal, isCurrent = () => true } = {}) {
  if (!path.startsWith('/api/') || /[\r\n]/.test(path)) throw new Error('報表下載路徑不合法。');
  const startedContext = context;
  const guard = () => {
    if (signal?.aborted || context !== startedContext || !isCurrent()) throw new DOMException('操作已取消', 'AbortError');
  };
  guard();
  const controller = new AbortController(), externalAbort = () => controller.abort();
  signal?.addEventListener('abort', externalAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, {
      credentials: 'same-origin', signal: controller.signal,
      headers: { 'X-Org-Id': startedContext.organizationId, Accept: 'text/csv' }
    });
    guard();
    if (!response.ok) {
      const data = await response.json().catch(error => { if (error.name === 'AbortError') throw error; return {}; }); guard();
      const error = new Error(data.error?.message || `報表無法下載（${response.status}）`);
      error.status = response.status; error.code = data.error?.code; error.fields = data.error?.fields; error.details = data.error?.details;
      if (response.status === 401) sessionExpired();
      throw error;
    }
    if (!/^text\/csv(?:\s*;|\s*$)/i.test(response.headers.get('Content-Type') || '')) throw new Error('伺服器未回傳 CSV，請重試。');
    const blob = await response.blob(); guard();
    if (!blob.size) throw new Error('報表回應為空，請重試。');
    const safeName = String(filename).replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 180) || '報表.csv';
    const url = URL.createObjectURL(blob);
    try {
      guard();
      const link = el('a', { href: url, download: safeName });
      document.body.append(link); link.click(); link.remove();
    } finally { setTimeout(() => URL.revokeObjectURL(url), 2000); }
  } catch (error) {
    if (error.name === 'AbortError' && (signal?.aborted || context !== startedContext || !isCurrent())) throw error;
    if (error.name === 'AbortError') throw new Error('報表下載逾時，請重試。');
    if (error instanceof TypeError) throw new Error('目前無法連線，請確認網路後重試。');
    throw error;
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', externalAbort); }
}
// The template package is already a freshly authorized, verified definition.
// This opt-in keeps local file delivery under the existing UI/context owner.
export function downloadCustomFormPackageText(text, { filename = '自訂模板.json', signal, isCurrent = () => true } = {}) {
  const startedContext = context;
  const guard = () => { if (signal?.aborted || context !== startedContext || !isCurrent()) throw new DOMException('操作已取消', 'AbortError'); };
  guard();
  if (typeof text !== 'string' || !text.length || new TextEncoder().encode(text).byteLength > 4 * 1024 * 1024) throw new Error('模板套件內容無法完整下載。');
  const safeName = String(filename).replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 175).replace(/\.json$/i, '') + '.json';
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  try { guard(); const link = el('a', { href: url, download: safeName }); document.body.append(link); link.click(); link.remove(); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 2000); }
}
export async function api(path, options = {}) {
  if (!path.startsWith('/api/')) path = `/api/${path.replace(/^\//, '')}`;
  const { body, headers = {}, ...other } = options;
  const controller = new AbortController();
  const externalAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', externalAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, {
      ...other, credentials: 'same-origin', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(context.organizationId ? { 'X-Org-Id': context.organizationId } : {}), ...(context.csrfToken ? { 'X-CSRF-Token': context.csrfToken } : {}), ...(submissionKey && other.method === 'POST' ? { 'Idempotency-Key': submissionKey } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    let data;
    try { data = await response.json(); }
    catch (error) {
      // A successful status alone cannot confirm that the submitted record was saved.
      if (error.name === 'AbortError') throw error;
      if (response.ok) throw new Error('無法讀取伺服器回應，請保留輸入內容並重試。');
      data = {};
    }
    if (!response.ok) {
      const error = new Error(data.error?.message || `無法完成操作（${response.status}）`);
      error.status = response.status; error.code = data.error?.code; error.fields = data.error?.fields; error.details = data.error?.details;
      if (response.status === 401 && !['/api/login', '/api/setup'].includes(path)) sessionExpired();
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError' && options.signal?.aborted) throw error;
    if (error.name === 'AbortError') throw new Error('連線逾時，請保留輸入內容並重試。');
    if (error instanceof TypeError) throw new Error('目前無法連線，請確認網路後重試。');
    throw error;
  } finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', externalAbort); }
}
export async function fetchAll(entity, params = {}) {
  const query = new URLSearchParams(params).toString();
  if (query) entity += `${entity.includes('?') ? '&' : '?'}${query}`;
  let items = [], page = 1;
  while (page <= 100) {
    const separator = entity.includes('?') ? '&' : '?';
    const data = await api(`${entity}${separator}page=${page}&pageSize=100`);
    items.push(...(data.items || []));
    if (items.length >= data.total || !(data.items || []).length) return items;
    page++;
  }
  throw new Error('資料超過可選範圍，請縮小查詢條件。');
}
export function pageHeader(title, subtitle = '', actions = []) {
  return el('header', { class: 'page-header' }, el('div', { class: 'page-heading' }, el('p', { class: 'eyebrow' }, '歲悅居家照顧'), el('h1', { tabindex: '-1' }, title), subtitle && el('p', { class: 'subtitle' }, subtitle)), el('div', { class: 'actions page-actions' }, actions));
}
const statusLabels = { active: '服務中', inactive: '停用', paused: '暫停', closed: '結案', draft: '草稿', submitted: '待核閱', approved: '已核准', returned: '退回修改', pending: '待處理', scheduled: '已排班', completed: '已完成', cancelled: '已取消', rejected: '未核准', published: '已發布', ended: '已結束', admin: '管理者', supervisor: '督導', caregiver: '居服員', finance: '薪資／財務' };
export function badge(value) { return el('span', { class: `badge status-${String(value).replace(/[^a-z-]/g, '')}` }, statusLabels[value] || value || '未設定'); }
export function table(columns, rows, { emptyText = '目前沒有資料。', caption } = {}) {
  if (!rows?.length) return el('div', { class: 'empty-state', role: 'status' }, el('span', { class: 'empty-mark', 'aria-hidden': 'true' }, icon('archive', { size: 26 })), el('p', {}, emptyText));
  const head = el('thead', {}, el('tr', {}, columns.map(c => el('th', { scope: 'col' }, c.label || c.key))));
  const body = el('tbody', {}, rows.map(row => el('tr', {}, columns.map(c => el('td', {}, c.render ? c.render(row) : row[c.key] ?? '—')))));
  return el('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': caption || '資料表，可左右捲動' }, el('table', {}, caption && el('caption', { class: 'sr-only' }, caption), head, body));
}
export function pagination({ page, pageSize = 25, total = 0, onChange }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return el('nav', { class: 'pagination', 'aria-label': '資料分頁' }, el('span', {}, total ? `共 ${total} 筆 · 第 ${Math.min(page, pages)} / ${pages} 頁` : '共 0 筆'), el('div', { class: 'actions' }, button('上一頁', () => onChange(page - 1), { variant: 'outline', disabled: page <= 1 }), button('下一頁', () => onChange(page + 1), { variant: 'outline', disabled: page >= pages })));
}
export function searchBox({ value = '', onSearch, label = '搜尋', placeholder = '輸入關鍵字' }) {
  let timer, composing = false;
  const id = `search-${crypto.randomUUID()}`;
  const input = el('input', { id, type: 'search', value, placeholder, autocomplete: 'off' });
  const clear = button('清除', () => { clearTimeout(timer); input.value = ''; clear.hidden = true; onSearch(''); input.focus(); }, { variant: 'ghost', 'aria-label': `清除${label}`, hidden: !value });
  const send = () => { clear.hidden = !input.value; clearTimeout(timer); timer = setTimeout(() => onSearch(input.value.trim()), 300); };
  input.addEventListener('input', () => { if (!composing) send(); });
  input.addEventListener('compositionstart', () => { composing = true; clearTimeout(timer); });
  input.addEventListener('compositionend', () => { composing = false; send(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { clearTimeout(timer); onSearch(input.value.trim()); } });
  return el('div', { class: 'search-box' }, el('label', { for: id, class: 'sr-only' }, label), icon('search'), input, clear);
}
export function errorState(error, onRetry) {
  const forbidden = error.status === 403;
  return el('div', { class: 'error-state', role: 'alert' }, el('h2', {}, forbidden ? '您沒有這項操作權限' : '資料暫時無法取得'), el('p', {}, error.message), button(forbidden ? '回到工作台' : '重新讀取', forbidden ? () => navigate('/') : onRetry, { variant: 'outline' }));
}
export function toast(message, tone = 'success') {
  let region = document.querySelector('#toast-region');
  if (!region) { region = el('div', { id: 'toast-region', class: 'toast-region', 'aria-live': 'polite', 'aria-atomic': 'false' }); document.body.append(region); }
  if ([...region.children].some(x => x.textContent === message)) return;
  // Keep recent feedback visible without covering a phone's work list after several actions.
  while (region.children.length >= 2) region.firstElementChild.remove();
  const node = el('div', { class: `toast toast-${tone}`, role: 'status' }, message); region.append(node); setTimeout(() => node.remove(), 6000);
}
function createDialog(title) {
  const trigger = document.activeElement;
  const headingId = `dialog-${crypto.randomUUID()}`;
  const dialog = el('dialog', { class: 'app-dialog', 'aria-labelledby': headingId });
  const heading = el('div', { class: 'dialog-header' }, el('h2', { id: headingId }, title));
  dialog.append(heading); document.body.append(dialog);
  dialog.addEventListener('close', () => {
    dialog.remove();
    const parent = [...document.querySelectorAll('dialog[open]')].at(-1);
    const available = node => node?.isConnected && node !== document.body && node.getClientRects().length
      && !node.matches(':disabled') && !node.closest('[hidden],[inert],[aria-hidden="true"]')
      && (!parent || parent.contains(node));
    if (available(trigger)) trigger.focus();
    // A submitting parent form temporarily disables its trigger before opening
    // confirmation. Return to its available controls instead of leaving focus
    // on the page behind the still-open modal.
    if (parent && !parent.contains(document.activeElement)) {
      const target = [...parent.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')].find(available) || parent;
      target.focus();
    } else if (!parent && !available(trigger)) document.querySelector('main h1')?.focus();
  }, { once: true });
  return dialog;
}
export function openDetails({ title, load, wide = false, printable = false, isCurrent = () => true, loadingText = '正在讀取歷程…', readAcknowledgement, guardedRead = false }) {
  return new Promise(resolve => {
    const dialog = createDialog(title);
    if (wide) dialog.classList.add('app-dialog-wide');
    if (printable) dialog.classList.add('app-dialog-printable');
    const startedContext = context;
    const controller = new AbortController();
    const body = el('div', { class: 'dialog-body' });
    const printNotice = printable ? el('p', { class: 'notice', role: 'status', hidden: true, 'data-no-print': true }, '請使用「列印／另存 PDF」按鈕重新讀取資料後列印。') : null;
    const close = button('關閉', () => { if (!readBusy) dialog.close(); }, { variant: 'outline' });
    const current = () => !controller.signal.aborted && dialog.isConnected && dialog.open && isCurrent() && (!(printable || readAcknowledgement || guardedRead) || context === startedContext);
    let busy = false, readBusy = false, printReady = false, printAuthorized = false;
    const readError = readAcknowledgement ? el('div', { class: 'form-summary', role: 'alert', hidden: true }) : null;
    const readEnabled = () => !busy && !readBusy && current() && readAcknowledgement?.isEnabled?.() === true;
    const commitRead = async () => {
      if (!readEnabled()) return;
      readBusy = true; close.disabled = true; readCommit.disabled = true; readCommit.setAttribute('aria-busy', 'true'); readError.hidden = true;
      try {
        await readAcknowledgement.onConfirm({ signal: controller.signal, isCurrent: current });
        if (current()) { readBusy = false; await reload(); }
      } catch (error) {
        if (current()) readError.replaceChildren(el('p', {}, error.message), error.readRequiresReload
          ? button('重新讀取公告', () => reload(), { variant: 'outline' })
          : button('重試記錄本版閱讀', () => commitRead(), { variant: 'outline' }));
        if (current()) readError.hidden = false;
      } finally {
        readBusy = false; close.disabled = false;
        if (readCommit) { readCommit.disabled = !readEnabled(); readCommit.removeAttribute('aria-busy'); }
      }
    };
    const readCommit = typeof readAcknowledgement?.onConfirm === 'function'
      ? button('我已閱讀本版公告', () => commitRead(), { disabled: true }) : null;
    const print = printable ? button('列印／另存 PDF', () => reload(true), { disabled: true }) : null;
    const reload = async (printAfterLoad = false) => {
      if (busy || readBusy || !current()) return;
      busy = true; printReady = false;
      if (readCommit) readCommit.disabled = true;
      if (readError) readError.hidden = true;
      if (printNotice) printNotice.hidden = true;
      if (print) { print.disabled = true; print.setAttribute('aria-busy', 'true'); }
      body.replaceChildren(el('p', { role: 'status' }, loadingText));
      try {
        const content = await load(controller.signal, { reload: () => reload(), isCurrent: current,
          close: () => { if (!current() || readBusy) return false; dialog.close(); return true; } });
        if (!current()) return;
        body.replaceChildren(content);
        printReady = true;
        if (print) print.disabled = false;
        if (printAfterLoad && current()) {
          // Only this fresh, authorized response may reach the native print dialog.
          printAuthorized = true;
          try { window.print(); } finally { printAuthorized = false; }
        }
      } catch (error) {
        if (current()) body.replaceChildren(errorState(error, () => reload()));
      } finally {
        busy = false;
        if (readCommit) readCommit.disabled = !readEnabled();
        print?.removeAttribute('aria-busy');
      }
    };
    const invalidate = () => {
      if (dialog.open && !current()) { body.replaceChildren(); controller.abort(); dialog.close(); }
    };
    const beforePrint = () => {
      if (current() && printReady && printAuthorized) {
        document.body.classList.remove('print-suppressed');
        return;
      }
      // Native print has already started: closing the dialog must not expose the app.
      document.body.classList.add('print-suppressed');
      window.addEventListener('afterprint', () => document.body.classList.remove('print-suppressed'), { once: true });
      if (current() && printNotice) printNotice.hidden = false;
      invalidate();
    };
    const observer = new MutationObserver(invalidate);
    dialog.append(body, ...(readError ? [readError] : []), ...(printNotice ? [printNotice] : []), el('div', { class: 'dialog-footer' }, close, readCommit, print));
    const guardReadEscape = event => { if (readAcknowledgement && current() && readBusy && event.key === 'Escape' && !event.isComposing) event.preventDefault(); };
    if (readAcknowledgement) document.addEventListener('keydown', guardReadEscape, true);
    dialog.addEventListener('cancel', event => { if (readAcknowledgement && readBusy) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      controller.abort(); observer?.disconnect();
      if (readAcknowledgement) document.removeEventListener('keydown', guardReadEscape, true);
      window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate); window.removeEventListener('beforeprint', beforePrint);
      resolve();
    }, { once: true });
    dialog.showModal(); close.focus(); reload();
    observer.observe(document.body, { childList: true, subtree: true, ...(readAcknowledgement || guardedRead ? { attributes: true, attributeFilter: ['data-render-version'] } : {}) });
    window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate);
    if (printable) window.addEventListener('beforeprint', beforePrint);
  });
}
export function confirmAction({ title, message, confirmLabel = '確認', danger = false, onConfirm, signal, isCurrent }) {
  return new Promise(resolve => {
    const guarded = typeof isCurrent === 'function';
    if (signal?.aborted || (guarded && !isCurrent())) { resolve(false); return; }
    const controller = new AbortController();
    const dialog = createDialog(title); const error = el('p', { class: 'form-summary', role: 'alert', hidden: true });
    const current = () => !signal?.aborted && !controller.signal.aborted && dialog.isConnected && dialog.open && (!guarded || isCurrent());
    let busy = false;
    const cancel = button('取消', () => dialog.close(), { variant: 'outline' });
    const commit = button(confirmLabel, async () => {
      if (busy || signal?.aborted || (guarded && !current())) return;
      busy = true;
      if (guarded) cancel.disabled = true;
      commit.disabled = true; commit.setAttribute('aria-busy', 'true'); error.hidden = true;
      try { await onConfirm?.(guarded ? { signal: controller.signal, isCurrent: current } : undefined); if (!signal?.aborted && (!guarded || current())) dialog.close('confirmed'); }
      catch (e) { if (!signal?.aborted && (!guarded || current())) { error.textContent = e.message; error.hidden = false; } }
      finally { busy = false; cancel.disabled = false; commit.disabled = false; commit.removeAttribute('aria-busy'); }
    }, { variant: danger ? 'danger' : 'primary' });
    dialog.append(el('div', { class: 'dialog-body' }, el('p', {}, message), error), el('div', { class: 'dialog-footer' }, cancel, commit));
    const abort = () => { controller.abort(); dialog.replaceChildren(); dialog.close(); };
    const invalidate = () => { if (dialog.open && !current()) abort(); };
    const observer = guarded ? new MutationObserver(invalidate) : null;
    signal?.addEventListener('abort', abort, { once: true });
    const guardBusyEscape = event => { if (current() && busy && event.key === 'Escape' && !event.isComposing) event.preventDefault(); };
    if (guarded) document.addEventListener('keydown', guardBusyEscape, true);
    dialog.addEventListener('cancel', event => { if (guarded && busy) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      controller.abort(); observer?.disconnect(); signal?.removeEventListener('abort', abort);
      if (guarded) { document.removeEventListener('keydown', guardBusyEscape, true); window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate); }
      resolve(dialog.returnValue === 'confirmed');
    }, { once: true });
    dialog.showModal(); cancel.focus();
    if (guarded) {
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] });
      window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate);
      invalidate();
    }
  });
}
export function createForm({ fields, initial = {}, onSubmit, onChange, submitLabel = '儲存', onCancel, cancelLabel = '取消', onPreview, previewLabel = '預覽', previewInstruction = '請先預覽，確認日期與衝突後再建立。', previewRequiredMessage = '請先重新預覽並處理衝突，再建立全部班次。', lockDuringSubmit = false, readOnlySubmission = false, beforeFields }) {
  const form = el('form', { noValidate: true, class: 'app-form' });
  const summary = el('div', { class: 'form-summary', role: 'alert', hidden: true });
  const grid = el('div', { class: 'form-grid' }); const controls = new Map(); const errors = new Map(); const descriptors = new Map(); const groups = new Map(); const hiddenControls = new Map();
  let fieldOwner = grid;
  let busy = false, dirty = false, phase = null, previewReady = false, previewGeneration = 0, previewController, previewSignature;
  let invalidatePreview = () => {};
  const values = () => Object.fromEntries(fields.map(f => {
    const c = controls.get(f.name);
    if (f.type === 'services') return [f.name, [...c.querySelectorAll('input')].filter(x => Number(x.value) > 0).map(x => ({ serviceItemId: x.dataset.serviceId, quantity: Number(x.value) }))];
    if (f.type === 'checkbox-group') return [f.name, [...c.querySelectorAll('input:checked')].map(x => descriptors.get(f.name).options.find(o => String(o.value) === x.dataset.choiceValue).value)];
    return [f.name, f.type === 'file' ? c.files?.[0] || null : f.type === 'checkbox' ? c.checked : f.type === 'number' ? (c.value === '' ? null : Number(c.value)) : c.value];
  }));
  const setValue = (name, value) => {
    const f = descriptors.get(name), c = controls.get(name); if (!f || !c) return;
    if (f.type === 'services') for (const input of c.querySelectorAll('input')) input.value = value?.find(x => x.serviceItemId === input.dataset.serviceId)?.quantity || '';
    else if (f.type === 'checkbox-group') for (const input of c.querySelectorAll('input')) input.checked = Array.isArray(value) && value.some(v => String(v) === input.dataset.choiceValue);
    else if (f.type === 'checkbox') c.checked = Boolean(value);
    else if (f.type === 'file') { c.value = ''; c.dispatchEvent(new Event('change')); }
    else c.value = value ?? '';
  };
  const setControlDisabled = (f, c, disabled) => {
    c.disabled = Boolean(disabled);
    if (f.type === 'services' && f.preserveWhenDisabled === true) {
      c.setAttribute('aria-disabled', String(c.disabled));
      for (const input of c.querySelectorAll('input')) input.disabled = c.disabled;
    }
  };
  const fillOptions = (f, c, options) => {
    if (f.type === 'services') {
      c.replaceChildren(...options.map(o => { const inputId = `qty-${crypto.randomUUID()}`; return el('div', { class: 'service-option' }, el('label', { for: inputId }, o.label), el('input', { id: inputId, type: 'number', min: '0', max: '10000', step: '1', inputmode: 'numeric', 'data-service-id': o.value, 'aria-label': `${o.label} 數量`, placeholder: '0' })); }));
      if (f.preserveWhenDisabled === true) setControlDisabled(f, c, c.disabled);
    } else if (f.type === 'checkbox-group') {
      c.replaceChildren(...options.map(o => el('label', { class: 'choice-option' }, el('input', { type: 'checkbox', 'data-choice-value': o.value }), el('span', {}, o.label))));
    } else c.replaceChildren(el('option', { value: '' }, f.placeholder || '請選擇'), ...options.map(o => el('option', { value: o.value }, o.label)));
  };
  const restoreHiddenControls = name => { for (const [item, disabled] of hiddenControls.get(name) || []) item.disabled = disabled; };
  const captureHiddenControls = name => {
    const group = groups.get(name), control = controls.get(name);
    const descendants = [...new Set([control, ...group.querySelectorAll('input,select,textarea,button')])];
    hiddenControls.set(name, descendants.map(item => [item, Boolean(item.disabled)]));
    for (const item of descendants) item.disabled = true;
  };
  const setHidden = (name, hidden) => {
    const group = groups.get(name), control = controls.get(name); if (!group || !control || (busy && !(readOnlySubmission === true && !onPreview && !lockDuringSubmit))) return;
    hidden = Boolean(hidden); if (group.hidden === hidden) return;
    group.hidden = hidden;
    if (hidden) {
      captureHiddenControls(name);
      errors.get(name).hidden = true; control.removeAttribute('aria-invalid');
    } else {
      restoreHiddenControls(name);
      hiddenControls.delete(name);
    }
    invalidatePreview();
  };
  const helpers = { setOptions(name, options) { const f = descriptors.get(name); if (f && ['select', 'services', 'checkbox-group'].includes(f.type)) { const hidden=Boolean(groups.get(name)?.hidden); if(hidden)restoreHiddenControls(name); f.options = options; fillOptions(f, controls.get(name), options); if(hidden)captureHiddenControls(name); invalidatePreview(); } }, setValue(name, value) { setValue(name, value); invalidatePreview(); }, setDisabled(name, disabled) { const control = controls.get(name), descriptor = descriptors.get(name); if (control && descriptor) { const hidden=Boolean(groups.get(name)?.hidden); if(hidden)restoreHiddenControls(name); setControlDisabled(descriptor, control, disabled); if(hidden)captureHiddenControls(name); } }, setHidden };
  for (const field of fields) {
    const f = { ...field }; descriptors.set(f.name, f); const id = `field-${crypto.randomUUID()}`; const errorId = `${id}-error`; const helpId = `${id}-help`;
    let control;
    if (f.type === 'services') { control = el('div', { class: 'services-picker', role: 'group', 'aria-labelledby': `${id}-label` }); fillOptions(f, control, f.options || []); }
    else if (f.type === 'checkbox-group') { control = el('div', { class: 'checkbox-picker', role: 'group', 'aria-labelledby': `${id}-label` }); fillOptions(f, control, f.options || []); }
    else if (f.type === 'select') { control = el('select', { id, name: f.name }); fillOptions(f, control, f.options || []); }
    else if (f.type === 'textarea') control = el('textarea', { id, name: f.name, rows: '4' });
    else if (f.type === 'file') control = el('input', { id, name: f.name, type: 'file', accept: f.accept || ATTACHMENT_FILE_ACCEPT });
    else control = el('input', { id, name: f.name, type: f.type || 'text', autocomplete: f.type === 'password' ? 'current-password' : 'off', ...(f.min !== undefined ? { min: f.min } : {}), ...(f.max !== undefined ? { max: f.max } : {}), ...(f.step !== undefined ? { step: f.step } : {}), ...(f.maxLength ? { maxlength: f.maxLength } : {}) });
    if (['numeric', 'decimal'].includes(f.inputMode) && control.tagName === 'INPUT') control.inputMode = f.inputMode;
    controls.set(f.name, control); setValue(f.name, initial[f.name] ?? f.defaultValue ?? '');
    if (f.disabled) setControlDisabled(f, control, true);
    if (f.readOnly) control.readOnly = true;
    if (f.required && !['services', 'checkbox-group'].includes(f.type)) control.required = true;
    control.setAttribute('aria-describedby', `${errorId}${f.help ? ` ${helpId}` : ''}`);
    const error = el('p', { id: errorId, class: 'field-error', hidden: true }); errors.set(f.name, error);
    const label = el('label', { for: ['services', 'checkbox-group'].includes(f.type) ? undefined : id, id: `${id}-label` }, f.label, f.required && el('span', { class: 'required', 'aria-label': '必填' }, ' *'));
    const group = el('div', { class: `field${f.wide || ['textarea', 'services', 'file', 'checkbox-group'].includes(f.type) ? ' field-wide' : ''}` }, label, control, f.help && el('p', { id: helpId, class: 'field-help' }, f.help), error);
    if (f.type === 'password') {
      const reveal = button('顯示密碼', () => { const hidden = control.type === 'password'; control.type = hidden ? 'text' : 'password'; reveal.textContent = hidden ? '隱藏密碼' : '顯示密碼'; reveal.setAttribute('aria-pressed', String(hidden)); }, { variant: 'ghost', class: 'btn btn-ghost password-toggle', 'aria-pressed': 'false' });
      group.append(reveal);
    }
    if (typeof f.groupLabel === 'string' && f.groupLabel.trim()) {
      const headingId = `form-group-${crypto.randomUUID()}`;
      fieldOwner = el('div', { class: 'form-grid' });
      grid.append(el('section', { class: 'field-wide', 'aria-labelledby': headingId }, el('h3', { id: headingId }, f.groupLabel), fieldOwner));
    }
    groups.set(f.name, group); fieldOwner.append(group);
    let fileInfo, clearFile;
    const change = () => {
      dirty = true; errors.get(f.name).hidden = true; control.removeAttribute('aria-invalid'); invalidatePreview();
      if (f.type === 'file') {
        const file = control.files?.[0];
        fileInfo.textContent = file ? `已選擇：${file.name} · ${formatFileSize(file.size)}` : '尚未選擇檔案';
        clearFile.hidden = !file;
        const message = pickedFileError(file, f);
        if (message) { error.textContent = message; error.hidden = false; control.setAttribute('aria-invalid', 'true'); }
      }
      onChange?.(values(), helpers);
    };
    if (f.type === 'file') {
      fileInfo = el('p', { id: `${id}-selection`, class: 'file-selection', 'aria-live': 'polite' }, '尚未選擇檔案');
      clearFile = button('移除選檔', () => { control.value = ''; change(); control.focus(); }, { variant: 'ghost', hidden: true, 'aria-label': `移除選檔：${f.label}` });
      control.setAttribute('aria-describedby', `${control.getAttribute('aria-describedby')} ${id}-selection`);
      group.insertBefore(el('div', { class: 'file-selection-row' }, fileInfo, clearFile), error);
    }
    control.addEventListener('input', change); control.addEventListener('change', change);
  }
  for (const f of fields) if (f.hidden) setHidden(f.name, true);
  const submit = el('button', { type: 'submit', class: 'btn btn-primary' }, submitLabel);
  const previewRegion = onPreview ? el('section', { class: 'form-preview', 'aria-label': `${previewLabel}結果`, 'aria-live': 'polite', tabindex: '-1' }, el('p', { class: 'notice' }, previewInstruction)) : null;
  let previewButton;
  const footer = el('div', { class: 'dialog-footer' }, onCancel && button(cancelLabel, onCancel, { variant: 'outline' }), onPreview && (previewButton = button(previewLabel, () => preview(), { variant: 'outline' })), submit);
  form.append(summary, ...(beforeFields instanceof Node ? [beforeFields] : []), grid, ...(previewRegion ? [previewRegion] : []), footer);
  if (onPreview) submit.disabled = true;
  invalidatePreview = (content) => {
    if (!onPreview) return;
    previewGeneration++; previewController?.abort(); previewReady = false; previewSignature = null; submit.disabled = true;
    previewRegion.replaceChildren(content || el('p', { class: 'notice' }, '資料已變更，請重新預覽後再建立。'));
  };
  const showErrors = messages => {
    let first;
    for (const [name, message] of Object.entries(messages)) {
      if (errors.has(name) && !groups.get(name)?.hidden) { errors.get(name).textContent = message; errors.get(name).hidden = false; controls.get(name).setAttribute('aria-invalid', 'true'); first ||= controls.get(name); }
    }
    summary.textContent = '請修正以下欄位後再儲存。'; summary.hidden = false;
    if (first?.matches('input,select,textarea')) first.focus(); else first?.querySelector('input')?.focus();
  };
  const validatedValues = () => {
    const data = values(); const messages = {};
    for (const f of fields) {
      if (groups.get(f.name)?.hidden) continue;
      if (f.type === 'services' && f.preserveWhenDisabled === true && controls.get(f.name).disabled === true) continue;
      const value = data[f.name];
      if (f.type === 'file' && pickedFileError(value, f)) messages[f.name] = pickedFileError(value, f);
      else if (f.type === 'services' && [...controls.get(f.name).querySelectorAll('input')].some(input => input.value !== '' && (!Number.isSafeInteger(Number(input.value)) || Number(input.value) < 0 || Number(input.value) > 10000))) messages[f.name] = '服務數量須為0至10000的整數；0代表不選取。';
      else if ((f.required && (value === '' || value === null)) || (f.type === 'services' && !value.length) || (f.type === 'checkbox-group' && f.required && !value.length)) messages[f.name] = `請填寫${f.label}。`;
      else if (f.type === 'number' && value !== null && (!Number.isFinite(value) || (f.min !== undefined && value < f.min) || (f.max !== undefined && value > f.max))) messages[f.name] = `${f.label}超出允許範圍。`;
      else if (f.type === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) messages[f.name] = '請輸入有效的電子信箱。';
      else if (f.type === 'password' && f.minLength && value.length < f.minLength) messages[f.name] = `密碼至少需要 ${f.minLength} 個字元。`;
    }
    if (Object.keys(messages).length) { showErrors(messages); return null; }
    return data;
  };
  async function preview() {
    if (busy) return;
    const data = validatedValues(); if (!data) return;
    invalidatePreview(); const generation = previewGeneration;
    previewController = new AbortController(); const controller = previewController;
    busy = true; phase = 'preview'; previewButton.disabled = true; previewButton.setAttribute('aria-busy', 'true'); summary.hidden = true;
    previewRegion.replaceChildren(el('p', { role: 'status' }, '正在預覽…'));
    try {
      const result = await onPreview(data, { signal: controller.signal });
      if (controller.signal.aborted || generation !== previewGeneration || !form.isConnected) return;
      if (!(result?.content instanceof Node)) throw new Error('未取得有效預覽，請保留輸入內容並重試。');
      previewRegion.replaceChildren(result.content); previewReady = result.canSubmit === true; previewSignature = JSON.stringify(data);
      previewRegion.focus({ preventScroll: true }); previewRegion.scrollIntoView({ block: 'nearest' });
    } catch (error) {
      if (error.name !== 'AbortError' && !controller.signal.aborted && generation === previewGeneration) {
        if (error.fields && Object.keys(error.fields).length) showErrors(error.fields);
        else { summary.textContent = error.message; summary.hidden = false; }
        previewRegion.replaceChildren(el('p', { class: 'notice' }, '預覽未完成，請修正內容或重新預覽。'));
      }
    } finally {
      busy = false; phase = null; previewButton.disabled = false; previewButton.removeAttribute('aria-busy'); submit.disabled = !previewReady;
    }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || event.isComposing) return;
    if (onPreview && !previewReady) { summary.textContent = previewRequiredMessage; summary.hidden = false; return; }
    const data = validatedValues(); if (!data) return;
    if (onPreview && previewSignature !== JSON.stringify(data)) { invalidatePreview(); summary.textContent = '內容與預覽不一致，請重新預覽。'; summary.hidden = false; return; }
    const lockedControls = onPreview || lockDuringSubmit ? [...form.querySelectorAll('input,select,textarea')].map(control => [control, control.disabled]) : [];
    for (const [control] of lockedControls) control.disabled = true;
    summary.hidden = true; busy = true; phase = 'submit'; submit.disabled = true; submit.setAttribute('aria-busy', 'true'); if (previewButton) previewButton.disabled = true;
    const previousKey = submissionKey;
    submissionKey = form.mutationKey;
    try { if (await onSubmit(data) !== false) dirty = false; }
    catch (e) { for (const [control, disabled] of lockedControls) control.disabled = disabled; if (e.invalidatePreview) invalidatePreview(e.previewContent); if (e.fields && Object.keys(e.fields).length) showErrors(e.fields); else { summary.textContent = e.message; summary.hidden = false; summary.scrollIntoView({ block: 'nearest' }); } }
    finally { submissionKey = previousKey; for (const [control, disabled] of lockedControls) control.disabled = disabled; busy = false; phase = null; submit.disabled = Boolean(onPreview && !previewReady); submit.removeAttribute('aria-busy'); if (previewButton) previewButton.disabled = false; }
  });
  form.isDirty = () => dirty;
  form.mutationKey = crypto.randomUUID();
  form.isBusy = () => busy && phase === 'submit';
  form.cancelPreview = () => { if (phase === 'preview') invalidatePreview(); };
  form.getValues = values;
  onChange?.(values(), helpers);
  return form;
}
export function openForm(config) {
  return new Promise(resolve => {
    const dialog = createDialog(config.title);
    const guarded = typeof config.isCurrent === 'function';
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && dialog.isConnected && dialog.open && (!guarded || config.isCurrent());
    const guard = () => { if (guarded && !current()) throw new DOMException('操作已取消，請重新讀取資料確認保存狀態。', 'AbortError'); };
    let observer, invalidate = () => {}, cleaned = false;
    const close = async () => {
      if (form.isBusy()) return;
      form.cancelPreview();
      if (form.isDirty()) { const discard = await confirmAction({ title: '放棄未儲存的內容？', message: '關閉後，這次輸入的內容不會儲存。', confirmLabel: '放棄修改', danger: true, ...(guarded ? { signal: controller.signal } : {}) }); if (!discard) return; }
      if (guarded && !current()) return;
      dialog.close();
      cleanup();
    };
    const form = createForm({ ...config, lockDuringSubmit: guarded || config.lockDuringSubmit === true, onCancel: close, onSubmit: async data => {
      guard(); const result = await config.onSubmit(data, guarded ? { signal: controller.signal, isCurrent: current } : undefined); guard();
      if (config.keepOpenOnFalse === true && result === false) return false;
      dialog.close('saved'); cleanup(); resolve(config.returnSubmitResult === true ? result : data);
    } });
    const guardUnload = event => { if (current() && form.isDirty()) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guardUnload);
    const guardBusyEscape = event => { if (current() && form.isBusy() && event.key === 'Escape' && !event.isComposing) event.preventDefault(); };
    if (guarded) document.addEventListener('keydown', guardBusyEscape, true);
    const cleanup = () => {
      if (cleaned) return; cleaned = true;
      if (guarded) document.removeEventListener('keydown', guardBusyEscape, true);
      window.removeEventListener('beforeunload', guardUnload); form.cancelPreview();
      controller.abort(); observer?.disconnect();
      window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate);
    };
    dialog.addEventListener('close', cleanup, { once: true });
    dialog.append(form); dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', () => resolve(false), { once: true }); dialog.showModal();
    if (guarded) {
      let invalidated = false;
      invalidate = () => {
        if (invalidated || current()) return;
        invalidated = true;
        cleanup(); dialog.replaceChildren(); dialog.close();
      };
      observer = new MutationObserver(invalidate);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] });
      window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate);
      invalidate();
    }
    (form.querySelector('input,select,textarea') || dialog).focus();
  });
}
export async function downloadReport(kind, month) {
  const response = await fetch(`/api/reports/${encodeURIComponent(kind)}.csv?month=${encodeURIComponent(month || '')}`, { headers: { 'X-Org-Id': context.organizationId }, credentials: 'same-origin' });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error?.message || '報表無法下載。'); }
  const url = URL.createObjectURL(await response.blob()); const link = el('a', { href: url, download: `歲悅-${kind}-${month || today()}.csv` }); document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
