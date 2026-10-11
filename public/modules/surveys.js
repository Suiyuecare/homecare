import { api, el, button, pageHeader, table, pagination, badge, errorState, getContext, openDetails, openForm, confirmAction, toast } from '../ui.js';
import { SURVEY_NOTICE, SURVEY_TYPE_LABELS, surveyIdentity, surveyPublicUrl, confirmSurveyTemplate, confirmSurveyList, confirmSurveyDetail, confirmSurveyPreview, confirmSurveyCreate, confirmSurveyDisable, confirmSurveyResponses, confirmSurveyHistory, confirmSurveyResponseHistory, createSurveyInvitationEditor, surveyAnswerRows } from '../data/survey-ui.js';
import { formClosed, formArray } from '../data/custom-form-engine.js';
import { surveySame } from '../data/survey-core.js';
import { privateSurveyRequest, surveyPngDataUrl } from './survey-requests.js';

const cancelled = () => new DOMException('本機填答管理操作已失效。', 'AbortError');
const actions = (...nodes) => el('div', { class: 'actions row-actions' }, ...nodes);
const notice = value => el('p', { class: 'notice' }, value);
function publicQuestions(snapshot) {
  const groups = new Map(snapshot.groups.map(group => [group.id, group.label]));
  return el('section', { 'data-survey-public-preview': true }, el('h3', {}, snapshot.title), table([{ label: '群組', render: field => groups.get(field.groupId) || '一般題目' }, { key: 'label', label: '完整公開題目' }, { label: '型別', render: field => SURVEY_TYPE_LABELS[field.type] }, { label: '必填', render: field => field.required ? '必填' : '可略過' }, { label: '公開選項（名稱／保存值）', render: field => el('span', { class: 'pre-wrap' }, field.options.map(option => `${option.label}（${option.value}）`).join('\n') || '不適用') }, { label: '完整顯示條件', render: field => field.visibleIf ? `${field.visibleIf.field} = ${String(field.visibleIf.equals)}` : '持續顯示' }], snapshot.fields, { caption: '本次明確核准的完整公開題目、選項與控制條件' }));
}
function invitationContent(item) {
  return el('section', {}, notice(SURVEY_NOTICE), el('h2', {}, item.publicSnapshot.title), el('p', {}, `保存版次 ${item.version} · ${item.status === 'active' ? '已開通' : '已停用'} · 原始填答 ${item.responseCount} 筆／容量 ${item.maxResponses}`), el('p', { class: 'pre-wrap' }, `精確模板：${item.templateId} · SQL保存版次 ${item.templateVersion}\nUTC截止時刻：${item.expiresAt}\n人工公開核准依據：${item.approvalReference}`), publicQuestions(item.publicSnapshot), item.status === 'disabled' && el('p', { class: 'pre-wrap' }, `UTC停用時刻：${item.disabledAt}\n停用理由：${item.disableReason}`), notice('既有開通紀錄不含原始連結或QR。原始連結只在首次成功回應的當次記憶體提供；不能按紀錄復原。'));
}
function guardedButton(label, operation, variant = 'outline') {
  let busy = false;
  const node = button(label, async () => { if (busy) return; busy = true; node.setAttribute('aria-busy', 'true'); node.setAttribute('aria-disabled', 'true'); try { await operation(node); } catch (error) { if (node.isConnected && error.name !== 'AbortError') toast(error.message, 'error'); } finally { busy = false; node.removeAttribute('aria-busy'); node.removeAttribute('aria-disabled'); } }, { variant }); return node;
}
function openInvitationDetails(id, isCurrent) {
  const orgId = getContext().organizationId;
  return openDetails({ title: '本機填答開通詳情', wide: true, guardedRead: true, isCurrent, load: async (signal, owner) => { const item = confirmSurveyDetail(await api(`/api/survey-invitations/${encodeURIComponent(id)}`, { signal }), { orgId, id }); if (!owner.isCurrent()) throw cancelled(); return invitationContent(item); } });
}
function openResponses(id, isCurrent) {
  const orgId = getContext().organizationId; let page = 1;
  return openDetails({ title: '匿名原始填答與筆數', wide: true, guardedRead: true, isCurrent,
    load: async (signal, owner) => {
      const path = `/api/survey-invitations/${encodeURIComponent(id)}/responses?page=${page}&pageSize=25`, result = confirmSurveyResponses(await api(path, { signal }), { orgId, id, page });
      if (!owner.isCurrent()) throw cancelled();
      return el('section', {}, notice(SURVEY_NOTICE), el('h2', {}, result.invitation.publicSnapshot.title), el('p', {}, `目前原始提交共 ${result.total} 筆；不同提交識別不等於不同自然人。`), table([{ key: 'id', label: '匿名提交紀錄識別' }, { key: 'createdAt', label: 'UTC保存時刻' }, { label: '保存方式', render: () => '原始答案已保存' }, { label: '操作', render: row => guardedButton('查看原始答案', trigger => openDetails({ title: '匿名填答完整原文', wide: true, guardedRead: true, isCurrent: () => owner.isCurrent() && trigger.isConnected, load: async (readSignal, detailOwner) => { const fresh = confirmSurveyResponses(await api(path, { signal: readSignal }), { orgId, id, page }); const current = fresh.items.find(item => item.id === row.id); if (!detailOwner.isCurrent()) throw cancelled(); if (!current || !surveySame(current, row)) throw new Error('這筆完整填答已不在本頁，請關閉後重新查詢。'); const values = surveyAnswerRows(current.publicSnapshot, current.answers); return el('section', {}, notice(SURVEY_NOTICE), el('h3', {}, current.publicSnapshot.title), el('p', {}, `UTC保存時刻：${current.createdAt} · 保存版次 ${current.version}`), table([{ key: 'group', label: '群組' }, { key: 'label', label: '題目' }, { key: 'type', label: '題型' }, { label: '完整保存原始答案', render: entry => el('span', { class: 'pre-wrap' }, entry.answer) }], values, { caption: '按保存的公開題目與條件呈現原始答案；未計分' }), guardedButton('原始答案版本歷程', trigger => openResponseHistory(current, () => detailOwner.isCurrent() && trigger.isConnected))); } })) }], result.items, { caption: '本機匿名原始填答紀錄', emptyText: '尚無已保存匿名填答；不代表未閱讀或義務未完成。' }), pagination({ page, pageSize: 25, total: result.total, onChange: next => { if (owner.isCurrent()) { page = next; owner.reload(); } } }));
    },
  });
}
function openResponseHistory(expected, isCurrent) {
  const orgId = getContext().organizationId;
  return openDetails({ title: '匿名原始答案版本歷程', wide: true, guardedRead: true, isCurrent, load: async (signal, owner) => {
    const result = confirmSurveyResponseHistory(await api(`/api/survey-responses/${encodeURIComponent(expected.id)}/history?page=1&pageSize=25&compare=previous`, { signal }), { orgId, expected });
    if (!owner.isCurrent()) throw cancelled();
    return el('section', {}, notice(SURVEY_NOTICE), ...result.items.map(row => el('section', {}, el('h3', {}, `保存版次 ${row.version}`), el('p', {}, `UTC保存時刻：${row.createdAt} · 保存來源：${row.source}`), table([{ key: 'group', label: '群組' }, { key: 'label', label: '題目' }, { key: 'type', label: '題型' }, { label: '完整保存原始答案', render: entry => el('span', { class: 'pre-wrap' }, entry.answer) }], surveyAnswerRows(row.snapshot.publicSnapshot, row.snapshot.answers), { caption: '此份不可改寫的原始答案保存版次' }))));
  } });
}
function openHistory(id, isCurrent) {
  const orgId = getContext().organizationId; let page = 1;
  return openDetails({ title: '本機填答開通版本歷程', wide: true, guardedRead: true, isCurrent, load: async (signal, owner) => {
    const result = confirmSurveyHistory(await api(`/api/survey-invitations/${encodeURIComponent(id)}/history?page=${page}&pageSize=25&compare=previous`, { signal }), { orgId, id, page }); if (!owner.isCurrent()) throw cancelled();
    return el('section', {}, notice('保存原核准公開題目及開通／停用版次；不含原始連結、匿名提交識別或內部核准依據。'), table([{ key: 'version', label: '保存版次' }, { key: 'createdAt', label: 'UTC保存時刻' }, { key: 'source', label: '保存來源' }, { label: '保存狀態', render: row => row.snapshot.status === 'active' ? '已開通' : '已停用' }, { label: '保存公開內容', render: row => publicQuestions(row.snapshot.publicSnapshot) }], result.items, { caption: '開通紀錄的完整公開內容版本歷程' }), pagination({ page, pageSize: 25, total: result.total, onChange: next => { if (owner.isCurrent()) { page = next; owner.reload(); } } }));
  } });
}
async function disableInvitation(id, isCurrent, afterSave) {
  const orgId = getContext().organizationId;
  return openDetails({ title: '核對要停用的開通紀錄', wide: true, guardedRead: true, isCurrent, load: async (signal, owner) => {
    const item = confirmSurveyDetail(await api(`/api/survey-invitations/${encodeURIComponent(id)}`, { signal }), { orgId, id }); if (!owner.isCurrent()) throw cancelled();
    const stop = guardedButton('填寫停用理由', async trigger => {
      if (item.status !== 'active' || !owner.isCurrent()) return;
      const saved = await openForm({ title: '明確停用本機填答', isCurrent: () => owner.isCurrent() && trigger.isConnected, fields: [{ name: 'reason', label: '本次停用理由', required: true, maxLength: 1000 }], initial: { reason: '' }, onSubmit: async (values, formOwner) => {
        const payload = { version: item.version, reason: values.reason };
        if (!values.reason.trim() || /[\x00\r\n]/.test(values.reason)) throw new Error('請填寫本次單行停用理由。');
        const agreed = await confirmAction({ title: '停用此匿名填答連結？', message: '停用後不能再填答；既有原始答案與公開快照保持，不能恢復原始連結。', confirmLabel: '停用此連結', danger: true, signal: formOwner.signal, isCurrent: formOwner.isCurrent }); if (!agreed) throw new Error('尚未停用，輸入理由仍保留。');
        const result = await api(`/api/survey-invitations/${encodeURIComponent(id)}/disable`, { method: 'POST', body: payload, signal: formOwner.signal }); if (!formOwner.isCurrent()) throw cancelled(); confirmSurveyDisable(result, { original: item, orgId, payload });
      } }); if (saved && owner.isCurrent()) { toast('已保存停用紀錄；既有原始答案保持。'); await owner.reload(); afterSave?.(); }
    }, 'danger');
    return el('section', {}, invitationContent(item), item.status === 'active' ? stop : notice('此開通紀錄已停用，不能恢復或再次改寫。'));
  } });
}
async function showIssued(item, token, isCurrent) {
  let dataUrl;
  try {
    await openDetails({ title: token ? '本次開通的本機填答QR' : '開通已保存，但未取得原始連結', wide: true, guardedRead: true, isCurrent, load: async (signal, owner) => {
      if (!token) return el('section', {}, notice('開通保存已確認；本次沒有首次回應的原始連結。原始連結不能復原，不會自動換識別再次開通。需要新連結時，請明確停用這筆紀錄後另行開通。'), el('p', {}, `保存紀錄：${item.id} · ${item.publicSnapshot.title}`), guardedButton('查看已保存開通詳情', () => openInvitationDetails(item.id, owner.isCurrent)));
      const response = await privateSurveyRequest('qr', { token }, { id: item.id, signal, isCurrent: owner.isCurrent }); if (!owner.isCurrent()) throw cancelled();
      dataUrl = await surveyPngDataUrl(response.png, { signal, isCurrent: owner.isCurrent }); const url = surveyPublicUrl(location.origin, token);
      return el('section', {}, notice('此QR與原始連結僅在當次記憶體顯示；關閉後不能由歷程復原。這是本機入口，外部手機不一定能連線，不代表正式公開發布。'), el('h3', {}, item.publicSnapshot.title), el('img', { src: dataUrl, width: 256, height: 256, alt: '本機匿名填答QR，開啟本次核准公開題目' }), el('p', {}, el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, '開啟本機填答頁')), el('p', { class: 'pre-wrap' }, url), publicQuestions(item.publicSnapshot));
    } });
  } finally { dataUrl = null; token = null; }
}
async function inviteWithTemplate(template, isCurrent) {
  const orgId = getContext().organizationId, editor = createSurveyInvitationEditor(template, orgId), keys = new Map(); let lastPreview;
  const result = await openForm({ title: '核准公開題目並開通本機填答', isCurrent, fields: editor.fields, initial: editor.initial, submitLabel: '核准並開通本機填答', previewLabel: '核對完整公開題目', previewInstruction: '先人工選取公開題目及前序控制題；預覽確認完整選項與條件後才開通。', keepOpenOnFalse: true, returnSubmitResult: true,
    onPreview: async (values, previewOwner) => { const payload = editor.buildPayload(values); const preview = await confirmSurveyPreview(await api('/api/survey-invitations/preview', { method: 'POST', body: payload, signal: previewOwner.signal }), { template: editor.template, payload, orgId }); if (!isCurrent() || previewOwner.signal.aborted) throw cancelled(); lastPreview = { payload, preview }; return { content: el('section', {}, notice('這是即將公開的完整內容；內部模板名稱、代碼、說明、備註與機構識別不公開。此預覽尚未保存或開通。'), publicQuestions(preview.publicSnapshot), el('p', {}, `UTC截止：${preview.expiresAt} · 容量：${preview.maxResponses}筆`)), canSubmit: true }; },
    onSubmit: async (values, owner) => { const payload = editor.buildPayload(values); if (!lastPreview || !surveySame(payload, lastPreview.payload)) throw new Error('內容已變更，請重新核對完整公開題目。'); const sent = { ...payload, previewHash: lastPreview.preview.previewHash }; const agreed = await confirmAction({ title: '明確核准並發出本機填答連結？', message: '只公開預覽中的完整題目；原始連結只在首次回應提供，無法從清單復原。這是本機匿名原始填答，不是官方滿意度評分。', confirmLabel: '核准並開通', signal: owner.signal, isCurrent: owner.isCurrent }); if (!agreed) throw new Error('尚未開通，原輸入及預覽仍保留。'); const signature = JSON.stringify(sent); if (!keys.has(signature)) keys.set(signature, crypto.randomUUID()); let item; const response = await privateSurveyRequest('create', sent, { idempotencyKey: keys.get(signature), confirmAcknowledgement: async data => { item = await confirmSurveyCreate(data, { orgId, payload: sent, preview: lastPreview.preview }); }, signal: owner.signal, isCurrent: owner.isCurrent }); if (!owner.isCurrent()) throw cancelled(); return { item, token: response.issuedToken }; },
  });
  if (result && isCurrent()) await showIssued(result.item, result.token, isCurrent);
}
function openTemplateChooser(isCurrent) {
  const orgId = getContext().organizationId; let page = 1;
  return openDetails({ title: '選擇已發布模板的精確保存版次', wide: true, guardedRead: true, isCurrent, load: async (signal, owner) => {
    const value = await api(`/api/form-templates?status=published&page=${page}&pageSize=25`, { signal }); if (!owner.isCurrent()) throw cancelled();
    if (!formClosed(value, ['items', 'total', 'page', 'pageSize']) || !formArray(value.items, 25) || !Number.isSafeInteger(value.total) || value.total < 0 || value.total > 10000 || value.page !== page || value.pageSize !== 25 || value.items.length !== Math.max(0, Math.min(25, value.total - (page - 1) * 25))) throw new Error('已發布模板清單未完整確認。');
    const ids = new Set(); for (const row of value.items) { confirmSurveyTemplate(row, orgId); if (ids.has(row.id)) throw new Error('模板識別重複。'); ids.add(row.id); }
    return el('section', {}, notice('先選同機構目前已發布的精確SQL版次；公開標題與題目需在下一步另外人工核准。'), table([{ key: 'name', label: '內部模板名稱' }, { key: 'revision', label: '人工修訂號' }, { key: 'version', label: '精確SQL保存版次' }, { label: '操作', render: row => guardedButton('使用此保存版次', async trigger => { const fresh = await api(`/api/form-templates/${encodeURIComponent(row.id)}`, { signal }); if (!formClosed(fresh, ['item'])) throw new Error('模板回應未確認。'); const template = confirmSurveyTemplate(fresh.item, orgId, { id: row.id, version: row.version }); if (!owner.isCurrent()) throw cancelled(); await inviteWithTemplate(template, () => owner.isCurrent() && trigger.isConnected); }) }], value.items, { caption: '同機構目前已發布的自訂模板', emptyText: '沒有已發布自訂模板；請先在自訂表單完成模板發布。' }), pagination({ page, pageSize: 25, total: value.total, onChange: next => { if (owner.isCurrent()) { page = next; owner.reload(); } } }));
  } });
}
function openInvitationList(isCurrent) {
  const orgId = getContext().organizationId; let page = 1, status = '', draft = '', generation = 0;
  return openDetails({ title: '本機匿名填答開通紀錄', wide: true, guardedRead: true, isCurrent, load: async (signal, owner) => {
    const started = generation, params = new URLSearchParams({ page: String(page), pageSize: '25' }); if (status) params.set('status', status);
    const result = confirmSurveyList(await api(`/api/survey-invitations?${params}`, { signal }), { orgId, page, status }); if (!owner.isCurrent() || started !== generation) throw cancelled();
    const content = el('section'), footer = el('div'); let initialized = false, enabled = true;
    const current = () => owner.isCurrent() && form.isConnected && enabled && started === generation;
    const form = createFilterForm(); function createFilterForm() { return createManagerFilter({ initial: { status: draft }, onChange: next => { if (!initialized || !owner.isCurrent()) return; draft = next.status; generation++; enabled = false; content.replaceChildren(notice('條件已變更，請明確重新查詢。')); footer.replaceChildren(); }, onSubmit: async next => { if (!owner.isCurrent()) return false; draft = status = next.status; page = 1; generation++; await owner.reload(); } }); } initialized = true;
    content.append(table([{ label: '公開標題', render: row => row.publicSnapshot.title }, { label: '狀態', render: row => row.status === 'active' ? '已開通' : '已停用' }, { key: 'expiresAt', label: 'UTC截止時刻' }, { key: 'responseCount', label: '原始提交筆數' }, { key: 'maxResponses', label: '保存容量' }, { key: 'version', label: '保存版次' }, { label: '操作', render: row => actions(guardedButton('詳情', trigger => openInvitationDetails(row.id, () => current() && trigger.isConnected)), guardedButton('原始填答', trigger => openResponses(row.id, () => current() && trigger.isConnected)), guardedButton('版本歷程', trigger => openHistory(row.id, () => current() && trigger.isConnected)), ...(row.status === 'active' ? [guardedButton('停用', trigger => disableInvitation(row.id, () => current() && trigger.isConnected), 'danger')] : [])) }], result.items, { caption: '本機匿名填答開通紀錄', emptyText: '目前條件沒有開通紀錄；原始連結只在首次成功開通回應提供。' }));
    footer.append(pagination({ page, pageSize: 25, total: result.total, onChange: next => { if (current()) { page = next; generation++; owner.reload(); } } })); return el('section', {}, notice(SURVEY_NOTICE), form, content, footer);
  } });
}
// Shared native form owner; this thin helper only declares the status filter.
import { createForm } from '../ui.js';
function createManagerFilter(config) { return createForm({ ...config, fields: [{ name: 'status', label: '開通保存狀態', type: 'select', options: [{ value: 'active', label: '已開通' }, { value: 'disabled', label: '已停用' }], placeholder: '全部狀態' }], submitLabel: '查詢開通紀錄', lockDuringSubmit: true }); }
export function mountSurveys(container, { isCurrent = () => true } = {}) {
  const context = getContext(), identity = surveyIdentity(context), hash = location.hash;
  const current = () => container.isConnected && isCurrent() && getContext() === context && surveyIdentity(getContext()) === identity && location.hash === hash && ['admin', 'supervisor'].includes(getContext().role);
  if (!['admin', 'supervisor'].includes(context.role)) { container.replaceChildren(errorState(Object.assign(new Error('只有原機構管理者或督導可管理本機匿名填答。'), { status: 403 }))); return; }
  const invite = guardedButton('開通匿名填答', trigger => openTemplateChooser(() => current() && trigger.isConnected), 'primary'), list = guardedButton('查詢開通紀錄', trigger => openInvitationList(() => current() && trigger.isConnected));
  container.replaceChildren(pageHeader('本機匿名填答與QR', '人工核准完整公開題目，保存匿名原始答案及筆數。', [invite, list]), el('section', { class: 'panel' }, notice(SURVEY_NOTICE), el('h2', {}, '先核對，再明確開通'), el('p', {}, '依同機構已發布模板的精確保存版次，人工選取要公開的題目及控制條件。每次只在首次成功回應提供原始連結；關閉後不能從清單復原。'), el('p', {}, '公開填答不需要登入，不新增帳號、不帶個案或員工資料。QR開啟本機網址，不代表正式主機可供外部手機使用。')));
}
