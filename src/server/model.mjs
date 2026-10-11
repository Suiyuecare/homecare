import { entitySpan, assertSpanPayload, coversOriginalDateBounds, assertSpanServiceValidity, capturedEntityMinutes, SPAN_END_FIELDS, readSpanDependencyRows } from './shift-span.mjs';
import { spansOverlap } from '../../public/data/shift-span.js';
import { isGuardedStoredEntity, guardedStoredRows, guardedStoredGet } from './guarded-records.mjs';
import { internalNotificationEntities, isInternalNotificationEntity, guardInternalNotificationAccess, normalizeInternalNotificationPayload, assertInternalNotificationPayload, validateInternalNotification, internalNotificationVisible, publicInternalNotification } from './internal-notifications.mjs';
import { substitutionEntities, isSubstitutionEntity, guardSubstitutionAccess, substitutionVisible } from './shift-substitution.mjs';
import { contractDeadlineEntities, isContractDeadlineEntity, guardContractDeadlineAccess, normalizeContractDeadlinePayload, assertContractDeadlinePayload, validateContractDeadline, contractDeadlineVisible } from './contract-deadlines.mjs';
import { caseFamilyEntities, isCaseFamilyEntity, guardCaseFamilyAccess, normalizeCaseFamilyPayload, validateCaseFamily, caseFamilyRecordVisible } from './case-family.mjs';
import { attendanceExceptionEntities, isAttendanceExceptionEntity, guardAttendanceExceptionAccess, normalizeAttendanceExceptionPayload, assertAttendanceExceptionTransitionPayload, validateAttendanceException, attendanceExceptionVisible } from './attendance-exceptions.mjs';
import { interviewExtensionSpec, isInterviewExtensionEntity, normalizeExtendedInterviewPayload, assertInterviewExtensionPayload, validateInterviewExtension, interviewExtensionVisible, projectInterviewReadRecord } from './interview-extension.mjs';
import { caseContactFootprintEntities, isCaseContactFootprintEntity, guardCaseContactFootprintAccess, normalizeCaseContactFootprintPayload, validateCaseContactFootprint, caseContactFootprintHistoryVisible } from './case-contact-footprints.mjs';
import { institutionHolidayEntities, isInstitutionHolidayEntity, guardInstitutionHolidayAccess, normalizeInstitutionHolidayPayload, validateInstitutionHoliday, institutionHolidayVisible } from './institution-holidays.mjs';
import { trainingCreditEntities, isTrainingCreditEntity, guardTrainingCreditAccess, normalizeTrainingCreditPayload, assertTrainingCreditTransitionPayload, validateTrainingCredit, trainingCreditVisible } from './training-credits.mjs';
import { shiftSeriesEntities } from './shift-series-schema.mjs';
import { isShiftSeriesEntity, guardShiftSeriesAccess, normalizeShiftSeriesPayload, validateShiftSeries, shiftSeriesHistoryVisible, assertShiftSeriesShiftEdit, excludeShiftSeriesMoveOldPosition } from './shift-series.mjs';
import { contractsTasksEntities, isContractsTasksEntity, guardContractsTasksAccess, normalizeContractsTasksPayload, assertContractsTasksTransitionPayload, validateContractsTasks, contractsTasksVisible } from './contracts-tasks.mjs';
import { customFormEntities, isCustomFormEntity, guardCustomFormAccess, normalizeCustomFormPayload, validateCustomForm, customFormVisible } from './custom-forms.mjs';
import { caseHealthEntities, isCaseHealthEntity, guardCaseHealthAccess, normalizeCaseHealthPayload, validateCaseHealth } from './case-health.mjs';
import { claimBatchEntities, isClaimBatchEntity, guardClaimBatchAccess, normalizeClaimBatchPayload, assertClaimBatchTransitionPayload, validateClaimBatch, claimBatchVisible } from './claim-batches.mjs';
import { randomUUID } from 'node:crypto';
import { billingDocumentEntities, isBillingDocumentEntity, guardBillingDocumentAccess, normalizeBillingDocumentPayload, assertBillingDocumentTransitionPayload, validateBillingDocument, billingDocumentVisible } from './billing-documents.mjs';
import { payrollStatementEntities, isPayrollStatementEntity, guardPayrollStatementAccess, normalizePayrollStatementPayload, assertPayrollStatementTransitionPayload, validatePayrollStatement, payrollStatementVisible } from './payroll-statements.mjs';
import { businessRuleEntities, isBusinessRuleEntity, guardBusinessRuleAccess, normalizeBusinessRulePayload, validateBusinessRule } from './business-rules.mjs';
import { caseSupportEntities, isCaseSupportEntity, normalizeCaseSupportPayload, validateCaseSupport, guardCaseSupportAccess } from './case-support.mjs';
import { institutionAdminEntities, isInstitutionAdminEntity, normalizeInstitutionAdminPayload, validateInstitutionAdmin, guardInstitutionAdminAccess } from './institution-admin.mjs';
import { personalCalendarEntities, isPersonalCalendarEntity, guardPersonalCalendarAccess, personalCalendarOwned, personalCalendarReader, validatePersonalCalendar } from './personal-calendar.mjs';
import { interviewApplicantEntities, isInterviewApplicantEntity, normalizeInterviewApplicantPayload, validateInterviewApplicant, guardInterviewApplicantAccess } from './interview-applicants.mjs';
import { personnelEntities, isPersonnelEntity, normalizePersonnelPayload, validatePersonnel, guardPersonnelAccess } from './personnel.mjs';
import { contactEntities, isContactEntity, normalizeContactPayload, validateContact, guardContactAccess } from './contacts.mjs';
import { caseStatusFollowupEntities, isCaseStatusFollowupEntity, normalizeCaseStatusFollowupPayload, validateCaseStatusFollowup, guardCaseStatusFollowupAccess } from './case-status-followups.mjs';
import { attachmentEntities, isAttachmentEntity, initAttachmentStorage, normalizeAttachmentPayload, validateAttachment, guardAttachmentAccess } from './attachments.mjs';
import { certificationAttachmentEntities, isCertificationAttachmentEntity, initCertificationAttachmentStorage, normalizeCertificationAttachmentPayload, validateCertificationAttachment, guardCertificationAttachmentAccess, readableCertificationParents, certificationAttachmentVisible, requireCertificationParent } from './certification-attachments.mjs';
export class HttpError extends Error { constructor(status,code,message,fields){super(message);this.status=status;this.code=code;this.fields=fields;} }
export const fail=(status,code,message,fields)=>{throw new HttpError(status,code,message,fields);};
export const now=()=>new Date().toISOString();
export const id=()=>randomUUID();
export const entities={
 ...internalNotificationEntities,
 ...substitutionEntities,
 ...contractDeadlineEntities,
 ...caseFamilyEntities,
 ...attendanceExceptionEntities,
 ...caseContactFootprintEntities,
 ...institutionHolidayEntities,
 ...trainingCreditEntities,
 ...contractsTasksEntities,
 ...shiftSeriesEntities,
 ...customFormEntities,
 ...claimBatchEntities,
 ...billingDocumentEntities,
 ...payrollStatementEntities,
 ...businessRuleEntities,
 ...caseSupportEntities,
 ...caseHealthEntities,
 ...institutionAdminEntities,
 ...personalCalendarEntities,
 ...interviewApplicantEntities,
 'interview-applicants':interviewExtensionSpec,
 ...personnelEntities,
 ...contactEntities,
 ...caseStatusFollowupEntities,
 ...attachmentEntities,
 ...certificationAttachmentEntities,
 employees:{fields:'name employeeNo role phone email status qualification regions note hourlyRateCents',required:['name','employeeNo'],statuses:['active','inactive'],defaults:{status:'active',hourlyRateCents:0,regions:''}},
 cases:{fields:'name caseNo birthDate gender phone address status cmsLevel welfare supervisorId primaryCarer contactName contactPhone note',required:['name','caseNo'],statuses:['active','paused','closed'],defaults:{status:'active'}},
 'service-items':{fields:'code name minutes unitPriceCents validFrom validTo status note',required:['code','name','minutes','unitPriceCents'],statuses:['active','inactive'],defaults:{status:'active'}},
 'care-plans':{fields:'caseId validFrom validTo status services goals note',required:['caseId','validFrom','validTo','services'],statuses:['draft','active','ended'],defaults:{status:'draft',services:[]}},
 shifts:{fields:'caseId employeeId carePlanId date startTime endTime services status note endDate',required:['caseId','employeeId','carePlanId','date','startTime','endTime','services'],statuses:['scheduled','completed','cancelled'],defaults:{status:'scheduled',services:[]}},
 'service-records':{fields:'shiftId caseId employeeId date actualStart actualEnd services status note reviewNote actualEndDate',required:['shiftId','caseId','employeeId','date','actualStart','actualEnd','services'],statuses:['draft','submitted','approved','returned'],defaults:{status:'draft',services:[]}},
 'leave-requests':{fields:'employeeId date startTime endTime type reason status endDate',required:['employeeId','date','startTime','endTime','type'],statuses:['pending','approved','rejected','cancelled'],defaults:{status:'pending'}},
 assessments:{fields:'caseId templateId date answers status',required:['caseId','templateId','date'],statuses:['draft','submitted'],defaults:{status:'draft',answers:{}}},
 announcements:{fields:'title body audience status',required:['title','body'],statuses:['draft','published'],defaults:{status:'draft',audience:'all'}}
};
export function initDb(db,{configureJournalMode=true}={}){
 db.exec(`PRAGMA foreign_keys=ON; ${configureJournalMode?'PRAGMA journal_mode=WAL;':''} PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS memberships(org_id TEXT NOT NULL REFERENCES organizations(id),user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL,employee_id TEXT,PRIMARY KEY(org_id,user_id));
 CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),entity TEXT NOT NULL,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS records_org_entity ON records(org_id,entity);
 CREATE TABLE IF NOT EXISTS record_versions(org_id TEXT NOT NULL REFERENCES organizations(id),entity TEXT NOT NULL,record_id TEXT NOT NULL REFERENCES records(id),version INTEGER NOT NULL,snapshot TEXT NOT NULL,created_at TEXT NOT NULL,source TEXT NOT NULL,PRIMARY KEY(record_id,version));
 CREATE INDEX IF NOT EXISTS versions_org_record ON record_versions(org_id,entity,record_id);
 CREATE TRIGGER IF NOT EXISTS versions_no_update BEFORE UPDATE ON record_versions BEGIN SELECT RAISE(ABORT,'Version history is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS versions_no_delete BEFORE DELETE ON record_versions BEGIN SELECT RAISE(ABORT,'Version history is immutable'); END;
 CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,org_id TEXT REFERENCES organizations(id),user_id TEXT,action TEXT NOT NULL,entity TEXT,record_id TEXT,detail TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS audit_org_time ON audit(org_id,created_at);
 CREATE TABLE IF NOT EXISTS idempotency(org_id TEXT NOT NULL,user_id TEXT NOT NULL,key TEXT NOT NULL,route TEXT NOT NULL,hash TEXT NOT NULL,response TEXT NOT NULL,status INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(org_id,user_id,key));
 CREATE TABLE IF NOT EXISTS demo_seeds(org_id TEXT PRIMARY KEY REFERENCES organizations(id),created_at TEXT NOT NULL);`);
 initAttachmentStorage(db);
 initCertificationAttachmentStorage(db);
 for(const r of db.prepare('SELECT r.* FROM records r WHERE NOT EXISTS (SELECT 1 FROM record_versions v WHERE v.record_id=r.id AND v.version=r.version)').all())saveVersion(db,decode(r),'baseline');
}
export const decode=r=>r?{...JSON.parse(r.data),id:r.id,orgId:r.org_id,version:r.version,createdAt:r.created_at,updatedAt:r.updated_at}:null;
function strictSpanOrganization(db,org){for(const entity of Object.keys(SPAN_END_FIELDS)){const field=SPAN_END_FIELDS[entity];for(const row of db.prepare('SELECT data FROM records WHERE org_id=? AND entity=?').all(org,entity)){try{const data=JSON.parse(row.data);if(data&&typeof data==='object'&&Object.hasOwn(data,field))return true;}catch{}}
 for(const row of db.prepare('SELECT snapshot,source FROM record_versions WHERE org_id=? AND entity=?').all(org,entity)){if(['span-create','span-update'].includes(row.source))return true;try{const snapshot=JSON.parse(row.snapshot);if(snapshot&&typeof snapshot==='object'&&Object.hasOwn(snapshot,field))return true;}catch{}}}return false;}
function spanStoredRows(db,org,entity){const spec=entities[entity];return readSpanDependencyRows(db,org,entity,{fields:[...spec.fields.split(' '),...(entity==='service-records'?['billingSnapshot']:[])],required:spec.required,statuses:spec.statuses,fail,assertExtra:item=>{const data=Object.fromEntries(Object.entries(business(item)).filter(([key])=>key!=='billingSnapshot'));validatePayload(entity,data);if(Object.hasOwn(item,SPAN_END_FIELDS[entity])&&['employeeId',...(entity==='leave-requests'?[]:['caseId']),...(entity==='service-records'?['shiftId']:[])].some(key=>typeof item[key]!=='string'||!item[key].trim()||item[key]!==item[key].trim()||/[\r\n]/.test(item[key])))fail(409,'SPAN_DATA_INVALID','明確日期時段的保存身份無法確認');}});}
export const rows=(db,org,entity)=>SPAN_END_FIELDS[entity]&&strictSpanOrganization(db,org)?spanStoredRows(db,org,entity):isGuardedStoredEntity(entity)?guardedStoredRows(db,org,entity):db.prepare('SELECT * FROM records WHERE org_id=? AND entity=? ORDER BY created_at DESC,id').all(org,entity).map(decode);
export const get=(db,org,entity,recordId)=>SPAN_END_FIELDS[entity]&&strictSpanOrganization(db,org)?spanStoredRows(db,org,entity).find(item=>item.id===recordId)||null:isGuardedStoredEntity(entity)?guardedStoredGet(db,org,entity,recordId):decode(db.prepare('SELECT * FROM records WHERE org_id=? AND entity=? AND id=?').get(org,entity,recordId));
export function audit(db,ctx,action,entity,recordId,detail={}){db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run(id(),ctx?.orgId||null,ctx?.user?.id||null,action,entity||null,recordId||null,JSON.stringify(detail),now());}
export function saveVersion(db,item,source='update'){const entity=db.prepare('SELECT entity FROM records WHERE id=?').get(item.id).entity;db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(item.orgId,entity,item.id,item.version,JSON.stringify(item),item.updatedAt,source);}
export function insert(db,org,entity,data){const item={...data,id:id(),orgId:org,version:1,createdAt:now(),updatedAt:now()};db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id,org,entity,JSON.stringify(data),1,item.createdAt,item.updatedAt);saveVersion(db,item,SPAN_END_FIELDS[entity]&&Object.hasOwn(data,SPAN_END_FIELDS[entity])?'span-create':'create');return item;}
export function replace(db,org,entity,old,data){const time=now();const result=db.prepare('UPDATE records SET data=?,version=version+1,updated_at=? WHERE id=? AND org_id=? AND entity=? AND version=?').run(JSON.stringify(data),time,old.id,org,entity,old.version);if(!result.changes)fail(409,'VERSION_CONFLICT','資料已更新，請重新讀取後再操作');const item={...data,id:old.id,orgId:org,version:old.version+1,createdAt:old.createdAt,updatedAt:time};saveVersion(db,item,SPAN_END_FIELDS[entity]&&Object.hasOwn(data,SPAN_END_FIELDS[entity])?'span-update':'update');return item;}
export const business=item=>Object.fromEntries(Object.entries(item).filter(([k])=>!['id','orgId','version','createdAt','updatedAt'].includes(k)));
export const dateValid=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
export function timeMinute(v,date){if(typeof v!=='string')return NaN;if(/^\d{2}:\d{2}$/.test(v)){const [h,m]=v.split(':').map(Number);return h<24&&m<60?h*60+m:NaN;}if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)&&v.slice(0,10)===date&&Number.isFinite(Date.parse(v)))return timeMinute(v.slice(11,16),date);return NaN;}
export function interval(start,end,date){const a=timeMinute(start,date),b=timeMinute(end,date);if(!Number.isFinite(a)||!Number.isFinite(b)||b<=a)fail(422,'TIME_RANGE','結束時間必須晚於開始時間，且須為同日有效時間');return [a,b];}
export const overlaps=(a,b,c,d)=>a<d&&c<b;
// Preserve source order and lazy first-hit behavior for the approval write guard.
// Read-only callers may consume the entire generator before projecting results.
export function* leaveShiftConflicts(leave,shifts,leaveInterval){
 if(!Object.hasOwn(leave,'endDate')&&shifts.every(shift=>!Object.hasOwn(shift,'endDate'))){const [start,end]=leaveInterval||interval(leave.startTime,leave.endTime,leave.date);for(const shift of shifts.filter(x=>x.date===leave.date&&x.employeeId===leave.employeeId&&x.status!=='cancelled')){const [a,b]=interval(shift.startTime,shift.endTime,shift.date);if(overlaps(start,end,a,b))yield shift;}return;}
 const range=entitySpan('leave-requests',leave,fail);for(const shift of shifts.filter(x=>x.employeeId===leave.employeeId&&x.status!=='cancelled'))if(spansOverlap(range,entitySpan('shifts',shift,fail)))yield shift;
}

const isObject=x=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
export function validatePayload(entity,payload,patch=false){
 assertSpanPayload(entity,payload,fail);
 const spec=entities[entity];if(!spec)fail(404,'NOT_FOUND','找不到資料類型');if(!isObject(payload))fail(400,'INVALID_BODY','請提供JSON物件');
 payload=normalizeInternalNotificationPayload(entity,payload);
 assertInternalNotificationPayload(entity,payload,fail);
 payload=normalizeContractDeadlinePayload(entity,payload);
 assertContractDeadlinePayload(entity,payload,fail,patch);
 payload=normalizeCaseFamilyPayload(entity,payload);
 payload=normalizeAttendanceExceptionPayload(entity,payload);
 assertAttendanceExceptionTransitionPayload(entity,payload,fail);
 payload=normalizeCaseContactFootprintPayload(entity,payload);
 payload=normalizeInstitutionHolidayPayload(entity,payload);
 payload=normalizeTrainingCreditPayload(entity,payload);
 assertTrainingCreditTransitionPayload(entity,payload,fail);
 payload=normalizeShiftSeriesPayload(entity,payload);
 payload=normalizeCustomFormPayload(entity,payload);
 payload=normalizeContractsTasksPayload(entity,payload);
 assertContractsTasksTransitionPayload(entity,payload,fail);
 payload=normalizeClaimBatchPayload(entity,payload);
 assertClaimBatchTransitionPayload(entity,payload,fail);
 payload=normalizeBillingDocumentPayload(entity,payload);
 assertBillingDocumentTransitionPayload(entity,payload,fail);
 payload=normalizePayrollStatementPayload(entity,payload);
 assertPayrollStatementTransitionPayload(entity,payload,fail);
 payload=normalizeBusinessRulePayload(entity,payload);
 payload=normalizeCaseSupportPayload(entity,payload);
 payload=normalizeCaseHealthPayload(entity,payload);
 payload=normalizeInstitutionAdminPayload(entity,payload);
 payload=normalizeExtendedInterviewPayload(entity,payload);
 assertInterviewExtensionPayload(entity,payload,fail,patch);
 payload=normalizePersonnelPayload(entity,payload);
 payload=normalizeContactPayload(entity,payload);
 payload=normalizeCaseStatusFollowupPayload(entity,payload);
 payload=normalizeAttachmentPayload(entity,payload);
 payload=normalizeCertificationAttachmentPayload(entity,payload);
 const allowed=spec.fields.split(' ').concat(patch?['version']:[]);for(const k of Object.keys(payload))if(!allowed.includes(k))fail(422,'UNKNOWN_FIELD','不允許的欄位：'+k,{[k]:'未知欄位'});
 if(patch&&(!Number.isSafeInteger(payload.version)||payload.version<1))fail(422,'VERSION_REQUIRED','更新必須提供正整數version');
 for(const [k,v] of Object.entries(payload)){
  if(k==='version')continue;
  if(['services','answers','regions'].includes(k)||spec.jsonFields?.includes(k))continue;
  if(spec.integerFields?.includes(k)){if(!Number.isSafeInteger(v)||v<1)fail(422,'INVALID_NUMBER','版次或週期須為正整數',{[k]:'正整數'});}
  else if(['minutes','unitPriceCents','hourlyRateCents','cmsLevel','trainingMinutes'].includes(k)){if(v===''&&k==='cmsLevel')continue;if(!Number.isSafeInteger(v)||v<0||v>1e9)fail(422,'INVALID_NUMBER','數字欄位必須是合理範圍的非負整數',{[k]:'整數'});}
  else if(typeof v!=='string'||v.length>(spec.maxLengths?.[k]??(['body','note','goals','reviewNote','reason'].includes(k)||(isInterviewApplicantEntity(entity)&&k==='interviewContent')?10000:500)))fail(422,'INVALID_FIELD','欄位格式或長度不符',{[k]:'請檢查格式與長度'});
 }
 if(payload.regions!==undefined&&!(typeof payload.regions==='string'&&payload.regions.length<=1000)&&!(Array.isArray(payload.regions)&&payload.regions.length<=50&&payload.regions.every(x=>typeof x==='string'&&x.length<100)))fail(422,'INVALID_FIELD','regions必須是文字或文字陣列');
 if(payload.answers!==undefined&&(!isObject(payload.answers)||JSON.stringify(payload.answers).length>(spec.maxAnswersLength??50000)))fail(422,'INVALID_FIELD','answers必須是有限大小的物件');
 return Object.fromEntries(Object.entries(payload).filter(([k])=>k!=='version'));
}
export function validate(db,ctx,entity,d,old=null){
 if(SPAN_END_FIELDS[entity]&&(Object.hasOwn(d,SPAN_END_FIELDS[entity])||strictSpanOrganization(db,ctx.orgId)))for(const dependency of ['shifts','leave-requests','service-records'])spanStoredRows(db,ctx.orgId,dependency);
 if(SPAN_END_FIELDS[entity]&&old?.version===Number.MAX_SAFE_INTEGER)fail(409,'VERSION_LIMIT','保存版次已達安全上限');
 if(isGuardedStoredEntity(entity)&&old?.version===Number.MAX_SAFE_INTEGER)fail(409,'VERSION_LIMIT','保存版次已達安全上限，請核對資料');
 validateInternalNotification(db,ctx,entity,d,old,fail,get);
 validateContractDeadline(db,ctx,entity,d,old,fail,rows,get,contractsTasksVisible);
 validateCaseFamily(db,ctx,entity,d,old,fail,get,rows);
 validateAttendanceException(db,ctx,entity,d,old,fail,get);
 validateCaseContactFootprint(entity,d,old,fail,dateValid,db,ctx,get);
 validateInstitutionHoliday(db,ctx,entity,d,old,fail,dateValid,rows);
 validateTrainingCredit(db,ctx,entity,d,old,fail,get);
 validateShiftSeries(db,ctx,entity,d,old,fail);
 validateCustomForm(db,ctx,entity,d,old,fail,get,rows);
 validateContractsTasks(db,ctx,entity,d,old,fail,dateValid,rows,get);
 validateClaimBatch(db,ctx,entity,d,old,fail,dateValid,rows,get);
 validateBillingDocument(db,ctx,entity,d,old,fail,dateValid,rows,get);
 validatePayrollStatement(db,ctx,entity,d,old,fail,dateValid,rows,get);
 validateBusinessRule(db,ctx,entity,d,old,fail,dateValid,rows);
 validateCaseSupport(entity,d,old,fail,dateValid,db,ctx,get);
 validateCaseHealth(entity,d,old,fail,dateValid,db,ctx,get);
 validateInstitutionAdmin(db,ctx,entity,d,old,fail,dateValid,get);
 validatePersonalCalendar(entity,d,old,ctx,fail,dateValid);
 validateInterviewApplicant(entity,d,fail,dateValid);
 validateInterviewExtension(db,ctx,entity,d,old,fail,get);
 validateContact(entity,d,old,fail);
 validateCaseStatusFollowup(entity,d,old,fail,dateValid);
 validateAttachment(entity,d,old,fail);
 validateCertificationAttachment(entity,d,old,fail);
 const spec=entities[entity];for(const field of spec.required)if(d[field]===undefined||d[field]===null||d[field]===''||(Array.isArray(d[field])&&!d[field].length))fail(422,'REQUIRED','請填寫必要欄位',{[field]:'必填'});
 if(!spec.statuses.includes(d.status))fail(422,'INVALID_STATUS','不支援的狀態');
 validatePersonnel(entity,d,old,fail,dateValid);
 if(isCertificationAttachmentEntity(entity)){const parent=requireCertificationParent(db,ctx,d.certificationId,scopedRows,fail);if(d.employeeId!==parent.employeeId)fail(404,'NOT_FOUND','找不到可讀取的證照附件');}
 for(const k of ['date','birthDate','validFrom','validTo'])if(d[k]&&!dateValid(d[k]))fail(422,'INVALID_DATE','日期必須為有效YYYY-MM-DD',{[k]:'日期格式錯誤'});
 if(d.validFrom&&d.validTo&&d.validFrom>d.validTo)fail(422,'DATE_RANGE','結束日期不可早於開始日期');
 if(d.minutes!==undefined&&(d.minutes<1||d.minutes>1440))fail(422,'INVALID_NUMBER','服務分鐘數必須介於1至1440');
 if(d.cmsLevel!==undefined&&d.cmsLevel!==''&&(d.cmsLevel<1||d.cmsLevel>8))fail(422,'INVALID_NUMBER','CMS等級必須介於1至8');
 const ref=(kind,key)=>{if(d[key]===undefined||d[key]===null||d[key]==='')return null;if(typeof d[key]!=='string')fail(422,'INVALID_REFERENCE','關聯資料不存在或不屬於本機構',{[key]:'同機構關聯必要'});const r=get(db,ctx.orgId,kind,d[key]);if(!r)fail(422,'INVALID_REFERENCE','關聯資料不存在或不屬於本機構',{[key]:'同機構關聯必要'});return r;};
 const employee=ref('employees','employeeId'),caseItem=ref('cases','caseId'),supervisor=ref('employees','supervisorId');void supervisor;
 if(entity==='cases'&&d.primaryCarer){/* A descriptive primary-carer contact, not a declared foreign key. */}
 const plan=ref('care-plans','carePlanId'),shift=ref('shifts','shiftId');
 if(d.services!==undefined){if(!Array.isArray(d.services)||!d.services.length||d.services.length>100)fail(422,'INVALID_SERVICES','請設定1至100個服務項目');const seen=new Set();for(const s of d.services){if(!isObject(s)||Object.keys(s).some(k=>!['serviceItemId','quantity'].includes(k))||typeof s.serviceItemId!=='string'||!Number.isSafeInteger(s.quantity)||s.quantity<1||s.quantity>10000||seen.has(s.serviceItemId))fail(422,'INVALID_SERVICES','服務項目、正整數數量或重複項目不合法');seen.add(s.serviceItemId);const it=get(db,ctx.orgId,'service-items',s.serviceItemId);if(!it)fail(422,'INVALID_REFERENCE','服務項目不存在或不屬於本機構');if(['shifts','service-records'].includes(entity)){if(it.status!=='active')fail(422,'INACTIVE_SERVICE','服務項目未啟用或不在有效期間');assertSpanServiceValidity(entity,d,it,fail);}}}
 const uniqueKey=entity==='employees'?'employeeNo':entity==='cases'?'caseNo':entity==='service-items'?'code':null;
 if(uniqueKey&&rows(db,ctx.orgId,entity).some(x=>x.id!==old?.id&&x[uniqueKey]===d[uniqueKey]))fail(409,'DUPLICATE_CODE','同機構編號已存在');
 if(entity==='shifts'){
  assertShiftSeriesShiftEdit(db,ctx,entity,d,old);
  const range=entitySpan('shifts',d,fail);
  if(d.status!=='cancelled'){
   if(caseItem.status!=='active'||employee.status!=='active')fail(422,'INACTIVE_ASSIGNMENT','個案與員工必須啟用');
   if(plan.caseId!==d.caseId||plan.status!=='active'||!coversOriginalDateBounds(range,plan.validFrom,plan.validTo,fail))fail(422,'INVALID_PLAN','排班必須對應涵蓋服務日的有效個案計畫');
   if(d.services.some(s=>!plan.services.some(x=>x.serviceItemId===s.serviceItemId)))fail(422,'PLAN_SERVICE','排班服務項目不在照顧計畫內');
   if(!Object.hasOwn(d,'endDate')&&!strictSpanOrganization(db,ctx.orgId)){
    const [start,end]=interval(d.startTime,d.endTime,d.date);
    for(const x of rows(db,ctx.orgId,'shifts').filter(x=>x.id!==old?.id&&!excludeShiftSeriesMoveOldPosition(db,ctx,old,d,x)&&x.status!=='cancelled'&&x.date===d.date&&(x.employeeId===d.employeeId||x.caseId===d.caseId))){const [a,b]=interval(x.startTime,x.endTime,x.date);if(overlaps(start,end,a,b))fail(409,'SHIFT_CONFLICT','員工或個案已有重疊班次');}
    for(const x of rows(db,ctx.orgId,'leave-requests').filter(x=>x.employeeId===d.employeeId&&x.date===d.date&&x.status==='approved')){const [a,b]=interval(x.startTime,x.endTime,x.date);if(overlaps(start,end,a,b))fail(409,'LEAVE_CONFLICT','時段與已核准請假重疊');}
   }else{
   for(const x of rows(db,ctx.orgId,'shifts').filter(x=>x.id!==old?.id&&!excludeShiftSeriesMoveOldPosition(db,ctx,old,d,x)&&x.status!=='cancelled'&&(x.employeeId===d.employeeId||x.caseId===d.caseId))){if(spansOverlap(range,entitySpan('shifts',x,fail)))fail(409,'SHIFT_CONFLICT','員工或個案已有重疊班次');}
   for(const x of rows(db,ctx.orgId,'leave-requests').filter(x=>x.employeeId===d.employeeId&&x.status==='approved')){if(spansOverlap(range,entitySpan('leave-requests',x,fail)))fail(409,'LEAVE_CONFLICT','時段與已核准請假重疊');}
   }
  }
  const record=rows(db,ctx.orgId,'service-records').find(x=>x.shiftId===old?.id);
  if(record&&['caseId','employeeId','carePlanId','date','startTime','endTime','endDate','services','status'].some(k=>JSON.stringify(d[k])!==JSON.stringify(old[k])))fail(409,'SHIFT_HAS_RECORD','班次已有服務紀錄，不能改寫關聯、時段、服務或狀態');
  if(d.status==='completed'&&(!old||old.status!=='completed'))fail(422,'REVIEW_REQUIRED','班次須由服務核閱完成');
 }
 if(entity==='service-records'){
  const recordRange=entitySpan('service-records',d,fail);
  if(!shift||shift.status==='cancelled'||shift.caseId!==d.caseId||shift.employeeId!==d.employeeId||shift.date!==d.date)fail(422,'SHIFT_MISMATCH','服務紀錄必須與有效班次的個案、員工、日期一致');
  if(caseItem.status!=='active'||employee.status!=='active')fail(422,'INACTIVE_ASSIGNMENT','個案與員工必須啟用');
  const currentPlan=get(db,ctx.orgId,'care-plans',shift.carePlanId);
  if(!currentPlan||currentPlan.status!=='active'||!coversOriginalDateBounds(recordRange,currentPlan.validFrom,currentPlan.validTo,fail)||currentPlan.caseId!==d.caseId)fail(422,'INVALID_PLAN','服務紀錄的照顧計畫已失效');
  if(d.services.some(s=>!shift.services.some(x=>x.serviceItemId===s.serviceItemId)||!currentPlan.services.some(x=>x.serviceItemId===s.serviceItemId)))fail(422,'PLAN_SERVICE','紀錄服務必須包含於班次及計畫');
  if(rows(db,ctx.orgId,entity).some(x=>x.id!==old?.id&&x.shiftId===d.shiftId))fail(409,'DUPLICATE_RECORD','同一班次已有服務紀錄');
 }
 if(entity==='leave-requests'){
  entitySpan('leave-requests',d,fail);
  if(d.status==='approved'&&!leaveShiftConflicts(d,rows(db,ctx.orgId,'shifts')).next().done)fail(409,'SHIFT_CONFLICT','核准請假前須先處理重疊班次');
 }
 if(entity==='care-plans'&&old){for(const s of rows(db,ctx.orgId,'shifts').filter(x=>x.carePlanId===old.id&&x.status==='scheduled'))if(d.caseId!==s.caseId||d.status!=='active'||!coversOriginalDateBounds(entitySpan('shifts',s,fail),d.validFrom,d.validTo,fail)||s.services.some(v=>!d.services.some(x=>x.serviceItemId===v.serviceItemId)))fail(409,'PLAN_IN_USE','計畫已有班次，請先調整相關班次');}
}
export function publicRecord(ctx,item){const{fileId,...publicItem}=item;if(['admin','finance'].includes(ctx.role))return publicItem;const{billingSnapshot,...safe}=publicItem;return safe;}
export function scopedRows(db,ctx,entity){
 guardInternalNotificationAccess(entity,ctx,true,fail);
 if(isInternalNotificationEntity(entity))return rows(db,ctx.orgId,entity).filter(item=>internalNotificationVisible(db,ctx,item,get)).map(item=>publicInternalNotification(ctx,item));
 guardSubstitutionAccess(entity,ctx,true,fail);
 guardContractDeadlineAccess(entity,ctx,true,fail);
 guardCaseFamilyAccess(entity,ctx,true,fail);
 guardAttendanceExceptionAccess(entity,ctx,true,fail);
 guardCaseContactFootprintAccess(entity,ctx,true,fail);
 guardInstitutionHolidayAccess(entity,ctx,true,fail);
 guardTrainingCreditAccess(entity,ctx,true,fail);
 guardShiftSeriesAccess(entity,ctx,true,fail);
 guardCustomFormAccess(entity,ctx,true,fail);
 guardContractsTasksAccess(entity,ctx,true,fail);
 guardClaimBatchAccess(entity,ctx,true,fail);
 guardBillingDocumentAccess(entity,ctx,true,fail);
 guardPayrollStatementAccess(entity,ctx,true,fail);
 guardBusinessRuleAccess(entity,ctx,true,fail);
 guardCaseSupportAccess(entity,ctx,true,fail);
 guardCaseHealthAccess(entity,ctx,true,fail);
 guardInstitutionAdminAccess(entity,ctx,true,fail);
 guardPersonalCalendarAccess(entity,ctx,fail);
 guardInterviewApplicantAccess(entity,ctx,true,fail);
 guardPersonnelAccess(entity,ctx,true,fail);
 guardContactAccess(entity,ctx,true,fail);
 guardCaseStatusFollowupAccess(entity,ctx,true,fail);
 guardAttachmentAccess(entity,ctx,true,fail);
 guardCertificationAttachmentAccess(entity,ctx,true,fail);
 const all=rows(isPersonalCalendarEntity(entity)?personalCalendarReader(db):db,ctx.orgId,entity).map(x=>publicRecord(ctx,x));
 if(isSubstitutionEntity(entity))return all.filter(item=>substitutionVisible(db,ctx,entity,item,get));
 if(isContractDeadlineEntity(entity))return all.filter(item=>contractDeadlineVisible(db,ctx,entity,item,get,contractsTasksVisible));
 if(isCaseFamilyEntity(entity))return all.filter(item=>caseFamilyRecordVisible(db,ctx,entity,item,get));
 if(isAttendanceExceptionEntity(entity))return all.filter(item=>attendanceExceptionVisible(db,ctx,entity,item,get));
 if(isInterviewExtensionEntity(entity))return all.map(projectInterviewReadRecord).filter(item=>interviewExtensionVisible(db,ctx,entity,item,get));
 if(isCaseContactFootprintEntity(entity))return all.filter(item=>caseContactFootprintHistoryVisible(db,ctx,item,item,get,dateValid));
 if(isInstitutionHolidayEntity(entity))return all.filter(item=>institutionHolidayVisible(db,ctx,entity,item));
 if(isTrainingCreditEntity(entity))return all.filter(item=>trainingCreditVisible(db,ctx,entity,item,get));
 if(isShiftSeriesEntity(entity))return all.filter(item=>shiftSeriesHistoryVisible(db,ctx,item,item));
 if(isCustomFormEntity(entity))return all.filter(item=>customFormVisible(db,ctx,entity,item,get));
 if(isContractsTasksEntity(entity))return all.filter(item=>contractsTasksVisible(db,ctx,entity,item,get));
 if(isClaimBatchEntity(entity))return all.filter(item=>claimBatchVisible(db,ctx,entity,item,get));
 if(isBillingDocumentEntity(entity))return all.filter(x=>billingDocumentVisible(db,ctx,entity,x,get));
 if(isPayrollStatementEntity(entity))return all.filter(item=>payrollStatementVisible(db,ctx,entity,item,get));
 if(isInstitutionAdminEntity(entity)||isBusinessRuleEntity(entity))return all;
 if(isPersonalCalendarEntity(entity))return all.filter(x=>personalCalendarOwned(x,ctx));
 if(isCertificationAttachmentEntity(entity)){const parents=readableCertificationParents(db,ctx,scopedRows);return all.filter(x=>certificationAttachmentVisible(x,parents));}
 if(isContactEntity(entity)||isAttachmentEntity(entity)||isCaseStatusFollowupEntity(entity)||isCaseSupportEntity(entity)||isCaseHealthEntity(entity)){const visibleCases=new Set(scopedRows(db,ctx,'cases').map(x=>x.id));return all.filter(x=>visibleCases.has(x.caseId));}
 if(ctx.role!=='caregiver')return all;
 if(!ctx.employeeId)fail(403,'EMPLOYEE_LINK_REQUIRED','居服員帳號尚未連結有效員工');
 if(isPersonnelEntity(entity))return all.filter(x=>x.employeeId===ctx.employeeId);
 const ownShifts=rows(db,ctx.orgId,'shifts').filter(x=>x.employeeId===ctx.employeeId);const caseIds=new Set(ownShifts.map(x=>x.caseId));
 if(entity==='cases')return all.filter(x=>caseIds.has(x.id));
 if(['shifts','service-records','leave-requests'].includes(entity))return all.filter(x=>x.employeeId===ctx.employeeId);
 if(entity==='employees')return all.filter(x=>x.id===ctx.employeeId);
 if(entity==='care-plans')return all.filter(x=>caseIds.has(x.caseId));
 if(entity==='service-items'){const ids=new Set(ownShifts.flatMap(x=>x.services.map(s=>s.serviceItemId)));return all.filter(x=>ids.has(x.id));}
 if(entity==='announcements')return all.filter(x=>x.status==='published'&&['all','caregiver'].includes(x.audience));
 fail(403,'ROLE_FORBIDDEN','此角色無權讀取此資料');
}
export function writeGuard(ctx,entity,data,old){
 guardInternalNotificationAccess(entity,ctx,false,fail);
 if(isInternalNotificationEntity(entity))return;
 if(isSubstitutionEntity(entity))fail(405,'SUBSTITUTION_LOCKED','請使用明確提出及人工審核流程');
 guardContractDeadlineAccess(entity,ctx,false,fail);
 if(isContractDeadlineEntity(entity))return;
 guardCaseFamilyAccess(entity,ctx,false,fail);
 guardAttendanceExceptionAccess(entity,ctx,false,fail);
 if(isCaseFamilyEntity(entity)||isAttendanceExceptionEntity(entity))return;
 guardCaseContactFootprintAccess(entity,ctx,false,fail);
 guardInstitutionHolidayAccess(entity,ctx,false,fail);
 guardTrainingCreditAccess(entity,ctx,false,fail);
 if(isCaseContactFootprintEntity(entity)||isInstitutionHolidayEntity(entity)||isTrainingCreditEntity(entity))return;
 guardShiftSeriesAccess(entity,ctx,false,fail);
 guardCustomFormAccess(entity,ctx,false,fail);
 guardContractsTasksAccess(entity,ctx,false,fail);
 guardClaimBatchAccess(entity,ctx,false,fail);
 if(isClaimBatchEntity(entity))return;
 guardBillingDocumentAccess(entity,ctx,false,fail);
 if(isBillingDocumentEntity(entity))return;
 guardPayrollStatementAccess(entity,ctx,false,fail);
 if(isPayrollStatementEntity(entity))return;
 guardBusinessRuleAccess(entity,ctx,false,fail);
 guardCaseSupportAccess(entity,ctx,false,fail);
 guardCaseHealthAccess(entity,ctx,false,fail);
 guardInstitutionAdminAccess(entity,ctx,false,fail);
 if(isPersonalCalendarEntity(entity)){guardPersonalCalendarAccess(entity,ctx,fail);if(data.ownerUserId!==ctx.user.id||(old&&!personalCalendarOwned(old,ctx)))fail(404,'NOT_FOUND','找不到本人行事事件');return;}
 guardInterviewApplicantAccess(entity,ctx,false,fail);
 guardPersonnelAccess(entity,ctx,false,fail);
 guardContactAccess(entity,ctx,false,fail);
 guardCaseStatusFollowupAccess(entity,ctx,false,fail);
 guardAttachmentAccess(entity,ctx,false,fail);
 guardCertificationAttachmentAccess(entity,ctx,false,fail);
 if(['admin','supervisor'].includes(ctx.role))return;
 if(ctx.role==='caregiver'&&entity==='service-records'&&data.employeeId===ctx.employeeId&&(!old||old.employeeId===ctx.employeeId))return;
 fail(403,'ROLE_FORBIDDEN','此角色無權變更此資料');
}

export function billingSnapshot(db,org,record){
 const employee=get(db,org,'employees',record.employeeId);
 return {capturedAt:now(),currency:'TWD',trial:true,source:'approval',serviceMinutes:capturedEntityMinutes('service-records',record,fail),employee:{id:employee.id,name:employee.name,employeeNo:employee.employeeNo,hourlyRateCents:employee.hourlyRateCents||0},items:record.services.map(s=>{const it=get(db,org,'service-items',s.serviceItemId);return{serviceItemId:it.id,code:it.code,name:it.name,quantity:s.quantity,unitPriceCents:it.unitPriceCents,amountCents:it.unitPriceCents*s.quantity};})};
}
