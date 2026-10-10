import { api, el, button, table, pagination, createForm, openDetails, getContext, toast } from '../ui.js';
import { confirmAnnouncementReadState, confirmAnnouncementReadResult, confirmAnnouncementReadRoster,
  savedAnnouncementText, parseAnnouncementVersion } from '../data/announcement-read-receipts.js';

const PAGE_SIZE = 25;
const audiences = { all: '全體同仁', caregiver: '居服員', supervisor: '督導', finance: '財務', admin: '管理者' };
const statuses = { published: '已發布', draft: '草稿' };
const roles = { admin: '管理者', supervisor: '督導', finance: '財務', caregiver: '居服員' };
const identity = () => {
  const context = getContext();
  return JSON.stringify([context.user?.id, context.organizationId || context.orgId, context.role, context.user?.employeeId]);
};
function guard(isCurrent) {
  const startedContext = getContext(), startedIdentity = identity(), startedHash = window.location.hash;
  return { context: startedContext, current: () => isCurrent() && getContext() === startedContext
    && identity() === startedIdentity && window.location.hash === startedHash };
}
const savedLabel = (value, dictionary) => typeof value === 'string' && Object.hasOwn(dictionary, value) ? dictionary[value] : savedAnnouncementText(value);
const readTime = value => new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value));
function metadata(item, currentVersion) {
  return el('dl', { class: 'history-fields' }, [
    ['保存公告版次', `第 ${item.version} 版${item.version === currentVersion ? '（目前版）' : '（歷史版）'}`],
    ['目前公告版次', `第 ${currentVersion} 版`], ['保存公告狀態', savedLabel(item.status, statuses)],
    ['保存閱讀對象', savedLabel(item.audience, audiences)],
  ].map(([label, value]) => el('div', {}, el('dt', {}, label), el('dd', { class: 'pre-wrap' }, value))));
}
const note = () => el('p', { class: 'notice' }, '此回執僅保存本人操作紀錄，不代表已理解內容或完成法定簽收；不寄送外部訊息。');

/** Business adapter only; openDetails owns mutation, retry, busy and lifetime. */
export function openAnnouncementRead({ id, isCurrent = () => true }) {
  const owner = guard(isCurrent), orgId = owner.context.organizationId, userId = owner.context.user?.id;
  if (typeof id !== 'string' || !id || !userId || !orgId || !owner.current()) return Promise.resolve();
  let loaded, mutationKey;
  return openDetails({
    title: '閱讀公告全文', wide: true, isCurrent: owner.current, loadingText: '正在讀取公告與本人閱讀紀錄…',
    readAcknowledgement: {
      isEnabled: () => loaded?.canAcknowledge === true && loaded.receipt === null,
      onConfirm: async ({ signal, isCurrent: current }) => {
        if (!loaded || !current()) throw new DOMException('操作已取消', 'AbortError');
        const version = loaded.announcement.version;
        try {
          const result = await api(`/api/announcements/${encodeURIComponent(id)}/read-state`, {
            method: 'POST', body: { version }, signal, headers: { 'Idempotency-Key': mutationKey },
          });
          await confirmAnnouncementReadResult(result, { id, orgId, version, userId, role: owner.context.role, userName: owner.context.user.name });
          if (!current()) throw new DOMException('操作已取消；請重新讀取確認保存狀態。', 'AbortError');
          toast(`已保存第 ${version} 版公告的閱讀紀錄`, 'success');
        } catch (error) {
          if (error.name !== 'AbortError' && error.status === undefined && error.code !== 'ANNOUNCEMENT_READ_UNCONFIRMED') {
            error.message = `閱讀結果未確認；${error.message}`;
          }
          if (error.status === 409 || error.status === 403 || error.status === 404 || error.status === 422) {
            loaded = null; error.readRequiresReload = true;
          }
          throw error;
        }
      },
    },
    load: async (signal, helpers) => {
      loaded = null; mutationKey = crypto.randomUUID();
      const result = await confirmAnnouncementReadState(await api(`/api/announcements/${encodeURIComponent(id)}/read-state`, { signal }), { id, orgId, userId });
      if (signal.aborted || !helpers.isCurrent()) throw new DOMException('讀取已取消', 'AbortError');
      loaded = result;
      const { announcement: item, receipt } = result;
      const acknowledgement = receipt
        ? `您已記錄閱讀第 ${item.version} 版公告：${readTime(receipt.readAt)}（臺北時間）。`
        : `尚未記錄您對第 ${item.version} 版公告的閱讀。`;
      return el('section', { 'aria-label': '公告全文與本人閱讀狀態' },
        el('h3', { class: 'pre-wrap' }, savedAnnouncementText(item.title)), metadata(item, result.currentVersion),
        el('h3', {}, '公告全文'), el('p', { class: 'pre-wrap' }, savedAnnouncementText(item.body)),
        el('p', { role: 'status' }, acknowledgement),
        !result.canAcknowledge && el('p', { class: 'notice' }, '本版不是可確認的目前已發布文字公告，無法記錄本版閱讀。'),
        receipt && el('p', { class: 'muted' }, `閱讀時保存姓名：${receipt.userName || '空文字'} · 閱讀時保存角色：${roles[receipt.role]}`),
        note(), el('div', { class: 'actions' }, button('重新讀取公告', () => helpers.reload(), { variant: 'outline' })));
    },
  });
}

export function openAnnouncementReadReceipts({ id, isCurrent = () => true }) {
  const owner = guard(isCurrent), orgId = owner.context.organizationId;
  if (!['admin', 'supervisor'].includes(owner.context.role) || typeof id !== 'string' || !id || !orgId || !owner.current()) return Promise.resolve();
  let page = 1, version;
  return openDetails({
    title: '公告閱讀紀錄', wide: true, isCurrent: owner.current, loadingText: '正在讀取已保存的閱讀紀錄…',
    // The shared business variant also guards the lifetime of this read-only roster.
    readAcknowledgement: {},
    load: async (signal, helpers) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), ...(version === undefined ? {} : { version: String(version) }) });
        const result = await confirmAnnouncementReadRoster(await api(`/api/announcements/${encodeURIComponent(id)}/read-receipts?${query}`, { signal }), { id, orgId, version, page, pageSize: PAGE_SIZE });
        if (signal.aborted || !helpers.isCurrent()) throw new DOMException('讀取已取消', 'AbortError');
        const lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
        if (page > lastPage) { page = lastPage; continue; }
        const queryForm = createForm({
          fields: [{ name: 'version', label: '精確保存公告版次', type: 'number', min: 1, step: 1, required: true,
            help: '只查詢您有權讀取的精確保存版次；不推定應讀人員或未讀人數。' }],
          initial: { version: version ?? result.announcement.version }, submitLabel: '查詢版次',
          onSubmit: async values => { if (!helpers.isCurrent()) return; version = parseAnnouncementVersion(values.version); page = 1; await helpers.reload(); },
        });
        return el('section', { 'aria-label': '已保存的公告閱讀紀錄' },
          el('h3', { class: 'pre-wrap' }, savedAnnouncementText(result.announcement.title)), metadata(result.announcement, result.currentVersion),
          note(), el('p', { class: 'muted' }, '僅列出本版已保存的閱讀紀錄；姓名與角色為閱讀時保存值。'),
          el('details', {}, el('summary', {}, '查詢精確保存版次'), queryForm),
          el('div', { class: 'actions' }, button('查詢目前版', () => { version = undefined; page = 1; helpers.reload(); }, { variant: 'outline' }),
            button('重新讀取閱讀紀錄', () => helpers.reload(), { variant: 'outline' })),
          el('h3', {}, `第 ${result.announcement.version} 版閱讀紀錄：共 ${result.total} 筆`),
          table([
            { key: 'userName', label: '閱讀時保存姓名', render: receipt => el('span', { class: 'pre-wrap' }, receipt.userName || '空文字') },
            { key: 'role', label: '閱讀時保存角色', render: receipt => roles[receipt.role] },
            { key: 'readAt', label: '保存閱讀時間（臺北）', render: receipt => el('time', { datetime: receipt.readAt }, readTime(receipt.readAt)) },
          ], result.items, { caption: '所選公告版次的已保存閱讀紀錄，可左右捲動', emptyText: '本版尚無已保存的閱讀紀錄。' }),
          pagination({ page: result.page, pageSize: result.pageSize, total: result.total, onChange: next => { if (helpers.isCurrent()) { page = next; helpers.reload(); } } }));
      }
      throw new Error('閱讀紀錄在查詢期間已變更，請重新讀取。');
    },
  });
}
