import { formClosed, formArray, formId, formFailure, isCustomFormDate, assertFormDefinition, assertFormAnswers,
  assertFormTemplateRecord, assertFormRecord, captureFormTemplate, customFormValueText } from '../../public/data/custom-form-engine.js';

export const customFormEntities = {
  'form-templates': {
    fields: 'code name description revision previousTemplateId groups fields status note',
    required: ['code', 'name', 'revision', 'fields'], statuses: ['draft', 'published', 'inactive'],
    defaults: { description: '', revision: 1, previousTemplateId: '', groups: [], status: 'draft', note: '' },
    jsonFields: ['groups', 'fields'], integerFields: ['revision'], maxLengths: { code: 100, name: 200, description: 10000, note: 10000 },
  },
  'form-records': {
    fields: 'caseId templateId templateVersion date answers attachmentIds status note',
    required: ['caseId', 'templateId', 'templateVersion', 'date'], statuses: ['draft', 'submitted'],
    defaults: { answers: {}, attachmentIds: [], status: 'draft', note: '' },
    jsonFields: ['answers', 'attachmentIds'], integerFields: ['templateVersion'], maxAnswersLength: 600000, maxLengths: { date: 10, note: 10000 },
  },
};
export const isCustomFormEntity = entity => Object.hasOwn(customFormEntities, entity);
export function guardCustomFormAccess(entity, ctx, _readOnly, fail = formFailure) {
  if (isCustomFormEntity(entity) && !['admin', 'supervisor'].includes(ctx.role)) fail(403, 'ROLE_FORBIDDEN', '只有管理者與督導可讀取及維護自訂表單。');
}
export function normalizeCustomFormPayload(entity, payload) {
  if (!isCustomFormEntity(entity)) return payload;
  const normalized = new Set(entity === 'form-templates' ? ['code', 'name', 'previousTemplateId', 'status'] : ['caseId', 'templateId', 'date', 'status']);
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, normalized.has(key) && typeof value === 'string' ? value.trim() : value]));
}
const text = (value, max, required = false) => typeof value === 'string' && value.length <= max && (!required || !!value.trim());
const positive = value => Number.isSafeInteger(value) && value > 0;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const invalid = () => { throw new Error('invisible custom form'); };
function currentTemplate(db, ctx, id, get, fail) {
  const parent = get(db, ctx.orgId, 'form-templates', id);
  if (!parent) fail(404, 'NOT_FOUND', '找不到本機構模板。');
  assertFormTemplateRecord(parent, ctx.orgId, fail); return parent;
}
function templateLineage(db, ctx, item, get, fail) {
  if (!item.previousTemplateId) return;
  const previous = currentTemplate(db, ctx, item.previousTemplateId, get, fail);
  if (previous.code !== item.code || previous.revision + 1 !== item.revision || !['published', 'inactive'].includes(previous.status)) fail(409, 'FORM_DATA_INVALID', '模板前版與本機構修訂鏈不一致。');
}
/** Prove snapshot provenance against the immutable published SQL version. No BLOB access. */
export function readPublishedFormSnapshot(db, ctx, templateId, templateVersion, get, fail = formFailure) {
  if (!formId(templateId) || !positive(templateVersion)) fail(422, 'INVALID_TEMPLATE_VERSION', '請提供模板識別碼與正整數保存版次。');
  const current = currentTemplate(db, ctx, templateId, get, fail); templateLineage(db, ctx, current, get, fail);
  const statement = db.prepare('SELECT version,snapshot FROM record_versions WHERE org_id=? AND entity=? AND record_id=? AND version=?');
  statement.setReadBigInts(true);
  const row = statement.get(ctx.orgId, 'form-templates', templateId, templateVersion);
  if (!row || row.version !== BigInt(templateVersion)) fail(404, 'NOT_FOUND', '找不到已發布的保存模板版次。');
  let item; try { item = JSON.parse(row.snapshot); } catch { fail(409, 'FORM_DATA_INVALID', '保存模板歷程無法確認。'); }
  assertFormTemplateRecord(item, ctx.orgId, fail);
  if (item.id !== templateId || item.version !== templateVersion || item.status !== 'published') fail(409, 'FORM_DATA_INVALID', '填答模板必須對應已發布的精確保存版次。');
  return captureFormTemplate(item, ctx.orgId, fail);
}
function references(db, ctx, record, get, fail, { activeAttachments = false } = {}) {
  if (!get(db, ctx.orgId, 'cases', record.caseId)) fail(404, 'NOT_FOUND', '找不到本機構個案。');
  if (!formArray(record.attachmentIds, 20) || !record.attachmentIds.every(formId) || new Set(record.attachmentIds).size !== record.attachmentIds.length) fail(422, 'INVALID_FORM_ATTACHMENTS', '附件需為最多20個不重複識別碼。');
  for (const attachmentId of record.attachmentIds) {
    const attachment = get(db, ctx.orgId, 'case-attachments', attachmentId);
    if (!attachment || attachment.caseId !== record.caseId || !['active', 'inactive'].includes(attachment.status) || activeAttachments && attachment.status !== 'active')
      fail(422, 'INVALID_FORM_ATTACHMENTS', '只能引用本機構同個案的既有有效附件。', { attachmentIds: '請重新核對附件所屬個案與狀態' });
  }
}
export function customFormVisible(db, ctx, entity, item, get) {
  if (!isCustomFormEntity(entity)) return true;
  try {
    guardCustomFormAccess(entity, ctx, true, invalid);
    if (entity === 'form-templates') { assertFormTemplateRecord(item, ctx.orgId, invalid); templateLineage(db, ctx, item, get, invalid); return true; }
    assertFormRecord(item, ctx.orgId, invalid); references(db, ctx, item, get, invalid);
    return same(item.templateSnapshot, readPublishedFormSnapshot(db, ctx, item.templateId, item.templateVersion, get, invalid));
  } catch { return false; }
}
export function customFormHistoryVisible(db, ctx, entity, snapshot, current, get) {
  if (!customFormVisible(db, ctx, entity, current, get) || !customFormVisible(db, ctx, entity, snapshot, get) || snapshot.id !== current.id) return false;
  return entity === 'form-templates'
    ? snapshot.code === current.code && snapshot.revision === current.revision && snapshot.previousTemplateId === current.previousTemplateId
    : snapshot.caseId === current.caseId && snapshot.templateId === current.templateId && snapshot.templateVersion === current.templateVersion && same(snapshot.templateSnapshot, current.templateSnapshot);
}
export function validateCustomForm(db, ctx, entity, data, old, fail = formFailure, get, rows) {
  if (!isCustomFormEntity(entity)) return;
  guardCustomFormAccess(entity, ctx, false, fail);
  if (old && !customFormVisible(db, ctx, entity, old, get)) fail(404, 'NOT_FOUND', '找不到可維護的保存表單。');
  const spec = customFormEntities[entity];
  for (const [key, max] of Object.entries(spec.maxLengths)) if (!text(data[key], max, spec.required.includes(key))) fail(422, 'INVALID_FIELD', '表單文字格式或長度不符。', { [key]: '請核對欄位' });
  if (!spec.statuses.includes(data.status)) fail(422, 'INVALID_STATUS', '表單狀態不合法。');
  if (entity === 'form-templates') {
    const occupied = rows(db, ctx.orgId, entity), count = db.prepare('SELECT count(*) n FROM records WHERE org_id=? AND entity=?'); count.setReadBigInts(true);
    if (count.get(ctx.orgId, entity).n !== BigInt(occupied.length)) fail(409, 'FORM_DATA_INVALID', '本機構既有模板資料無法完整確認，請先核對保存資料。');
    try { for (const item of occupied) { assertFormTemplateRecord(item, ctx.orgId); templateLineage(db, ctx, item, get, formFailure); } }
    catch { fail(409, 'FORM_DATA_INVALID', '本機構既有模板定義或修訂鏈無法確認，請先核對保存資料。'); }
    if (!text(data.code, 100, true) || data.code !== data.code.trim() || /[\r\n]/.test(data.code) || !positive(data.revision) || !(data.previousTemplateId === '' || formId(data.previousTemplateId))) fail(422, 'INVALID_TEMPLATE_IDENTITY', '請核對模板代碼、修訂號與前版識別碼。');
    assertFormDefinition(data.groups, data.fields, fail);
    if (old && ['code', 'revision', 'previousTemplateId'].some(key => data[key] !== old[key])) fail(409, 'FORM_IDENTITY_IMMUTABLE', '模板代碼、修訂號與前版建立後不可更換。');
    if (!old) {
      if (data.status !== 'draft') fail(422, 'FORM_STATE', '新模板需先建立草稿。');
      if (data.previousTemplateId === '') { if (data.revision !== 1) fail(422, 'INVALID_REVISION', '第一版修訂號須為1。'); }
      else {
        const prior = currentTemplate(db, ctx, data.previousTemplateId, get, fail);
        if (!['published', 'inactive'].includes(prior.status) || prior.code !== data.code || data.revision !== prior.revision + 1) fail(409, 'INVALID_REVISION', '新版需引用同代碼已發布或停用前版，修訂號加1。');
      }
    } else if (old.status === 'draft') {
      if (!['draft', 'published'].includes(data.status)) fail(409, 'FORM_STATE', '模板草稿只可保存或發布。');
    } else if (old.status === 'inactive' || data.status !== 'inactive' || spec.fields.split(' ').filter(key => key !== 'status').some(key => !same(data[key], old[key]))) {
      fail(409, 'FORM_TEMPLATE_LOCKED', '已發布模板內容鎖定；只可停用，修改請建立新版草稿。');
    }
    if (occupied.some(item => item.id !== old?.id && item.code === data.code && item.revision === data.revision)) fail(409, 'DUPLICATE_FORM_REVISION', '相同模板代碼已有此修訂號。');
    return;
  }
  if (!formId(data.caseId) || !formId(data.templateId) || !positive(data.templateVersion) || !isCustomFormDate(data.date)) fail(422, 'INVALID_FORM_IDENTITY', '請核對個案、模板、保存版次與有效日期。');
  if (!old && data.status !== 'draft') fail(422, 'FORM_STATE', '新填答需先建立草稿。');
  if (old && ['caseId', 'templateId', 'templateVersion'].some(key => data[key] !== old[key])) fail(409, 'FORM_IDENTITY_IMMUTABLE', '填答所屬個案與模板保存版次不可更換。');
  if (old?.status === 'submitted') fail(409, 'FORM_RECORD_LOCKED', '已提交填答不可改寫；請建立新紀錄。');
  const parent = currentTemplate(db, ctx, data.templateId, get, fail);
  if (parent.status !== 'published' || parent.version !== data.templateVersion) fail(409, 'FORM_TEMPLATE_UNAVAILABLE', '草稿保存與提交需使用目前有效且版次一致的已發布模板。');
  references(db, ctx, data, get, fail, { activeAttachments: true });
  const saved = readPublishedFormSnapshot(db, ctx, data.templateId, data.templateVersion, get, fail);
  if (old && !same(old.templateSnapshot, saved)) fail(409, 'FORM_DATA_INVALID', '原模板快照與保存歷程不一致。');
  data.templateSnapshot = structuredClone(saved);
  assertFormAnswers(saved.groups, saved.fields, data.answers, { submitted: data.status === 'submitted' }, fail);
}
export function customFormQuery(entity, params, fail = formFailure, mode = 'list') {
  if (!isCustomFormEntity(entity)) return {};
  const allowed = mode === 'history' ? ['page', 'pageSize', 'compare'] : ['page', 'pageSize', 'q', 'status', ...(entity === 'form-records' ? ['caseId', 'templateId', 'date'] : [])];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) fail(422, 'INVALID_QUERY', '自訂表單查詢欄位不合法或重複。');
  const integer = (key, fallback, maximum) => {
    const raw = params.get(key) ?? String(fallback), value = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || /[\r\n]/.test(raw) || !Number.isSafeInteger(value) || value > maximum) fail(422, 'INVALID_QUERY', '自訂表單分頁參數不合法。');
    return value;
  };
  const query = { page: integer('page', 1, Math.floor(Number.MAX_SAFE_INTEGER / 100)), pageSize: integer('pageSize', 25, 100), q: params.get('q') || '', status: params.get('status') || '' };
  if (query.q.length > 200 || params.has('status') && !customFormEntities[entity].statuses.includes(query.status) || params.has('compare') && params.get('compare') !== 'previous') fail(422, 'INVALID_QUERY', '自訂表單查詢值不合法。');
  for (const key of ['caseId', 'templateId']) if (params.has(key)) { if (!formId(params.get(key))) fail(422, 'INVALID_QUERY', '所屬識別碼查詢值不合法。'); query[key] = params.get(key); }
  if (params.has('date')) { if (!isCustomFormDate(params.get('date'))) fail(422, 'INVALID_QUERY', '查詢日期不合法。'); query.date = params.get('date'); }
  return query;
}
export function filterCustomForms(entity, items, query) {
  const q = query.q.toLocaleLowerCase('zh-TW');
  return items.filter(item => (!query.status || item.status === query.status) && ['caseId', 'templateId', 'date'].every(key => !query[key] || item[key] === query[key])
    && (!q || (entity === 'form-templates' ? [item.code, item.name, item.description, item.note] : [item.templateSnapshot.code, item.templateSnapshot.name, item.note]).some(value => value.toLocaleLowerCase('zh-TW').includes(q))));
}
/** Safe local paper model, from the stored version only; renderer uses textContent. */
export function customFormPrintModel(db, ctx, item, get, fail = formFailure) {
  guardCustomFormAccess('form-records', ctx, true, fail);
  if (!customFormVisible(db, ctx, 'form-records', item, get)) fail(404, 'NOT_FOUND', '找不到可列印填答。');
  const snapshot = item.templateSnapshot, visible = assertFormAnswers(snapshot.groups, snapshot.fields, item.answers, { submitted: item.status === 'submitted' }, fail);
  const groups = new Map(snapshot.groups.map(group => [group.id, group.label]));
  return { official: false, warning: '機構自訂表單，非官方核定模板；不計分。', recordId: item.id, recordVersion: item.version, caseId: item.caseId,
    templateId: item.templateId, templateVersion: item.templateVersion, revision: snapshot.revision, title: snapshot.name, code: snapshot.code, description: snapshot.description,
    date: item.date, status: item.status, note: item.note, attachmentIds: [...item.attachmentIds],
    fields: snapshot.fields.filter(field => visible.has(field.key)).map(field => ({ key: field.key, label: field.label, group: groups.get(field.groupId) || '一般題項', type: field.type, required: field.required, answer: customFormValueText(field, item.answers[field.key]) })) };
}
