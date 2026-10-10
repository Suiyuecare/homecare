import { api, el, getContext, openDetails } from '../ui.js';

/** Domain profiles supply saved content; openDetails owns the dialog lifecycle. */
export function openSavedRecordDetails({ id, isCurrent = () => true, profile }) {
  const startedContext = getContext();
  let identity;
  try { identity = profile.identity(startedContext); }
  catch (error) {
    if (profile.requireActorScope) return Promise.resolve();
    throw error;
  }
  const hash = window.location.hash;
  const matchesContext = () => getContext() === startedContext && profile.identity(getContext()) === identity
    && window.location.hash === hash && isCurrent();
  const current = profile.requireActorScope
    ? () => { try { return matchesContext(); } catch { return false; } }
    : matchesContext;
  let orgId;
  try {
    orgId = startedContext.organizationId ?? startedContext.orgId;
    if (profile.requireActorScope && (typeof startedContext.user?.id !== 'string' || !startedContext.user.id.trim()
      || typeof orgId !== 'string' || !orgId.trim())) return Promise.resolve();
  } catch (error) {
    if (profile.requireActorScope) return Promise.resolve();
    throw error;
  }
  if (!current() || !profile.roles.includes(startedContext.role) || !profile.isId(id)) return Promise.resolve();
  return openDetails({
    title: profile.title, wide: true, guardedRead: true, isCurrent: current,
    loadingText: profile.loadingText,
    load: async (signal, helpers) => {
      const response = await api(`/api/${profile.entity}/${encodeURIComponent(id)}`, { signal });
      if (signal.aborted || !helpers.isCurrent()) throw new DOMException(profile.cancelMessage, 'AbortError');
      const item = profile.confirm(response, { id, orgId });
      const metadata = el('dl', { class: 'detail-grid', 'aria-label': '保存紀錄資訊' }, [
        ['版次', String(item.version)], ['保存更新文字', item.updatedAt],
        ['保存建立文字', item.createdAt], ['識別碼', item.id],
      ].map(([label, text]) => el('div', {}, el('dt', {}, label), el('dd', { class: 'pre-wrap' }, text))));
      const fields = el('dl', { class: 'detail-grid' }, item.fields.map(field =>
        el('div', { class: profile.fullWidthKeys.includes(field.key) ? 'field-wide' : '',
          [profile.fieldAttribute]: field.key, 'data-saved-kind': field.kind },
          el('dt', {}, field.label), el('dd', { class: 'pre-wrap' }, profile.formatField(field)))));
      return el('section', { 'aria-label': profile.regionLabel },
        el('p', { class: 'notice' }, profile.notice),
        metadata, fields);
    },
  });
}
