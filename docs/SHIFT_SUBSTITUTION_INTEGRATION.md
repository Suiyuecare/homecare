# 最小root整合接口（候選）

自有相對路徑：src/server/shift-substitution.mjs、public/data/shift-substitution-core.js、public/data/shift-substitution-editor.js、public/modules/shift-substitution.js、tests/shift-substitution.test.mjs、docs/SHIFT_SUBSTITUTION_SCOPE.md。先保持candidate，root允許後才promote；目前没有src/public/tests/docs正式修改。

server完全不import model。注入exact deps：`{get,rows,business,validatePayload,validate,writeGuard,insert,replace,audit,publicRecord,fail}`。這些都沿既有model函式，validate必須保留永久週期、已服務、有效plan、核准請假與重疊守門。server內不建立第二套交易／冪等資料表，沒有schema物件新增。

exports：

- substitutionEntities；isSubstitutionEntity(entity)
- guardSubstitutionAccess(entity,ctx,readOnly,fail)；guardSubstitutionReview(ctx,fail)
- substitutionOperationQuery(params,fail)
- substitutionVisible(db,ctx,entity,item,get)
- substitutionHistoryVisible(db,ctx,entity,snapshot,current,get)
- substitutionQuery(entity,params,fail,mode='list')
- assertSubstitutionQueryTarget(db,ctx,entity,query,fail,get)
- filterSubstitutionRequests(entity,items,query)
- substitutionCreateDefinition(payload,fail)；substitutionReviewDefinition(payload,fail)
- createSubstitutionRequest(db,ctx,payload,deps) → item
- previewSubstitutionReview(db,ctx,id,payload,deps) → `{item,decision,canCommit:true,before:seven|null,after:seven|null}`
- commitSubstitutionReview(db,ctx,id,payload,deps) → `{item,shift:newFullShift|null}`

最小API分支放generic CRUD之前，角色守門先於body／query解析：

```js
const deps={get,rows,business,validatePayload,validate,writeGuard,insert,replace,audit,publicRecord,fail};
if(isSubstitutionEntity(entity)) {
  guardSubstitutionAccess(entity,ctx,req.method==='GET',fail);
  if(req.method==='POST'&&!recordId) {
    substitutionOperationQuery(url.searchParams,fail);
    const payload=await body(req);
    const result=idem(req,ctx,payload,()=>({status:201,value:{item:createSubstitutionRequest(db,ctx,payload,deps)}}));
    return send(res,result.status,result.value);
  }
  if(req.method==='POST'&&recordId&&['review-preview','review'].includes(action)) {
    guardSubstitutionReview(ctx,fail);
    substitutionOperationQuery(url.searchParams,fail);
    const payload=await body(req);
    if(action==='review-preview')return send(res,200,previewSubstitutionReview(db,ctx,recordId,payload,deps));
    const result=idem(req,ctx,payload,()=>({status:200,value:commitSubstitutionReview(db,ctx,recordId,payload,deps)}));
    return send(res,result.status,result.value);
  }
  if(['PATCH','DELETE'].includes(req.method))fail(405,'SUBSTITUTION_LOCKED','原申請內容鎖定；請另提申請或走人工審核。');
}
```

新entity spread入model.entities，加入guarded-records集合，使BigInt SQL current讀取能hide unsafe版本／bad JSON／metadata injection並且零repair。`scopedRows`新type先guardSubstitutionAccess再filter substitutionVisible。禁止generic create／patch旁路；server專屬create只從原shiftderive身份與snapshot，專屬review雙保存；不需generic payload/validate新增例外。

GETlist／single：substitutionQuery(entity,url.searchParams,fail,recordId?'single':'list')→assertSubstitutionQueryTarget→scopedRows→filterSubstitutionRequests→原pagination。list allowed page/pageSize/year/date/employeeId/status/q；single零query。history只page/pageSize/compare=previous，reuse已BigInt safeSQL與JSON容錯reader，新增comparable entity及snapshot.version===row.version後substitutionHistoryVisible。原固定worker／requester／shift／snapshot／理由／附註在每版匹配current，精確前版不足不得跳版。

shared歷程新增十四typed fields（完整descriptor見editor的substitutionHistoryFields）。兩snapshot都要closed seven-scalar projection再轉label/value rows，不rawJSON；root可沿已存在attendance-shift-snapshot table renderer，但不能把unknown key展開。status使用SUBSTITUTION_STATUSES。employee refs只有當次有權nameMap，caregiver map只自己員工、替代者只id，無弱lookup。

UI import `mountShiftSubstitution`，route `shift-substitution`，三角色admin/supervisor/caregiver，h1及nav「人工代班申請」。finance無入口且server403。本candidate不增加caregiver同事employees查詢權；普通review替代員工選取只有manager呼叫原pagedemployees。主列表及saved snapshots不依current shift歸屬。可於原班表給捷徑，但本切片獨立入口已完整，不需改frozen班表owner。

正式接線後仍須新增真HTTP與真瀏覽器測試，不把dependency-injected單元測試當成實际router/CSRF/idempotency/markup驗證。
