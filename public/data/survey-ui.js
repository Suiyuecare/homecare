import { formClosed, formArray, formFailure, assertFormTemplateRecord, captureFormTemplate, assertFormAnswers, visibleFormFields, isCustomFormDate } from './custom-form-engine.js';
import { SURVEY_MODE, SURVEY_NOTICE, SURVEY_META_KEYS, SURVEY_INVITATION_DTO_KEYS, surveyId, surveyPositive, surveyHash, surveySecret, surveyTimestamp, surveyCanonical, surveySame, assertSurveySnapshot, capturePublicSurvey, assertSurveyPreviewPayload, assertSurveyPreviewDto, assertPublicSurveyDto, assertSurveyInvitationDto, assertSurveyResponseDto } from './survey-core.js';

export { SURVEY_MODE, SURVEY_NOTICE };
export const SURVEY_COMMON_KEYS = SURVEY_INVITATION_DTO_KEYS;
export const SURVEY_TYPE_LABELS = Object.freeze({ text: '短文字', textarea: '多行文字', number: '十進位文字', date: '日期', select: '單選', multiselect: '多選', boolean: '是／否' });
const invalid = (message = '填答回應未完整確認，請保留輸入內容並重新讀取。', fields) => formFailure(409, 'SURVEY_ACK_INVALID', message, fields);
const input = (key, message) => formFailure(422, 'SURVEY_INPUT_INVALID', message, { [key]: message });
const text = (value, maximum, required = false, single = false) => typeof value === 'string' && value.length <= maximum && (!required || !!value.trim()) && (!single || !/[\x00\r\n]/.test(value));
const clone = value => structuredClone(value);
function meta(item, orgId) {
  if (!surveyId(item.id) || item.orgId !== orgId || !surveyId(orgId) || !surveyPositive(item.version) || !surveyTimestamp(item.createdAt) || !surveyTimestamp(item.updatedAt) || item.updatedAt < item.createdAt) invalid();
}
function count(value, maximum = 1000) { if (!Number.isSafeInteger(value) || value < 0 || value > maximum) invalid(); return value; }
export function surveyIdentity(context) { return JSON.stringify([context?.user?.id, context?.organizationId ?? context?.orgId, context?.role, context?.user?.employeeId ?? null]); }
export function surveyPublicUrl(origin, token) {
  if (!surveySecret(token) || typeof origin !== 'string') input('token', '本次填答連結無法確認。');
  let parsed; try { parsed = new URL(origin); } catch { input('token', '本機來源網址無法確認。'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password) input('token', '只能使用目前本機來源網址。');
  return origin + '/survey/#' + token;
}
export function surveyFragmentToken(hash) {
  if (typeof hash !== 'string' || hash.length !== 44 || hash[0] !== '#' || !surveySecret(hash.slice(1))) input('token', '此本機填答連結無法使用。');
  return hash.slice(1);
}
export function createSurveyNonce(cryptoProvider = globalThis.crypto) {
  const bytes = new Uint8Array(32); cryptoProvider.getRandomValues(bytes);
  const token = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  if (!surveySecret(token)) throw new Error('本機提交識別無法建立。'); return token;
}
export async function surveyPublicHash(snapshot) {
  assertSurveySnapshot(snapshot);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(surveyCanonical(snapshot)));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}
export async function confirmSurveyPublic(value) {
  assertPublicSurveyDto(value);
  if (value.formHash !== await surveyPublicHash({ title: value.title, groups: value.groups, fields: value.fields })) invalid('公開題目與保存指紋不一致，未開啟填答。');
  return clone(value);
}
export function confirmSurveyTemplate(item, orgId, expected = {}) {
  assertFormTemplateRecord(item, orgId);
  if (item.status !== 'published' || expected.id !== undefined && item.id !== expected.id || expected.version !== undefined && item.version !== expected.version) invalid('模板已變更或停用，請重新選取目前已發布的精確版次。');
  return clone(item);
}
export function confirmSurveyManagerItem(item, { orgId, kind = 'list', id, version } = {}) {
  const keys = [...SURVEY_COMMON_KEYS, ...(kind === 'common' ? [] : ['responseCount']), ...(kind === 'detail' ? ['approvalReference', 'disableReason'] : [])];
  if (!['list', 'common', 'detail'].includes(kind) || !formClosed(item, keys)) invalid();
  if (!formArray(item.publicFieldKeys, 50) || item.publicFieldKeys.some(key => typeof key !== 'string')) invalid();
  assertSurveyInvitationDto(item, orgId, { mode: kind === 'common' ? 'parent' : kind });
  meta(item, orgId); assertSurveySnapshot(item.publicSnapshot);
  if (!surveyId(item.templateId) || !surveyPositive(item.templateVersion) || !surveyHash(item.formHash) || !surveyTimestamp(item.expiresAt) || !Number.isSafeInteger(item.maxResponses) || item.maxResponses < 1 || item.maxResponses > 1000 || !['active', 'disabled'].includes(item.status)
    || !formArray(item.publicFieldKeys, 50) || !surveySame(item.publicFieldKeys, item.publicSnapshot.fields.map(field => field.key)) || id !== undefined && item.id !== id || version !== undefined && item.version !== version) invalid();
  if (item.status === 'active' ? item.version !== 1 || item.disabledAt !== '' : item.version !== 2 || !surveyTimestamp(item.disabledAt) || item.disabledAt < item.createdAt) invalid();
  if (kind !== 'common') count(item.responseCount, item.maxResponses);
  if (kind === 'detail' && (!text(item.approvalReference, 1000, true, true) || !text(item.disableReason, 1000, item.status === 'disabled', true) || item.status === 'active' && item.disableReason !== '')) invalid();
  return clone(item);
}
function pageEnvelope(value, keys, expected, maximum = 1000) {
  if (!formClosed(value, keys) || !surveyPositive(expected.page) || expected.page > Math.floor(Number.MAX_SAFE_INTEGER / 100) || !surveyPositive(expected.pageSize) || expected.pageSize > 100 || value.page !== expected.page || value.pageSize !== expected.pageSize || !formArray(value.items, expected.pageSize)) invalid();
  count(value.total, maximum);
  if (value.items.length !== Math.max(0, Math.min(expected.pageSize, value.total - (expected.page - 1) * expected.pageSize))) invalid();
}
export function confirmSurveyList(value, { orgId, page = 1, pageSize = 25, status = '' } = {}) {
  if (!['', 'active', 'disabled'].includes(status)) invalid();
  pageEnvelope(value, ['items', 'total', 'page', 'pageSize'], { page, pageSize }); const ids = new Set();
  for (const row of value.items) { confirmSurveyManagerItem(row, { orgId }); if (ids.has(row.id) || status && row.status !== status) invalid(); ids.add(row.id); }
  return clone(value);
}
export function confirmSurveyDetail(value, expected) { if (!formClosed(value, ['item'])) invalid(); return confirmSurveyManagerItem(value.item, { ...expected, kind: 'detail' }); }
export async function confirmSurveyPreview(value, { template, payload, orgId } = {}) {
  confirmSurveyTemplate(template, orgId); assertSurveyPreviewPayload(payload);
  if (!formClosed(value, ['mode', 'templateId', 'templateVersion', 'publicSnapshot', 'expiresAt', 'maxResponses', 'previewHash']) || value.mode !== SURVEY_MODE || value.templateId !== template.id || value.templateVersion !== template.version || payload.templateId !== template.id || payload.templateVersion !== template.version || value.expiresAt !== payload.expiresAt || value.maxResponses !== payload.maxResponses || !surveyHash(value.previewHash)) invalid();
  assertSurveySnapshot(value.publicSnapshot);
  const expected = capturePublicSurvey(captureFormTemplate(template, orgId), payload.publicTitle, payload.publicFieldKeys);
  if (!surveySame(value.publicSnapshot, expected)) invalid('公開預覽與人工選取的完整題目不一致。');
  // previewHash additionally includes private approval input; snapshot is independently closed before canonical hashing.
  const proof = { mode: value.mode, templateId: value.templateId, templateVersion: value.templateVersion, publicSnapshot: expected, expiresAt: payload.expiresAt, maxResponses: payload.maxResponses, approvalReference: payload.approvalReference, approvedPublicQuestions: true };
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(surveyCanonical(proof)));
  if ([...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('') !== value.previewHash) invalid('公開核對指紋未確認，請重新預覽。');
  return clone(value);
}
export async function confirmSurveyCreate(value, { orgId, payload, preview } = {}) {
  if (!formClosed(value, ['item'])) invalid(); assertSurveyPreviewPayload(payload, { create: true });
  const item = confirmSurveyManagerItem(value.item, { orgId, kind: 'detail' });
  assertSurveyPreviewDto(preview, payload.templateId, payload.templateVersion);
  if (preview.previewHash !== payload.previewHash || preview.expiresAt !== payload.expiresAt || preview.maxResponses !== payload.maxResponses || item.templateId !== payload.templateId || item.templateVersion !== payload.templateVersion || !surveySame(item.publicSnapshot, preview.publicSnapshot) || !surveySame(item.publicFieldKeys, payload.publicFieldKeys) || item.publicSnapshot.title !== payload.publicTitle || item.expiresAt !== payload.expiresAt || item.maxResponses !== payload.maxResponses || item.approvalReference !== payload.approvalReference || item.responseCount !== 0 || item.status !== 'active' || item.formHash !== await surveyPublicHash(item.publicSnapshot)) invalid('開通保存回應未確認，請保留輸入並以相同識別重試。');
  return item;
}
export function confirmSurveyDisable(value, { original, orgId, payload } = {}) {
  const old = confirmSurveyManagerItem(original, { orgId, kind: 'detail' });
  if (!formClosed(payload, ['version', 'reason']) || payload.version !== old.version || !text(payload.reason, 1000, true, true) || !formClosed(value, ['item'])) invalid();
  const item = confirmSurveyManagerItem(value.item, { orgId, kind: 'detail', id: old.id, version: old.version + 1 });
  if (old.status !== 'active' || item.status !== 'disabled' || item.disableReason !== payload.reason || item.updatedAt < old.updatedAt) invalid();
  if (item.responseCount < old.responseCount) invalid();
  for (const key of [...SURVEY_COMMON_KEYS, 'approvalReference'].filter(key => !['version', 'updatedAt', 'status', 'disabledAt'].includes(key))) if (!surveySame(item[key], old[key])) invalid();
  return item;
}
export function confirmSurveyResponses(value, { orgId, id, page = 1, pageSize = 25 } = {}) {
  pageEnvelope(value, ['items', 'total', 'page', 'pageSize', 'invitation'], { page, pageSize });
  const invitation = confirmSurveyManagerItem(value.invitation, { orgId, kind: 'common', id }); const ids = new Set();
  if (value.total > invitation.maxResponses) invalid();
  for (const row of value.items) {
    if (!formClosed(row, [...SURVEY_META_KEYS, 'invitationId', 'formHash', 'publicSnapshot', 'answers', 'status'])) invalid(); meta(row, orgId);
    assertSurveySnapshot(row.publicSnapshot);
    assertSurveyResponseDto(row, orgId, invitation);
    if (ids.has(row.id) || row.version !== 1 || row.status !== 'submitted' || row.invitationId !== id || row.formHash !== invitation.formHash || !surveySame(row.publicSnapshot, invitation.publicSnapshot)) invalid();
    assertSurveySnapshot(row.publicSnapshot); assertFormAnswers(row.publicSnapshot.groups, row.publicSnapshot.fields, row.answers, { submitted: true }); ids.add(row.id);
  }
  return clone(value);
}
export function confirmSurveyHistory(value, { orgId, id, page = 1, pageSize = 25, compare = 'previous' } = {}) {
  pageEnvelope(value, ['items', 'total', 'page', 'pageSize', 'compare', 'currentVersion'], { page, pageSize }, 2);
  if (value.compare !== compare || value.currentVersion !== value.total || !surveyPositive(value.currentVersion) || value.currentVersion > 2) invalid();
  for (let index = 0; index < value.items.length; index++) {
    const row = value.items[index]; if (!formClosed(row, ['version', 'createdAt', 'source', 'snapshot']) || row.version !== value.currentVersion - (page - 1) * pageSize - index || !surveyTimestamp(row.createdAt) || !['create', 'update', 'baseline'].includes(row.source)) invalid();
    const snapshot = confirmSurveyManagerItem(row.snapshot, { orgId, kind: 'common', id, version: row.version }); if (snapshot.updatedAt !== row.createdAt) invalid();
    if (index && SURVEY_COMMON_KEYS.filter(key => !['version', 'updatedAt', 'status', 'disabledAt'].includes(key)).some(key => !surveySame(snapshot[key], value.items[0].snapshot[key]))) invalid();
  }
  return clone(value);
}
export function confirmSurveyResponseHistory(value, { orgId, expected, page = 1, pageSize = 25, compare = 'previous' } = {}) {
  assertSurveyResponseDto(expected, orgId);
  pageEnvelope(value, ['items', 'total', 'page', 'pageSize', 'compare', 'currentVersion'], { page, pageSize }, 1);
  if (value.total !== 1 || value.currentVersion !== 1 || value.compare !== compare) invalid();
  for (const row of value.items) {
    if (!formClosed(row, ['version', 'createdAt', 'source', 'snapshot']) || row.version !== 1 || row.createdAt !== expected.updatedAt || !['create', 'update', 'baseline'].includes(row.source)) invalid();
    assertSurveyResponseDto(row.snapshot, orgId);
    if (!surveySame(row.snapshot, expected)) invalid('匿名填答歷程與目前完整保存答案不一致。');
  }
  return clone(value);
}
export function createSurveyInvitationEditor(template, orgId, now = new Date().toISOString()) {
  const current = confirmSurveyTemplate(template, orgId); if (!surveyTimestamp(now)) invalid();
  const next = new Date(Date.parse(now) + 7 * 86400000).toISOString();
  const initial = { publicTitle: '', publicFieldKeys: [], expiresDate: next.slice(0, 10), expiresTime: next.slice(11, 16), maxResponses: '100', approvalReference: '', approvedPublicQuestions: false };
  const fields = [{ name: 'publicTitle', label: '公開填答標題', required: true, maxLength: 200, help: '請人工輸入可公開文字；不自動複製內部模板名稱。' }, { name: 'publicFieldKeys', label: '明確核准公開的題目', type: 'checkbox-group', required: true, options: current.fields.map(field => ({ value: field.key, label: `${field.label} · ${SURVEY_TYPE_LABELS[field.type]}${field.required ? ' · 必填' : ''}${field.visibleIf ? ` · 控制題：${field.visibleIf.field}` : ''}` })), help: '條件題目需一併明確選取前序控制題；不自動增加公開欄位。' }, { name: 'expiresDate', label: '截止日期（UTC）', type: 'date', required: true, min: '0001-01-01', max: '9999-12-31' }, { name: 'expiresTime', label: '截止時間（UTC）', type: 'time', required: true, help: '臺灣時間為UTC加8小時；保存明確UTC時刻，不推定正式通知期限。' }, { name: 'maxResponses', label: '最多保存填答筆數', required: true, inputMode: 'numeric', maxLength: 4, help: '1至1000筆。不同匿名提交不等於自然人去重。' }, { name: 'approvalReference', label: '人工公開核准依據（內部）', required: true, maxLength: 1000, help: '只供原機構管理者或督導查看，不公開到填答頁。' }, { name: 'approvedPublicQuestions', label: '我已核對完整公開題目、選項、條件與公開政策，核准本次公開', type: 'checkbox' }];
  function buildPayload(values) {
    if (!formClosed(values, Object.keys(initial))) input('publicTitle', '請核對完整表單欄位。');
    if (!formArray(values.publicFieldKeys, 50) || values.publicFieldKeys.some(key => typeof key !== 'string')) input('publicFieldKeys', '請核對明確選取的公開題目。');
    if (!isCustomFormDate(values.expiresDate) || typeof values.expiresTime !== 'string' || values.expiresTime.length !== 5 || !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(values.expiresTime)) input('expiresDate', '請填寫有效UTC截止日期與時間。');
    if (typeof values.maxResponses !== 'string' || !/^[1-9][0-9]{0,3}$/.test(values.maxResponses) || values.maxResponses.includes('\n') || Number(values.maxResponses) > 1000) input('maxResponses', '容量須為1至1000的整數，不接受指數或小數。');
    const payload = { templateId: current.id, templateVersion: current.version, publicTitle: values.publicTitle, publicFieldKeys: clone(values.publicFieldKeys), expiresAt: `${values.expiresDate}T${values.expiresTime}:00.000Z`, maxResponses: Number(values.maxResponses), approvalReference: values.approvalReference, approvedPublicQuestions: values.approvedPublicQuestions };
    assertSurveyPreviewPayload(payload); capturePublicSurvey(captureFormTemplate(current, orgId), payload.publicTitle, payload.publicFieldKeys); return payload;
  }
  return { fields, initial, template: current, buildPayload };
}
export function createSurveyAnswerEditor(open) {
  assertPublicSurveyDto(open); const snapshot = { title: open.title, groups: clone(open.groups), fields: clone(open.fields) }, initial = {};
  const groups = new Map(snapshot.groups.map(group => [group.id, group.label]));
  const fields = snapshot.fields.map(field => { const name = 'answer_' + field.key; initial[name] = field.type === 'multiselect' ? [] : ''; return { name, label: `${groups.has(field.groupId) ? groups.get(field.groupId) + ' · ' : ''}${field.label}${field.required ? '（必填）' : ''}`, type: field.type === 'number' ? 'text' : field.type === 'boolean' ? 'select' : field.type === 'multiselect' ? 'checkbox-group' : field.type, options: field.type === 'boolean' ? [{ value: 'true', label: '是' }, { value: 'false', label: '否' }] : clone(field.options), ...(field.type === 'number' ? { inputMode: 'decimal', maxLength: 29 } : field.type === 'textarea' ? { maxLength: 10000 } : field.type === 'text' ? { maxLength: 500 } : {}), help: field.type === 'number' ? '保存您輸入的十進位原文，不換算分數。' : field.visibleIf ? '依前面的控制題顯示；變更条件前會確認清除不適用答案。' : undefined }; });
  const read = values => { if (!formClosed(values, Object.keys(initial))) input('answers', '填答欄位無法確認。'); const answers = {}; for (const field of snapshot.fields) { const value = values['answer_' + field.key]; if (field.type === 'multiselect' ? !formArray(value, 50) || value.some(entry => typeof entry !== 'string') : typeof value !== 'string') input('answer_' + field.key, '此題的輸入格式無法確認。'); if (value === '' || field.type === 'multiselect' && !value.length) continue; answers[field.key] = field.type === 'boolean' ? value === 'true' ? true : value === 'false' ? false : value : clone(value); } return answers; };
  const visibility = values => visibleFormFields(snapshot.groups, snapshot.fields, read(values));
  const conditionalChange = (before, next) => { const previous = read(before), visible = visibility(next); return snapshot.fields.filter(field => Object.hasOwn(previous, field.key) && !visible.has(field.key)).map(field => field.key); };
  const buildAnswers = values => { const answers = read(values); assertFormAnswers(snapshot.groups, snapshot.fields, answers, { submitted: true }, (status, code, message, errors) => formFailure(status, code, message, Object.fromEntries(Object.entries(errors || {}).map(([key, value]) => ['answer_' + key, value])))); return answers; };
  return { fields, initial, snapshot, visibility, conditionalChange, buildAnswers, clearValue: key => snapshot.fields.find(field => field.key === key)?.type === 'multiselect' ? [] : '' };
}
export function confirmSurveyAccepted(value) { if (!formClosed(value, ['accepted']) || value.accepted !== true) invalid('提交結果未確認；請保留原答案，以同一提交識別重試。'); return true; }
export function createSurveySubmitAttempt(token, open, nonce = createSurveyNonce()) {
  if (!surveySecret(token) || !surveySecret(nonce)) input('token', '填答識別無法確認。'); assertPublicSurveyDto(open); let saved;
  return { build(answers) { assertFormAnswers(open.groups, open.fields, answers, { submitted: true }); const payload = { token, nonce, formHash: open.formHash, answers: clone(answers) }; if (saved && !surveySame(saved, payload)) input('answers', '上次提交結果可能已保存；請還原同一份答案後重試，不會自動換識別重複提交。'); saved ||= clone(payload); return payload; } };
}
export function surveyAnswerRows(snapshot, answers) {
  assertSurveySnapshot(snapshot); const visible = assertFormAnswers(snapshot.groups, snapshot.fields, answers, { submitted: true }), groups = new Map(snapshot.groups.map(group => [group.id, group.label]));
  return snapshot.fields.filter(field => visible.has(field.key)).map(field => ({ group: groups.get(field.groupId) || '一般題目', key: field.key, label: field.label, type: SURVEY_TYPE_LABELS[field.type], answer: !Object.hasOwn(answers, field.key) ? '未填寫' : field.type === 'boolean' ? `${answers[field.key] ? '是' : '否'}（${String(answers[field.key])}）` : field.type === 'select' ? `${field.options.find(option => option.value === answers[field.key]).label}（保存值：${answers[field.key]}）` : field.type === 'multiselect' ? answers[field.key].map(value => `${field.options.find(option => option.value === value).label}（保存值：${value}）`).join('\n') : answers[field.key] }));
}
