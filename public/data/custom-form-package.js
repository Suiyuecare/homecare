import { formClosed, assertFormDefinition, assertFormTemplateRecord } from './custom-form-engine.js';

export const CUSTOM_FORM_PACKAGE_FORMAT = 'suiyue-custom-form-template-package';
export const CUSTOM_FORM_PACKAGE_VERSION = 1;
export const CUSTOM_FORM_PACKAGE_MAX_BYTES = 4 * 1024 * 1024;
const definitionKeys = ['code', 'name', 'description', 'groups', 'fields', 'note'];
const invalid = message => { const error = new Error(message); error.code = 'CUSTOM_FORM_PACKAGE_INVALID'; error.fields = { file: message }; throw error; };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const cleanText = value => typeof value === 'string' && !value.includes('\0') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
function assertDefinition(value) {
  if (!formClosed(value, definitionKeys)) invalid('模板套件只能包含代碼、名稱、說明、群組、題項及備註；不能包含帳號、個案、填答或附件。');
  assertFormDefinition(value.groups, value.fields, (_status, _code, message) => invalid(message));
  assertFormTemplateRecord({ ...value, revision: 1, previousTemplateId: '', status: 'draft', id: 'package-definition', orgId: 'package-definition', version: 1,
    createdAt: 'package-definition', updatedAt: 'package-definition' }, 'package-definition', (_status, _code, message) => invalid(message));
  const strings = [value.code, value.name, value.description, value.note, ...value.groups.flatMap(group => [group.id, group.label]),
    ...value.fields.flatMap(field => [field.key, field.label, field.type, field.groupId, ...field.options.flatMap(option => [option.value, option.label]),
      ...(field.visibleIf ? [field.visibleIf.field, ...(typeof field.visibleIf.equals === 'string' ? [field.visibleIf.equals] : [])] : [])])];
  if (strings.some(value => !cleanText(value))) invalid('模板文字包含無法完整保存的控制字元或 Unicode；請先修正來源模板。');
  return value;
}
function definitionCopy(value) {
  assertDefinition(value);
  return { code: value.code, name: value.name, description: value.description,
    groups: value.groups.map(group => ({ id: group.id, label: group.label })),
    fields: value.fields.map(field => ({ key: field.key, label: field.label, type: field.type, groupId: field.groupId, required: field.required,
      options: field.options.map(option => ({ value: option.value, label: option.label })), visibleIf: field.visibleIf === null ? null : { field: field.visibleIf.field, equals: field.visibleIf.equals } })),
    note: value.note };
}
function packageBody(definition) { return { format: CUSTOM_FORM_PACKAGE_FORMAT, version: CUSTOM_FORM_PACKAGE_VERSION, definition: definitionCopy(definition) }; }
async function hash(body) {
  if (!globalThis.crypto?.subtle?.digest) invalid('目前瀏覽器不能核對模板檔案，請改用支援安全連線的瀏覽器。');
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  if (bytes.byteLength > CUSTOM_FORM_PACKAGE_MAX_BYTES) invalid('模板套件超過 4 MiB，請縮小題項定義。');
  return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
}
export async function createCustomFormPackage(template, orgId) {
  assertFormTemplateRecord(template, orgId);
  const definition = Object.fromEntries(definitionKeys.map(key => [key, template[key]]));
  const body = packageBody(definition), sha256 = await hash(body);
  return freeze({ ...body, sha256 });
}
// Detect duplicate keys before they can be overwritten by JSON.parse, including
// escaped spellings of the same key. Only JSON values are read; no evaluator.
function parseUniqueJson(text) {
  let index = 0, nodes = 0;
  const space = () => { while (/[\t\n\r ]/.test(text[index] || '\0')) index++; };
  const string = () => {
    const start = index++; let escaped = false;
    while (index < text.length) {
      const char = text[index++];
      if (!escaped && char === '"') { try { return JSON.parse(text.slice(start, index)); } catch { invalid('模板檔案不是有效的 JSON 文字。'); } }
      if (!escaped && char === '\\') escaped = true; else escaped = false;
    }
    invalid('模板檔案不是完整的 JSON 文字。');
  };
  const value = depth => {
    if (++nodes > 40000 || depth > 16) invalid('模板檔案的巢狀結構或項目數超過限制。');
    space(); const char = text[index];
    if (char === '"') return string();
    if (char === '{') {
      index++; space(); const result = {}, keys = new Set(); if (text[index] === '}') { index++; return result; }
      for (;;) {
        space(); if (text[index] !== '"') invalid('模板 JSON 欄位名稱必須為文字。'); const key = string();
        if (keys.has(key)) invalid('模板 JSON 含重複欄位，尚未匯入。'); keys.add(key);
        space(); if (text[index++] !== ':') invalid('模板檔案不是有效的 JSON 物件。');
        Object.defineProperty(result, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        space(); const next = text[index++]; if (next === '}') return result; if (next !== ',') invalid('模板檔案不是完整的 JSON 物件。');
      }
    }
    if (char === '[') {
      index++; space(); const result = []; if (text[index] === ']') { index++; return result; }
      for (;;) { result.push(value(depth + 1)); space(); const next = text[index++]; if (next === ']') return result; if (next !== ',') invalid('模板檔案不是完整的 JSON 清單。'); }
    }
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]]) if (text.startsWith(literal, index)) { index += literal.length; return parsed; }
    const number = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!number) invalid('模板檔案不是有效的 JSON 內容。'); index += number[0].length; return Number(number[0]);
  };
  const result = value(0); space(); if (index !== text.length) invalid('模板 JSON 後面包含其他內容。'); return result;
}
export async function readCustomFormPackage(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > CUSTOM_FORM_PACKAGE_MAX_BYTES) invalid('請選擇非空白、4 MiB 以內的模板套件。');
  let text; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { invalid('模板檔案不是完整的 UTF-8 文字，尚未匯入。'); }
  if (!cleanText(text)) invalid('模板檔案含無法完整保存的控制字元或 Unicode。');
  const parsed = parseUniqueJson(text);
  if (!formClosed(parsed, ['format', 'version', 'definition', 'sha256']) || parsed.format !== CUSTOM_FORM_PACKAGE_FORMAT || parsed.version !== CUSTOM_FORM_PACKAGE_VERSION
      || typeof parsed.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.sha256)) invalid('模板套件格式、版次或完整性碼無法確認。');
  const body = packageBody(parsed.definition), sha256 = await hash(body);
  if (sha256 !== parsed.sha256) invalid('模板檔案的內容與完整性碼不符；請重新取得完整檔案。');
  return freeze({ ...body, sha256 });
}
export function customFormPackageDraft(packageValue, choice) {
  if (!formClosed(packageValue, ['format', 'version', 'definition', 'sha256']) || packageValue.format !== CUSTOM_FORM_PACKAGE_FORMAT || packageValue.version !== CUSTOM_FORM_PACKAGE_VERSION
      || typeof packageValue.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(packageValue.sha256) || !formClosed(choice, ['code', 'name'])) invalid('請重新核對模板套件與新模板名稱。');
  const definition = definitionCopy(packageValue.definition);
  if (!cleanText(choice.code) || /[\r\n]/.test(choice.code) || !cleanText(choice.name)) invalid('請填寫單行新模板代碼與名稱。');
  const code = choice.code.trim(), name = choice.name.trim();
  if (!code || code === definition.code || code.length > 100 || /[\r\n]/.test(code) || !name || name.length > 200) invalid('請明確填寫不同於來源的新模板代碼與名稱；不會覆寫原模板。');
  const draft = { ...definition, code, name, revision: 1, previousTemplateId: '', status: 'draft' };
  assertDefinition(Object.fromEntries(definitionKeys.map(key => [key, draft[key]]))); return freeze(draft);
}
