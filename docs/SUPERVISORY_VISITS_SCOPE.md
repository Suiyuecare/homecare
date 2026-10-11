# 督導訪視保存紀錄查詢（0.48）

日期：2026-10-10。本機獨立唯讀切片；先沿已接受的 APM CIS／Portal 整合，再补既有 assessment-04 保存紀錄的跨個案查詢。正式主機、HTTPS、Portal發布與本人UAT沿部署交接未完成。

## 範圍與來源

RM-07；原入口 URL-56520498f5f2（/supervisorVisitRecord，P-5D5AFB33／P-DD76C7AB）。既有本機 TEMPLATE-99aab37537a1 的 assessment-04 有 q001…q010 十個固定欄。原 REPORT-cea40c27e384、EXPORT-99aab37537a1 的正式查詢、列印、匯出及完整選項保持 not_started／unverified；不把本機查詢算作原報表完成。

新增 /supervisory-visits「督導訪視查詢」，只讀目前同機構、目前可讀父個案的 assessments 且 templateId 精確等於 assessment-04。填寫仍在原 /assessments；不建立第二套訪視紀錄、表或寫入端點。不判定正式訪視頻率、逾期、資格、評分、核銷；不發外部訊息。

## 授權與 API

GET /api/supervisory-visits 及 /api/supervisory-visits/:id，只允許 admin／supervisor。先沿 session／membership／org，再在 query／body 前拒絕 finance／caregiver。一般 mutating Origin／CSRF守門保持，這個入口對其他方法405，不讀body、不寫任何資料。任何不存在、其他模板、不同entity、外機構或目前不可讀父個案的單筆皆404；不更動原 assessments CRUD／history 權限。

list query僅 page、pageSize、q、status、date、caseId；每key只一次。page為十進位正safe integer，pageSize1…100預設25，不接受空白、小數、指數及空值。q原文字保留、最多200字元（UTF-16），小寫匹配十個 own string 答案各自，不跨欄拼接、不搜unknown keys、巢狀值、型別標記或metadata／個案姓名。status缺省或空為全部，非空僅draft/submitted；date缺省或空為全部，非空為有效YYYY-MM-DD（含0000），精確比對保存的 assessments.date「填寫日期」，不是 q001「訪視日期」。caseId缺省或空為全部；非空須最多500字元（UTF-16）的非空白文字且目前可讀case，原文字不trim，否則422或404。paused／closed仍有讀權，不能按姓名猜ID。filters四key原文回顯。single不允許任何query。

保留原 scopedRows 的 created_at DESC／id 穩定順序、同機構與父個案重新授權；safeVersionReader 避免unsafe SQLite integer轉換失真。只在符合模板、父個案及明確查詢條件的候選驗證非空識別、org、case、safe正version、有效date、draft/submitted；不合法回409 VISIT_DATA_INVALID，不轉型／補值。只驗目前頁亦會隱藏全結果損壞，因此驗全符合候選後再25筆分頁。GET全程十一表、六trigger、schema、total_changes不變；Idempotency-Key不產生紀錄。

## 專用投影與確認

list exact own keys {items,total,page,pageSize,filters}；filters exact {q,status,date,caseId}。single exact {item}。每row exact {id,orgId,version,templateId,caseId,caseNo,caseName,date,status,answerContainerKind,hasUnknownAnswerKeys,answers}。caseNo／caseName僅目前可讀父case string，非文字為空，不把名字當歷史保存值。

answers exact own q001…q010。own string（包括空與長文字）為 {kind:'string',value:完整原字串}；missing／null／array／object／number／boolean只有 {kind}，不返回非文字值或巢狀內容。answerContainerKind 區分 missing/null/object/array/string/number/boolean；只有own非array的object容器讀白名單。hasUnknownAnswerKeys只回布林，不能列未知key名／內文。非object容器十题皆missing；非法或未支援型別拒絕，不能coercion。pure adapter核對全DTO keys／tag與meta、filters exact echo、分頁筆數、unique id、template、org及query/date/status/caseId一致，非法2xx不能顯示資料。

## 共用介面

admin.listPage唯一搜尋、25筆分頁、loading／error／retry與context失效owner；僅有限 endpoint、caseFilter、dateFilter設定及captured request傳遞變體，interviews既有requested／控件保持。原生select/date沿 zh-TW／Asia/Taipei既有契約，搜尋與case/date條件只在記憶體，不進URL／storage。個案選項ID含同名／停用／paused／closed；清除明確選全部，查詢404不能默默改全部。

列表只顯示保存string摘要（160字），詳情使用唯一 openDetails({guardedRead:true,wide:true}) 每次 fresh single GET、完整十題與型別tag／目前名稱標示。Escape回焦點、重試、pending／loaded失效沿同owner，完整user/org/role/employeeId/hash/renderVersion primitive guard。版本歷程仍 openRecordHistory('assessments')，原歷史可能不同模板／個案，按既有逐版授權和精確previous顯示；此入口不縮減或改寫歷程。無CSV／print變體，不新CSS／token／dialog／控制器。

## 驗收與追溯

新HTTP及pure測試、完整unit、source check、必要共用list／assessment／history／core／APM CIS與HTTPS Portal browser、strict與DESIGN lint。合成memory fixture只由本次factory建立，setup／login寫入另列；所有查詢／對話框／篩選／失敗測試全十一表與schema及total_changes零寫，核閱快照及BLOB保持。桌機／390px逐圖實際檢視，包含長文字、空／無結果、讀取失敗、malformed2xx、切換context、真request abort。異常預期精確phase／URL／method／status或errorCode／count，不用整entity錯誤白名單；原失敗與raw視檢pending保持。

通過必要整合與瀏覽器才標 implemented_verified，本機版本0.48；只將原入口 URL-56520498f5f2 由not_started轉partial／related_only，mappingStatus維持unverified及currentRoutes追加本機路由。其他179目錄、report/export/template狀態、九階段、completedOriginalItems0、既有里程碑／source前綴保持。RM07仍partial。根使用者source先保留精確副本，凍結QA後才同步有權範圍；不存取data／實際env／真binding／私人備份／4310，不修改DNS或發布。


本機接受：861程式測試／8必要browser／16新圖，詳verification。原完整對等、CI、人工UAT與正式部署未驗。
