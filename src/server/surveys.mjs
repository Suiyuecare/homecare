import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { formClosed, formFailure, assertFormTemplateRecord, captureFormTemplate, assertFormAnswers } from '../../public/data/custom-form-engine.js';
import { SURVEY_MODE, SURVEY_NOTICE, SURVEY_INVITATION_KEYS, SURVEY_RESPONSE_KEYS, SURVEY_META_KEYS, assertSurveyInvitation, assertSurveyResponse, assertSurveyPreviewPayload, assertPublicSurveyOpen, assertPublicSurveySubmit, capturePublicSurvey, surveyId, surveyPositive, surveyHash, surveyTimestamp, surveySecret, surveyCanonical, surveySame, surveyQuery, assertSurveyInvitationDto } from '../../public/data/survey-core.js';

export { SURVEY_MODE, surveyQuery };
export const surveyEntities={
 'survey-invitations':{fields:SURVEY_INVITATION_KEYS.join(' '),required:['templateId','templateVersion','publicSnapshot','tokenHash','formHash','expiresAt','maxResponses','approvalReference'],statuses:['active','disabled'],defaults:{},jsonFields:['templateSnapshot','publicSnapshot','publicFieldKeys','approvedPublicQuestions'],integerFields:['templateVersion','maxResponses']},
 'survey-responses':{fields:SURVEY_RESPONSE_KEYS.join(' '),required:['invitationId','templateId','templateVersion','formHash','publicSnapshot','answers','nonceHash','payloadHash'],statuses:['submitted'],defaults:{},jsonFields:['publicSnapshot','answers'],integerFields:['templateVersion'],maxAnswersLength:600000}
};
export const isSurveyEntity=entity=>Object.hasOwn(surveyEntities,entity);
export const surveyDigest=value=>createHash('sha256').update(value).digest('hex');
const hash=value=>surveyDigest(surveyCanonical(value));
const invalid=fail=>()=>fail(409,'SURVEY_DATA_INVALID','本機填答保存資料無法完整確認。');
const unavailable=fail=>()=>fail(404,'SURVEY_UNAVAILABLE','此本機填答連結目前無法使用。');
const stamp=deps=>deps?.now?.()??new Date().toISOString();
const defaultFail=formFailure;
function sqlStatement(db,sql) {
 // node:sqlite TEXT reads may stop at a literal NUL; hex proves and reconstructs every persisted byte.
 const columns=sql.startsWith('SELECT * FROM records ')?['id','org_id','entity','data','created_at','updated_at']:sql.startsWith('SELECT * FROM record_versions ')?['org_id','entity','record_id','snapshot','created_at','source']:[];
 const projected=columns.length?sql.replace('SELECT *', 'SELECT *,'+columns.map((column,index)=>`hex(CAST(${column} AS BLOB)) AS survey_hex_${index}`).join(',')):sql;
 const statement=db.prepare(projected);statement.setReadBigInts(true);
 const decode=row=>{if(!row)return row;const value={...row};for(const [index,column] of columns.entries()){const hex=value['survey_hex_'+index];delete value['survey_hex_'+index];try{value[column]=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(hex,'hex'));}catch{value[column]=undefined;}}return value;};
 return {all:(...args)=>statement.all(...args).map(decode),get:(...args)=>decode(statement.get(...args))};
}
const sqlRows=(db,sql,args)=>sqlStatement(db,sql).all(...args);
const sqlGet=(db,sql,args)=>sqlStatement(db,sql).get(...args);
const safeVersion=value=>typeof value==='bigint'&&value>0n&&value<=BigInt(Number.MAX_SAFE_INTEGER);
const meta=item=>Object.fromEntries(SURVEY_META_KEYS.map(key=>[key,item[key]]));
const business=item=>Object.fromEntries(Object.entries(item).filter(([key])=>!SURVEY_META_KEYS.includes(key)));
function safeJson(value,bad) {if(typeof value!=='string')bad();try{return JSON.parse(value);}catch{bad();}}
function knownHistorySource(value){return typeof value==='string'&&['create','update','baseline'].includes(value);}
/** This reader never repairs data. SQL version and immutable head must match the exact closed current item. */
function readRow(db,entity,row,assert,bad) {
 if(!row||!surveyId(row.id)||!surveyId(row.org_id)||row.entity!==entity||!safeVersion(row.version)||typeof row.created_at!=='string'||typeof row.updated_at!=='string')bad();
 const data=safeJson(row.data,bad),known=entity==='form-templates'?['code','name','description','revision','previousTemplateId','groups','fields','status','note']:entity==='survey-invitations'?SURVEY_INVITATION_KEYS:SURVEY_RESPONSE_KEYS;
 if(!formClosed(data,known))bad();
 const item={...data,id:row.id,orgId:row.org_id,version:Number(row.version),createdAt:row.created_at,updatedAt:row.updated_at};
 assert(item,row.org_id,bad);
 const head=sqlGet(db,'SELECT * FROM record_versions WHERE org_id=? AND entity=? AND record_id=? AND version=?',[row.org_id,entity,row.id,row.version]);
 if(!head||head.version!==row.version||head.record_id!==row.id||head.org_id!==row.org_id||head.entity!==entity||head.created_at!==item.updatedAt||!knownHistorySource(head.source))bad();
 const saved=safeJson(head.snapshot,bad);assert(saved,row.org_id,bad);if(!surveySame(item,saved))bad();return item;
}
function closedTemplate(db,orgId,id,bad) {
 const row=sqlGet(db,'SELECT * FROM records WHERE org_id=? AND entity=? AND id=?',[orgId,'form-templates',id]);
 return readRow(db,'form-templates',row,assertFormTemplateRecord,bad);
}
function templateLineage(db,template,bad,seen=new Set()) {
 if(seen.has(template.id))bad();seen.add(template.id);
 if(template.previousTemplateId){const previous=closedTemplate(db,template.orgId,template.previousTemplateId,bad);if(previous.code!==template.code||previous.revision+1!==template.revision||!['published','inactive'].includes(previous.status))bad();templateLineage(db,previous,bad,seen);}
}
function publishedProof(db,orgId,id,version,bad,{current=false}={}) {
 if(!surveyId(orgId)||!surveyId(id)||!surveyPositive(version))bad();
 const item=closedTemplate(db,orgId,id,bad);templateLineage(db,item,bad);
 if(current&&(item.status!=='published'||item.version!==version))bad();
 const versionRow=sqlGet(db,'SELECT * FROM record_versions WHERE org_id=? AND entity=? AND record_id=? AND version=?',[orgId,'form-templates',id,version]);
 if(!versionRow||versionRow.version!==BigInt(version)||versionRow.org_id!==orgId||versionRow.entity!=='form-templates'||versionRow.record_id!==id||!knownHistorySource(versionRow.source))bad();
 const saved=safeJson(versionRow.snapshot,bad);assertFormTemplateRecord(saved,orgId,bad);
 if(saved.id!==id||saved.version!==version||saved.status!=='published'||versionRow.created_at!==saved.updatedAt||saved.code!==item.code||saved.revision!==item.revision||saved.previousTemplateId!==item.previousTemplateId)bad();
 if(!['published','inactive'].includes(item.status)||item.status==='inactive'&&item.version!==version+1||['code','name','description','revision','previousTemplateId','groups','fields','note','createdAt'].some(key=>!surveySame(item[key],saved[key])))bad();
 return captureFormTemplate(saved,orgId,bad);
}
function invitationProof(db,item,bad,{current=false}={}) {
 assertSurveyInvitation(item,item.orgId,bad);
 if(hash(item.publicSnapshot)!==item.formHash||!surveySame(item.templateSnapshot,publishedProof(db,item.orgId,item.templateId,item.templateVersion,bad,{current})))bad();
 return item;
}
function responseProof(item,invitation,bad) {
 assertSurveyResponse(item,invitation.orgId,bad);
 if(item.invitationId!==invitation.id||item.templateId!==invitation.templateId||item.templateVersion!==invitation.templateVersion||item.formHash!==invitation.formHash||!surveySame(item.publicSnapshot,invitation.publicSnapshot)||hash({formHash:item.formHash,answers:item.answers})!==item.payloadHash)bad();return item;
}
function invitationRows(db,orgId,bad) {
 const all=sqlRows(db,'SELECT * FROM records WHERE org_id=? AND entity=? ORDER BY created_at DESC,id',[orgId,'survey-invitations']);
 if(all.length>1000)bad();
 return all.map(row=>invitationProof(db,readRow(db,'survey-invitations',row,assertSurveyInvitation,bad),bad));
}
function responseRows(db,invitation,bad) {
 // Validate every org response before filtering. Malformed JSON cannot be silently skipped and free capacity.
 const all=sqlRows(db,'SELECT * FROM records WHERE org_id=? AND entity=? ORDER BY created_at DESC,id',[invitation.orgId,'survey-responses']);
 const rows=all.map(row=>readRow(db,'survey-responses',row,assertSurveyResponse,bad));
 const selected=rows.filter(item=>item.invitationId===invitation.id).map(item=>responseProof(item,invitation,bad));
 if(selected.length>invitation.maxResponses||new Set(selected.map(item=>item.nonceHash)).size!==selected.length)bad();return selected;
}
export function guardSurveyManager(db,ctx,fail=defaultFail) {
 if(!ctx||!surveyId(ctx.orgId)||!surveyId(ctx.user?.id)||!['admin','supervisor'].includes(ctx.role))fail(403,'ROLE_FORBIDDEN','只有本機構管理者與督導可維護本機填答。');
 const membership=db.prepare('SELECT m.role FROM memberships m JOIN users u ON u.id=m.user_id JOIN organizations o ON o.id=m.org_id WHERE m.org_id=? AND m.user_id=?').get(ctx.orgId,ctx.user.id);
 if(!membership||membership.role!==ctx.role||!['admin','supervisor'].includes(membership.role))fail(403,'ROLE_FORBIDDEN','本機構維護權限已失效。');
}
export function guardSurveyAccess(entity,ctx,_readOnly,fail=defaultFail) {
 if(isSurveyEntity(entity)&&!['admin','supervisor'].includes(ctx?.role))fail(403,'ROLE_FORBIDDEN','只有管理者與督導可讀取本機填答。');
}
export function lockSurveyGenericWrite(entity,fail=defaultFail) {if(isSurveyEntity(entity))fail(409,'SURVEY_WORKFLOW_REQUIRED','請使用本機填答開通、停用或匿名提交流程。');}
export function readSurveyInvitation(db,orgId,id,fail=defaultFail) {
 if(!surveyId(orgId)||!surveyId(id))fail(404,'NOT_FOUND','找不到本機構填答開通紀錄。');
 const row=sqlGet(db,'SELECT * FROM records WHERE org_id=? AND entity=? AND id=?',[orgId,'survey-invitations',id]);
 if(!row)fail(404,'NOT_FOUND','找不到本機構填答開通紀錄。');
 const bad=invalid(fail);return invitationProof(db,readRow(db,'survey-invitations',row,assertSurveyInvitation,bad),bad);
}
function publicInvitation(item,count,{detail=false,history=false}={}) {
 const common={...meta(item),templateId:item.templateId,templateVersion:item.templateVersion,publicSnapshot:structuredClone(item.publicSnapshot),publicFieldKeys:[...item.publicFieldKeys],formHash:item.formHash,expiresAt:item.expiresAt,maxResponses:item.maxResponses,status:item.status,disabledAt:item.disabledAt};
 if(count!==undefined)common.responseCount=count;
 if(detail&&!history){common.approvalReference=item.approvalReference;common.disableReason=item.disableReason;}
 return common;
}
const page=(items,query)=>({items:items.slice((query.page-1)*query.pageSize,query.page*query.pageSize),total:items.length,page:query.page,pageSize:query.pageSize});
export function previewSurveyInvitation(db,ctx,payload,deps={}) {
 const fail=deps.fail??defaultFail;guardSurveyManager(db,ctx,fail);assertSurveyPreviewPayload(payload,{},fail);
 const time=stamp(deps);if(!surveyTimestamp(time)||payload.expiresAt<=time)fail(422,'SURVEY_EXPIRY','到期時間須晚於本次操作時間。');
 const snapshot=publishedProof(db,ctx.orgId,payload.templateId,payload.templateVersion,invalid(fail),{current:true});
 const publicSnapshot=capturePublicSurvey(snapshot,payload.publicTitle,payload.publicFieldKeys,fail);
 const preview={mode:SURVEY_MODE,templateId:payload.templateId,templateVersion:payload.templateVersion,publicSnapshot,expiresAt:payload.expiresAt,maxResponses:payload.maxResponses};
 return {...preview,previewHash:hash({...preview,approvalReference:payload.approvalReference,approvedPublicQuestions:true})};
}
/** Call inside root mandatory-idempotency transaction. The raw token is emitted to a closure only after save/audit; never return it as cached JSON. */
export function createSurveyInvitation(db,ctx,payload,deps) {
 const fail=deps.fail??defaultFail;guardSurveyManager(db,ctx,fail);assertSurveyPreviewPayload(payload,{create:true},fail);
 const {previewHash,...reviewed}=payload,preview=previewSurveyInvitation(db,ctx,reviewed,deps);
 if(preview.previewHash!==previewHash)fail(409,'SURVEY_PREVIEW_CHANGED','模板或公開核對內容已變更，請重新預覽。');
 const existing=invitationRows(db,ctx.orgId,invalid(fail));if(existing.length>=1000)fail(409,'SURVEY_LIMIT','本機構開通紀錄已達本機保存上限。');
 if(typeof deps.onIssuedToken!=='function'||typeof deps.insert!=='function'||typeof deps.audit!=='function')throw new TypeError('Survey write callbacks required');
 const bytes=(deps.randomBytes??randomBytes)(32);if(!Buffer.isBuffer(bytes)||bytes.length!==32)throw new TypeError('Survey token entropy requires 32 bytes');
 const token=bytes.toString('base64url');if(!surveySecret(token))throw new Error('Invalid token encoding');
 const tokenHash=surveyDigest(token);if(sqlRows(db,"SELECT id FROM records WHERE entity=? AND CASE WHEN json_valid(data) THEN json_extract(data,'$.tokenHash') END=?",['survey-invitations',tokenHash]).length)fail(409,'SURVEY_TOKEN_COLLISION','請重新開通本機填答。');
 const templateSnapshot=publishedProof(db,ctx.orgId,payload.templateId,payload.templateVersion,invalid(fail),{current:true});
 const item=deps.insert(db,ctx.orgId,'survey-invitations',{templateId:payload.templateId,templateVersion:payload.templateVersion,templateSnapshot,publicSnapshot:preview.publicSnapshot,publicFieldKeys:[...payload.publicFieldKeys],tokenHash,formHash:hash(preview.publicSnapshot),expiresAt:payload.expiresAt,maxResponses:payload.maxResponses,approvalReference:payload.approvalReference,approvedPublicQuestions:true,status:'active',disabledAt:'',disableReason:''});
 assertSurveyInvitation(item,ctx.orgId,invalid(fail));
 deps.audit(db,ctx,'survey-invitation-approved','survey-invitations',item.id,{templateId:item.templateId,templateVersion:item.templateVersion,fieldKeys:[...item.publicFieldKeys],publicTitle:item.publicSnapshot.title,expiresAt:item.expiresAt,maxResponses:item.maxResponses});
 deps.onIssuedToken(token);return {item:publicInvitation(item,0,{detail:true})};
}
export function surveyManagerPreflight(db,ctx,deps={}) {guardSurveyManager(db,ctx,deps.fail??defaultFail);}
export function listSurveyInvitations(db,ctx,params,deps={}) {
 const fail=deps.fail??defaultFail;guardSurveyManager(db,ctx,fail);const query=surveyQuery(params,{mode:'list'},fail),bad=invalid(fail);
 return page(invitationRows(db,ctx.orgId,bad).filter(item=>!query.status||item.status===query.status).map(item=>publicInvitation(item,responseRows(db,item,bad).length)),query);
}
export function surveyInvitationDetail(db,ctx,id,params=new URLSearchParams(),deps={}) {
 const fail=deps.fail??defaultFail;guardSurveyManager(db,ctx,fail);surveyQuery(params,{mode:'single'},fail);const item=readSurveyInvitation(db,ctx.orgId,id,fail);return {item:publicInvitation(item,responseRows(db,item,invalid(fail)).length,{detail:true})};
}
export function disableSurveyInvitation(db,ctx,id,payload,deps) {
 const fail=deps.fail??defaultFail;guardSurveyManager(db,ctx,fail);
 if(!formClosed(payload,['version','reason'])||!surveyPositive(payload.version)||typeof payload.reason!=='string'||!payload.reason.trim()||payload.reason.length>1000||/[\x00\r\n]/.test(payload.reason))fail(422,'SURVEY_INVALID','停用須提供目前版次與新理由。');
 const old=readSurveyInvitation(db,ctx.orgId,id,fail);
 if(old.version!==payload.version)fail(409,'VERSION_CONFLICT','資料已更新，請重新核對。');
 if(old.version===Number.MAX_SAFE_INTEGER)fail(409,'VERSION_LIMIT','保存版次已達安全上限。');
 if(old.status!=='active')fail(409,'SURVEY_LOCKED','已停用開通紀錄不可再次修改。');
 const item=deps.replace(db,ctx.orgId,'survey-invitations',old,{...business(old),status:'disabled',disabledAt:stamp(deps),disableReason:payload.reason});
 assertSurveyInvitation(item,ctx.orgId,invalid(fail));deps.audit(db,ctx,'survey-invitation-disabled','survey-invitations',id,{version:item.version});return {item:publicInvitation(item,responseRows(db,item,invalid(fail)).length,{detail:true})};
}
export function listSurveyResponses(db,ctx,id,params,deps={}) {
 const fail=deps.fail??defaultFail;guardSurveyManager(db,ctx,fail);const query=surveyQuery(params,{mode:'responses'},fail),invitation=readSurveyInvitation(db,ctx.orgId,id,fail);
 return {...page(responseRows(db,invitation,invalid(fail)).map(item=>({...meta(item),invitationId:item.invitationId,formHash:item.formHash,publicSnapshot:structuredClone(item.publicSnapshot),answers:structuredClone(item.answers),status:item.status})),query),invitation:publicInvitation(invitation,undefined)};
}
export function readSurveyInvitationHistory(db,ctx,id,params,deps={}) {
 const fail=deps.fail??defaultFail;guardSurveyManager(db,ctx,fail);const query=surveyQuery(params,{mode:'history'},fail),current=readSurveyInvitation(db,ctx.orgId,id,fail),bad=invalid(fail);
 const raws=sqlRows(db,'SELECT * FROM record_versions WHERE org_id=? AND entity=? AND record_id=? ORDER BY version DESC',[ctx.orgId,'survey-invitations',id]);
 const history=raws.map(row=>{if(!safeVersion(row.version)||row.org_id!==ctx.orgId||row.entity!=='survey-invitations'||row.record_id!==id||!knownHistorySource(row.source))bad();const item=safeJson(row.snapshot,bad);invitationProof(db,item,bad);if(item.id!==id||item.orgId!==ctx.orgId||item.version!==Number(row.version)||item.updatedAt!==row.created_at||SURVEY_INVITATION_KEYS.filter(key=>!['status','disabledAt','disableReason'].includes(key)).some(key=>!surveySame(item[key],current[key])))bad();return {version:item.version,createdAt:item.updatedAt,source:row.source,snapshot:publicInvitation(item,undefined,{history:true})};});
 if(history.length!==current.version||history.some((item,index)=>item.version!==current.version-index)||history.at(-1).snapshot.status!=='active'||current.version>2||current.version===2&&current.status!=='disabled')bad();
 return {...page(history,query),compare:query.compare,currentVersion:current.version};
}
function findPublicInvitation(db,token,deps={}) {
 const fail=deps.fail??defaultFail,bad=unavailable(fail),digest=surveyDigest(token);
 const raws=sqlRows(db,"SELECT * FROM records WHERE entity=? AND CASE WHEN json_valid(data) THEN json_extract(data,'$.tokenHash') END=?",['survey-invitations',digest]);
 if(raws.length!==1)bad();const item=invitationProof(db,readRow(db,'survey-invitations',raws[0],assertSurveyInvitation,bad),bad,{current:true});
 if(!timingSafeEqual(Buffer.from(item.tokenHash,'hex'),Buffer.from(digest,'hex'))||item.status!=='active'||!surveyTimestamp(stamp(deps))||item.expiresAt<=stamp(deps))bad();return item;
}
export function openPublicSurvey(db,payload,deps={}) {
 const fail=deps.fail??defaultFail;try{assertPublicSurveyOpen(payload,unavailable(fail));}catch(error){throw error;}
 const item=findPublicInvitation(db,payload.token,deps);return {mode:SURVEY_MODE,formHash:item.formHash,...structuredClone(item.publicSnapshot),notice:SURVEY_NOTICE};
}
/** Must inject BEGIN IMMEDIATE transaction. Fresh status/template/expiry validation occurs before nonce replay. */
export function submitPublicSurvey(db,payload,deps) {
 const fail=deps.fail??defaultFail;assertPublicSurveySubmit(payload,unavailable(fail));
 if(typeof deps.transaction!=='function'||typeof deps.insert!=='function'||typeof deps.audit!=='function')throw new TypeError('Survey atomic write callbacks required');
 return deps.transaction(()=>{
  const item=findPublicInvitation(db,payload.token,deps);
  if(payload.formHash!==item.formHash)fail(409,'SURVEY_FORM_CHANGED','公開題目核對已失效，請重新開啟填答。');
  const publicKeys=new Set(item.publicSnapshot.fields.map(field=>field.key));
  const answerFail=(status,code,message,fields)=>fail(status,code,message,fields?Object.fromEntries(Object.entries(fields).filter(([key])=>publicKeys.has(key))):undefined);
  assertFormAnswers(item.publicSnapshot.groups,item.publicSnapshot.fields,payload.answers,{submitted:true},answerFail);
  const nonceHash=surveyDigest(payload.nonce),payloadHash=hash({formHash:item.formHash,answers:payload.answers});
  const responses=responseRows(db,item,unavailable(fail)),prior=responses.find(response=>response.nonceHash===nonceHash);
  if(prior){if(prior.payloadHash!==payloadHash)fail(409,'SURVEY_NONCE_CONFLICT','本次提交識別已對應另一份答案。');return {accepted:true};}
  if(responses.length>=item.maxResponses)fail(409,'SURVEY_CAPACITY','此本機填答已達容量上限。');
  const response=deps.insert(db,item.orgId,'survey-responses',{invitationId:item.id,templateId:item.templateId,templateVersion:item.templateVersion,formHash:item.formHash,publicSnapshot:structuredClone(item.publicSnapshot),answers:structuredClone(payload.answers),nonceHash,payloadHash,status:'submitted'});
  responseProof(response,item,unavailable(fail));deps.audit(db,{orgId:item.orgId},'survey-anonymous-submitted','survey-responses',response.id,{invitationId:item.id});return {accepted:true};
 });
}
export function verifySurveyQrToken(db,ctx,id,payload,deps={}) {
 const fail=deps.fail??defaultFail;guardSurveyManager(db,ctx,fail);
 if(!formClosed(payload,['token'])||!surveySecret(payload.token))fail(404,'SURVEY_UNAVAILABLE','此本機填答連結目前無法使用。');
 const owned=readSurveyInvitation(db,ctx.orgId,id,fail),fresh=findPublicInvitation(db,payload.token,deps);
 if(fresh.id!==owned.id||fresh.orgId!==ctx.orgId)unavailable(fail)();return fresh;
}
/** DTO/history adapters always strip secrets and private template text. Root never calls generic publicRecord for these entities. */
export function publicSurveyRecord(ctx,item) {
 guardSurveyAccess('survey-invitations',ctx,true);
 if(Object.hasOwn(item,'tokenHash')){assertSurveyInvitation(item,ctx.orgId);return publicInvitation(item,undefined);}
 assertSurveyResponse(item,ctx.orgId);return {...meta(item),invitationId:item.invitationId,formHash:item.formHash,publicSnapshot:structuredClone(item.publicSnapshot),answers:structuredClone(item.answers),status:item.status};
}
export function readSurveyResponse(db,orgId,id,fail=defaultFail) {
 const bad=invalid(fail),row=sqlGet(db,'SELECT * FROM records WHERE org_id=? AND entity=? AND id=?',[orgId,'survey-responses',id]);
 if(!row)fail(404,'NOT_FOUND','找不到本機構原始填答。');
 const item=readRow(db,'survey-responses',row,assertSurveyResponse,bad),parent=readSurveyInvitation(db,orgId,item.invitationId,fail);return responseProof(item,parent,bad);
}
export function readSurveyResponseHistory(db,ctx,id,params,deps={}) {
 const fail=deps.fail??defaultFail;guardSurveyManager(db,ctx,fail);const query=surveyQuery(params,{mode:'history'},fail),current=readSurveyResponse(db,ctx.orgId,id,fail),bad=invalid(fail);
 const raws=sqlRows(db,'SELECT * FROM record_versions WHERE org_id=? AND entity=? AND record_id=? ORDER BY version DESC',[ctx.orgId,'survey-responses',id]);
 if(raws.length!==1||raws[0].version!==1n||raws[0].created_at!==current.updatedAt||!knownHistorySource(raws[0].source)||!surveySame(safeJson(raws[0].snapshot,bad),current))bad();
 return {...page([{version:1,createdAt:current.updatedAt,source:raws[0].source,snapshot:publicSurveyRecord(ctx,current)}],query),compare:query.compare,currentVersion:1};
}
export function surveyVisible(db,ctx,entity,item) {
 if(!isSurveyEntity(entity))return true;
 try{guardSurveyManager(db,ctx);if(entity==='survey-invitations')return readSurveyInvitation(db,ctx.orgId,item.id).id===item.id;return readSurveyResponse(db,ctx.orgId,item.id).id===item.id;}catch{return false;}
}

/** Validate the immutable original ACK after shared idempotency. Fresh permissions are checked again; no raw token or private unknown cache fields can escape. */
export function confirmSurveyCreateResponse(db,ctx,payload,value,deps={}) {
 const fail=deps.fail??defaultFail,bad=invalid(fail);guardSurveyManager(db,ctx,fail);
 if(!formClosed(value,['item']))bad();assertSurveyInvitationDto(value.item,ctx.orgId,{mode:'detail'},bad);
 const current=readSurveyInvitation(db,ctx.orgId,value.item.id,fail);
 const initialRow=sqlGet(db,'SELECT * FROM record_versions WHERE org_id=? AND entity=? AND record_id=? AND version=?',[ctx.orgId,'survey-invitations',current.id,1]);
 if(!initialRow||initialRow.version!==1n||!knownHistorySource(initialRow.source))bad();
 const original=safeJson(initialRow.snapshot,bad);invitationProof(db,original,bad);
 if(original.id!==current.id||original.version!==1||original.status!=='active'||original.updatedAt!==initialRow.created_at||SURVEY_INVITATION_KEYS.filter(key=>!['status','disabledAt','disableReason'].includes(key)).some(key=>!surveySame(original[key],current[key])))bad();
 const reviewed={mode:SURVEY_MODE,templateId:original.templateId,templateVersion:original.templateVersion,publicSnapshot:original.publicSnapshot,expiresAt:original.expiresAt,maxResponses:original.maxResponses};
 if(!surveySame(value,{item:publicInvitation(original,0,{detail:true})})||payload.templateId!==original.templateId||payload.templateVersion!==original.templateVersion||payload.publicTitle!==original.publicSnapshot.title||!surveySame(payload.publicFieldKeys,original.publicFieldKeys)||payload.expiresAt!==original.expiresAt||payload.maxResponses!==original.maxResponses||payload.approvalReference!==original.approvalReference||payload.approvedPublicQuestions!==true||payload.previewHash!==hash({...reviewed,approvalReference:original.approvalReference,approvedPublicQuestions:true}))bad();
 return value;
}
export function confirmSurveyDisableResponse(db,ctx,id,payload,value,deps={}) {
 const fail=deps.fail??defaultFail,bad=invalid(fail);guardSurveyManager(db,ctx,fail);
 if(!formClosed(value,['item']))bad();assertSurveyInvitationDto(value.item,ctx.orgId,{mode:'detail'},bad);
 const current=readSurveyInvitation(db,ctx.orgId,id,fail);
 if(current.status!=='disabled'||current.version!==2||payload.version!==1||payload.reason!==current.disableReason||!surveySame(value,{item:publicInvitation(current,responseRows(db,current,bad).length,{detail:true})}))bad();return value;
}
