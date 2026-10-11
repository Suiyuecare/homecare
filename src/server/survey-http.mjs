import { formFailure } from '../../public/data/custom-form-engine.js';
import { SURVEY_BODY_BYTES } from '../../public/data/survey-core.js';
import { openPublicSurvey,submitPublicSurvey } from './surveys.mjs';
export const PUBLIC_SURVEY_PATHS=Object.freeze(['/api/public-surveys/open','/api/public-surveys/submit']);
export const isPublicSurveyNamespace=raw=>{if(typeof raw!=='string')return false;if(raw.startsWith('/api/public-surveys'))return true;try{return decodeURIComponent(new URL(raw,'http://local.invalid').pathname).startsWith('/api/public-surveys');}catch{return false;}};
/** Dedicated public body reader: UTF-8 is fatal, never replacement-decoded, and content type/query are closed. */
export async function readPublicSurveyBody(req,fail=formFailure) {
 const type=req.headers['content-type'];
 if(typeof type!=='string'||type.length>64||!/^(application\/json)(; charset=utf-8)?$/i.test(type))fail(415,'SURVEY_CONTENT_TYPE','請使用 JSON 格式提交本機填答。');
 const declared=req.headers['content-length'];
 if(declared!==undefined && (typeof declared!=='string'||!/^([1-9][0-9]*|0)$/.test(declared)||!Number.isSafeInteger(Number(declared))||Number(declared)>SURVEY_BODY_BYTES))fail(413,'SURVEY_BODY_LIMIT','本機填答超過提交大小上限。');
 const chunks=[];let length=0;
 for await(const chunk of req){length+=chunk.length;if(length>SURVEY_BODY_BYTES)fail(413,'SURVEY_BODY_LIMIT','本機填答超過提交大小上限。');chunks.push(chunk);}
 let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{fail(400,'SURVEY_BODY_INVALID','本機填答 JSON 格式無法確認。');}
 if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'SURVEY_BODY_INVALID','請提供本機填答 JSON 物件。');return value;
}
/** Root invokes after common Host/security headers and before private auth. No cookie/session/Portal state is read or changed. */
export async function handlePublicSurvey(req,res,{db,originGuard,send,fail=formFailure,...deps}) {
 if(!isPublicSurveyNamespace(req.url))return false;
 if(req.method!=='POST'||!PUBLIC_SURVEY_PATHS.includes(req.url))fail(404,'SURVEY_UNAVAILABLE','此本機填答連結目前無法使用。');
 if(typeof originGuard!=='function'||typeof send!=='function')throw new TypeError('Survey HTTP guards required');
 originGuard(req);const payload=await readPublicSurveyBody(req,fail);
 const value=req.url===PUBLIC_SURVEY_PATHS[0]?openPublicSurvey(db,payload,{...deps,fail}):submitPublicSurvey(db,payload,{...deps,fail});
 if(Buffer.byteLength(JSON.stringify(value),'utf8')>SURVEY_BODY_BYTES)fail(413,'SURVEY_BODY_LIMIT','本機填答超過回應大小上限。');
 send(res,200,value);return true;
}
