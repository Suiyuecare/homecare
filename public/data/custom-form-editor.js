import { FORM_TYPES, FORM_TYPE_LABELS, formClosed, formArray, formId, formFailure, isCustomFormDate, assertFormDefinition, assertFormAnswers, assertFormTemplateRecord,
  assertFormRecord, assertFormTemplateSnapshot, captureFormTemplate, visibleFormFields } from './custom-form-engine.js';
const own = (value, key) => Object.hasOwn(value, key);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const blank = field => field.type === 'multiselect' ? [] : '';
const baselineText = value => typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : value;
const error = (name, message) => formFailure(422, 'FORM_INPUT_INVALID', message, { [name]: message });
const recordBusiness = ['caseId', 'templateId', 'templateVersion', 'date', 'answers', 'attachmentIds', 'status', 'note'];
const templateBusiness = ['code', 'name', 'description', 'revision', 'previousTemplateId', 'groups', 'fields', 'status', 'note'];
export function confirmCustomFormSave(result, { entity, orgId, original, payload, snapshot } = {}) {
  if (!['form-templates', 'form-records'].includes(entity) || !formClosed(result, ['item'])) error('status', '保存回應格式未確認。');
  const item = result.item;
  (entity === 'form-templates' ? assertFormTemplateRecord : assertFormRecord)(item, orgId);
  if (original && (item.id !== original.id || item.version !== original.version + 1 || item.createdAt !== original.createdAt)) error('status', '保存識別碼或版次未確認，請保留輸入並重新讀取。');
  if (!original && item.version !== 1) error('status', '新增保存版次未確認，請保留輸入並重新讀取。');
  for (const key of entity === 'form-templates' ? templateBusiness : recordBusiness) {
    if (own(payload, key) && !same(item[key], payload[key]) || original && !own(payload, key) && !same(item[key], original[key])) error('status', '保存內容未確認，請保留輸入並重新讀取。');
  }
  if (snapshot && !same(snapshot, item.templateSnapshot) || original?.templateSnapshot && !same(original.templateSnapshot, item.templateSnapshot)) error('status', '模板保存快照未確認。');
  return item;
}
export function createCustomFormRecordEditor({ template, existing, caseId, attachments = [], date = '' }) {
  if (existing ? !formClosed(existing, [...recordBusiness, 'templateSnapshot', 'id', 'orgId', 'version', 'createdAt', 'updatedAt'])
    : !formClosed(template, [...templateBusiness, 'id', 'orgId', 'version', 'createdAt', 'updatedAt'])) error('answers', '保存表單或模板格式未確認。');
  const snapshot = existing ? assertFormTemplateSnapshot(existing.templateSnapshot, existing.orgId) : captureFormTemplate(template, template.orgId);
  if (existing) { assertFormRecord(existing, existing.orgId); if (existing.status !== 'draft') error('status', '已提交填答不可改寫。'); }
  if (!formId(caseId) || existing && caseId !== existing.caseId || !formArray(attachments, 10000)) error('caseId', '個案或附件選取資料無法確認。');
  const ids = new Set();
  for (const attachment of attachments) if (!attachment || !formClosed(attachment, Object.keys(attachment)) || !formId(attachment.id) || attachment.orgId !== snapshot.orgId || attachment.caseId !== caseId || attachment.status !== 'active' || typeof attachment.title !== 'string' || ids.has(attachment.id)) error('attachmentIds', '同個案有效附件清單無法確認。'); else ids.add(attachment.id);
  const original = existing ? structuredClone(existing.answers) : {}, cleared = new Set();
  const initial = { date: existing?.date || date, status: existing?.status || 'draft', note: baselineText(existing?.note || ''), attachmentIds: existing ? attachments.filter(item => existing.attachmentIds.includes(item.id)).map(item => item.id) : [] };
  const fields = [{ name: 'date', label: '填寫日期', type: 'date', required: true },
    { name: 'status', label: '保存方式', type: 'select', required: true, options: [{ value: 'draft', label: '儲存草稿' }, { value: 'submitted', label: '提交並鎖定填答' }] }];
  const groups = new Map(snapshot.groups.map(group => [group.id, group.label]));
  for (const field of snapshot.fields) {
    const name = 'answer_' + field.key, value = original[field.key];
    initial[name] = own(original, field.key) ? field.type === 'boolean' ? String(value) : field.type === 'multiselect' ? field.options.filter(option => value.includes(option.value)).map(option => option.value) : baselineText(value) : blank(field);
    const options = field.type === 'boolean' ? [{ value: 'true', label: '是' }, { value: 'false', label: '否' }] : field.options;
    fields.push({ name, label: `${groups.has(field.groupId) ? groups.get(field.groupId) + ' · ' : ''}${field.label}${field.required ? '（提交時必填）' : ''}`,
      type: field.type === 'number' ? 'text' : field.type === 'boolean' ? 'select' : field.type === 'multiselect' ? 'checkbox-group' : field.type,
      ...(field.type === 'number' ? { inputMode: 'decimal', maxLength: 29 } : {}), options,
      help: field.type === 'number' ? '保存原始十進位文字；不轉換分數、費用或官方量測判讀。' : field.visibleIf ? '依前面題項的明確相等條件顯示；改條件前會確認清除不適用答案。' : undefined,
      maxLength: field.type === 'textarea' ? 10000 : field.type === 'text' ? 500 : undefined });
  }
  fields.push({ name: 'attachmentIds', label: '引用既有個案附件', type: 'checkbox-group', options: attachments.map(item => ({ value: item.id, label: item.title })),
    help: '只引用此個案有效附件，不複製檔案。', wide: true }, { name: 'note', label: '填答備註', type: 'textarea', maxLength: 10000, wide: true });
  const controls = new Set(Object.keys(initial));
  function readAnswers(values) {
    const result = {};
    for (const field of snapshot.fields) {
      const name = 'answer_' + field.key, raw = values[name] ?? initial[name];
      if (own(original, field.key) && !cleared.has(field.key) && same(raw, initial[name])) { result[field.key] = structuredClone(original[field.key]); continue; }
      if (raw === '' || field.type === 'multiselect' && formArray(raw, 50) && !raw.length) continue;
      result[field.key] = field.type === 'boolean' ? raw === 'true' ? true : raw === 'false' ? false : raw : structuredClone(raw);
    }
    return result;
  }
  function visibility(values) { const answers = readAnswers(values); return visibleFormFields(snapshot.groups, snapshot.fields, answers); }
  function conditionalChange(previous, next) {
    const before = readAnswers(previous), visible = visibility(next);
    return snapshot.fields.filter(field => own(before, field.key) && !visible.has(field.key)).map(field => field.key);
  }
  function confirmClear(keys) { for (const key of keys) cleared.add(key); }
  function buildPayload(values) {
    if (!formClosed(values, [...controls])) error('answers', '表單包含未知或未確認的控制項。');
    const answers = readAnswers(values), visible = visibleFormFields(snapshot.groups, snapshot.fields, answers);
    for (const key of Object.keys(answers)) if (!visible.has(key)) error('answer_' + key, '請先確認清除不適用的答案，輸入仍保留。');
    if (!isCustomFormDate(values.date) || !['draft', 'submitted'].includes(values.status)) error('date', '請選擇有效日期與保存方式。');
    assertFormAnswers(snapshot.groups, snapshot.fields, answers, { submitted: values.status === 'submitted' }, (status, code, message, errors) => formFailure(status, code, message, Object.fromEntries(Object.entries(errors || {}).map(([key, value]) => [controls.has('answer_' + key) ? 'answer_' + key : key, value]))));
    if (!formArray(values.attachmentIds, 20) || new Set(values.attachmentIds).size !== values.attachmentIds.length || values.attachmentIds.some(id => !ids.has(id))) error('attachmentIds', '請重新核對同個案有效附件。');
    if (typeof values.note !== 'string' || values.note.length > 10000) error('note', '備註最多10000字。');
    const payload = { caseId, templateId: snapshot.id, templateVersion: snapshot.version, date: values.date, answers, attachmentIds: existing && same(values.attachmentIds, initial.attachmentIds) ? [...existing.attachmentIds] : [...values.attachmentIds], status: values.status,
      note: existing && values.note === initial.note ? existing.note : values.note };
    return existing ? Object.fromEntries(Object.entries(payload).filter(([key, value]) => !same(value, existing[key]))) : payload;
  }
  return { fields, initial, snapshot, buildPayload, visibility, conditionalChange, confirmClear, clearValue: key => blank(snapshot.fields.find(field => field.key === key)) };
}
export function customFormFieldEditor(template, original, index = template.fields.length) {
  const previous = template.fields.slice(0, index).filter(field => field.type !== 'multiselect');
  const initial = { key: original?.key || '', label: original?.label || '', type: original?.type || 'text', groupId: original?.groupId || '', required: original?.required || false,
    options: original?.options.map(option => `${option.value}｜${option.label}`).join('\n') || '', conditionField: original?.visibleIf?.field || '',
    conditionValue: typeof original?.visibleIf?.equals === 'boolean' ? '' : baselineText(original?.visibleIf?.equals || ''),
    conditionChoice: typeof original?.visibleIf?.equals === 'boolean' ? String(original.visibleIf.equals) : original?.visibleIf?.equals || '' };
  const fields = [{ name: 'key', label: '題項代碼', required: true, readOnly: !!original, maxLength: 50, help: '英文字母開頭，可加數字與底線；發布後不能修改。' },
    { name: 'label', label: '題項名稱', required: true, maxLength: 200 }, { name: 'type', label: '題項型別', type: 'select', required: true, options: FORM_TYPES.map(value => ({ value, label: FORM_TYPE_LABELS[value] })) },
    { name: 'groupId', label: '群組', type: 'select', options: template.groups.map(group => ({ value: group.id, label: group.label })) },
    { name: 'required', label: '提交時必填', type: 'checkbox' }, { name: 'options', label: '單選／多選選項', type: 'textarea', wide: true,
      help: '每行一個「代碼｜顯示名稱」，例如 yes｜同意；只用於單選與多選。' },
    { name: 'conditionField', label: '顯示條件的前序題項', type: 'select', options: previous.map(field => ({ value: field.key, label: field.label })), help: '留空代表一律顯示；只支援前序題項的單一相等條件。' },
    { name: 'conditionChoice', label: '相等選項', type: 'select', options: [], help: '選擇前序題項的單選結果或是／否。' },
    { name: 'conditionValue', label: '相等文字或日期', type: 'textarea', maxLength: 10000, help: '與前序題項的保存文字精確相同；數值文字會保留小數位。' }];
  function build(values) {
    if (Object.keys(values).some(key => !own(initial, key))) error('key', '題項含未知欄位。');
    let options = [];
    if (original && original.type === values.type && values.options === initial.options) options = structuredClone(original.options);
    else if (['select', 'multiselect'].includes(values.type)) options = values.options.split(/\r?\n/).filter(line => line.trim()).map(line => {
      const separator = line.indexOf('｜'); if (separator < 1) error('options', '每行請使用「代碼｜顯示名稱」。'); return { value: line.slice(0, separator).trim(), label: line.slice(separator + 1).trim() };
    });
    const controller = previous.find(field => field.key === values.conditionField);
    let equals = controller && ['boolean', 'select'].includes(controller.type) ? values.conditionChoice : values.conditionValue;
    if (controller?.type === 'boolean') { if (!['true', 'false'].includes(equals)) error('conditionChoice', '請選擇是／否相等值。'); equals = equals === 'true'; }
    if (controller && !['boolean', 'select'].includes(controller.type) && original?.visibleIf?.field === controller.key && values.conditionValue === initial.conditionValue) equals = original.visibleIf.equals;
    const field = { key: original?.key || values.key.trim(), label: values.label, type: values.type, groupId: values.groupId, required: values.required, options,
      visibleIf: values.conditionField ? { field: values.conditionField, equals } : null };
    const next = structuredClone(template.fields); if (original) next[index] = field; else next.push(field);
    assertFormDefinition(template.groups, next, (_status, _code, message) => error(message.includes('選項') ? 'options' : message.includes('條件') ? controller && ['boolean', 'select'].includes(controller.type) ? 'conditionChoice' : 'conditionValue' : 'key', message)); return next;
  }
  let conditionKey;
  function onChange(values, helpers) {
    const controller = previous.find(field => field.key === values.conditionField), choice = !!controller && ['boolean', 'select'].includes(controller.type);
    helpers.setHidden('options', !['select', 'multiselect'].includes(values.type));
    helpers.setHidden('conditionChoice', !choice); helpers.setHidden('conditionValue', !controller || choice);
    if (conditionKey !== values.conditionField) {
      conditionKey = values.conditionField;
      helpers.setOptions('conditionChoice', controller?.type === 'boolean' ? [{ value: 'true', label: '是' }, { value: 'false', label: '否' }] : controller?.type === 'select' ? controller.options : []);
      helpers.setValue('conditionChoice', initial.conditionField === conditionKey ? initial.conditionChoice : '');
    }
  }
  return { fields, initial, build, onChange };
}
