import { formClosed, formArray, formFailure, assertFormDefinition, assertFormAnswers, assertFormTemplateSnapshot } from './custom-form-engine.js';

export const SURVEY_MODE = 'local-approved-custom-survey-v1';
export const SURVEY_NOTICE = '本機匿名自訂填答；只保存原始答案，不計分，也不代表官方滿意度或評鑑認定。請勿填入姓名、電話、身分證或個案資料。';
export const SURVEY_SCHEMA_BYTES = 262144;
export const SURVEY_BODY_BYTES = 2097152;
export const SURVEY_INVITATION_KEYS = Object.freeze(['templateId','templateVersion','templateSnapshot','publicSnapshot','publicFieldKeys','tokenHash','formHash','expiresAt','maxResponses','approvalReference','approvedPublicQuestions','status','disabledAt','disableReason']);
export const SURVEY_RESPONSE_KEYS = Object.freeze(['invitationId','templateId','templateVersion','formHash','publicSnapshot','answers','nonceHash','payloadHash','status']);
export const SURVEY_META_KEYS = Object.freeze(['id','orgId','version','createdAt','updatedAt']);
export const SURVEY_PREVIEW_KEYS = Object.freeze(['templateId','templateVersion','publicTitle','publicFieldKeys','expiresAt','maxResponses','approvalReference','approvedPublicQuestions']);
export const surveyId = v => typeof v === 'string' && v.length > 0 && v.length <= 500 && v === v.trim() && !/[\x00\r\n]/.test(v);
export const surveyPositive = v => Number.isSafeInteger(v) && v > 0;
export const surveyHash = v => typeof v === 'string' && v.length === 64 && /^[a-f0-9]{64}$/.test(v);
export const surveySecret = v => typeof v === 'string' && v.length === 43 && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(v);
export const surveyTimestamp = v => typeof v === 'string' && v.length === 24 && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(v) && v.slice(0,4) !== '0000' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const text = (v,max,required=false,single=false) => typeof v==='string' && v.length<=max && (!required || !!v.trim()) && (!single || !/[\x00\r\n]/.test(v));
const failure = (fail, message='填答資料格式無法確認。') => fail(422,'SURVEY_INVALID',message);
export function surveyCanonical(value) {
  if (Array.isArray(value)) return '['+value.map(surveyCanonical).join(',')+']';
  if (value && typeof value === 'object') return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+surveyCanonical(value[key])).join(',')+'}';
  return JSON.stringify(value);
}
export const surveySame = (a,b) => surveyCanonical(a)===surveyCanonical(b);
export function assertSurveySnapshot(snapshot, fail=formFailure) {
  if (!formClosed(snapshot,['title','groups','fields']) || !text(snapshot.title,200,true,true)) failure(fail);
  assertFormDefinition(snapshot.groups,snapshot.fields,fail);
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength>SURVEY_SCHEMA_BYTES) failure(fail,'公開題目超過本機保存上限。');
  return snapshot;
}
export function capturePublicSurvey(template, title, keys, fail=formFailure) {
  assertFormTemplateSnapshot(template,template.orgId,fail);
  if (!text(title,200,true,true) || !formArray(keys,50) || !keys.length || new Set(keys).size!==keys.length || !keys.every(key=>typeof key==='string' && template.fields.some(field=>field.key===key))) failure(fail,'請核對明確批准的公開題項。');
  const selected=new Set(keys), fields=template.fields.filter(field=>selected.has(field.key));
  if (!surveySame(fields.map(field=>field.key),keys)) failure(fail,'公開題項須保持原模板順序。');
  if (fields.some(field=>field.visibleIf && !selected.has(field.visibleIf.field))) failure(fail,'條件題項的前序控制欄也須明確批准公開。');
  const groupIds=new Set(fields.map(field=>field.groupId).filter(Boolean));
  return assertSurveySnapshot(structuredClone({title,groups:template.groups.filter(group=>groupIds.has(group.id)),fields}),fail);
}
export function assertSurveyPreviewPayload(payload, {create=false}={}, fail=formFailure) {
  if (!formClosed(payload,[...SURVEY_PREVIEW_KEYS,...(create?['previewHash']:[])]) || !surveyId(payload.templateId) || !surveyPositive(payload.templateVersion) || !text(payload.publicTitle,200,true,true) || !surveyTimestamp(payload.expiresAt) || !Number.isSafeInteger(payload.maxResponses) || payload.maxResponses<1 || payload.maxResponses>1000 || !text(payload.approvalReference,1000,true,true) || payload.approvedPublicQuestions!==true || create&&!surveyHash(payload.previewHash)) failure(fail,'請核對模板保存版次、公開題目批准、到期時間與容量。');
  if (!formArray(payload.publicFieldKeys,50) || !payload.publicFieldKeys.length || !payload.publicFieldKeys.every(key=>typeof key==='string' && key.length<=50 && !/[\x00\r\n]/.test(key)) || new Set(payload.publicFieldKeys).size!==payload.publicFieldKeys.length) failure(fail);
  return payload;
}
function metadata(item,orgId,fail) {
  if (!surveyId(item.id) || !surveyId(item.orgId) || orgId!==undefined && item.orgId!==orgId || !surveyPositive(item.version) || !surveyTimestamp(item.createdAt) || !surveyTimestamp(item.updatedAt) || item.updatedAt<item.createdAt) failure(fail);
}
export function assertSurveyInvitation(item,orgId,fail=formFailure) {
  if (!formClosed(item,[...SURVEY_INVITATION_KEYS,...SURVEY_META_KEYS])) failure(fail);
  metadata(item,orgId,fail);
  if (!surveyId(item.templateId) || !surveyPositive(item.templateVersion) || !surveyHash(item.tokenHash) || !surveyHash(item.formHash) || !surveyTimestamp(item.expiresAt) || !Number.isSafeInteger(item.maxResponses) || item.maxResponses<1 || item.maxResponses>1000 || !text(item.approvalReference,1000,true,true) || item.approvedPublicQuestions!==true || !['active','disabled'].includes(item.status) || item.status==='active'&&item.version!==1 || item.status==='disabled'&&item.version!==2) failure(fail);
  assertFormTemplateSnapshot(item.templateSnapshot,item.orgId,fail);
  assertSurveySnapshot(item.publicSnapshot,fail);
  if (item.templateSnapshot.id!==item.templateId || item.templateSnapshot.version!==item.templateVersion || !surveySame(capturePublicSurvey(item.templateSnapshot,item.publicSnapshot.title,item.publicFieldKeys,fail),item.publicSnapshot)) failure(fail);
  if (item.status==='active' ? item.disabledAt!=='' || item.disableReason!=='' : !surveyTimestamp(item.disabledAt) || item.disabledAt<item.createdAt || !text(item.disableReason,1000,true,true)) failure(fail);
  return item;
}
export function assertSurveyResponse(item,orgId,fail=formFailure) {
  if (!formClosed(item,[...SURVEY_RESPONSE_KEYS,...SURVEY_META_KEYS])) failure(fail);
  metadata(item,orgId,fail);
  if (!surveyId(item.invitationId) || !surveyId(item.templateId) || !surveyPositive(item.templateVersion) || !surveyHash(item.formHash) || !surveyHash(item.nonceHash) || !surveyHash(item.payloadHash) || item.status!=='submitted' || item.version!==1) failure(fail);
  assertSurveySnapshot(item.publicSnapshot,fail);
  assertFormAnswers(item.publicSnapshot.groups,item.publicSnapshot.fields,item.answers,{submitted:true},fail);
  return item;
}
export function assertPublicSurveyOpen(payload,fail=formFailure) {
  if (!formClosed(payload,['token']) || !surveySecret(payload.token)) failure(fail);
}
export function assertPublicSurveySubmit(payload,fail=formFailure) {
  if (!formClosed(payload,['token','nonce','formHash','answers']) || !surveySecret(payload.token) || !surveySecret(payload.nonce) || !surveyHash(payload.formHash)) failure(fail);
}
export function assertPublicSurveyDto(value,fail=formFailure) {
  if (!formClosed(value,['mode','formHash','title','groups','fields','notice']) || value.mode!==SURVEY_MODE || !surveyHash(value.formHash) || value.notice!==SURVEY_NOTICE) failure(fail);
  assertSurveySnapshot({title:value.title,groups:value.groups,fields:value.fields},fail); return value;
}
export function surveyQuery(params,{mode='list'}={},fail=formFailure) {
  const allowed=mode==='single'?[]:mode==='history'?['page','pageSize','compare']:mode==='responses'?['page','pageSize']:['page','pageSize','status'];
  for(const key of params.keys()) if(!allowed.includes(key)||params.getAll(key).length!==1) failure(fail,'查詢參數不合法或重複。');
  const integer=(key,fallback,max)=>{const raw=params.get(key)??String(fallback),number=Number(raw);if(!/^[1-9][0-9]*$/.test(raw)||/[\r\n]/.test(raw)||!Number.isSafeInteger(number)||number>max)failure(fail,'分頁參數不合法。');return number;};
  if(mode==='single')return {};
  const query={page:integer('page',1,Math.floor(Number.MAX_SAFE_INTEGER/100)),pageSize:integer('pageSize',25,100)};
  if(params.has('status')&&!['active','disabled'].includes(params.get('status')))failure(fail);
  if(params.has('compare')&&params.get('compare')!=='previous')failure(fail);
  if(mode==='list')query.status=params.get('status')||'';
  if(mode==='history')query.compare=params.get('compare')||'';
  return query;
}

export const SURVEY_INVITATION_DTO_KEYS=Object.freeze([...SURVEY_META_KEYS,'templateId','templateVersion','publicSnapshot','publicFieldKeys','formHash','expiresAt','maxResponses','status','disabledAt']);
export const SURVEY_RESPONSE_DTO_KEYS=Object.freeze([...SURVEY_META_KEYS,'invitationId','formHash','publicSnapshot','answers','status']);
export function assertSurveyInvitationDto(item,orgId,{mode='list'}={},fail=formFailure) {
 const extras=mode==='detail'?['responseCount','approvalReference','disableReason']:mode==='list'?['responseCount']:[];
 if(!['list','detail','history','parent'].includes(mode)||!formClosed(item,[...SURVEY_INVITATION_DTO_KEYS,...extras]))failure(fail);
 metadata(item,orgId,fail);assertSurveySnapshot(item.publicSnapshot,fail);
 if(!surveyId(item.templateId)||!surveyPositive(item.templateVersion)||!surveyHash(item.formHash)||!surveyTimestamp(item.expiresAt)||!Number.isSafeInteger(item.maxResponses)||item.maxResponses<1||item.maxResponses>1000||!formArray(item.publicFieldKeys,50)||!surveySame(item.publicFieldKeys,item.publicSnapshot.fields.map(field=>field.key))||!['active','disabled'].includes(item.status)||item.status==='active'&&(item.version!==1||item.disabledAt!=='')||item.status==='disabled'&&(item.version!==2||!surveyTimestamp(item.disabledAt)||item.disabledAt<item.createdAt))failure(fail);
 if(extras.includes('responseCount')&&(!Number.isSafeInteger(item.responseCount)||item.responseCount<0||item.responseCount>item.maxResponses))failure(fail);
 if(mode==='detail'&&(!text(item.approvalReference,1000,true,true)||!text(item.disableReason,1000,item.status==='disabled',true)||item.status==='active'&&item.disableReason!==''))failure(fail);
 return item;
}
export function assertSurveyResponseDto(item,orgId,invitation,fail=formFailure) {
 if(!formClosed(item,SURVEY_RESPONSE_DTO_KEYS))failure(fail);metadata(item,orgId,fail);assertSurveySnapshot(item.publicSnapshot,fail);
 if(item.version!==1||item.status!=='submitted'||!surveyId(item.invitationId)||!surveyHash(item.formHash)||invitation&&(item.invitationId!==invitation.id||item.formHash!==invitation.formHash||!surveySame(item.publicSnapshot,invitation.publicSnapshot)))failure(fail);
 assertFormAnswers(item.publicSnapshot.groups,item.publicSnapshot.fields,item.answers,{submitted:true},fail);return item;
}
export function assertSurveyPreviewDto(value,templateId,templateVersion,fail=formFailure) {
 if(!formClosed(value,['mode','templateId','templateVersion','publicSnapshot','expiresAt','maxResponses','previewHash'])||value.mode!==SURVEY_MODE||!surveyId(value.templateId)||!surveyPositive(value.templateVersion)||templateId!==undefined&&value.templateId!==templateId||templateVersion!==undefined&&value.templateVersion!==templateVersion||!surveyTimestamp(value.expiresAt)||!Number.isSafeInteger(value.maxResponses)||value.maxResponses<1||value.maxResponses>1000||!surveyHash(value.previewHash))failure(fail);
 assertSurveySnapshot(value.publicSnapshot,fail);return value;
}
