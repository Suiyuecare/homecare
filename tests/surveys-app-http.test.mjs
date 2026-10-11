// Run after root wires the real createApp. Candidate handler tests separately prove output-only routing before integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
const formal=new URL('../src/server/index.mjs',import.meta.url);
const {createApp}=await import(fs.existsSync(formal)?formal:new URL('../../../../src/server/index.mjs',import.meta.url));
const existingFixture=new URL('./synthetic-backup-fixtures.mjs',import.meta.url);
const {readSyntheticRawState}=await import(fs.existsSync(existingFixture)?existingFixture:new URL('../../../../tests/synthetic-backup-fixtures.mjs',import.meta.url));
const fields=[{key:'participated',label:'合成是否參與',type:'boolean',groupId:'',required:true,options:[],visibleIf:null},{key:'experience',label:'合成原始感受',type:'textarea',groupId:'',required:true,options:[],visibleIf:{field:'participated',equals:true}}];
test('integrated createApp survey auth/CSRF/fresh manager once-header, exact public namespace/anonymous snapshots, original session and nonce/idempotency zero-write replay',async()=>{
 const app=createApp({dbPath:':memory:',port:0});try{const base=await app.listen();assert.equal(new URL(base).hostname,'127.0.0.1');assert.notEqual(new URL(base).port,'4310');let cookie='',auth;
 const request=async(path,{method='GET',body,manager=false,headers={}}={})=>{
  const res=await fetch(base+path,{method,headers:{Origin:base,...(body?{'Content-Type':'application/json'}:{}),...(manager?{Cookie:cookie,'X-Org-Id':auth.organizations[0].id,'X-CSRF-Token':auth.csrfToken}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});const text=await res.text();let value;try{value=JSON.parse(text);}catch{value=text;}return {status:res.status,value,headers:res.headers};
 };
 const setup=await request('/api/setup',{method:'POST',body:{name:'合成問卷管理者',email:'survey-app-fixture@example.test',password:'synthetic-survey-app-password',organizationName:'合成問卷機構'}});assert.equal(setup.status,201);auth=setup.value;cookie=setup.headers.get('set-cookie').split(';')[0];
 let template=(await request('/api/form-templates',{method:'POST',manager:true,body:{code:'SYNTHETIC-SURVEY',name:'合成私有模板',description:'PRIVATE_DESCRIPTION_DO_NOT_PUBLISH',groups:[],fields,note:'PRIVATE_NOTE_DO_NOT_PUBLISH'}})).value.item;
 assert.ok(template);template=(await request('/api/form-templates/'+template.id,{method:'PATCH',manager:true,body:{version:template.version,status:'published'}})).value.item;assert.equal(template.version,2);
 const input={templateId:template.id,templateVersion:2,publicTitle:'本機合成公開填答',publicFieldKeys:['participated','experience'],expiresAt:'2099-12-31T23:59:59.000Z',maxResponses:1,approvalReference:'PRIVATE_REFERENCE_DO_NOT_PUBLISH',approvedPublicQuestions:true};
 const before=readSyntheticRawState(app.db),changes=app.db.prepare('SELECT total_changes() n').get().n,preview=await request('/api/survey-invitations/preview',{method:'POST',manager:true,body:input});assert.equal(preview.status,200);assert.deepEqual(readSyntheticRawState(app.db),before);assert.equal(app.db.prepare('SELECT total_changes() n').get().n,changes);
 const body={...input,previewHash:preview.value.previewHash},created=await request('/api/survey-invitations/create',{method:'POST',manager:true,body,headers:{'Idempotency-Key':'synthetic-app-survey-create'}});assert.equal(created.status,201);const token=created.headers.get('x-survey-token');assert.equal(typeof token,'string');assert.equal(token.length,43);assert.equal(JSON.stringify(created.value).includes(token),false);
 const opened=await request('/api/public-surveys/open',{method:'POST',body:{token}});assert.equal(opened.status,200);assert.equal(opened.headers.get('set-cookie'),null);for(const forbidden of [auth.organizations[0].id,template.id,created.value.item.id,'PRIVATE_','caseId','employeeId','tokenHash'])assert.equal(JSON.stringify(opened.value).includes(forbidden),false);
 const answers={participated:true,experience:'合成原始答案\r\n保存原文'},submission={token,nonce:randomBytes(32).toString('base64url'),formHash:opened.value.formHash,answers},submitted=await request('/api/public-surveys/submit',{method:'POST',body:submission});assert.equal(submitted.status,200);assert.deepEqual(submitted.value,{accepted:true});
 const saved=readSyntheticRawState(app.db),savedChanges=app.db.prepare('SELECT total_changes() n').get().n;
 const replay=await request('/api/public-surveys/submit',{method:'POST',body:submission});assert.equal(replay.status,200);assert.deepEqual(replay.value,{accepted:true});
 const ack=await request('/api/survey-invitations/create',{method:'POST',manager:true,body,headers:{'Idempotency-Key':'synthetic-app-survey-create'}});assert.equal(ack.status,201);assert.deepEqual(ack.value,created.value);assert.equal(ack.headers.get('x-survey-token'),null);
 const responses=await request('/api/survey-invitations/'+created.value.item.id+'/responses',{manager:true});assert.equal(responses.status,200);assert.deepEqual(responses.value.items[0].answers,answers);
 const session=await request('/api/session',{headers:{Cookie:cookie}});assert.equal(session.status,200);assert.equal(session.value.user.id,auth.user.id);assert.deepEqual(readSyntheticRawState(app.db),saved);assert.equal(app.db.prepare('SELECT total_changes() n').get().n,savedChanges);
 const blocked=await request('/api/public-surveys/open?token='+token,{method:'POST',body:{token}});assert.equal(blocked.status,404);assert.equal(JSON.stringify(blocked.value).includes(token),false);assert.deepEqual(readSyntheticRawState(app.db),saved);
 app.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('finance',auth.organizations[0].id,auth.user.id);const revoked=readSyntheticRawState(app.db),revokedChanges=app.db.prepare('SELECT total_changes() n').get().n;
 const forbidden=await request('/api/survey-invitations/create',{method:'POST',manager:true,body,headers:{'Idempotency-Key':'synthetic-app-survey-create'}});assert.equal(forbidden.status,403);assert.equal(forbidden.headers.get('x-survey-token'),null);assert.deepEqual(readSyntheticRawState(app.db),revoked);assert.equal(app.db.prepare('SELECT total_changes() n').get().n,revokedChanges);
 }finally{await app.close();}
});
