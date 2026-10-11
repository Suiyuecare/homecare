/** Candidate: manually assigned family members/connections, never clinical genogram inference. */
export const CASE_FAMILY_MEMBER_ENTITY = 'case-family-members', CASE_FAMILY_LINK_ENTITY = 'case-family-links';
const memberFields = ['caseId','name','relationToCase','generation','gender','status','note'], linkFields = ['caseId','fromMemberId','toMemberId','kind','status','note'];
const maximum = { caseId:500,name:100,relationToCase:100,gender:100,status:8,note:10000,fromMemberId:500,toMemberId:500,kind:6 };
export const caseFamilyEntities = {
  [CASE_FAMILY_MEMBER_ENTITY]: { fields:memberFields.join(' '),required:['caseId','name','relationToCase','generation'],jsonFields:['generation'],statuses:['active','inactive'],defaults:{gender:'',status:'active',note:''},maxLengths:maximum },
  [CASE_FAMILY_LINK_ENTITY]: { fields:linkFields.join(' '),required:['caseId','fromMemberId','toMemberId','kind'],statuses:['active','inactive'],defaults:{status:'active',note:''},maxLengths:maximum },
};
const metadata = ['id','orgId','version','createdAt','updatedAt'], identity = value => typeof value==='string' && value===value.trim() && Boolean(value) && value.length<=500;
const plain = value => value!==null && typeof value==='object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key=>typeof key==='string' && Object.getOwnPropertyDescriptor(value,key).enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'));
const fieldsFor = entity => entity===CASE_FAMILY_MEMBER_ENTITY?memberFields:linkFields;
export const isCaseFamilyEntity = entity => Object.hasOwn(caseFamilyEntities,entity);
export function guardCaseFamilyAccess(entity,ctx,_readOnly,fail) { if(isCaseFamilyEntity(entity)&&!['admin','supervisor'].includes(ctx?.role))fail(403,'ROLE_FORBIDDEN','僅管理者與督導可維護人工家庭關係'); }
export function normalizeCaseFamilyPayload(entity,payload) { if(!isCaseFamilyEntity(entity)||!plain(payload))return payload; return Object.fromEntries(Object.entries(payload).map(([key,value])=>[key,['status','kind'].includes(key)&&typeof value==='string'?value.trim():value])); }
function shape(entity,data,fail) {
  const fields=fieldsFor(entity); if(!plain(data)||Object.keys(data).length!==fields.length||Object.keys(data).some(key=>!fields.includes(key)))fail(422,'UNKNOWN_FIELD','人工家庭資料須完整且不含未知欄位');
  for(const key of fields) {
    if(key==='generation'){if(typeof data[key]!=='number'||!Number.isSafeInteger(data[key])||data[key]<-5||data[key]>5)fail(422,'INVALID_GENERATION','世代須由人工指定-5至5整數',{generation:'上5代至下5代，不推定世代'});}
    else if(typeof data[key]!=='string'||data[key].length>maximum[key])fail(422,'INVALID_FIELD','人工家庭欄位格式或長度不符',{[key]:'請核對文字長度'});
  }
  for(const key of caseFamilyEntities[entity].required)if(key!=='generation'&&!data[key].trim())fail(422,'REQUIRED','必要人工關係尚未填寫',{[key]:'必填且不可只有空白'});
  for(const key of entity===CASE_FAMILY_MEMBER_ENTITY?['caseId']:['caseId','fromMemberId','toMemberId'])if(!identity(data[key]))fail(422,'INVALID_REFERENCE','原個案或成員識別未確認');
  if(!['active','inactive'].includes(data.status))fail(422,'INVALID_STATUS','人工家庭狀態不合法');
  if(entity===CASE_FAMILY_LINK_ENTITY){if(!['parent','spouse','other'].includes(data.kind))fail(422,'INVALID_KIND','人工關係只可父母至子女、伴侶或其他');if(data.fromMemberId===data.toMemberId)fail(422,'SELF_LINK','不能將成員連到自己');}
  return data;
}
function recordShape(entity,item,orgId,fail) {
  const fields=fieldsFor(entity);if(!plain(item)||Object.keys(item).length!==fields.length+metadata.length||Object.keys(item).some(key=>![...fields,...metadata].includes(key))||!identity(item.id)||item.orgId!==orgId||!Number.isSafeInteger(item.version)||item.version<1||['createdAt','updatedAt'].some(key=>typeof item[key]!=='string'||!item[key].trim()||item[key].length>100))fail(409,'FAMILY_DATA_UNCONFIRMED','無法確認人工家庭資料識別、版次與完整欄位');
  return shape(entity,Object.fromEntries(fields.map(key=>[key,item[key]])),fail);
}
function membersForLink(db,ctx,data,get,fail,{active=false}={}) {
  const pair=[data.fromMemberId,data.toMemberId].map(memberId=>get(db,ctx.orgId,CASE_FAMILY_MEMBER_ENTITY,memberId));
  for(const item of pair){if(!item)fail(422,'INVALID_REFERENCE','關係兩端必須為本機構同一個案的成員');recordShape(CASE_FAMILY_MEMBER_ENTITY,item,ctx.orgId,fail);if(item.caseId!==data.caseId)fail(422,'INVALID_REFERENCE','不可連到不同個案的家庭成員');if(active&&item.status!=='active')fail(409,'MEMBER_INACTIVE','使用中的關係須連接使用中的成員');}
  return pair;
}
/** A corrupt row cannot silently erase a relationship from cycle/deactivation guards. */
function completeOwnRows(db,ctx,entity,rows,fail) {
  const all=rows(db,ctx.orgId,entity);if(!Array.isArray(all))fail(409,'FAMILY_GRAPH_UNCONFIRMED','人工家庭關係完整性未確認');
  const count=db.prepare('SELECT COUNT(*) n FROM records WHERE org_id=? AND entity=?').get(ctx.orgId,entity).n;
  if(all.length!==Number(count))fail(409,'FAMILY_GRAPH_UNCONFIRMED','有無法讀取的人工家庭資料，不能忽略或自動修補');
  for(const item of all)recordShape(entity,item,ctx.orgId,fail);return all;
}
function activeParentCycle(links,candidate) {
  const outgoing=new Map();for(const edge of [...links,candidate])if(edge.status==='active'&&edge.kind==='parent'){if(!outgoing.has(edge.fromMemberId))outgoing.set(edge.fromMemberId,[]);outgoing.get(edge.fromMemberId).push(edge.toMemberId);}
  const visited=new Set(),pending=[candidate.toMemberId];while(pending.length){const node=pending.pop();if(node===candidate.fromMemberId)return true;if(visited.has(node))continue;visited.add(node);pending.push(...(outgoing.get(node)||[]));}return false;
}
function duplicateActiveLink(links) { const seen=new Set();for(const edge of links){if(edge.status!=='active')continue;const pair=edge.kind==='spouse'?[edge.fromMemberId,edge.toMemberId].sort():[edge.fromMemberId,edge.toMemberId],key=JSON.stringify([edge.kind,...pair]);if(seen.has(key))return true;seen.add(key);}return false; }
export function validateCaseFamily(db,ctx,entity,data,old,fail,get,rows) {
  if(!isCaseFamilyEntity(entity))return;guardCaseFamilyAccess(entity,ctx,false,fail);shape(entity,data,fail);
  if(old&&data.caseId!==old.caseId)fail(409,'CASE_IMMUTABLE','家庭資料所屬個案建立後固定');
  if(!get(db,ctx.orgId,'cases',data.caseId))fail(422,'INVALID_REFERENCE','所屬個案不存在或不屬於本機構');
  const ownLinks=completeOwnRows(db,ctx,CASE_FAMILY_LINK_ENTITY,rows,fail).filter(item=>item.caseId===data.caseId);
  if(entity===CASE_FAMILY_MEMBER_ENTITY){const ownMembers=completeOwnRows(db,ctx,CASE_FAMILY_MEMBER_ENTITY,rows,fail).filter(item=>item.caseId===data.caseId);if(!old&&ownMembers.length>=200)fail(413,'FAMILY_GRAPH_TOO_LARGE','單一個案最多200位人工成員，包含已停用');if(old&&old.status==='active'&&data.status==='inactive'&&ownLinks.some(edge=>edge.status==='active'&&[edge.fromMemberId,edge.toMemberId].includes(old.id)))fail(409,'ACTIVE_FAMILY_LINKS','請先明確停用此成員的使用中關係，再停用成員');return;}
  if(!old&&ownLinks.length>=400)fail(413,'FAMILY_GRAPH_TOO_LARGE','單一個案最多400組人工關係，包含已停用');
  if(old&&(data.fromMemberId!==old.fromMemberId||data.toMemberId!==old.toMemberId))fail(409,'MEMBERS_IMMUTABLE','關係兩端建立後固定，需停用原關係再新建');
  membersForLink(db,ctx,data,get,fail,{active:data.status==='active'});if(data.status!=='active')return;
  const other=ownLinks.filter(edge=>edge.id!==old?.id);
  for(const edge of other)if(edge.status==='active')membersForLink(db,ctx,edge,get,fail,{active:true});
  if(duplicateActiveLink(other))fail(409,'FAMILY_GRAPH_UNCONFIRMED','已有無法確認的重複人工關係，不能忽略或自動修補');
  if(other.some(edge=>edge.status==='active'&&edge.kind==='parent'&&activeParentCycle(other.filter(item=>item.id!==edge.id),edge)))fail(409,'FAMILY_GRAPH_UNCONFIRMED','已有無法確認的父母關係循環，不能忽略或自動修補');
  const duplicate=other.some(edge=>edge.status==='active'&&edge.kind===data.kind&&(edge.fromMemberId===data.fromMemberId&&edge.toMemberId===data.toMemberId||data.kind==='spouse'&&edge.fromMemberId===data.toMemberId&&edge.toMemberId===data.fromMemberId));
  if(duplicate)fail(409,'DUPLICATE_FAMILY_LINK','已有相同使用中人工關係，不重複建立');
  if(data.kind==='parent'&&activeParentCycle(other,data))fail(409,'PARENT_CYCLE','父母至子女的人工連線不能形成循環');
}
export function caseFamilyRecordVisible(db,ctx,entity,item,get) {
  if(!isCaseFamilyEntity(entity)||!['admin','supervisor'].includes(ctx?.role))return false;
  try{const fail=()=>{throw new Error('unconfirmed');};const data=recordShape(entity,item,ctx.orgId,fail);if(!get(db,ctx.orgId,'cases',data.caseId))return false;if(entity===CASE_FAMILY_LINK_ENTITY)membersForLink(db,ctx,data,get,fail,{active:data.status==='active'});return true;}catch{return false;}
}
export function caseFamilyHistoryVisible(db,ctx,entity,snapshot,current,get) {
  if(!isCaseFamilyEntity(entity)||!['admin','supervisor'].includes(ctx?.role)||!plain(current)||!plain(snapshot))return false;
  try{const fail=()=>{throw new Error('unconfirmed');};const data=recordShape(entity,snapshot,ctx.orgId,fail);if(snapshot.id!==current.id||snapshot.caseId!==current.caseId||entity===CASE_FAMILY_LINK_ENTITY&&(snapshot.fromMemberId!==current.fromMemberId||snapshot.toMemberId!==current.toMemberId)||!get(db,ctx.orgId,'cases',snapshot.caseId))return false;if(entity===CASE_FAMILY_LINK_ENTITY)membersForLink(db,ctx,data,get,fail);return true;}catch{return false;}
}
export function caseFamilyQuery(entity,params,fail,mode='list') {
  if(!isCaseFamilyEntity(entity))return{};if(!['list','single','history'].includes(mode))fail(422,'INVALID_QUERY','人工家庭查詢模式未確認');
  const allowed=mode==='single'?[]:mode==='history'?['page','pageSize','compare']:['page','pageSize','caseId','status','q'], result=mode==='single'?{}:{page:1,pageSize:25};
  for(const key of params.keys())if(!allowed.includes(key)||params.getAll(key).length!==1)fail(422,'INVALID_QUERY','人工家庭查詢不接受未知或重複欄位');
  for(const key of ['page','pageSize'])if(params.has(key)){const value=params.get(key);if(value!==value.trim()||!/^[1-9]\d*$/.test(value)||!Number.isSafeInteger(Number(value))||key==='pageSize'&&Number(value)>100)fail(422,'INVALID_QUERY','分頁須為合法正整數');result[key]=Number(value);}
  if(params.has('compare')){if(params.get('compare')!=='previous')fail(422,'INVALID_QUERY','只接受精確前版比較');result.compare='previous';}
  if(params.has('caseId')){if(!identity(params.get('caseId')))fail(422,'INVALID_QUERY','原個案查詢識別未確認');result.caseId=params.get('caseId');}
  if(params.has('status')){if(!['active','inactive'].includes(params.get('status')))fail(422,'INVALID_QUERY','人工家庭狀態不合法');result.status=params.get('status');}
  if(params.has('q')){if(params.get('q').length>200)fail(422,'INVALID_QUERY','人工家庭搜尋最多200字');result.q=params.get('q');}return result;
}
export function readCaseFamilyGraph(db,ctx,caseId,fail,get,rows) {
  guardCaseFamilyAccess(CASE_FAMILY_MEMBER_ENTITY,ctx,true,fail);if(!identity(caseId)||!get(db,ctx.orgId,'cases',caseId))fail(404,'NOT_FOUND','找不到個案家庭資料');
  const members=completeOwnRows(db,ctx,CASE_FAMILY_MEMBER_ENTITY,rows,fail).filter(item=>item.caseId===caseId), links=completeOwnRows(db,ctx,CASE_FAMILY_LINK_ENTITY,rows,fail).filter(item=>item.caseId===caseId);
  if(members.length>200||links.length>400)fail(413,'FAMILY_GRAPH_TOO_LARGE','單一人工家庭图最多200位成員與400組關係，不截斷');
  if([...members.map(item=>[CASE_FAMILY_MEMBER_ENTITY,item]),...links.map(item=>[CASE_FAMILY_LINK_ENTITY,item])].some(([entity,item])=>!caseFamilyRecordVisible(db,ctx,entity,item,get)))fail(409,'FAMILY_GRAPH_UNCONFIRMED','人工家庭圖的原個案與兩端成員需完整可讀');
  if(duplicateActiveLink(links))fail(409,'FAMILY_GRAPH_UNCONFIRMED','人工家庭圖有無法確認的重複使用中關係');
  if(links.some(edge=>edge.status==='active'&&edge.kind==='parent'&&activeParentCycle(links.filter(item=>item.id!==edge.id),edge)))fail(409,'FAMILY_GRAPH_UNCONFIRMED','人工父母至子女連線有無法確認的循環');
  return{caseId,orgId:ctx.orgId,members,links,totalMembers:members.length,totalLinks:links.length};
}
