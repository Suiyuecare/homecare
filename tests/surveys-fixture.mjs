import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
const modelUrl=new URL('../src/server/model.mjs',import.meta.url);
const {initDb,insert,replace,audit,business}=await import(fs.existsSync(modelUrl)?modelUrl:new URL('../../../../src/server/model.mjs',import.meta.url));
import { previewSurveyInvitation,createSurveyInvitation,disableSurveyInvitation,surveyManagerPreflight } from '../src/server/surveys.mjs';
export const digest=value=>createHash('sha256').update(value).digest('hex');
export function allTables(db){return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,(()=>{const statement=db.prepare('SELECT * FROM '+name+' ORDER BY rowid');statement.setReadBigInts(true);return JSON.parse(JSON.stringify(statement.all(),(_k,v)=>typeof v==='bigint'?v.toString():v));})()]));}
export const tableFingerprint=db=>digest(JSON.stringify(allTables(db),(_k,v)=>typeof v==='bigint'?v.toString():v));
export const totalChanges=db=>db.prepare('SELECT total_changes() n').get().n;
export function surveyFixture({dbPath=':memory:'}={}) {
 const db=new DatabaseSync(dbPath);initDb(db);if(dbPath!==':memory:')fs.chmodSync(dbPath,0o600);const orgId=randomUUID(),otherOrg=randomUUID(),userId=randomUUID(),time=new Date().toISOString();
 for(const org of [orgId,otherOrg])db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(org,'合成測試機構',time);
 db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(userId,'合成管理者',userId+'@example.invalid','synthetic-no-login',time);
 db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(orgId,userId,'supervisor',null);
 const ctx={orgId,user:{id:userId},role:'supervisor'};
 const field=(key,type,extra={})=>({key,label:'合成題目 '+key,type,groupId:'public',required:true,options:[],visibleIf:null,...extra});
 const groups=[{id:'public',label:'公開群組'},{id:'private',label:'PRIVATE_UNUSED_GROUP_SENTINEL'}];
 const fields=[field('gate','boolean'),field('text','text'),field('count','number'),field('visitDate','date'),field('choice','select',{options:[{value:'a',label:'甲'},{value:'b',label:'乙'}]}),field('tags','multiselect',{options:[{value:'x',label:'第一'},{value:'y',label:'第二'}]}),field('detail','textarea',{visibleIf:{field:'gate',equals:true}}),field('privateQuestion','text',{groupId:'private',label:'PRIVATE_UNSELECTED_QUESTION_SENTINEL'})];
 let template=insert(db,orgId,'form-templates',{code:'PRIVATE_CODE_SENTINEL',name:'PRIVATE_NAME_SENTINEL',description:'PRIVATE_DESCRIPTION_SENTINEL',revision:1,previousTemplateId:'',groups,fields,status:'draft',note:'PRIVATE_NOTE_SENTINEL'});
 template=replace(db,orgId,'form-templates',template,{...business(template),status:'published'});
 const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}};
 const deps={insert,replace,audit,transaction,now:()=>new Date().toISOString()};
 const input={templateId:template.id,templateVersion:template.version,publicTitle:'合成公開滿意填答',publicFieldKeys:fields.slice(0,7).map(field=>field.key),expiresAt:'2099-12-31T23:59:59.000Z',maxResponses:2,approvalReference:'PRIVATE_APPROVAL_REFERENCE_SENTINEL',approvedPublicQuestions:true};
 const preview=()=>previewSurveyInvitation(db,ctx,input,deps);
 let token;
 const create=(overrides={})=>transaction(()=>createSurveyInvitation(db,ctx,{...input,...overrides,previewHash:previewSurveyInvitation(db,ctx,{...input,...overrides},deps).previewHash},{...deps,onIssuedToken:value=>{token=value;}}));
 const issue=(overrides={})=>{const result=create(overrides);return {...result,token};};
 const nonce=()=>Buffer.from(randomUUID()+randomUUID()).subarray(0,32).toString('base64url');
 const answers={gate:true,text:'原始合成答案',count:'-00.2500',visitDate:'2026-10-11',choice:'b',tags:['y','x'],detail:'可見條件\n原始內容'};
 const disable=(item,reason='人工停止本機收件')=>transaction(()=>disableSurveyInvitation(db,ctx,item.id,{version:item.version,reason},deps));
 const idem=(key,payload,fn)=>transaction(()=>{
  surveyManagerPreflight(db,ctx,deps);const route='POST /api/survey-invitations/create',payloadHash=digest(JSON.stringify(payload));
  const prior=db.prepare('SELECT * FROM idempotency WHERE org_id=? AND user_id=? AND key=?').get(orgId,userId,key);
  if(prior){if(prior.route!==route||prior.hash!==payloadHash)throw Object.assign(new Error('idem conflict'),{status:409});return JSON.parse(prior.response);}
  const result=fn();db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?,?,?,?)').run(orgId,userId,key,route,payloadHash,JSON.stringify(result),201,new Date().toISOString());return result;
 });
 return {db,ctx,orgId,otherOrg,template,input,deps,preview,issue,create,nonce,answers,disable,idem,close:()=>db.close()};
}
