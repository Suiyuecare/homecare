import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes,createHash } from 'node:crypto';
import { formFailure } from '../public/data/custom-form-engine.js';
import { handlePublicSurvey,readPublicSurveyBody } from '../src/server/survey-http.mjs';
import { handleManagerSurvey } from '../src/server/survey-routes.mjs';
import { surveyFixture,tableFingerprint,totalChanges } from './surveys-fixture.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(){
 const f=surveyFixture(),session=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');let origin;
 f.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(session),f.ctx.user.id,csrf,Date.now()+3600000);
 const ctxFor=req=>{if(req.headers.cookie!=='suiyue_session='+session||req.headers['x-org-id']!==f.orgId||!f.db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?').get(hash(session),Date.now()))formFailure(401,'AUTH_REQUIRED','synthetic auth required');return f.ctx;};
 const csrfGuard=req=>{if(req.headers['x-csrf-token']!==csrf)formFailure(403,'CSRF_INVALID','synthetic csrf required');};
 const originGuard=req=>{if(req.headers.host!==new URL(origin).host)formFailure(403,'HOST_FORBIDDEN','host');if(req.headers.origin!==origin)formFailure(403,'ORIGIN_FORBIDDEN','origin');};
 const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
 const idem=(req,ctx,payload,fn,preflight)=>f.deps.transaction(()=>{preflight();const key=req.headers['idempotency-key'],route=req.method+' '+req.url,digest=hash(JSON.stringify(payload)),prior=f.db.prepare('SELECT * FROM idempotency WHERE org_id=? AND user_id=? AND key=?').get(ctx.orgId,ctx.user.id,key);if(prior){if(prior.route!==route||prior.hash!==digest)formFailure(409,'IDEMPOTENCY_CONFLICT','conflict');return {status:prior.status,value:JSON.parse(prior.response)};}const result=fn();f.db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?,?,?,?)').run(ctx.orgId,ctx.user.id,key,route,digest,JSON.stringify(result.value),result.status,new Date().toISOString());return result;});
 const server=http.createServer(async(req,res)=>{for(const [key,value] of Object.entries({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}))res.setHeader(key,value);try{
  if(req.headers.host!==new URL(origin).host)formFailure(403,'HOST_FORBIDDEN','host');
  if(await handlePublicSurvey(req,res,{db:f.db,originGuard,send,...f.deps}))return;
  const ctx=ctxFor(req);if(req.method!=='GET'){originGuard(req);csrfGuard(req);}
  if(await handleManagerSurvey(req,res,{db:f.db,ctx,send,body:readPublicSurveyBody,idem,preflight:()=>{ctxFor(req);csrfGuard(req);originGuard(req);},trustedOrigin:origin,...f.deps}))return;
  send(res,404,{error:{code:'NOT_FOUND',message:'not found'}});
 }catch(error){send(res,error.status??500,{error:{code:error.code??'SERVER_ERROR',message:error.status?error.message:'unexpected'}});}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
 const request=(url,{method='POST',payload,rawBody,headers={},manager=false}={})=>new Promise((resolve,reject)=>{const buffer=rawBody!==undefined?Buffer.from(rawBody):payload===undefined?null:Buffer.from(JSON.stringify(payload));const request=http.request(origin+url,{method,path:url,headers:{Origin:origin,...(buffer?{'Content-Type':'application/json','Content-Length':buffer.length}:{}),...(manager?{Cookie:'suiyue_session='+session,'X-Org-Id':f.orgId,'X-CSRF-Token':csrf}:{}),...headers}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const bytes=Buffer.concat(chunks);let value;try{value=JSON.parse(bytes);}catch{value=bytes;}resolve({status:res.statusCode,headers:res.headers,value});});});request.on('error',reject);if(buffer)request.write(buffer);request.end();});
 return {...f,origin,session,csrf,request,close:async()=>{await new Promise(resolve=>server.close(resolve));f.close();}};
}
const fp=f=>[tableFingerprint(f.db),totalChanges(f.db)];
const unchanged=(f,before)=>assert.deepEqual(fp(f),before);

test('production candidate handlers over random loopback: approval/create once-header, anonymous seven-type submit and public replay; all read/replay11 tables zero-write',async()=>{
 const f=await fixture();try{const before=fp(f),preview=await f.request('/api/survey-invitations/preview',{payload:f.input,manager:true});assert.equal(preview.status,200);unchanged(f,before);
 const createInput={...f.input,previewHash:preview.value.previewHash},created=await f.request('/api/survey-invitations/create',{payload:createInput,manager:true,headers:{'Idempotency-Key':'http-create-key'}});assert.equal(created.status,201);const token=created.headers['x-survey-token'];assert.equal(typeof token,'string');assert.equal(JSON.stringify(created.value).includes(token),false);
 const readBefore=fp(f),replay=await f.request('/api/survey-invitations/create',{payload:createInput,manager:true,headers:{'Idempotency-Key':'http-create-key'}});assert.equal(replay.status,201);assert.deepEqual(replay.value,created.value);assert.equal(replay.headers['x-survey-token'],undefined);unchanged(f,readBefore);
 const opened=await f.request('/api/public-surveys/open',{payload:{token}});assert.equal(opened.status,200);assert.equal(opened.headers['set-cookie'],undefined);assert.equal(opened.headers['cache-control'],'no-store');assert.equal(opened.headers['referrer-policy'],'no-referrer');unchanged(f,readBefore);
 const submitted={token,nonce:randomBytes(32).toString('base64url'),formHash:opened.value.formHash,answers:f.answers};const save=await f.request('/api/public-surveys/submit',{payload:submitted});assert.equal(save.status,200);assert.deepEqual(save.value,{accepted:true});
 const savedBefore=fp(f),second=await f.request('/api/public-surveys/submit',{payload:submitted});assert.equal(second.status,200);assert.deepEqual(second.value,save.value);unchanged(f,savedBefore);
 const listed=await f.request('/api/survey-invitations/'+created.value.item.id+'/responses',{method:'GET',manager:true});assert.equal(listed.status,200);assert.equal(listed.value.total,1);assert.deepEqual(listed.value.items[0].answers,f.answers);
 const history=await f.request('/api/survey-responses/'+listed.value.items[0].id+'/history?compare=previous',{method:'GET',manager:true});assert.equal(history.status,200);unchanged(f,savedBefore);
 const qr=await f.request('/api/survey-invitations/'+created.value.item.id+'/qr',{payload:{token},manager:true});assert.equal(qr.status,200);assert.equal(qr.headers['content-type'],'image/png');assert.deepEqual([...qr.value.subarray(0,8)],[137,80,78,71,13,10,26,10]);unchanged(f,savedBefore);
 assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM sessions').all()).includes(f.session),false);assert.equal(f.db.prepare('SELECT count(*) n FROM sessions').get().n,1);
 }finally{await f.close();}
});

test('public HTTP namespace rejects missing/foreign Origin, Host, method, encoded/noncanonical path, query, bad content type, invalid UTF8 and oversized body without writes',async()=>{
 const f=await fixture();try{const issued=f.issue(),before=fp(f),body={token:issued.token};
 const cases=[['/api/public-surveys/open',{method:'GET',payload:undefined},404],['/api/public-surveys/open?x=1',{payload:body},404],['/api/public-surveys/open?',{payload:body},404],['/api/public-surveys/open/',{payload:body},404],['/api/%70ublic-surveys/open',{payload:body},404],['/api/public-surveys/%6fpen',{payload:body},404],['/api/public-surveys/open',{payload:body,headers:{Origin:'http://foreign.invalid'}},403],['/api/public-surveys/open',{payload:body,headers:{Host:'foreign.invalid'}},403],['/api/public-surveys/open',{payload:body,headers:{'Content-Type':'application/json-evil'}},415],['/api/public-surveys/open',{rawBody:Buffer.from([0x7b,0x22,0x78,0x22,0x3a,0x22,0xff,0x22,0x7d])},400],['/api/public-surveys/open',{rawBody:'{"token":'},400],['/api/public-surveys/open',{payload:{...body,orgId:f.orgId}},404],['/api/public-surveys/open',{rawBody:' '.repeat(2097153)},413]];
 for(const [url,options,status] of cases){const result=await f.request(url,options);assert.equal(result.status,status,url);assert.equal(result.headers['set-cookie'],undefined);assert.equal(JSON.stringify(result.value).includes(f.orgId),false);assert.equal(JSON.stringify(result.value).includes(issued.item.id),false);unchanged(f,before);}
 const missing=await f.request('/api/public-surveys/open',{payload:body,headers:{Origin:''}});assert.equal(missing.status,403);unchanged(f,before);
 }finally{await f.close();}
});

test('manager HTTP CSRF/current session/current role and mandatory idempotency remain guarded, public API never drops logged-in state',async()=>{
 const f=await fixture();try{const p=f.preview(),body={...f.input,previewHash:p.previewHash},before=fp(f);
 const noKey=await f.request('/api/survey-invitations/create',{manager:true,payload:body});assert.equal(noKey.status,422);unchanged(f,before);
 const noCsrf=await f.request('/api/survey-invitations/create',{manager:true,payload:body,headers:{'Idempotency-Key':'csrf-key','X-CSRF-Token':''}});assert.equal(noCsrf.status,403);unchanged(f,before);
 const first=await f.request('/api/survey-invitations/create',{manager:true,payload:body,headers:{'Idempotency-Key':'role-key'}});assert.equal(first.status,201);const token=first.headers['x-survey-token'];
 for(const url of ['/api/survey-invitations?page=1%0A','/api/survey-invitations/'+first.value.item.id+'?page=1','/api/%73urvey-invitations']){const result=await f.request(url,{method:'GET',manager:true});assert.ok([404,422].includes(result.status));}
 const stillSessionBefore=fp(f);const unavailable=await f.request('/api/public-surveys/open',{payload:{token:randomBytes(32).toString('base64url')},manager:true});assert.equal(unavailable.status,404);assert.equal(unavailable.headers['set-cookie'],undefined);unchanged(f,stillSessionBefore);
 f.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('finance',f.orgId,f.ctx.user.id);const revoked=fp(f),replay=await f.request('/api/survey-invitations/create',{manager:true,payload:body,headers:{'Idempotency-Key':'role-key'}});assert.equal(replay.status,403);assert.equal(replay.headers['x-survey-token'],undefined);unchanged(f,revoked);
 const opened=await f.request('/api/public-surveys/open',{payload:{token}});assert.equal(opened.status,200);unchanged(f,revoked);
 }finally{await f.close();}
});

test('shared cached create ACK must prove closed immutable original record; tampered cache never exposes token or new unknown fields',async()=>{
 const f=await fixture();try{const preview=f.preview(),body={...f.input,previewHash:preview.previewHash},headers={'Idempotency-Key':'synthetic-tamper-key'};
 const created=await f.request('/api/survey-invitations/create',{manager:true,payload:body,headers});assert.equal(created.status,201);const token=created.headers['x-survey-token'];
 f.db.prepare('UPDATE idempotency SET response=? WHERE key=?').run(JSON.stringify({...created.value,token}),'synthetic-tamper-key');const before=fp(f),replay=await f.request('/api/survey-invitations/create',{manager:true,payload:body,headers});assert.equal(replay.status,409);assert.equal(replay.headers['x-survey-token'],undefined);assert.equal(JSON.stringify(replay.value).includes(token),false);unchanged(f,before);
 }finally{await f.close();}
});
