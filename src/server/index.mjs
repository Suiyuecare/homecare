import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,scryptSync,timingSafeEqual,createHash} from 'node:crypto';
import {mkdirSync,chmodSync,existsSync,readFileSync,statSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {HttpError,fail,id,now,initDb,entities,rows,get,insert,replace,business,audit,validatePayload,validate,scopedRows,writeGuard,dateValid,billingSnapshot,publicRecord} from './model.mjs';
import {report,toCsv} from './reports.mjs';
import {seedDemo} from './demo.mjs';
import { guardPersonnelAccess, personnelQuery, certificationView } from './personnel.mjs';
import { guardContactAccess, contactQuery } from './contacts.mjs';
import { caseStatusFollowupQuery, guardCaseStatusFollowupAccess } from './case-status-followups.mjs';
import { interviewApplicantQuery, guardInterviewApplicantAccess } from './interview-applicants.mjs';
import { guardSupervisoryVisitAccess, readSupervisoryVisits, readSupervisoryVisit } from './supervisory-visits.mjs';
import { guardNeedsAssessmentAccess, readNeedsAssessments, readNeedsAssessment } from './needs-assessments.mjs';
import { guardCaseFollowupWorklistAccess, readCaseFollowupWorklist, readCaseFollowupWorklistItem } from './case-followup-worklist.mjs';
import { personalCalendarEntity, guardPersonalCalendarAccess, assertPersonalCalendarItem, personalCalendarQuery, filterPersonalCalendar } from './personal-calendar.mjs';
import { readPersonalCalendarMonth } from './personal-calendar-month.mjs';
import { readPersonalCalendarYear } from './personal-calendar-year.mjs';
import { MAX_ATTACHMENT_BODY_BYTES, guardAttachmentAccess, attachmentQuery, validateAttachmentFile, attachmentFileMetadata, insertAttachmentFile, readAttachmentFile } from './attachments.mjs';
import { isCertificationAttachmentEntity, guardCertificationAttachmentAccess, validateCertificationAttachment, certificationAttachmentQuery, requireCertificationParent, insertCertificationAttachmentFile, readCertificationAttachmentFile } from './certification-attachments.mjs';
import { readHistory } from './history.mjs';
import { guardCaseRecordIndexAccess, readCaseRecordIndex } from './case-record-index.mjs';
import { guardEmployeeRecordIndexAccess, readEmployeeRecordIndex } from './employee-record-index.mjs';
import { validateAnnouncementReadQuery, validateAnnouncementReadPayload, readAnnouncementReadState, readAnnouncementReadReceipts, preflightAnnouncementRead, acknowledgeAnnouncementRead, confirmAnnouncementReadResponse } from './announcement-reads.mjs';
import { guardRecurringShiftAccess, previewRecurringShifts, commitRecurringShifts } from './recurring-shifts.mjs';
import { readShiftReport } from './shift-report.mjs';
import { readServiceReport } from './service-report.mjs';
import { readCaseReport } from './case-report.mjs';
import { readEmployeeReport } from './employee-report.mjs';
import { readLeaveReport } from './leave-report.mjs';
import { readTrainingReport } from './training-report.mjs';
import { readCertificationReport } from './certification-report.mjs';
import { guardLeaveShiftConflicts, validateLeaveShiftConflictsQuery, readLeaveShiftConflicts } from './leave-shift-conflicts.mjs';
import { normalizePortalConfig, portalConfigFromEnv, hasPortalStorage, initPortalStorage, portalMembershipForUser, consumePortalHandoff, readPortalForm, guardPortalHandoffRequest, HANDOFF_PATH, HANDOFF_DESTINATION } from './portal-handoff.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const roles=['admin','supervisor','caregiver','finance'];
const hash=s=>createHash('sha256').update(s).digest('hex');
const passwordHash=p=>{const salt=randomBytes(16).toString('hex');return salt+':'+scryptSync(p,salt,64).toString('hex');};
function checkPassword(p,s){try{const[salt,key]=s.split(':');const expected=Buffer.from(key,'hex');const actual=scryptSync(p,salt,64);return expected.length===actual.length&&timingSafeEqual(expected,actual);}catch{return false;}}
function textField(body,k,{min=1,max=200}={}){if(typeof body[k]!=='string'||body[k].trim().length<min||body[k].length>max)fail(422,'INVALID_FIELD','請檢查'+k+'欄位',{[k]:'長度或格式不符'});return body[k].trim();}
function credentials(body){const email=textField(body,'email',{max:254}).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(422,'INVALID_EMAIL','Email格式錯誤');const password=body.password;if(typeof password!=='string'||password.length<12||password.length>512)fail(422,'PASSWORD_LENGTH','密碼至少12字，最多512字');return{email,password};}
function unknown(body,allowed){if(!body||Array.isArray(body)||typeof body!=='object')fail(400,'INVALID_BODY','請提供JSON物件');for(const k of Object.keys(body))if(!allowed.includes(k))fail(422,'UNKNOWN_FIELD','不允許的欄位：'+k);}
function pageParams(url){const page=Number(url.searchParams.get('page')||1),pageSize=Number(url.searchParams.get('pageSize')||25);if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)fail(422,'PAGINATION','page須為正整數，pageSize介於1至100');return{page,pageSize};}
const paginate=(items,{page,pageSize})=>({items:items.slice((page-1)*pageSize,page*pageSize),total:items.length,page,pageSize});
export function createApp({dbPath,host='127.0.0.1',port=Number(process.env.PORT||4310),portalConfig=null}={}){
 if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid port');
 const portal=normalizePortalConfig(portalConfig);
 const dataDir=process.env.DATA_DIR||path.join(root,'data');const databasePath=dbPath||path.join(dataDir,'care.sqlite');
 if(databasePath!==':memory:'){mkdirSync(path.dirname(path.resolve(databasePath)),{recursive:true,mode:0o700});}
 const db=new DatabaseSync(databasePath);if(portal.mode==='local'&&hasPortalStorage(db)){db.close();throw new Error('HOME_CARE_PORTAL_MODE_REQUIRED');}initDb(db);if(databasePath!==':memory:')chmodSync(databasePath,0o600);
 if(portal.mode==='portal')initPortalStorage(db);
 const attempts=new Map();const publicRoot=path.join(root,'public');let closed=false;
 const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}};
 function activePortalConfig(){if(!portal.dynamicLoopbackPort)return portal;const publicUrl=new URL(portal.publicOrigin);publicUrl.port=String(server.address()?.port||port);return{...portal,publicOrigin:publicUrl.origin,publicHost:publicUrl.host};}
 function session(req){const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('suiyue_session='));if(!cookie)return null;const token=cookie.slice(15);if(!/^[a-f0-9]{64}$/.test(token))return null;const s=db.prepare('SELECT s.*,u.id,u.name,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=? AND expires_at>?').get(hash(token),Date.now());if(s&&portal.mode==='portal'&&!portalMembershipForUser(db,s.user_id))return null;return s||null;}
 function organizations(userId){if(portal.mode==='portal'){const binding=portalMembershipForUser(db,userId);if(!binding)return[];return db.prepare('SELECT o.id,o.name,m.role,m.employee_id AS employeeId FROM organizations o JOIN memberships m ON m.org_id=o.id WHERE m.user_id=? AND o.id=? ORDER BY o.created_at,o.id').all(userId,binding.org_id);}return db.prepare('SELECT o.id,o.name,m.role,m.employee_id AS employeeId FROM organizations o JOIN memberships m ON m.org_id=o.id WHERE m.user_id=? ORDER BY o.created_at,o.id').all(userId);}
 function sessionPayload(s,orgId){const orgs=organizations(s.user_id||s.id);const active=orgs.find(x=>x.id===orgId)||orgs[0];return{user:{id:s.user_id||s.id,name:s.name,email:s.email,role:active?.role,employeeId:active?.employeeId||null},organizations:orgs,csrfToken:s.csrf,...(portal.mode==='portal'?{authMode:'portal'}:{})};}
 function cookieAttributes(){return`HttpOnly; SameSite=${portal.mode==='portal'?'Lax':'Strict'}; Path=/${portal.secureCookie?'; Secure':''}`;}
 function prepareSession(user){const token=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(token),user.id,csrf,Date.now()+8*3600e3);return{session:{...user,user_id:user.id,csrf},cookie:`suiyue_session=${token}; ${cookieAttributes()}; Max-Age=28800`};}
 function newSession(user,res){const created=prepareSession(user);res.setHeader('Set-Cookie',created.cookie);return created.session;}
 function auth(req){const s=session(req);if(!s)fail(401,'AUTH_REQUIRED','請先登入');const orgId=req.headers['x-org-id'];if(typeof orgId!=='string'||!orgId)fail(400,'ORG_REQUIRED','請選擇機構');if(portal.mode==='portal'&&portalMembershipForUser(db,s.user_id)?.org_id!==orgId)fail(403,'ORG_FORBIDDEN','無權存取所選機構');const m=db.prepare('SELECT * FROM memberships WHERE org_id=? AND user_id=?').get(orgId,s.user_id);if(!m)fail(403,'ORG_FORBIDDEN','無權存取所選機構');if(m.role==='caregiver'&&(!m.employee_id||get(db,orgId,'employees',m.employee_id)?.status!=='active'))fail(403,'EMPLOYEE_LINK_REQUIRED','居服員帳號需連結同機構有效員工');return{orgId,role:m.role,employeeId:m.employee_id,user:{id:s.user_id,name:s.name,email:s.email},session:s};}
 function originGuard(req){if(portal.mode==='portal'){const config=activePortalConfig();if(req.headers.host!==config.publicHost)fail(403,'HOST_FORBIDDEN','不接受此主機名稱');if(req.headers.origin!==config.publicOrigin)fail(403,'ORIGIN_FORBIDDEN','請從居家系統頁面執行此操作');return;}const address=server.address();const allowed=new Set([`${host}:${address?.port||port}`,`127.0.0.1:${address?.port||port}`,`localhost:${address?.port||port}`]);const requestHost=req.headers.host;if(!allowed.has(requestHost))fail(403,'HOST_FORBIDDEN','不接受此主機名稱');const origin=req.headers.origin;let parsed;try{parsed=new URL(origin);}catch{fail(403,'ORIGIN_FORBIDDEN','請從本機系統頁面執行此操作');}if(!origin||!allowed.has(parsed.host)||!['http:','https:'].includes(parsed.protocol)||parsed.host!==requestHost||parsed.username||parsed.password)fail(403,'ORIGIN_FORBIDDEN','請從本機系統頁面執行此操作');}
 function csrf(req,s){const token=req.headers['x-csrf-token'];if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token)||token.length!==s.csrf.length||!timingSafeEqual(Buffer.from(token),Buffer.from(s.csrf)))fail(403,'CSRF_INVALID','安全驗證已失效，請重新整理頁面');}
 function admin(ctx){if(ctx.role!=='admin')fail(403,'ROLE_FORBIDDEN','僅管理者可執行');}
 async function body(req,maxBytes=131072){if(!(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))fail(415,'CONTENT_TYPE','請使用application/json');let size=0,parts=[];for await(const chunk of req){size+=chunk.length;if(size>maxBytes)fail(413,'BODY_TOO_LARGE','請求內容過大',maxBytes===MAX_ATTACHMENT_BODY_BYTES?{file:'上傳請求不可超過8 MiB'}:undefined);parts.push(chunk);}try{const value=JSON.parse(Buffer.concat(parts).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'INVALID_BODY','請提供JSON物件');return value;}catch(e){if(e instanceof HttpError)throw e;fail(400,'INVALID_JSON','JSON格式錯誤');}}
 function send(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}
 function idem(req,ctx,payload,fn,preflight){const key=req.headers['idempotency-key'];if(!key)return transaction(preflight?()=>{preflight();return fn();}:fn);if(typeof key!=='string'||!/^[\x21-\x7e]{1,128}$/.test(key))fail(422,'IDEMPOTENCY_KEY','Idempotency-Key格式錯誤');const route=req.method+' '+req.url;const digest=hash(JSON.stringify(payload));return transaction(()=>{if(preflight)preflight();const prior=db.prepare('SELECT * FROM idempotency WHERE org_id=? AND user_id=? AND key=?').get(ctx.orgId,ctx.user.id,key);if(prior){if(prior.route!==route||prior.hash!==digest)fail(409,'IDEMPOTENCY_CONFLICT','此重送鍵已用於不同請求');return{status:prior.status,value:JSON.parse(prior.response)};}const result=fn();db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?,?,?,?)').run(ctx.orgId,ctx.user.id,key,route,digest,JSON.stringify(result.value),result.status,now());return result;});}
 const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  try{
   const address=server.address();const config=activePortalConfig();const hostnames=portal.mode==='portal'?new Set([config.publicHost]):new Set([`${host}:${address?.port||port}`,`127.0.0.1:${address?.port||port}`,`localhost:${address?.port||port}`]);if(!hostnames.has(req.headers.host))fail(403,'HOST_FORBIDDEN','不接受此主機名稱');
   const url=new URL(req.url,'http://'+req.headers.host);let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{fail(400,'INVALID_PATH','網址格式錯誤');}
   if(pathname.includes('\0')||pathname.includes('\\'))fail(400,'INVALID_PATH','網址格式錯誤');
   const mutating=!['GET','HEAD','OPTIONS'].includes(req.method);const portalHandoff=portal.mode==='portal'&&req.method==='POST'&&req.url===HANDOFF_PATH;if(mutating&&!portalHandoff)originGuard(req);
   if(req.method==='GET'&&pathname==='/health')return send(res,200,{ok:true,mode:'local-prototype',storage:'sqlite'});
   if(pathname==='/api/setup/status'&&req.method==='GET'){const entry=new URL('/portal/',portal.mode==='portal'?config.portalOrigin:'https://login.suiyuecare.com');entry.searchParams.set('module','home-care');if(portal.mode==='portal')entry.searchParams.set('next',config.publicOrigin+HANDOFF_DESTINATION);return send(res,200,{needsSetup:!db.prepare('SELECT 1 FROM users LIMIT 1').get(),authMode:portal.mode,portalLoginUrl:portal.mode==='portal'?entry.toString():null,portalHomeUrl:'https://login.suiyuecare.com/portal/'});}
   if(pathname===HANDOFF_PATH){if(portal.mode!=='portal')fail(404,'NOT_FOUND','找不到此登入入口');guardPortalHandoffRequest(req,config);const envelope=await readPortalForm(req);const old=session(req);const created=consumePortalHandoff(db,config,envelope,user=>{const result=prepareSession(user);if(old)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(old.token_hash);return result;});res.setHeader('Set-Cookie',created.cookie);res.writeHead(303,{Location:HANDOFF_DESTINATION});res.end();return;}
   if(pathname==='/api/setup'&&req.method==='POST'){
    if(portal.mode==='portal')fail(403,'PORTAL_LOGIN_REQUIRED','請使用公司模組頁登入，帳號由管理者開通');
    const data=await body(req);unknown(data,['name','email','password','organizationName','seedDemo']);const{email,password}=credentials(data);const name=textField(data,'name'),organizationName=textField(data,'organizationName');if(data.seedDemo!==undefined&&typeof data.seedDemo!=='boolean')fail(422,'INVALID_FIELD','seedDemo須為boolean');
    const result=transaction(()=>{if(db.prepare('SELECT 1 FROM users LIMIT 1').get())fail(409,'SETUP_COMPLETE','初始設定已完成');const user={id:id(),name,email};const orgId=id();db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(orgId,organizationName,now());db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(user.id,name,email,passwordHash(password),now());db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(orgId,user.id,'admin',null);audit(db,{orgId,user},'setup',null,null,{});if(data.seedDemo)seedDemo(db,{orgId,user});return user;});
    return send(res,201,sessionPayload(newSession(result,res)));
   }
   if(pathname==='/api/login'&&req.method==='POST'){
    if(portal.mode==='portal')fail(403,'PORTAL_LOGIN_REQUIRED','請使用公司模組頁登入');
    const data=await body(req);unknown(data,['email','password']);const email=textField(data,'email',{max:254}).toLowerCase();if(typeof data.password!=='string'||data.password.length>512)fail(401,'LOGIN_FAILED','帳號或密碼不正確');
    const key=(req.socket.remoteAddress||'')+'|'+email,entry=attempts.get(key);if(entry&&entry.until>Date.now()&&entry.count>=10)fail(429,'RATE_LIMIT','嘗試次數過多，請15分鐘後再試');const user=db.prepare('SELECT * FROM users WHERE email=?').get(email);if(!user||!checkPassword(data.password,user.password_hash)){if(attempts.size>1000)for(const[k,v]of attempts)if(v.until<=Date.now())attempts.delete(k);if(attempts.size>2000)fail(429,'RATE_LIMIT','請稍後再試');attempts.set(key,{count:entry?.until>Date.now()?entry.count+1:1,until:Date.now()+15*60e3});fail(401,'LOGIN_FAILED','帳號或密碼不正確');}attempts.delete(key);const old=session(req);if(old)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(old.token_hash);return send(res,200,sessionPayload(newSession(user,res)));
   }
   if(pathname==='/api/session'&&req.method==='GET'){const s=session(req);return send(res,200,s?sessionPayload(s,req.headers['x-org-id']):{user:null,organizations:[],csrfToken:null});}
   if(pathname==='/api/logout'&&req.method==='POST'){const s=session(req);if(!s)fail(401,'AUTH_REQUIRED','請先登入');csrf(req,s);db.prepare('DELETE FROM sessions WHERE token_hash=?').run(s.token_hash);res.setHeader('Set-Cookie',`suiyue_session=; ${cookieAttributes()}; Max-Age=0`);return send(res,200,{ok:true});}
   if(pathname.startsWith('/api/')){
    const ctx=auth(req);if(mutating)csrf(req,ctx.session);
    if(/^\/api\/personal-calendar-events(?:\/|$)/.test(pathname)){
     const entity=personalCalendarEntity;guardPersonalCalendarAccess(entity,ctx,fail);
     if(pathname==='/api/personal-calendar-events/calendar'){
      if(req.method!=='GET')fail(405,'METHOD_NOT_ALLOWED','月份檢視僅支援唯讀GET');
      return send(res,200,readPersonalCalendarMonth(db,ctx,url.searchParams));
     }
     if(pathname==='/api/personal-calendar-events/year'){
      if(req.method!=='GET')fail(405,'METHOD_NOT_ALLOWED','年度檢視僅支援唯讀GET');
      return send(res,200,readPersonalCalendarYear(db,ctx,url.searchParams));
     }
     const calendarRoute=pathname.match(/^\/api\/personal-calendar-events(?:\/([a-f0-9-]+))?(?:\/(history))?$/);
     if(!calendarRoute)fail(404,'NOT_FOUND','找不到此個人行事曆入口');
     const[,recordId,action]=calendarRoute;
     const current=()=>{const item=scopedRows(db,ctx,entity).find(x=>x.id===recordId);if(!item)fail(404,'NOT_FOUND','找不到本人行事事件');return assertPersonalCalendarItem(item,ctx,fail);};
     if(req.method==='GET'){
      if(action==='history'){current();const query=personalCalendarQuery(url.searchParams,'history',fail,dateValid);return send(res,200,paginate(readHistory(db,ctx,entity,recordId,{compare:query.compare}),query));}
      if(recordId){const item=current();personalCalendarQuery(url.searchParams,'single',fail,dateValid);return send(res,200,{item});}
      const query=personalCalendarQuery(url.searchParams,'list',fail,dateValid),items=filterPersonalCalendar(scopedRows(db,ctx,entity),query);for(const item of items)assertPersonalCalendarItem(item,ctx,fail);return send(res,200,paginate(items,query));
     }
     if(req.method==='POST'&&!recordId&&!action){
      personalCalendarQuery(url.searchParams,'single',fail,dateValid);const payload=await body(req),data={...entities[entity].defaults,...validatePayload(entity,payload),ownerUserId:ctx.user.id};writeGuard(ctx,entity,data);
      const result=idem(req,ctx,payload,()=>{validate(db,ctx,entity,data);const item=insert(db,ctx.orgId,entity,data);audit(db,ctx,'record.create',entity,item.id,{status:item.status,version:1});return{status:201,value:{item:publicRecord(ctx,item)}};});return send(res,result.status,result.value);
     }
     if(req.method==='PATCH'&&recordId&&!action){
      current();personalCalendarQuery(url.searchParams,'single',fail,dateValid);const payload=await body(req),patch=validatePayload(entity,payload,true);
      const result=transaction(()=>{const old=current();assertPersonalCalendarItem(old,ctx,fail,{nextVersion:true});const data={...business(old),...patch};writeGuard(ctx,entity,data,old);if(old.version!==payload.version)fail(409,'VERSION_CONFLICT','資料已更新，請重新讀取');validate(db,ctx,entity,data,old);const item=replace(db,ctx.orgId,entity,old,data);audit(db,ctx,'record.update',entity,item.id,{fields:Object.keys(patch),fromStatus:old.status,toStatus:data.status,version:item.version});return{item:publicRecord(ctx,item)};});return send(res,200,result);
     }
     fail(404,'NOT_FOUND','找不到API或不支援此操作');
    }
    if(/^\/api\/case-followup-worklist(?:\/|$)/.test(pathname)){
     guardCaseFollowupWorklistAccess(ctx);
     const followupRoute=pathname.match(/^\/api\/case-followup-worklist(?:\/([^/]+))?$/);
     if(!followupRoute)fail(404,'NOT_FOUND','找不到此人工追蹤查詢入口');
     if(req.method!=='GET')fail(405,'METHOD_NOT_ALLOWED','人工追蹤查詢僅支援讀取');
     return send(res,200,followupRoute[1]?readCaseFollowupWorklistItem(db,ctx,followupRoute[1],url.searchParams):readCaseFollowupWorklist(db,ctx,url.searchParams));
    }
    if(/^\/api\/needs-assessments(?:\/|$)/.test(pathname)){
     guardNeedsAssessmentAccess(ctx);
     const needsRoute=pathname.match(/^\/api\/needs-assessments(?:\/([^/]+))?$/);
     if(!needsRoute)fail(404,'NOT_FOUND','找不到此需求評估查詢入口');
     if(req.method!=='GET')fail(405,'METHOD_NOT_ALLOWED','需求評估查詢僅支援讀取');
     return send(res,200,needsRoute[1]?readNeedsAssessment(db,ctx,needsRoute[1],url.searchParams):readNeedsAssessments(db,ctx,url.searchParams));
    }
    if(/^\/api\/supervisory-visits(?:\/|$)/.test(pathname)){
     guardSupervisoryVisitAccess(ctx);
     const visitRoute=pathname.match(/^\/api\/supervisory-visits(?:\/([^/]+))?$/);
     if(!visitRoute)fail(404,'NOT_FOUND','找不到此訪視查詢入口');
     if(req.method!=='GET')fail(405,'METHOD_NOT_ALLOWED','督導訪視查詢僅支援讀取');
     return send(res,200,visitRoute[1]?readSupervisoryVisit(db,ctx,visitRoute[1],url.searchParams):readSupervisoryVisits(db,ctx,url.searchParams));
    }
    if(/^\/api\/interview-applicants(?:\/|$)/.test(pathname))guardInterviewApplicantAccess('interview-applicants',ctx,req.method==='GET',fail);
    const announcementReadRoute=pathname.match(/^\/api\/announcements\/([a-f0-9-]+)\/(read-state|read-receipts)$/);
    if(announcementReadRoute){
     const[,recordId,action]=announcementReadRoute;
     if(req.method==='GET')return send(res,200,action==='read-state'?readAnnouncementReadState(db,ctx,recordId,url.searchParams):readAnnouncementReadReceipts(db,ctx,recordId,url.searchParams));
     if(action==='read-state'&&req.method==='POST'){
      validateAnnouncementReadQuery(url.searchParams,{post:true});const payload=await body(req),version=validateAnnouncementReadPayload(payload);
      const writeCtx=auth(req);csrf(req,writeCtx.session);let checkedCtx=writeCtx;
      const currentContext=()=>{const fresh=auth(req);csrf(req,fresh.session);if(fresh.orgId!==writeCtx.orgId||fresh.user.id!==writeCtx.user.id)fail(401,'AUTH_REQUIRED','登入狀態已變更，請重新讀取');checkedCtx=fresh;return fresh;};
      let result;
      try{result=idem(req,writeCtx,payload,()=>acknowledgeAnnouncementRead(db,currentContext(),recordId,version),()=>preflightAnnouncementRead(db,currentContext(),recordId,version));}
      catch(error){if(error instanceof SyntaxError||error instanceof RangeError)fail(409,'ANNOUNCEMENT_RECEIPT_INVALID','公告閱讀回執不完整，無法確認閱讀狀態');throw error;}
      return send(res,result.status,confirmAnnouncementReadResponse(db,checkedCtx,recordId,version,result.value,result.status,req.headers['idempotency-key']));
     }
     fail(405,'METHOD_NOT_ALLOWED','不支援此公告閱讀操作方法');
    }
    const leaveConflictsRoute=pathname.match(/^\/api\/leave-requests\/([a-f0-9-]+)\/shift-conflicts$/);
    if(leaveConflictsRoute&&req.method==='GET'){
     guardLeaveShiftConflicts(ctx);validateLeaveShiftConflictsQuery(url.searchParams);
     return send(res,200,readLeaveShiftConflicts(db,ctx,leaveConflictsRoute[1],pageParams(url)));
    }
    const recurringRoute=pathname.match(/^\/api\/recurring-shifts\/(preview|commit)$/);
    if(recurringRoute&&req.method==='POST'){
     guardRecurringShiftAccess(ctx);
     if(recurringRoute[1]==='commit'&&!req.headers['idempotency-key'])fail(422,'IDEMPOTENCY_REQUIRED','建立週期排班必須提供Idempotency-Key');
     const payload=await body(req);
     if(recurringRoute[1]==='preview')return send(res,200,previewRecurringShifts(db,ctx,payload));
     const result=idem(req,ctx,payload,()=>({status:201,value:commitRecurringShifts(db,ctx,payload)}));
     return send(res,result.status,result.value);
    }
    if(pathname==='/api/organizations'&&req.method==='POST'){admin(ctx);if(portal.mode==='portal')fail(403,'PORTAL_ACCOUNT_MANAGED','公司帳號與機構由統一入口管理者開通');const data=await body(req);unknown(data,['name']);const name=textField(data,'name');const result=idem(req,ctx,data,()=>{const orgId=id();db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(orgId,name,now());db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(orgId,ctx.user.id,'admin',null);audit(db,{...ctx,orgId},'organization.create','organizations',orgId);return{status:201,value:{item:{id:orgId,name,role:'admin'}}};});return send(res,result.status,result.value);}
    if(pathname==='/api/users'){
     admin(ctx);if(req.method==='GET'){const items=db.prepare('SELECT u.id,u.name,u.email,m.role,m.employee_id AS employeeId FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.org_id=? ORDER BY u.name').all(ctx.orgId);return send(res,200,paginate(items.map(x=>({...x,status:'active'})),pageParams(url)));}
     if(req.method==='POST'){if(portal.mode==='portal')fail(403,'PORTAL_ACCOUNT_MANAGED','公司帳號與機構由統一入口管理者開通');const data=await body(req);unknown(data,['name','email','password','role','employeeId']);const{email,password}=credentials(data),name=textField(data,'name');if(!roles.includes(data.role))fail(422,'INVALID_ROLE','登入角色不合法');if(data.employeeId!==undefined&&data.employeeId!==null&&typeof data.employeeId!=='string')fail(422,'INVALID_REFERENCE','employeeId須為員工識別碼');if(data.role==='caregiver'&&!data.employeeId)fail(422,'EMPLOYEE_LINK_REQUIRED','居服員登入必須指定員工');if(data.employeeId&&get(db,ctx.orgId,'employees',data.employeeId)?.status!=='active')fail(422,'INVALID_REFERENCE','員工必須同機構且有效');const result=idem(req,ctx,data,()=>{if(db.prepare('SELECT 1 FROM users WHERE email=?').get(email))fail(409,'EMAIL_EXISTS','Email已使用');const userId=id();db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(userId,name,email,passwordHash(password),now());db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(ctx.orgId,userId,data.role,data.employeeId||null);audit(db,ctx,'user.create','users',userId,{role:data.role});return{status:201,value:{item:{id:userId,name,email,role:data.role,employeeId:data.employeeId||null,status:'active'}}};});return send(res,result.status,result.value);}
    }
    if(pathname==='/api/demo/seed'&&req.method==='POST'){admin(ctx);const data=await body(req);unknown(data,[]);const r=idem(req,ctx,data,()=>({status:200,value:seedDemo(db,ctx)}));return send(res,r.status,r.value);}
    if(pathname==='/api/audit'&&req.method==='GET'){admin(ctx);const items=db.prepare('SELECT a.*,u.name AS actor FROM audit a LEFT JOIN users u ON u.id=a.user_id WHERE org_id=? ORDER BY created_at DESC,id DESC').all(ctx.orgId).map(x=>({id:x.id,orgId:x.org_id,userId:x.user_id,actor:x.actor,action:x.action,entity:x.entity,recordId:x.record_id,detail:JSON.parse(x.detail),createdAt:x.created_at}));const q=(url.searchParams.get('q')||'').slice(0,200).toLowerCase();const filtered=q?items.filter(x=>[x.action,x.entity,x.actor,x.recordId].some(v=>String(v||'').toLowerCase().includes(q))):items;return send(res,200,paginate(filtered,pageParams(url)));}
    if(pathname==='/api/dashboard'&&req.method==='GET'){const today=url.searchParams.get('date')||new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());if(!dateValid(today))fail(422,'INVALID_DATE','日期格式錯誤');const cases=scopedRows(db,ctx,'cases'),shifts=scopedRows(db,ctx,'shifts'),records=scopedRows(db,ctx,'service-records');return send(res,200,{counts:{cases:cases.length,activeCases:cases.filter(x=>x.status==='active').length,employees:scopedRows(db,ctx,'employees').length,activeEmployees:scopedRows(db,ctx,'employees').filter(x=>x.status==='active').length,shifts:shifts.length,pendingRecords:records.filter(x=>x.status==='submitted').length},todayShifts:shifts.filter(x=>x.date===today),pendingRecords:records.filter(x=>x.status==='submitted'),note:'本機資料，不含原系統或正式核銷資料'});}
    if(req.method==='GET'&&['/api/certification-report','/api/certification-report/export','/api/certification-report.csv'].includes(pathname)){
     const result=readCertificationReport(db,ctx,url.searchParams,{full:pathname!=='/api/certification-report'});
     if(pathname==='/api/certification-report.csv'){res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="certification-report.csv"'});return res.end(toCsv(result));}
     return send(res,200,result);
    }
    if(req.method==='GET'&&['/api/training-report','/api/training-report/export','/api/training-report.csv'].includes(pathname)){
     const result=readTrainingReport(db,ctx,url.searchParams,{full:pathname!=='/api/training-report'});
     if(pathname==='/api/training-report.csv'){res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="training-report.csv"'});return res.end(toCsv(result));}
     return send(res,200,result);
    }
    if(req.method==='GET'&&['/api/leave-report','/api/leave-report/export','/api/leave-report.csv'].includes(pathname)){
     const result=readLeaveReport(db,ctx,url.searchParams,{full:pathname!=='/api/leave-report'});
     if(pathname==='/api/leave-report.csv'){res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="leave-report.csv"'});return res.end(toCsv(result));}
     return send(res,200,result);
    }
    if(req.method==='GET'&&['/api/employee-report','/api/employee-report/export','/api/employee-report.csv'].includes(pathname)){
     const result=readEmployeeReport(db,ctx,url.searchParams,{full:pathname!=='/api/employee-report'});
     if(pathname==='/api/employee-report.csv'){res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="employee-report.csv"'});return res.end(toCsv(result));}
     return send(res,200,result);
    }
    if(req.method==='GET'&&['/api/shift-report','/api/shift-report/export','/api/shift-report.csv'].includes(pathname)){
     const result=readShiftReport(db,ctx,url.searchParams,{full:pathname!=='/api/shift-report'});
     if(pathname==='/api/shift-report.csv'){res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="shift-report.csv"'});return res.end(toCsv(result));}
     return send(res,200,result);
    }
    if(req.method==='GET'&&['/api/case-report','/api/case-report/export','/api/case-report.csv'].includes(pathname)){
     const result=readCaseReport(db,ctx,url.searchParams,{full:pathname!=='/api/case-report'});
     if(pathname==='/api/case-report.csv'){res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="case-report.csv"'});return res.end(toCsv(result));}
     return send(res,200,result);
    }
    if(req.method==='GET'&&['/api/service-report','/api/service-report/export','/api/service-report.csv'].includes(pathname)){
     const result=readServiceReport(db,ctx,url.searchParams,{full:pathname!=='/api/service-report'});
     if(pathname==='/api/service-report.csv'){res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="service-report.csv"'});return res.end(toCsv(result));}
     return send(res,200,result);
    }
    const reportMatch=pathname.match(/^\/api\/reports\/([a-z]+)(?:\.(csv))?$/);if(reportMatch&&req.method==='GET'){const r=report(db,ctx,reportMatch[1],url.searchParams.get('month'));if(reportMatch[2]||url.searchParams.get('format')==='csv'){res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${reportMatch[1]}.csv"`});return res.end(toCsv(r));}return send(res,200,r);}
    if(pathname==='/api/certification-attachments/upload'&&req.method==='POST'){
     const entity='certification-attachments';guardCertificationAttachmentAccess(entity,ctx,false,fail);
     const payload=await body(req,MAX_ATTACHMENT_BODY_BYTES);
     unknown(payload,['certificationId','title','note','status','fileName','mimeType','contentBase64']);
     const metadata=Object.fromEntries(Object.entries(payload).filter(([key])=>entities[entity].fields.split(' ').includes(key)));
     const data={...entities[entity].defaults,...validatePayload(entity,metadata)};
     validateCertificationAttachment(entity,data,null,fail);
     requireCertificationParent(db,ctx,data.certificationId,scopedRows,fail);
     const file=validateAttachmentFile(payload,fail);
     const result=idem(req,ctx,payload,()=>{const parent=requireCertificationParent(db,ctx,data.certificationId,scopedRows,fail);const saved={...data,employeeId:parent.employeeId,...attachmentFileMetadata(file)};validate(db,ctx,entity,saved);const item=insert(db,ctx.orgId,entity,saved);insertCertificationAttachmentFile(db,ctx,item,file);audit(db,ctx,'record.create',entity,item.id,{status:item.status,version:1,operation:'upload'});return{status:201,value:{item:publicRecord(ctx,item)}};});
     return send(res,result.status,result.value);
    }
    const certificationAttachmentAction=pathname.match(/^\/api\/certification-attachments\/([a-f0-9-]+)\/(replace-file|download)$/);
    if(certificationAttachmentAction){
     const[,recordId,action]=certificationAttachmentAction,entity='certification-attachments';guardCertificationAttachmentAccess(entity,ctx,req.method==='GET',fail);
     const authorize=()=>{const item=scopedRows(db,ctx,entity).find(item=>item.id===recordId);if(!item)fail(404,'NOT_FOUND','找不到資料');return item;};
     if(action==='download'&&req.method==='GET'){
      const file=readCertificationAttachmentFile(db,ctx,authorize(),url.searchParams,fail);res.writeHead(200,file.headers);return res.end(file.bytes);
     }
     if(action==='replace-file'&&req.method==='POST'){
      const payload=await body(req,MAX_ATTACHMENT_BODY_BYTES);unknown(payload,['version','fileName','mimeType','contentBase64']);
      if(!Number.isSafeInteger(payload.version)||payload.version<1)fail(422,'VERSION_REQUIRED','更換檔案必須提供正整數version');
      authorize();const file=validateAttachmentFile(payload,fail);
      const result=idem(req,ctx,payload,()=>{authorize();const old=get(db,ctx.orgId,entity,recordId);if(old.version!==payload.version)fail(409,'VERSION_CONFLICT','附件已更新，請重新讀取');const data={...business(old),...attachmentFileMetadata(file)};validate(db,ctx,entity,data,old);const item=replace(db,ctx.orgId,entity,old,data);insertCertificationAttachmentFile(db,ctx,item,file);audit(db,ctx,'record.update',entity,item.id,{fields:['fileName','mimeType','sizeBytes','sha256'],version:item.version,operation:'replace-file'});return{status:200,value:{item:publicRecord(ctx,item)}};});
      return send(res,result.status,result.value);
     }
    }
    if(pathname==='/api/case-attachments/upload'&&req.method==='POST'){
     const entity='case-attachments';guardAttachmentAccess(entity,ctx,false,fail);
     const payload=await body(req,MAX_ATTACHMENT_BODY_BYTES);
     unknown(payload,['caseId','title','category','note','status','fileName','mimeType','contentBase64']);
     const metadata=Object.fromEntries(Object.entries(payload).filter(([key])=>entities[entity].fields.split(' ').includes(key)));
     const data={...entities[entity].defaults,...validatePayload(entity,metadata)},file=validateAttachmentFile(payload,fail);
     const result=idem(req,ctx,payload,()=>{validate(db,ctx,entity,data);const item=insert(db,ctx.orgId,entity,{...data,...attachmentFileMetadata(file)});insertAttachmentFile(db,ctx,item,file);audit(db,ctx,'record.create',entity,item.id,{status:item.status,version:1,operation:'upload'});return{status:201,value:{item:publicRecord(ctx,item)}};});
     return send(res,result.status,result.value);
    }
    const attachmentAction=pathname.match(/^\/api\/case-attachments\/([a-f0-9-]+)\/(replace-file|download)$/);
    if(attachmentAction){
     const[,recordId,action]=attachmentAction,entity='case-attachments';guardAttachmentAccess(entity,ctx,req.method==='GET',fail);
     if(action==='download'&&req.method==='GET'){
      const current=scopedRows(db,ctx,entity).find(item=>item.id===recordId);if(!current)fail(404,'NOT_FOUND','找不到資料');
      const file=readAttachmentFile(db,ctx,current,url.searchParams,fail);res.writeHead(200,file.headers);return res.end(file.bytes);
     }
     if(action==='replace-file'&&req.method==='POST'){
      const payload=await body(req,MAX_ATTACHMENT_BODY_BYTES);unknown(payload,['version','fileName','mimeType','contentBase64']);
      if(!Number.isSafeInteger(payload.version)||payload.version<1)fail(422,'VERSION_REQUIRED','更換檔案必須提供正整數version');
      const file=validateAttachmentFile(payload,fail);
      const result=idem(req,ctx,payload,()=>{if(!scopedRows(db,ctx,entity).some(item=>item.id===recordId))fail(404,'NOT_FOUND','找不到資料');const old=get(db,ctx.orgId,entity,recordId);if(old.version!==payload.version)fail(409,'VERSION_CONFLICT','附件已更新，請重新讀取');const data={...business(old),...attachmentFileMetadata(file)};validate(db,ctx,entity,data,old);const item=replace(db,ctx.orgId,entity,old,data);insertAttachmentFile(db,ctx,item,file);audit(db,ctx,'record.update',entity,item.id,{fields:['fileName','mimeType','sizeBytes','sha256'],version:item.version,operation:'replace-file'});return{status:200,value:{item:publicRecord(ctx,item)}};});
      return send(res,result.status,result.value);
     }
    }
    const employeeRecordIndexRoute=pathname.match(/^\/api\/employees\/([a-f0-9-]+)\/record-index$/);
    if(employeeRecordIndexRoute){
     guardEmployeeRecordIndexAccess(ctx);
     if(req.method!=='GET')fail(405,'METHOD_NOT_ALLOWED','員工保存紀錄索引僅支援唯讀GET');
     return send(res,200,readEmployeeRecordIndex(db,ctx,employeeRecordIndexRoute[1],url.searchParams));
    }
    const caseRecordIndexRoute=pathname.match(/^\/api\/cases\/([a-f0-9-]+)\/record-index$/);
    if(caseRecordIndexRoute){
     guardCaseRecordIndexAccess(ctx);
     if(req.method!=='GET')fail(405,'METHOD_NOT_ALLOWED','個案保存紀錄索引僅支援唯讀GET');
     return send(res,200,readCaseRecordIndex(db,ctx,caseRecordIndexRoute[1],url.searchParams));
    }
    const match=pathname.match(/^\/api\/([a-z-]+)(?:\/([a-f0-9-]+))?(?:\/(review|history))?$/);if(match&&entities[match[1]]){
     const[,entity,recordId,action]=match;
     guardInterviewApplicantAccess(entity,ctx,req.method==='GET',fail);
     guardPersonnelAccess(entity,ctx,req.method==='GET',fail);
     guardContactAccess(entity,ctx,req.method==='GET',fail);
     guardCaseStatusFollowupAccess(entity,ctx,req.method==='GET',fail);
     guardAttachmentAccess(entity,ctx,req.method==='GET',fail);
     guardCertificationAttachmentAccess(entity,ctx,req.method==='GET',fail);
     if(entity==='case-attachments'&&req.method==='POST'&&!recordId)fail(405,'UPLOAD_REQUIRED','請使用附件上傳端點');
     if(isCertificationAttachmentEntity(entity)&&req.method==='POST'&&!recordId)fail(405,'UPLOAD_REQUIRED','請使用附件上傳端點');
     if(action==='history'&&req.method==='GET'){
      const comparisons=url.searchParams.getAll('compare');
      const compare=comparisons.length===0?undefined:comparisons.length===1?comparisons[0]:comparisons;
      const history=readHistory(db,ctx,entity,recordId,{compare});
      return send(res,200,paginate(history,pageParams(url)));
     }
     if(req.method==='GET'&&!action){const query={...interviewApplicantQuery(entity,url.searchParams,fail,dateValid),...personnelQuery(entity,url.searchParams,fail,dateValid),...contactQuery(entity,url.searchParams,fail),...caseStatusFollowupQuery(entity,url.searchParams,fail),...attachmentQuery(entity,url.searchParams,fail),...certificationAttachmentQuery(entity,url.searchParams,fail)};if(['case-status-followups','interview-applicants'].includes(entity))pageParams(url);if(query.certificationId)requireCertificationParent(db,ctx,query.certificationId,scopedRows,fail);let list=scopedRows(db,ctx,entity);if(entity==='employee-certifications')list=list.map(item=>certificationView(item,query.asOf));if(recordId){const item=list.find(x=>x.id===recordId);if(!item)fail(404,'NOT_FOUND','找不到資料');return send(res,200,{item});}let filtered=list;if(query.interviewDate)filtered=filtered.filter(item=>item.interviewDate===query.interviewDate);if(query.certificationId)filtered=filtered.filter(item=>item.certificationId===query.certificationId);if(query.expiry)filtered=filtered.filter(item=>item.expiryState===query.expiry);if(query.category)filtered=filtered.filter(item=>item.category===query.category);if(query.kind)filtered=filtered.filter(item=>item.kind===query.kind);for(const k of ['status','date','caseId','employeeId'])if(url.searchParams.has(k))filtered=filtered.filter(x=>x[k]===url.searchParams.get(k));const month=url.searchParams.get('month');if(month){if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))fail(422,'INVALID_MONTH','月份格式錯誤');filtered=filtered.filter(x=>{const value=x.date||x.validFrom||'';return typeof value==='string'&&value.startsWith(month);});}const q=(url.searchParams.get('q')||'').slice(0,200).toLowerCase();if(q)filtered=filtered.filter(x=>JSON.stringify(business(x)).toLowerCase().includes(q));return send(res,200,paginate(filtered,pageParams(url)));}
     if(entity==='service-records'&&action==='review'&&req.method==='POST'){
      if(!['admin','supervisor'].includes(ctx.role))fail(403,'ROLE_FORBIDDEN','僅管理者或督導可核閱');const data=await body(req);unknown(data,['version','decision','reviewNote']);if(!Number.isSafeInteger(data.version))fail(422,'VERSION_REQUIRED','必須提供version');if(!['approved','returned'].includes(data.decision))fail(422,'INVALID_DECISION','核閱結果不合法');if(typeof(data.reviewNote??'')!=='string'||(data.reviewNote||'').length>10000)fail(422,'INVALID_FIELD','核閱意見格式不符');
      const result=idem(req,ctx,data,()=>{const old=get(db,ctx.orgId,entity,recordId);if(!old)fail(404,'NOT_FOUND','找不到服務紀錄');if(old.version!==data.version)fail(409,'VERSION_CONFLICT','紀錄已更新');if(old.status!=='submitted')fail(409,'REVIEW_STATE','只有已提交紀錄可核閱');const updated={...business(old),status:data.decision,reviewNote:data.reviewNote||''};validate(db,ctx,entity,updated,old);if(data.decision==='approved')updated.billingSnapshot=billingSnapshot(db,ctx.orgId,updated);const item=replace(db,ctx.orgId,entity,old,updated);if(data.decision==='approved'){const shift=get(db,ctx.orgId,'shifts',old.shiftId);const completed=replace(db,ctx.orgId,'shifts',shift,{...business(shift),status:'completed'});audit(db,ctx,'shift.complete','shifts',completed.id,{version:completed.version});}audit(db,ctx,'service.review',entity,item.id,{decision:data.decision,version:item.version});return{status:200,value:{item:publicRecord(ctx,item)}};});return send(res,result.status,result.value);
     }
     if(req.method==='POST'&&!recordId){const payload=await body(req);const valid=validatePayload(entity,payload),data={...entities[entity].defaults,...valid};writeGuard(ctx,entity,data);if(entity==='service-records'&&!['draft','submitted'].includes(data.status))fail(422,'REVIEW_REQUIRED','新增紀錄僅允許草稿或提交');if(entity==='service-records'&&data.reviewNote)fail(422,'REVIEW_REQUIRED','核閱意見需由核閱流程建立');const result=idem(req,ctx,payload,()=>{validate(db,ctx,entity,data);const item=insert(db,ctx.orgId,entity,data);audit(db,ctx,'record.create',entity,item.id,{status:item.status,version:1});return{status:201,value:{item:publicRecord(ctx,item)}};});return send(res,result.status,result.value);}
     if(req.method==='PATCH'&&recordId&&!action){const payload=await body(req),patch=validatePayload(entity,payload,true);const result=transaction(()=>{const old=get(db,ctx.orgId,entity,recordId);if(!old)fail(404,'NOT_FOUND','找不到資料');if(isCertificationAttachmentEntity(entity)&&!scopedRows(db,ctx,entity).some(item=>item.id===recordId))fail(404,'NOT_FOUND','找不到資料');const data={...business(old),...patch};writeGuard(ctx,entity,data,old);if(old.version!==payload.version)fail(409,'VERSION_CONFLICT','資料已更新，請重新讀取');if(entity==='service-records'){if(['submitted','approved'].includes(old.status))fail(409,'RECORD_LOCKED','已提交或核閱的紀錄不可直接修改');if(!['draft','submitted','returned'].includes(data.status)||('reviewNote'in patch))fail(422,'REVIEW_REQUIRED','核閱結果或意見需由核閱流程建立');if(data.status==='returned'&&old.status!=='returned')fail(422,'REVIEW_REQUIRED','退回須經核閱流程');}validate(db,ctx,entity,data,old);const item=replace(db,ctx.orgId,entity,old,data);audit(db,ctx,'record.update',entity,item.id,{fields:Object.keys(patch),fromStatus:old.status,toStatus:data.status,version:item.version});return{item:publicRecord(ctx,item)};});return send(res,200,result);}
    }
    fail(404,'NOT_FOUND','找不到API或不支援此操作');
   }
   if(!['GET','HEAD'].includes(req.method))fail(405,'METHOD_NOT_ALLOWED','不支援此方法');
   if(pathname.split('/').includes('..')||pathname.split('/').some(x=>x.startsWith('.')))fail(404,'NOT_FOUND','找不到頁面');
   const staticPath=path.resolve(publicRoot,'.'+pathname);if(staticPath!==publicRoot&&!staticPath.startsWith(publicRoot+path.sep))fail(404,'NOT_FOUND','找不到頁面');
   let file=staticPath;if(!existsSync(file)||statSync(file).isDirectory()){if(path.extname(pathname))fail(404,'NOT_FOUND','找不到檔案');file=path.join(publicRoot,'index.html');}
   if(!existsSync(file)||!realpathSync(file).startsWith(realpathSync(publicRoot)+path.sep))fail(404,'NOT_FOUND','找不到檔案');
   const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.json':'application/json; charset=utf-8'};res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'});return res.end(req.method==='HEAD'?undefined:readFileSync(file));
  }catch(e){if(res.headersSent){res.end();return;}const status=e instanceof HttpError?e.status:500;if(status===500)console.error('Request failed:',portal.mode==='portal'?'PORTAL_REQUEST_FAILED':e.message);send(res,status,{error:{code:e.code||'INTERNAL_ERROR',message:status===500?'系統錯誤，請稍後再試':e.message,...(e.fields?{fields:e.fields}:{}),...(e instanceof HttpError&&e.details?{details:e.details}:{})}});}
 });
 server.requestTimeout=15000;server.headersTimeout=10000;server.maxHeadersCount=50;
 return{server,db,dbPath:databasePath,async listen(){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.off('error',reject);resolve();});});return`http://${host}:${server.address().port}`;},async close(){if(closed)return;closed=true;if(server.listening)await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));db.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const app=createApp({portalConfig:portalConfigFromEnv(process.env)});const url=await app.listen();console.log(`歲悅居家照顧本機測試版：${url}`);const stop=()=>app.close().then(()=>process.exit(0));process.on('SIGINT',stop);process.on('SIGTERM',stop);}
