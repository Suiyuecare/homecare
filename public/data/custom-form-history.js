import { assertFormTemplateRecord, assertFormRecord, assertFormTemplateSnapshot, visibleFormFields, customFormValueText } from './custom-form-engine.js';

const types = { text: '短文字', textarea: '多行文字', number: '十進位文字', date: '日期', select: '單選', multiselect: '多選', boolean: '是／否' };
const descriptorValue = (value, key) => { const d=Object.getOwnPropertyDescriptor(value,key); return d && Object.hasOwn(d,'value') ? d.value : undefined; };
function definition(snapshot) {
  const groups=snapshot.groups.map(group=>({id:group.id,label:group.label})), labels=new Map(groups.map(group=>[group.id,group.label]));
  return { groups, fields: snapshot.fields.map(field=>({ key:field.key,label:field.label,type:types[field.type],group:labels.get(field.groupId)||'未分組',required:field.required?'提交時必填':'選填',
    options:field.options.map(option=>`${option.label}（${option.value}）`).join('、')||'不適用',
    condition:field.visibleIf===null?'持續顯示':`${field.visibleIf.field} 等於 ${typeof field.visibleIf.equals==='boolean'?(field.visibleIf.equals?'是':'否'):field.visibleIf.equals}` })) };
}
export function customFormHistoryProjection(entity, snapshot) {
  try {
    if(!snapshot || typeof snapshot!=='object' || Array.isArray(snapshot))return null;
    const orgId=descriptorValue(snapshot,'orgId');
    if(entity==='form-templates') {
      assertFormTemplateRecord(snapshot,orgId);
      return definition(snapshot);
    }
    if(entity!=='form-records')return null;
    assertFormRecord(snapshot,orgId);
    const source=assertFormTemplateSnapshot(snapshot.templateSnapshot,orgId), schema=definition(source), visible=visibleFormFields(source.groups,source.fields,snapshot.answers);
    return { template:{ metadata:[['id','保存模板識別碼'],['version','保存模板SQL版次'],['code','保存模板代碼'],['name','保存模板名稱'],['revision','保存模板修訂序號'],['description','保存模板說明']].map(([key,label])=>({label,value:source[key]})),...schema },
      answers:source.fields.filter(field=>visible.has(field.key)).map(field=>({key:field.key,label:field.label,group:source.groups.find(group=>group.id===field.groupId)?.label||'未分組',type:types[field.type],value:customFormValueText(field,snapshot.answers[field.key])})),
      attachmentIds:snapshot.attachmentIds.map(id=>({id})) };
  } catch { return null; }
}
