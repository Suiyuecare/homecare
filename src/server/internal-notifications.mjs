/** Internal manual notifications and self receipts. No mail, legal signoff or inferred obligation. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
export const internalNotificationEntity = 'internal-notifications';
export const internalNotificationReceiptEntity = 'internal-notification-receipts';
export const internalNotificationFields = ['title','body','recipientUserIds','status','note','cancellationReason','publication'];
export const internalNotificationReceiptFields = ['notificationId','publicationVersion','recipientUserId','recipientSnapshot','status','reply','readAt','repliedAt'];
export const internalNotificationEntities = { [internalNotificationEntity]: {
  fields: internalNotificationFields.join(' '), required: ['title','body','recipientUserIds'],
  statuses: ['draft','published','cancelled'], jsonFields: ['recipientUserIds','publication'],
  defaults: {recipientUserIds:[],status:'draft',note:'',cancellationReason:'',publication:null},
  maxLengths: {title:200,body:10000,note:10000,cancellationReason:10000,status:20},
} };
export const isInternalNotificationEntity = entity => entity === internalNotificationEntity;
const roles = ['admin','supervisor','finance','caregiver'], managers = ['admin','supervisor'];
const metadata = ['id','orgId','version','createdAt','updatedAt'];
const identity = value => typeof value === 'string' && value === value.trim() && !!value && value.length <= 500 && !/[\r\n]/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const time = value => typeof value === 'string' && value.length === 24 && /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function closed(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return (!keys || own.length === keys.length) && own.every(key => typeof key === 'string' && (!keys || keys.includes(key))
    && Object.getOwnPropertyDescriptor(value,key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'));
}
function dense(array,max) {
  if (!Array.isArray(array) || Object.getPrototypeOf(array) !== Array.prototype || array.length > max || Reflect.ownKeys(array).length !== array.length+1) return false;
  for(let i=0;i<array.length;i++){const own=Object.getOwnPropertyDescriptor(array,String(i));if(!own?.enumerable || !Object.hasOwn(own,'value'))return false;}return true;
}
const person = value => closed(value,['userId','userName','role']) && identity(value.userId) && typeof value.userName === 'string' && !!value.userName.trim() && value.userName.length <= 200 && roles.includes(value.role);
function publication(value) {
  return closed(value,['publicationVersion','title','body','recipientSnapshots','publisher','publishedAt']) && positive(value.publicationVersion) && value.publicationVersion>=2
    && typeof value.title === 'string' && !!value.title.trim() && value.title.length <= 200 && typeof value.body === 'string' && !!value.body.trim() && value.body.length <= 10000
    && time(value.publishedAt) && person(value.publisher) && managers.includes(value.publisher.role) && dense(value.recipientSnapshots,100) && value.recipientSnapshots.length > 0
    && value.recipientSnapshots.every(person) && new Set(value.recipientSnapshots.map(item=>item.userId)).size === value.recipientSnapshots.length;
}
const meta = item => identity(item.id) && identity(item.orgId) && positive(item.version) && time(item.createdAt) && time(item.updatedAt) && item.createdAt <= item.updatedAt;
export function internalNotificationRecordShape(item,withMetadata=true) {
  if(!closed(item,withMetadata?[...internalNotificationFields,...metadata]:internalNotificationFields))return false;
  if(withMetadata&&!meta(item))return false;
  if(['title','body','note','cancellationReason'].some(key=>typeof item[key]!=='string'||item[key].length > (key==='title'?200:10000)) || !item.title.trim() || !item.body.trim()
    || !dense(item.recipientUserIds,100) || !item.recipientUserIds.length || !item.recipientUserIds.every(identity) || new Set(item.recipientUserIds).size!==item.recipientUserIds.length
    || !['draft','published','cancelled'].includes(item.status))return false;
  if(item.status==='draft')return item.publication===null && !item.cancellationReason;
  if(!publication(item.publication) || item.publication.title!==item.title || item.publication.body!==item.body
    || !isDeepStrictEqual(item.publication.recipientSnapshots.map(value=>value.userId),item.recipientUserIds)
    || withMetadata && (item.publication.publicationVersion>item.version || item.publication.publishedAt<item.createdAt || item.publication.publishedAt>item.updatedAt))return false;
  return item.status==='published'?!item.cancellationReason:!!item.cancellationReason.trim();
}
export function internalNotificationReceiptId(orgId,notificationId,publicationVersion,userId) {
  const hash=createHash('sha256').update(JSON.stringify(['suiyue-internal-receipt-v1',orgId,notificationId,publicationVersion,userId])).digest('hex');
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`;
}
export function internalNotificationReceiptShape(item) {
  return closed(item,[...internalNotificationReceiptFields,...metadata]) && meta(item) && identity(item.notificationId) && positive(item.publicationVersion)
    && identity(item.recipientUserId) && person(item.recipientSnapshot) && item.recipientSnapshot.userId===item.recipientUserId
    && ['read','replied'].includes(item.status) && typeof item.reply==='string' && item.reply.length<=10000 && time(item.readAt) && item.readAt===item.createdAt
    && (item.status==='read' ? item.version===1&&!item.reply&&!item.repliedAt&&item.updatedAt===item.readAt : !!item.reply.trim()&&time(item.repliedAt)&&item.repliedAt>=item.readAt&&item.repliedAt===item.updatedAt)
    && item.id===internalNotificationReceiptId(item.orgId,item.notificationId,item.publicationVersion,item.recipientUserId);
}
export function guardInternalNotificationAccess(entity,ctx,readOnly,fail) {
  if(!isInternalNotificationEntity(entity))return;
  if(!(readOnly?roles:managers).includes(ctx?.role)||!identity(ctx?.orgId)||!identity(ctx?.user?.id))fail(403,'ROLE_FORBIDDEN','此角色無權操作內部通知');
}
function member(db,orgId,userId,get) {
  const row=db.prepare('SELECT m.user_id,m.role,m.employee_id,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=? AND m.user_id=?').get(orgId,userId);
  if(!row||!roles.includes(row.role)||typeof row.name!=='string'||!row.name.trim()||row.name.length>200)return null;
  if(row.role==='caregiver') {
    if(!identity(row.employee_id))return null;let employee;try{employee=get(db,orgId,'employees',row.employee_id);}catch{return null;}
    if(!employee||employee.orgId!==orgId||employee.id!==row.employee_id||employee.status!=='active')return null;
  }
  return {userId:row.user_id,userName:row.name,role:row.role};
}
export function requireInternalNotificationMember(db,ctx,fail,get) {
  guardInternalNotificationAccess(internalNotificationEntity,ctx,true,fail);
  let selected;try{selected=member(db,ctx.orgId,ctx.user.id,get);}catch{fail(403,'MEMBERSHIP_REQUIRED','目前本人機構角色無法確認');}
  if(!selected||selected.role!==ctx.role)fail(403,'MEMBERSHIP_REQUIRED','本人目前機構角色已變更，請重新登入');
  return selected;
}
export function normalizeInternalNotificationPayload(entity,payload) {
  if(!isInternalNotificationEntity(entity)||!closed(payload))return payload;
  // Full text, including CRLF and padding, is never trimmed by this adapter.
  return Object.fromEntries(Object.entries(payload).map(([key,value])=>[key,key==='status'&&typeof value==='string'?value.trim():value]));
}
export function assertInternalNotificationPayload(entity,payload,fail) {
  if(!isInternalNotificationEntity(entity))return;
  if(!closed(payload)||Reflect.ownKeys(payload).some(key=>![...internalNotificationFields.filter(key=>key!=='publication'),'version'].includes(key)))fail(422,'UNKNOWN_FIELD','通知只接受明確可編輯欄位，發布快照由伺服器產生');
  if(payload.status==='cancelled'&&(!Object.hasOwn(payload,'cancellationReason')||typeof payload.cancellationReason!=='string'||!payload.cancellationReason.trim()))fail(422,'CANCELLATION_REASON','取消須填寫本次原因',{cancellationReason:'本次取消原因必填'});
}
export function internalNotificationVisible(db,ctx,item,get) {
  try { if(!internalNotificationRecordShape(item)||item.orgId!==ctx.orgId)return false;requireInternalNotificationMember(db,ctx,()=>{throw new Error('membership');},get);
    headMatches(db,internalNotificationEntity,item,internalNotificationRecordShape,()=>{throw new Error('head');},'BROKEN_NOTIFICATION');
    return managers.includes(ctx.role)||item.status!=='draft'&&item.recipientUserIds.includes(ctx.user.id);
  }catch{return false;}
}
export function internalNotificationHistoryVisible(db,ctx,snapshot,current,get) {
  if(!internalNotificationVisible(db,ctx,current,get)||!internalNotificationRecordShape(snapshot)||snapshot.id!==current.id||snapshot.orgId!==current.orgId||snapshot.createdAt!==current.createdAt||snapshot.version>current.version)return false;
  return managers.includes(ctx.role)||snapshot.status!=='draft'&&snapshot.publication?.publicationVersion===current.publication?.publicationVersion
    && isDeepStrictEqual(snapshot.publication,current.publication);
}
export function publicInternalNotification(ctx,item) {
  if(managers.includes(ctx.role))return item;
  if(!internalNotificationRecordShape(item)||!item.publication||!item.recipientUserIds.includes(ctx.user.id))return null;
  return {title:item.title,body:item.body,status:item.status,cancellationReason:item.cancellationReason,
    publicationVersion:item.publication.publicationVersion,publishedAt:item.publication.publishedAt,publisher:item.publication.publisher,
    recipientSnapshot:item.publication.recipientSnapshots.find(value=>value.userId===ctx.user.id),
    ...Object.fromEntries(metadata.map(key=>[key,item[key]]))};
}
export function validateInternalNotification(db,ctx,entity,data,old,fail,get,{now=()=>new Date().toISOString()}={}) {
  if(!isInternalNotificationEntity(entity))return;guardInternalNotificationAccess(entity,ctx,false,fail);
  const publisher=requireInternalNotificationMember(db,ctx,fail,get);
  if(old&&!internalNotificationVisible(db,ctx,old,get))fail(404,'NOT_FOUND','找不到可處理的通知');
  if(!closed(data,internalNotificationFields))fail(422,'INVALID_NOTIFICATION','通知欄位未完整確認');
  if(old?.version===Number.MAX_SAFE_INTEGER)fail(409,'VERSION_LIMIT','通知版次已達安全上限');
  if(!old&&data.status!=='draft')fail(422,'NOTIFICATION_STATE','新增通知須從草稿開始');
  if(old?.status==='cancelled')fail(409,'NOTIFICATION_LOCKED','已取消通知鎖定');
  if(old?.status==='published'){
    if(data.status!=='cancelled'||internalNotificationFields.filter(key=>!['status','cancellationReason'].includes(key)).some(key=>!isDeepStrictEqual(data[key],old[key])))fail(409,'NOTIFICATION_LOCKED','已發布原文與收件人固定，只可填本次原因取消');
  }
  if(!old||old.status==='draft'){
    if(!['draft','published'].includes(data.status)||data.publication!==null||data.cancellationReason)fail(422,'NOTIFICATION_STATE','草稿僅可保存或發布，不接受自製快照或取消原因');
    if(!dense(data.recipientUserIds,100)||!data.recipientUserIds.length||!data.recipientUserIds.every(identity)||new Set(data.recipientUserIds).size!==data.recipientUserIds.length)fail(422,'INVALID_RECIPIENTS','請明確選取1至100位不重複的同機構收件人',{recipientUserIds:'請重新核對收件人'});
    const recipientSnapshots=data.recipientUserIds.map(userId=>{let value;try{value=member(db,ctx.orgId,userId,get);}catch{}if(!value)fail(422,'INVALID_RECIPIENTS','所選收件人目前不是同機構有效登入成員',{recipientUserIds:'請重新讀取收件人'});return value;});
    if(data.status==='published'){
      const publishedAt=now();if(!time(publishedAt))fail(409,'INVALID_TIME','發布時間無法確認');
      data.publication={publicationVersion:old.version+1,title:data.title,body:data.body,recipientSnapshots,publisher,publishedAt};
    }
  }
  if(!internalNotificationRecordShape(data,false))fail(422,'INVALID_NOTIFICATION','請核對通知標題、全文、指定收件人與狀態');
}
function headMatches(db,entity,item,shape,fail,code) {
  const statement=db.prepare('SELECT version,snapshot,created_at FROM record_versions WHERE org_id=? AND entity=? AND record_id=? ORDER BY version DESC LIMIT 1');statement.setReadBigInts(true);
  const head=statement.get(item.orgId,entity,item.id);let snapshot;try{snapshot=head&&JSON.parse(head.snapshot);}catch{}
  if(!head||head.version!==BigInt(item.version)||!shape(snapshot)||!isDeepStrictEqual(snapshot,item)||head.created_at!==item.updatedAt)fail(409,code,'保存資料與 immutable 版次無法一致確認，未進行修補或略過');
}
function currentNotification(db,ctx,id,fail,get) {
  requireInternalNotificationMember(db,ctx,fail,get);
  if(!identity(id))fail(404,'NOT_FOUND','找不到內部通知');
  const exists=db.prepare('SELECT 1 FROM records WHERE org_id=? AND entity=? AND id=?').get(ctx.orgId,internalNotificationEntity,id),item=get(db,ctx.orgId,internalNotificationEntity,id);
  if(exists&&!internalNotificationRecordShape(item))fail(409,'BROKEN_NOTIFICATION','目前通知保存格式無法確認');
  if(!item||!managers.includes(ctx.role)&&(item.status==='draft'||!item.recipientUserIds.includes(ctx.user.id)))fail(404,'NOT_FOUND','找不到本人可讀內部通知');
  headMatches(db,internalNotificationEntity,item,internalNotificationRecordShape,fail,'BROKEN_NOTIFICATION');return item;
}
function receiptById(db,ctx,id,fail,get) {
  const exists=db.prepare('SELECT 1 FROM records WHERE org_id=? AND entity=? AND id=?').get(ctx.orgId,internalNotificationReceiptEntity,id);
  if(!exists)return null;const item=get(db,ctx.orgId,internalNotificationReceiptEntity,id);
  if(!internalNotificationReceiptShape(item)||item.orgId!==ctx.orgId)fail(409,'BROKEN_RECEIPT','內部回執保存格式無法確認');
  headMatches(db,internalNotificationReceiptEntity,item,internalNotificationReceiptShape,fail,'BROKEN_RECEIPT');return item;
}
function ownReceipt(db,ctx,notification,fail,get) {
  if(!notification.publication)return null;
  const id=internalNotificationReceiptId(ctx.orgId,notification.id,notification.publication.publicationVersion,ctx.user.id),receipt=receiptById(db,ctx,id,fail,get);
  if(receipt&&(receipt.notificationId!==notification.id||receipt.publicationVersion!==notification.publication.publicationVersion||receipt.recipientUserId!==ctx.user.id))fail(409,'BROKEN_RECEIPT','本人回執識別無法確認');return receipt;
}
export function internalNotificationQuery(params,fail,mode='list') {
  const allowed=mode==='single'||mode==='receipt'||mode==='mutation'?[]:mode==='directory'?['page','pageSize','q','role']:mode==='history'?['page','pageSize','compare']:mode==='receipt-history'?['page','pageSize']:mode==='receipts'?['page','pageSize','status']:['page','pageSize','q','status','view'];
  for(const key of params.keys())if(!allowed.includes(key)||params.getAll(key).length!==1)fail(422,'INVALID_QUERY','通知查詢參數未知或重複');
  if(!allowed.length)return{};
  const integer=(key,fallback,max)=>{const raw=params.has(key)?params.get(key):String(fallback),value=Number(raw);if(/[\r\n]/.test(raw)||!/^[1-9]\d*$/.test(raw)||!positive(value)||value>max)fail(422,'PAGINATION','請使用合理正整數分頁');return value;};
  const result={page:integer('page',1,Math.floor(Number.MAX_SAFE_INTEGER/100)),pageSize:integer('pageSize',25,100)};
  for(const key of ['q','status','view','role','compare'])if(params.has(key))result[key]=params.get(key);
  if(result.q!==undefined&&(result.q.length>200||/[\r\n]/.test(result.q)))fail(422,'INVALID_QUERY','搜尋最多200字且不可換行');
  if(result.status!==undefined&&!(mode==='receipts'?['read','replied']:['draft','published','cancelled']).includes(result.status))fail(422,'INVALID_STATUS','查詢狀態不合法');
  if(result.role!==undefined&&!roles.includes(result.role)||result.view!==undefined&&!['managed','mine'].includes(result.view)||result.compare!==undefined&&result.compare!=='previous')fail(422,'INVALID_QUERY','查詢分類不合法');return result;
}
export function filterInternalNotifications(ctx,items,query) {
  const q=(query.q||'').toLowerCase();return items.filter(item=>(!query.status||item.status===query.status)&&(!query.view||query.view==='managed'||item.status!=='draft'&&(managers.includes(ctx.role)?item.recipientUserIds.includes(ctx.user.id):item.recipientSnapshot?.userId===ctx.user.id))
    &&(!q||[item.title,item.body,item.cancellationReason,...(managers.includes(ctx.role)&&query.view!=='mine'?[item.note]:[])].some(value=>value.toLowerCase().includes(q))));
}
export function assertInternalNotificationQueryAccess(ctx,query,fail) {
  guardInternalNotificationAccess(internalNotificationEntity,ctx,true,fail);
  if(query.view==='managed'&&!managers.includes(ctx.role))fail(403,'ROLE_FORBIDDEN','機構通知管理清單僅供管理者或督導');
}
const pageOf=(items,query)=>({items:items.slice((query.page-1)*query.pageSize,query.page*query.pageSize),total:items.length,page:query.page,pageSize:query.pageSize});
export function readInternalNotificationRecipients(db,ctx,params,fail,get) {
  guardInternalNotificationAccess(internalNotificationEntity,ctx,false,fail);requireInternalNotificationMember(db,ctx,fail,get);
  const query=internalNotificationQuery(params,fail,'directory'),ids=db.prepare('SELECT user_id FROM memberships WHERE org_id=? ORDER BY user_id').all(ctx.orgId);
  const all=ids.map(row=>member(db,ctx.orgId,row.user_id,get)).filter(Boolean),q=(query.q||'').toLowerCase();return pageOf(all.filter(item=>(!query.role||item.role===query.role)&&(!q||item.userName.toLowerCase().includes(q))),query);
}
export function readInternalNotificationReceipt(db,ctx,id,params,fail,get) {
  guardInternalNotificationAccess(internalNotificationEntity,ctx,true,fail);internalNotificationQuery(params,fail,'receipt');
  const notification=currentNotification(db,ctx,id,fail,get),selected=notification.status!=='draft'&&notification.recipientUserIds.includes(ctx.user.id);
  if(!selected)fail(404,'NOT_FOUND','您不是本通知明確指定的收件人');
  return {notification:publicInternalNotification(ctx,notification),receipt:ownReceipt(db,ctx,notification,fail,get),canRecord:notification.status==='published'};
}
export function validateInternalNotificationReceiptPayload(payload,fail) {
  if(!closed(payload,['publicationVersion','receiptVersion','action','reply'])||!positive(payload.publicationVersion)||!Number.isSafeInteger(payload.receiptVersion)||payload.receiptVersion<0
    || !['read','reply'].includes(payload.action)||typeof payload.reply!=='string'||payload.reply.length>10000||payload.action==='read'&&payload.reply||payload.action==='reply'&&!payload.reply.trim())fail(422,'INVALID_SELF_RECEIPT','本人回執只接受精確發布版次、回執版次與本次操作／回覆，不接受代他人欄位');return payload;
}
export function preflightInternalNotificationReceipt(db,ctx,id,payload,fail,get) {
  guardInternalNotificationAccess(internalNotificationEntity,ctx,true,fail);requireInternalNotificationMember(db,ctx,fail,get);validateInternalNotificationReceiptPayload(payload,fail);
  const notification=currentNotification(db,ctx,id,fail,get);
  if(notification.status!=='published'||!notification.recipientUserIds.includes(ctx.user.id))fail(409,'RECEIPT_CLOSED','只有目前已發布且明確指定本人之通知可保存本人回執');
  if(notification.publication.publicationVersion!==payload.publicationVersion)fail(409,'PUBLICATION_CONFLICT','精確發布版次不一致，請重新讀取');
  return {notification,receipt:ownReceipt(db,ctx,notification,fail,get)};
}
export function commitInternalNotificationReceipt(db,ctx,id,payload,fail,get,{now=()=>new Date().toISOString(),audit}={}) {
  guardInternalNotificationAccess(internalNotificationEntity,ctx,true,fail);if(!db.isTransaction)fail(409,'TRANSACTION_REQUIRED','本人回執須在原子交易內保存');
  if(typeof audit!=='function')fail(409,'AUDIT_REQUIRED','本人回執須由伺服器保存實際本人稽核紀錄');
  const {notification,receipt}=preflightInternalNotificationReceipt(db,ctx,id,payload,fail,get);
  if((receipt?.version||0)!==payload.receiptVersion)fail(409,'VERSION_CONFLICT','本人回執已保存或更新，請重新讀取');
  if(receipt?.version===Number.MAX_SAFE_INTEGER)fail(409,'VERSION_LIMIT','回執版次已達上限');
  if(receipt&&payload.action==='read')return {notification:publicInternalNotification(ctx,notification),receipt,canRecord:true};
  const savedAt=now();if(!time(savedAt)||receipt&&savedAt<receipt.updatedAt||savedAt<notification.publication.publishedAt)fail(409,'INVALID_TIME','回執保存時間無法確認');
  const data={notificationId:id,publicationVersion:payload.publicationVersion,recipientUserId:ctx.user.id,
    recipientSnapshot:receipt?.recipientSnapshot||requireInternalNotificationMember(db,ctx,fail,get),status:payload.action==='reply'?'replied':'read',reply:payload.reply,readAt:receipt?.readAt||savedAt,repliedAt:payload.action==='reply'?savedAt:''};
  const item={...data,id:receipt?.id||internalNotificationReceiptId(ctx.orgId,id,payload.publicationVersion,ctx.user.id),orgId:ctx.orgId,version:(receipt?.version||0)+1,createdAt:receipt?.createdAt||savedAt,updatedAt:savedAt};
  if(!internalNotificationReceiptShape(item))fail(409,'BROKEN_RECEIPT','本次回執保存形狀無法確認');
  if(receipt){const result=db.prepare('UPDATE records SET data=?,version=?,updated_at=? WHERE id=? AND org_id=? AND entity=? AND version=?').run(JSON.stringify(data),item.version,savedAt,item.id,ctx.orgId,internalNotificationReceiptEntity,receipt.version);if(!result.changes)fail(409,'VERSION_CONFLICT','回執已更新');}
  else db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id,ctx.orgId,internalNotificationReceiptEntity,JSON.stringify(data),1,savedAt,savedAt);
  db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(ctx.orgId,internalNotificationReceiptEntity,item.id,item.version,JSON.stringify(item),savedAt,payload.action==='reply'?'internal-notification.reply':'internal-notification.read');
  audit(db,ctx,payload.action==='reply'?'internal-notification.reply':'internal-notification.read',internalNotificationReceiptEntity,item.id,{notificationId:id,publicationVersion:payload.publicationVersion,version:item.version});
  return {notification:publicInternalNotification(ctx,notification),receipt:item,canRecord:true};
}
export function confirmInternalNotificationReceiptResponse(db,ctx,id,payload,result,fail,get) {
  const {notification}=preflightInternalNotificationReceipt(db,ctx,id,payload,fail,get),item=result?.receipt;
  if(!closed(result,['notification','receipt','canRecord'])||!internalNotificationReceiptShape(item)||item.orgId!==ctx.orgId||item.recipientUserId!==ctx.user.id||item.notificationId!==id
    || item.publicationVersion!==payload.publicationVersion||payload.action==='reply'&&(item.status!=='replied'||item.reply!==payload.reply)||!isDeepStrictEqual(result.notification,publicInternalNotification(ctx,notification))||result.canRecord!==true)fail(409,'RECEIPT_UNCONFIRMED','本人保存結果未完整確認');
  const row=db.prepare('SELECT snapshot FROM record_versions WHERE org_id=? AND entity=? AND record_id=? AND version=?').get(ctx.orgId,internalNotificationReceiptEntity,item.id,item.version);let saved;try{saved=row&&JSON.parse(row.snapshot);}catch{}
  if(!isDeepStrictEqual(item,saved))fail(409,'RECEIPT_UNCONFIRMED','本人保存結果与不可改寫版本不一致');return result;
}
export function readInternalNotificationReceiptHistory(db,ctx,id,params,fail,get) {
  guardInternalNotificationAccess(internalNotificationEntity,ctx,true,fail);const query=internalNotificationQuery(params,fail,'receipt-history'),notification=currentNotification(db,ctx,id,fail,get);
  if(notification.status==='draft'||!notification.recipientUserIds.includes(ctx.user.id))fail(404,'NOT_FOUND','找不到本人回執歷程');
  const current=ownReceipt(db,ctx,notification,fail,get);if(!current)return {items:[],total:0,page:query.page,pageSize:query.pageSize};
  const statement=db.prepare('SELECT * FROM record_versions WHERE org_id=? AND entity=? AND record_id=? ORDER BY version DESC');statement.setReadBigInts(true);
  const rows=statement.all(ctx.orgId,internalNotificationReceiptEntity,current.id),items=[];
  if(rows.length!==current.version)fail(409,'BROKEN_RECEIPT','本人回執歷程有缺口');
  for(let index=0;index<rows.length;index++){const row=rows[index];let snapshot;try{snapshot=JSON.parse(row.snapshot);}catch{}
    if(!internalNotificationReceiptShape(snapshot)||!['internal-notification.read','internal-notification.reply'].includes(row.source)||row.source!==('internal-notification.'+(snapshot.status==='read'?'read':'reply'))||row.version!==BigInt(current.version-index)||snapshot.version!==current.version-index||snapshot.id!==current.id||snapshot.orgId!==ctx.orgId||snapshot.notificationId!==id||snapshot.publicationVersion!==current.publicationVersion||snapshot.recipientUserId!==ctx.user.id||snapshot.readAt!==current.readAt||!isDeepStrictEqual(snapshot.recipientSnapshot,current.recipientSnapshot)||row.created_at!==snapshot.updatedAt)fail(409,'BROKEN_RECEIPT','本人回執不可改寫歷程無法確認');
    items.push({version:snapshot.version,createdAt:snapshot.updatedAt,source:row.source,snapshot});
  }
  // Dedicated history is a closed snapshot list, not the generic diff envelope.
  if(query.compare)fail(422,'INVALID_QUERY','本人回執歷程只提供逐版完整原文，尚無compare操作');
  return pageOf(items,query);
}
export function readInternalNotificationReceipts(db,ctx,id,params,fail,get) {
  guardInternalNotificationAccess(internalNotificationEntity,ctx,false,fail);const query=internalNotificationQuery(params,fail,'receipts'),notification=currentNotification(db,ctx,id,fail,get);
  if(!notification.publication)return {items:[],total:0,page:query.page,pageSize:query.pageSize};
  const raw=db.prepare('SELECT id,data FROM records WHERE org_id=? AND entity=? ORDER BY created_at DESC,id').all(ctx.orgId,internalNotificationReceiptEntity),items=[];
  // Do not let malformed imported JSON erase saved receipts from the manager roster.
  for(const row of raw){let data;try{data=JSON.parse(row.data);}catch{fail(409,'BROKEN_RECEIPT','同機構回執有無法確認之資料');}
    if(!closed(data,internalNotificationReceiptFields))fail(409,'BROKEN_RECEIPT','同機構回執有未知保存欄位');
    if(data.notificationId===id){const item=receiptById(db,ctx,row.id,fail,get);if(item.publicationVersion!==notification.publication.publicationVersion||!notification.recipientUserIds.includes(item.recipientUserId))fail(409,'BROKEN_RECEIPT','回執與發布快照不一致');if(!query.status||item.status===query.status)items.push(item);}}
  return pageOf(items,query);
}
