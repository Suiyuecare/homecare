import { api, el, button, table, openDetails, getContext } from '../ui.js';
import {
  announcementPageIdentity, confirmAnnouncementPageSnapshot, projectAnnouncementPageReadState,
} from '../data/announcement-page-receipts.js';

const unconfirmedText = '未確認，請重新查詢';

export function openAnnouncementPageReceipts({ snapshot, isCurrent }) {
  const startedContext = getContext();
  let identity;
  try { identity = announcementPageIdentity(startedContext); }
  catch { return Promise.resolve(); }
  const orgId = startedContext?.organizationId ?? startedContext?.orgId;
  const userId = startedContext?.user?.id;
  if (!['admin', 'supervisor', 'finance', 'caregiver'].includes(startedContext?.role)
    || typeof orgId !== 'string' || !orgId.length || typeof userId !== 'string' || !userId.length) return Promise.resolve();
  const startedHash = window.location.hash;
  const checked = confirmAnnouncementPageSnapshot(snapshot, { orgId });
  const current = () => {
    try {
      return typeof isCurrent === 'function' && isCurrent() && getContext() === startedContext
        && window.location.hash === startedHash && announcementPageIdentity(getContext()) === identity;
    } catch { return false; }
  };
  if (!current() || !checked.ids.length) return Promise.resolve();

  return openDetails({
    title: '本頁本人公告回執', wide: true, guardedRead: true, isCurrent: current,
    loadingText: '正在查詢本頁本人公告回執…',
    load: async (signal, helpers) => {
      const guard = () => {
        if (signal.aborted || !helpers.isCurrent()) throw new DOMException('操作已取消', 'AbortError');
      };
      const rows = [];
      for (const id of checked.ids) {
        guard();
        try {
          const response = await api(`/api/announcements/${encodeURIComponent(id)}/read-state`, { signal });
          guard();
          const item = await projectAnnouncementPageReadState(response, { id, orgId, userId });
          guard();
          rows.push({ id, confirmed: true, item });
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          guard();
          rows.push({ id, confirmed: false });
        }
      }
      guard();
      const confirmed = rows.filter(row => row.confirmed).length;
      const columns = [
        { label: '公告標題', render: row => row.confirmed ? el('span', { class: 'pre-wrap' }, row.item.title) : '—' },
        { label: '精確識別碼', render: row => el('span', { 'data-announcement-id': row.id }, row.id) },
        { label: '目前保存版次', render: row => row.confirmed ? `第 ${row.item.version} 版` : '—' },
        { label: '本人本版回執', render: row => !row.confirmed ? unconfirmedText
          : row.item.receiptState === 'saved' ? '本版已保存本人閱讀回執' : '本版尚無本人閱讀回執' },
        { label: '保存閱讀時間（UTC）', render: row => row.confirmed && row.item.receiptState === 'saved'
          ? el('time', { datetime: row.item.readAt }, row.item.readAt) : '—' },
        { label: '本版確認閱讀資格', render: row => row.confirmed
          ? row.item.canAcknowledge ? '本版可確認閱讀' : '本版不可確認閱讀' : '—' },
      ];
      return el('section', { 'aria-label': '本頁本人公告回執查詢結果' },
        el('aside', { class: 'notice', role: 'note' },
          el('strong', {}, '只查詢本頁本人回執'),
          el('p', {}, '每筆採本次重新讀取的目前保存版次；整批並非同時點快照。沒有本版回執不代表未讀或未完成義務。本頁不提交閱讀，也不顯示公告內文或其他人的資料。')),
        el('div', { class: 'toolbar' },
          el('p', { role: 'status' }, `本次已確認 ${confirmed} 筆；未確認 ${rows.length - confirmed} 筆。`),
          button('重新查詢本頁本人回執', () => helpers.reload(), { variant: 'outline' })),
        table(columns, rows, { caption: '本頁本人公告回執，可左右捲動' }));
    },
  });
}
