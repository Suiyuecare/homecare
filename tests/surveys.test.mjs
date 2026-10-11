import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { assertSurveyPreviewPayload,assertPublicSurveyDto,assertSurveySnapshot,surveySecret,surveyQuery } from '../public/data/survey-core.js';
import { openPublicSurvey,submitPublicSurvey,previewSurveyInvitation,createSurveyInvitation,disableSurveyInvitation,listSurveyInvitations,listSurveyResponses,surveyInvitationDetail,readSurveyInvitationHistory,readSurveyResponseHistory,guardSurveyManager,lockSurveyGenericWrite } from '../src/server/surveys.mjs';
import { surveyFixture,tableFingerprint,totalChanges,allTables } from './surveys-fixture.mjs';
const expect=(fn,status,code)=>assert.throws(fn,error=>error.status===status&&(!code||error.code===code));
const fp=f=>[tableFingerprint(f.db),totalChanges(f.db)];
const unchanged=(f,before)=>assert.deepEqual(fp(f),before);
function payload(f,issued,answers=f.answers,nonce=f.nonce()){return {token:issued.token,nonce,formHash:issued.item.formHash,answers};}

test('approval preview, public open and manager reads do not change any of 11 tables; approved minimal schema omits private source fields',()=>{
 const f=surveyFixture();try{
  assert.equal(Object.keys(allTables(f.db)).length,11);const before=fp(f),preview=f.preview();unchanged(f,before);assertSurveySnapshot(preview.publicSnapshot);
  const issued=f.issue(),readBefore=fp(f),publicDto=openPublicSurvey(f.db,{token:issued.token},f.deps);assertPublicSurveyDto(publicDto);
  assert.equal(publicDto.fields.length,7);assert.equal(publicDto.groups.length,1);
  const publicText=JSON.stringify(publicDto);for(const hidden of [f.orgId,f.template.id,'PRIVATE_',issued.token,'tokenHash','reference','revision','caseId','employeeId'])assert.equal(publicText.includes(hidden),false,hidden);
  listSurveyInvitations(f.db,f.ctx,new URLSearchParams(),f.deps);surveyInvitationDetail(f.db,f.ctx,issued.item.id,new URLSearchParams(),f.deps);
  readSurveyInvitationHistory(f.db,f.ctx,issued.item.id,new URLSearchParams('compare=previous'),f.deps);listSurveyResponses(f.db,f.ctx,issued.item.id,new URLSearchParams(),f.deps);unchanged(f,readBefore);
 }finally{f.close();}
});

test('all seven typed conditional answers, decimal original and immutable published-version snapshot save; manager sees raw answers without nonce/token/reference in list or history',()=>{
 const f=surveyFixture();try{const issued=f.issue(),body=payload(f,issued);assert.deepEqual(submitPublicSurvey(f.db,body,f.deps),{accepted:true});
 const {items,total}=listSurveyResponses(f.db,f.ctx,issued.item.id,new URLSearchParams(),f.deps);assert.equal(total,1);assert.deepEqual(items[0].answers,f.answers);assert.equal(items[0].answers.count,'-00.2500');
 const responseHistory=readSurveyResponseHistory(f.db,f.ctx,items[0].id,new URLSearchParams('compare=previous'),f.deps);assert.deepEqual(responseHistory.items[0].snapshot.answers,f.answers);
 const list=listSurveyInvitations(f.db,f.ctx,new URLSearchParams(),f.deps),history=readSurveyInvitationHistory(f.db,f.ctx,issued.item.id,new URLSearchParams(),f.deps);
 for(const serialized of [JSON.stringify(list),JSON.stringify(history),JSON.stringify(items),JSON.stringify(responseHistory)])for(const hidden of [issued.token,body.nonce,'tokenHash','nonceHash','payloadHash','PRIVATE_APPROVAL_REFERENCE_SENTINEL','PRIVATE_DESCRIPTION_SENTINEL'])assert.equal(serialized.includes(hidden),false,hidden);
 const raw=JSON.stringify(allTables(f.db));assert.equal(raw.includes(issued.token),false);assert.equal(raw.includes(body.nonce),false);
 }finally{f.close();}
});

test('nonce replay at capacity is true zero-write; changed answers conflict; new nonce at capacity blocked',()=>{
 const f=surveyFixture();try{const issued=f.issue({maxResponses:1}),body=payload(f,issued);submitPublicSurvey(f.db,body,f.deps);const before=fp(f);
 assert.deepEqual(submitPublicSurvey(f.db,{...body,answers:{...body.answers}},f.deps),{accepted:true});unchanged(f,before);
 expect(()=>submitPublicSurvey(f.db,{...body,answers:{...body.answers,text:'另一原文'}},f.deps),409,'SURVEY_NONCE_CONFLICT');unchanged(f,before);
 expect(()=>submitPublicSurvey(f.db,{...body,nonce:f.nonce()},f.deps),409,'SURVEY_CAPACITY');unchanged(f,before);
 }finally{f.close();}
});

test('disabled, expired and inactive/revised current template reject even cached anonymous nonce; manager still reads saved answers and version snapshots',()=>{
 const f=surveyFixture();try{const issued=f.issue(),body=payload(f,issued);submitPublicSurvey(f.db,body,f.deps);
 let before=fp(f);expect(()=>openPublicSurvey(f.db,{token:issued.token},{...f.deps,now:()=>issued.item.expiresAt}),404,'SURVEY_UNAVAILABLE');expect(()=>submitPublicSurvey(f.db,body,{...f.deps,now:()=>issued.item.expiresAt}),404,'SURVEY_UNAVAILABLE');unchanged(f,before);
 f.disable(issued.item);before=fp(f);expect(()=>openPublicSurvey(f.db,{token:issued.token},f.deps),404,'SURVEY_UNAVAILABLE');expect(()=>submitPublicSurvey(f.db,body,f.deps),404,'SURVEY_UNAVAILABLE');unchanged(f,before);
 assert.equal(listSurveyResponses(f.db,f.ctx,issued.item.id,new URLSearchParams(),f.deps).total,1);assert.equal(readSurveyInvitationHistory(f.db,f.ctx,issued.item.id,new URLSearchParams(),f.deps).items.length,2);
 }finally{f.close();}
});

test('current published template deactivation closes live link while historical responses remain readable',()=>{
 const f=surveyFixture();try{const issued=f.issue(),body=payload(f,issued);submitPublicSurvey(f.db,body,f.deps);
 const old=f.template;const data=JSON.parse(f.db.prepare('SELECT data FROM records WHERE id=?').get(old.id).data);f.deps.replace(f.db,f.orgId,'form-templates',old,{...data,status:'inactive'});
 const before=fp(f);expect(()=>openPublicSurvey(f.db,{token:issued.token},f.deps),404,'SURVEY_UNAVAILABLE');expect(()=>submitPublicSurvey(f.db,body,f.deps),404,'SURVEY_UNAVAILABLE');unchanged(f,before);
 assert.equal(listSurveyResponses(f.db,f.ctx,issued.item.id,new URLSearchParams(),f.deps).total,1);
 }finally{f.close();}
});

test('hidden/unknown/ill-typed answers, partial approvals, wrong form hash and unsafe versions fail with zero writes',()=>{
 const f=surveyFixture();try{const issued=f.issue(),before=fp(f),base=payload(f,issued);
 for(const answers of [{...f.answers,gate:false},{...f.answers,privateQuestion:'not approved'},{...f.answers,count:0.25},{...f.answers,visitDate:'0000-01-01'},{...f.answers,tags:['x','x']},{...f.answers,text:undefined},{...f.answers,gate:'true'}]){expect(()=>submitPublicSurvey(f.db,{...base,answers},f.deps),422);unchanged(f,before);}
 expect(()=>submitPublicSurvey(f.db,{...base,formHash:'0'.repeat(64)},f.deps),409,'SURVEY_FORM_CHANGED');unchanged(f,before);
 for(const patch of [{approvedPublicQuestions:false},{templateVersion:Number.MAX_SAFE_INTEGER+1},{publicFieldKeys:['detail']},{publicFieldKeys:['text','gate']},{expiresAt:'0000-01-01T00:00:00.000Z'},{publicTitle:'unsafe\n'}]){expect(()=>previewSurveyInvitation(f.db,f.ctx,{...f.input,...patch},f.deps),422);unchanged(f,before);}
 }finally{f.close();}
});

test('canonical 256-bit secret and strict queries reject trailing LF, getters, extra keys and unsafe integers',()=>{
 const f=surveyFixture();try{const token=randomBytes(32).toString('base64url');assert.equal(surveySecret(token),true);for(const bad of [token+'\n',token+'=',token.slice(1),token.slice(0,-1)+'B'])assert.equal(surveySecret(bad),false);
 for(const value of ['page=1%0A','page=01','page=9007199254740993','pageSize=101','status=active%0A','page=1&page=1','token=x','compare=previous%0A'])expect(()=>surveyQuery(new URLSearchParams(value),{mode:value.startsWith('compare')?'history':'list'}),422);
 expect(()=>surveyQuery(new URLSearchParams('page=1'),{mode:'single'}),422);
 let calls=0;const getter={...f.input};Object.defineProperty(getter,'approvedPublicQuestions',{enumerable:true,get(){calls++;return true;}});expect(()=>assertSurveyPreviewPayload(getter),422);assert.equal(calls,0);
 const before=fp(f);expect(()=>openPublicSurvey(f.db,{token,orgId:f.orgId},f.deps),404,'SURVEY_UNAVAILABLE');unchanged(f,before);
 }finally{f.close();}
});

test('manager roles, current membership and cross-org reads/creation/cached replay are closed',()=>{
 const f=surveyFixture();try{const issued=f.issue(),before=fp(f);
 for(const role of ['caregiver','finance']){expect(()=>listSurveyInvitations(f.db,{...f.ctx,role},new URLSearchParams(),f.deps),403);expect(()=>previewSurveyInvitation(f.db,{...f.ctx,role},f.input,f.deps),403);}
 expect(()=>surveyInvitationDetail(f.db,{...f.ctx,orgId:f.otherOrg},issued.item.id,new URLSearchParams(),f.deps),403);unchanged(f,before);
 const preview=f.preview(),input={...f.input,previewHash:preview.previewHash};let firstToken;
 const first=f.idem('fresh-key',input,()=>createSurveyInvitation(f.db,f.ctx,input,{...f.deps,onIssuedToken:value=>{firstToken=value;}}));assert.equal(surveySecret(firstToken),true);const cachedBefore=fp(f);let replayToken;
 assert.deepEqual(f.idem('fresh-key',input,()=>createSurveyInvitation(f.db,f.ctx,input,{...f.deps,onIssuedToken:value=>{replayToken=value;}})),first);assert.equal(replayToken,undefined);unchanged(f,cachedBefore);
 const cachedRows=JSON.stringify(allTables(f.db));assert.equal(cachedRows.includes(firstToken),false);
 f.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('finance',f.orgId,f.ctx.user.id);const revokedBefore=fp(f);expect(()=>f.idem('fresh-key',input,()=>first),403);expect(()=>guardSurveyManager(f.db,f.ctx),403);unchanged(f,revokedBefore);
 }finally{f.close();}
});

test('preview hash freshness, CAS/terminal locks, generic write lock and failed audit atomic rollback with same-key retry',()=>{
 const f=surveyFixture();try{const p=f.preview(),input={...f.input,previewHash:p.previewHash},before=fp(f);
 expect(()=>f.deps.transaction(()=>createSurveyInvitation(f.db,f.ctx,{...input,maxResponses:3},{...f.deps,onIssuedToken(){}})),409,'SURVEY_PREVIEW_CHANGED');unchanged(f,before);
 let issuedToken;assert.throws(()=>f.idem('retry-key',input,()=>createSurveyInvitation(f.db,f.ctx,input,{...f.deps,audit(){throw new Error('synthetic audit failure');},onIssuedToken:value=>{issuedToken=value;}})),/synthetic audit failure/);assert.equal(issuedToken,undefined);assert.equal(tableFingerprint(f.db),before[0]);
 const ack=f.idem('retry-key',input,()=>createSurveyInvitation(f.db,f.ctx,input,{...f.deps,onIssuedToken:value=>{issuedToken=value;}}));assert.equal(surveySecret(issuedToken),true);
 const stable=fp(f);expect(()=>f.deps.transaction(()=>disableSurveyInvitation(f.db,f.ctx,ack.item.id,{version:2,reason:'人工停止'},f.deps)),409,'VERSION_CONFLICT');unchanged(f,stable);
 const disabled=f.disable(ack.item);const terminal=fp(f);expect(()=>f.disable(disabled.item),409,'SURVEY_LOCKED');expect(()=>lockSurveyGenericWrite('survey-invitations'),409,'SURVEY_WORKFLOW_REQUIRED');expect(()=>lockSurveyGenericWrite('survey-responses'),409);unchanged(f,terminal);
 }finally{f.close();}
});

test('anonymous audit failure rolls back response/head/audit, permits retry and retains original answers',()=>{
 const f=surveyFixture();try{const issued=f.issue(),body=payload(f,issued),before=tableFingerprint(f.db);
 assert.throws(()=>submitPublicSurvey(f.db,body,{...f.deps,audit(){throw new Error('synthetic second write failure');}}),/synthetic second write failure/);assert.equal(tableFingerprint(f.db),before);
 assert.deepEqual(submitPublicSurvey(f.db,body,f.deps),{accepted:true});assert.equal(listSurveyResponses(f.db,f.ctx,issued.item.id,new URLSearchParams(),f.deps).items.length,1);
 }finally{f.close();}
});

test('current SQL unsafe/null/bad JSON/head metadata drift cannot fall back to a readable public or manager record',()=>{
 for(const corruption of ['unsafe','null','bad-json','head-mismatch','unknown','missing-head']){
  const f=surveyFixture();try{const issued=f.issue();
   if(corruption==='unsafe')f.db.prepare('UPDATE records SET version=? WHERE id=?').run(9007199254740993n,issued.item.id);
   if(corruption==='null')f.db.prepare('UPDATE records SET data=? WHERE id=?').run('null',issued.item.id);
   if(corruption==='bad-json')f.db.prepare('UPDATE records SET data=? WHERE id=?').run('{broken',issued.item.id);
   if(corruption==='head-mismatch')f.db.prepare('UPDATE records SET updated_at=? WHERE id=?').run('2026-10-01T00:00:00.000Z',issued.item.id);
   if(corruption==='unknown'){const row=f.db.prepare('SELECT data FROM records WHERE id=?').get(issued.item.id);f.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.data),caseId:'not permitted'}),issued.item.id);}
   if(corruption==='missing-head')f.db.prepare('UPDATE records SET version=? WHERE id=?').run(2,issued.item.id);
   const before=fp(f);expect(()=>openPublicSurvey(f.db,{token:issued.token},f.deps),404,'SURVEY_UNAVAILABLE');expect(()=>surveyInvitationDetail(f.db,f.ctx,issued.item.id,new URLSearchParams(),f.deps),409,'SURVEY_DATA_INVALID');unchanged(f,before);
  }finally{f.close();}
 }
});

test('malformed unrelated org response prevents omitted rows from creating false capacity, and unsafe/null history blocks zero-write',()=>{
 const f=surveyFixture();try{const issued=f.issue(),body=payload(f,issued);submitPublicSurvey(f.db,body,f.deps);
 const response=listSurveyResponses(f.db,f.ctx,issued.item.id,new URLSearchParams(),f.deps).items[0];f.db.prepare('UPDATE records SET data=? WHERE id=?').run('null',response.id);
 const before=fp(f);expect(()=>submitPublicSurvey(f.db,{...body,nonce:f.nonce()},f.deps),404,'SURVEY_UNAVAILABLE');expect(()=>listSurveyResponses(f.db,f.ctx,issued.item.id,new URLSearchParams(),f.deps),409,'SURVEY_DATA_INVALID');unchanged(f,before);
 }finally{f.close();}
 for(const version of [9007199254740993n,0n]){const f=surveyFixture();try{const issued=f.issue();f.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.orgId,'survey-invitations',issued.item.id,version,'null',new Date().toISOString(),'update');const before=fp(f);expect(()=>readSurveyInvitationHistory(f.db,f.ctx,issued.item.id,new URLSearchParams(),f.deps),409,'SURVEY_DATA_INVALID');unchanged(f,before);}finally{f.close();}}
});

test('literal SQL NUL/invalid UTF8 bytes and matching-head metadata are never cropped into apparently valid JSON or identity',()=>{
 for(const mutation of ['data-nul','created-nul','invalid-utf8']){const f=surveyFixture();try{const issued=f.issue();
  if(mutation==='data-nul'){const raw=f.db.prepare('SELECT data FROM records WHERE id=?').get(issued.item.id).data;f.db.prepare('UPDATE records SET data=? WHERE id=?').run(raw+'\0hidden',issued.item.id);}
  if(mutation==='created-nul')f.db.prepare('UPDATE records SET created_at=? WHERE id=?').run(issued.item.createdAt+'\0hidden',issued.item.id);
  if(mutation==='invalid-utf8')f.db.prepare("UPDATE records SET data=CAST(? AS TEXT) WHERE id=?").run(Buffer.from([0xff,0xfe]),issued.item.id);
  const before=tableFingerprint(f.db),changes=totalChanges(f.db);expect(()=>listSurveyInvitations(f.db,f.ctx,new URLSearchParams(),f.deps),409,'SURVEY_DATA_INVALID');expect(()=>openPublicSurvey(f.db,{token:issued.token},f.deps),404,'SURVEY_UNAVAILABLE');assert.equal(tableFingerprint(f.db),before);assert.equal(totalChanges(f.db),changes);
 }finally{f.close();}}
});
