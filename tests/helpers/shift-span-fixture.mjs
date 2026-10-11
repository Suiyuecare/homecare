import assert from 'node:assert/strict';
import { createApp } from '../../src/server/index.mjs';
import { id } from '../../src/server/model.mjs';
export async function fixture(t) {
  const app=createApp({dbPath:':memory:',port:0}), base=await app.listen(); t.after(()=>app.close());
  const request=async(actor,method,route,data,key)=>{const response=await fetch(base+route,{method,headers:{Origin:base,...(actor?{Cookie:actor.cookie,'X-Org-Id':actor.org,'X-CSRF-Token':actor.csrf}:{}),...(data===undefined?{}:{'Content-Type':'application/json'}),...(key?{'Idempotency-Key':key}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});return{status:response.status,body:await response.json(),headers:response.headers};};
  const password='synthetic-v074-span-password'; const setup=await request(null,'POST','/api/setup',{name:'合成兩日管理員',email:'span-admin@example.test',password,organizationName:'合成兩日機構'}); assert.equal(setup.status,201);
  const admin={cookie:setup.headers.get('set-cookie').split(';')[0],org:setup.body.organizations[0].id,csrf:setup.body.csrfToken};
  const create=async(entity,data,actor=admin,key=id())=>{const result=await request(actor,'POST','/api/'+entity,data,key);assert.equal(result.status,201,JSON.stringify(result.body));return result.body.item;};
  const employee=await create('employees',{name:'合成夜班原員工',employeeNo:'SPAN-A',hourlyRateCents:10001}), otherEmployee=await create('employees',{name:'合成夜班第二員工',employeeNo:'SPAN-B'}), caseItem=await create('cases',{name:'合成夜班個案',caseNo:'SPAN-C'}), service=await create('service-items',{code:'SPAN-S',name:'合成夜班服務',minutes:60,unitPriceCents:12345}), services=[{serviceItemId:service.id,quantity:2}], plan=await create('care-plans',{caseId:caseItem.id,validFrom:'0001-01-01',validTo:'9999-12-31',status:'active',services});
  const actors={admin}; for(const role of ['caregiver','supervisor','finance']){await create('users',{name:'合成兩日'+role,email:'span-'+role+'@example.test',password,role,...(role==='caregiver'?{employeeId:employee.id}:{})});const login=await request(null,'POST','/api/login',{email:'span-'+role+'@example.test',password}); assert.equal(login.status,200); actors[role]={cookie:login.headers.get('set-cookie').split(';')[0],org:admin.org,csrf:login.body.csrfToken};}
  const shiftBody=(extra={})=>({caseId:caseItem.id,employeeId:employee.id,carePlanId:plan.id,date:'2026-12-31',startTime:'23:30',endTime:'01:00',endDate:'2027-01-01',services,status:'scheduled',note:' 合成夜班原文\r\n末行 ',...extra});
  const state=()=>Object.fromEntries(['records','record_versions','audit','idempotency'].map(table=>{const statement=app.db.prepare('SELECT * FROM '+table+' ORDER BY rowid');statement.setReadBigInts(true);return[table,statement.all()];}));
  return {app,base,admin,actors,request,create,employee,otherEmployee,caseItem,service,services,plan,shiftBody,state};
}
