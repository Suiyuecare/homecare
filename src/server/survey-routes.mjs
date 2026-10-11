import { formFailure } from '../../public/data/custom-form-engine.js';
import { SURVEY_BODY_BYTES,surveyId } from '../../public/data/survey-core.js';
import { guardSurveyManager,previewSurveyInvitation,createSurveyInvitation,disableSurveyInvitation,listSurveyInvitations,surveyInvitationDetail,listSurveyResponses,readSurveyInvitationHistory,readSurveyResponseHistory,surveyManagerPreflight,confirmSurveyCreateResponse,confirmSurveyDisableResponse } from './surveys.mjs';
import { renderSurveyQr } from './survey-qr.mjs';
export const isManagerSurveyNamespace=raw=>{if(typeof raw!=='string')return false;const matches=value=>value.startsWith('/api/survey-invitations')||value.startsWith('/api/survey-responses');if(matches(raw))return true;try{return matches(decodeURIComponent(new URL(raw,'http://local.invalid').pathname));}catch{return false;}};
function requiredIdempotency(req,fail) {const key=req.headers['idempotency-key'];if(typeof key!=='string'||key.length<1||key.length>128||!/^[\x21-\x7e]+$/.test(key))fail(422,'IDEMPOTENCY_REQUIRED','開通與停用須提供本次提交識別。');}
function canonicalId(raw,fail) {let id;try{id=decodeURIComponent(raw);}catch{fail(404,'NOT_FOUND','找不到本機填答紀錄。');}if(!surveyId(id)||encodeURIComponent(id)!==raw||id.includes('/')||id.includes('\\'))fail(404,'NOT_FOUND','找不到本機填答紀錄。');return id;}
/** Root calls after its normal current auth+CSRF. idem must be its shared transaction, and preflight re-auth/CSRF before cached lookup. */
export async function handleManagerSurvey(req,res,{db,ctx,body,send,idem,preflight,trustedOrigin,fail=formFailure,...deps}) {
 if(!isManagerSurveyNamespace(req.url))return false;
 guardSurveyManager(db,ctx,fail);
 if(!req.url.startsWith('/api/survey-invitations')&&!req.url.startsWith('/api/survey-responses'))fail(404,'NOT_FOUND','找不到本機填答操作。');
 if(typeof body!=='function'||typeof send!=='function'||typeof idem!=='function'||typeof preflight!=='function')throw new TypeError('Survey manager route callbacks required');
 const url=new URL(req.url,'http://local.invalid'),path=url.pathname,query=url.searchParams;
 const match=/^\/api\/survey-invitations(?:\/([^/]+)(?:\/(history|responses|disable|qr))?)?$/.exec(path);
 const responseHistory=/^\/api\/survey-responses\/([^/]+)\/history$/.exec(path);
 const recheck=()=>{preflight();surveyManagerPreflight(db,ctx,{...deps,fail});};
 if(req.method==='POST'&&['/api/survey-invitations/preview','/api/survey-invitations/create'].includes(path)) {
  if(req.url!==path)fail(422,'SURVEY_INVALID','本次操作不接受查詢參數。');
  const payload=await body(req,SURVEY_BODY_BYTES);
  if(path.endsWith('/preview')){send(res,200,previewSurveyInvitation(db,ctx,payload,{...deps,fail}));return true;}
  requiredIdempotency(req,fail);let issuedToken;
  const result=idem(req,ctx,payload,()=>({status:201,value:createSurveyInvitation(db,ctx,payload,{...deps,fail,onIssuedToken:value=>{issuedToken=value;}})}),recheck);
  if(result.status!==201)fail(409,'SURVEY_DATA_INVALID','本機填答保存回應無法確認。');
  const confirmed=confirmSurveyCreateResponse(db,ctx,payload,result.value,{...deps,fail});
  if(issuedToken)res.setHeader('X-Survey-Token',issuedToken);
  send(res,result.status,confirmed);return true;
 }
 if(responseHistory&&req.method==='GET'){send(res,200,readSurveyResponseHistory(db,ctx,canonicalId(responseHistory[1],fail),query,{...deps,fail}));return true;}
 if(!match)fail(404,'NOT_FOUND','找不到本機填答操作。');
 const id=match[1]?canonicalId(match[1],fail):'',operation=match[2]??'';
 if(req.method==='GET') {
  const value=!id?listSurveyInvitations(db,ctx,query,{...deps,fail}):operation==='history'?readSurveyInvitationHistory(db,ctx,id,query,{...deps,fail}):operation==='responses'?listSurveyResponses(db,ctx,id,query,{...deps,fail}):!operation?surveyInvitationDetail(db,ctx,id,query,{...deps,fail}):null;
  if(value){send(res,200,value);return true;}
 }
 if(req.method==='POST'&&id&&['disable','qr'].includes(operation)){
  if(req.url!==path)fail(422,'SURVEY_INVALID','本次操作不接受查詢參數。');const payload=await body(req,SURVEY_BODY_BYTES);
  if(operation==='disable'){requiredIdempotency(req,fail);const result=idem(req,ctx,payload,()=>({status:200,value:disableSurveyInvitation(db,ctx,id,payload,{...deps,fail})}),recheck);if(result.status!==200)fail(409,'SURVEY_DATA_INVALID','本機填答保存回應無法確認。');send(res,result.status,confirmSurveyDisableResponse(db,ctx,id,payload,result.value,{...deps,fail}));return true;}
  recheck();const png=await renderSurveyQr(db,ctx,id,payload,trustedOrigin,{...deps,fail});recheck();res.writeHead(200,{'Content-Type':'image/png','Content-Length':png.length,'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});res.end(png);return true;
 }
 if(['POST','PATCH','DELETE'].includes(req.method)&&!operation)fail(409,'SURVEY_WORKFLOW_REQUIRED','請使用本機填答開通、停用或匿名提交流程。');
 fail(404,'NOT_FOUND','找不到本機填答操作。');
}
