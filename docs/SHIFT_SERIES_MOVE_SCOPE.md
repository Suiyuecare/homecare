# 永久週期整組移日：0.71 本機完成（跨夜另驗）

這份切片新增永久週期已產班的「整組移動服務日期」。既有單筆一般班次的同日移日、永久週期逐期產班、整組改派／取消／同日調時維持原操作與原測試；跨夜、跨兩日服務及其規則仍是第二階段待完成，不能由本切片推定完成。沒有新增擴展班次實體、表、背景自動排班、薪資推算或正式申報。

## 操作與 API

只有目前機構 admin／supervisor 可操作；caregiver／finance 拒絕。原路徑保持：

- `POST /api/shift-series/:id/adjustments/preview`：唯讀零寫入。
- `POST /api/shift-series/:id/adjustments/commit`：必須 `Idempotency-Key`，在 root 既有 `BEGIN IMMEDIATE` 單一交易內保存。

新增封閉 payload：`{version,fromDate,toDate,action:'move',items:[{id,version}],daysOffset,reason}`。`daysOffset` 是非零 safe integer JSON number，最多絕對值3652058，UI 普通文字輸入接受精確有號十進位整數；拒絕小數、指數、零、前導零、CRLF、字串 API 數字、accessor、symbol、稀疏陣列及任何略過守門旗標。所有移日後日期須在0001-01-01至9999-12-31之內。`reason` 保存原文，非空且最多2000字。

選取範圍按**原產班日期**計，含兩端最多93日；本範圍全部目前 scheduled、沒有任何狀態服務紀錄的班次必須逐筆明確選取與目前版次一致，共1至50筆。不截斷或略過失敗項。任何服務紀錄、completed 或 cancelled 的班次列為 excluded，保持原資料與追溯。

移日保存原 shift id，只改目前 `date`。case、人員、計畫、時段、services 量及順序、status、raw note／CRLF／空白邊界維持。原週期設定、原 link.date、deterministic link id、link SQLversion1 和 seriesSnapshot 都保持；重跑原產班範圍仍認為原 slot 已產班，不自動補班。

原班次若保存 ISO 日期時間，移日預覽回 actionable `MOVE_CLOCK_REPLACEMENT_REQUIRED`，不得裁切或偷偷改為HH:mm。唯讀追溯仍呈原保存字串；使用者可先沿既有同日調時明確改成HH:mm再移日。這不是跨夜或時區轉換功能。

## 原子驗證與相容性

移日預覽先確認原範圍內 exact all-editable membership、SQL/CAS 安全版次、parent/org、原版本1與目前不可變 head，建立全部 final targets，再用既有 shift validator 核對 active case/employee/care plan、計畫／service item 日期與服務、approved leave、非選取班次重疊及任何服務紀錄鎖定。

只在 private synchronous `WeakMap(db→scope)` 內，對 model 排班重疊檢查排除 exact selected old positions。scope 需要相同 ctx reference／primitive fingerprint、相同 old object id/version、相同 target object reference，以及 exact selected other id/version/full old content；client flag、裸skip list、外部callback皆不能創建。最後對全部 final targets 兩兩檢查 employee/case 重疊。所有 before-write checks 完成後才執行 replace CAS／不可變版本／audit；第二筆 history 或 audit 失敗由交易全部回滾。callback `finally` 撤除 scope，成功、衝突及失敗後 generic linked-date PATCH 都仍拒絕。

critical current rows 對同機構 cases/employees/care-plans/service-items/shifts/leave-requests/service-records 逐筆 BigInt SQLversion、closed JSON／metadata、基本 required/type/status/date/services/time 與 exact immutable head 比對；坏JSON/null/unsafe SQLversion/metadata injection/同版直接 SQL改日期不得略過。合法 approved service-record 的 server-derived billingSnapshot 沿原 model trial 七欄／員工四欄／明細六欄與原 dateValid／interval／timeMinute語義封閉驗證，保存原計價內容，不將新 linked移日0001範圍套回舊來源，也不拿目前單價回算；只有validatePayload排除這一server-derived欄，head仍比對完整快照。已核閱班保留，其餘editable可移日與原slot重跑不補班另有true HTTP regression。所有 internal links raw count 與 valid count 相同，version1 link head exact matching；linked shift 的原 immutable `record_versions` version1 必須 matching id/org/version/case/original date/createdAt，current head 必須 exact 全部現在 data+metadata。没有修補或假造歷史。

occurrence 原8欄維持。只有經 server 上述雙層驗證且目前 shift.date 不同 link.date 时，新增 primitive `movedDate: shift.date`；presence iff dates differ，exact matching。旧8欄直接改shift.date仍被 UI 原斷言拒絕。移回原日則沒有此新欄。移日 preview 每行新增 `originalDate`，`before` 是目前保存班次，`after` 是只有 date 改動的完整 business payload；commit result 為 `{batchId,action:'move',daysOffset,reason,items,total}`。

## Root 唯一共享接線

1. model 原 shift-series import 新增 `excludeShiftSeriesMoveOldPosition`。原 shift overlap filter 在 `x.id!==old?.id` 之後新增 `!excludeShiftSeriesMoveOldPosition(db,ctx,old,d,x)`，其他条件保持。linked-date 例外在本模块 `assertShiftSeriesShiftEdit` 内由相同私有scope判斷，不加 model/client permissive flag。
2. index 原 import 新增 `preflightShiftSeriesAdjustmentReplay`。仅 adjustments commit 的既有 `idem(req,ctx,payload,fn,preflight)` 第五參數，先沿原 canonical fresh auth/active membership 重新取得角色與org guard，再调用 helper。非move helper no-op；不会改原3種action重送。
3. cached move 重送只確認fresh角色／機構、目前 critical dependency／head/origin/link，以及選取 ID 在原範圍仍屬此series；不要求成功前旧shift/template CAS或scheduled狀態，不再次模擬移日，避免成功之後 ACK 同key重試被錯誤拒絕。第一次commit仍完整CAS及target preflight。
4. root 處理 package scripts、API/DESIGN/UX/BUILD_STATE/backlog／visual manifest，不由候選作者修改。

## UI 與驗收

同一路徑／owner `public/modules/shift-series.js` 的整組後續班次表單新增 move action 與普通有號整數輸入，原範圍／全部班次 checkbox、typed preview、共用 confirmAction、same-key submit、toast／409重預覽與資料保留沿既有 `public/ui.js`。預覽明列原產班日／目前服務日時段／移日後日時段；追溯詳情另列目前服務日。沒有新CSS、字型、picker或parallel dialog/focus owner。來源 primitive/hash/context/trigger失效、AbortSignal、late ACK、nested取消與焦點由既有 owner 管理。

新 tests `shift-series-move-editor.test.mjs` 9關在候選已 native exit0；r01 合成 preview before/after 使用共享引用、不是 JSON wire round-trip，造成一個測例不符合 wire 資料，修正 fixture JSON clone 后 r02過；原失敗日志保持。新 memory／true HTTP tests／ordinary browser 都是实际可執行測試，使用 :memory: 與 loopback random port，待 root hook promote 之後實跑，**候選階段不能宣稱通過**。原 shift-series pure/HTTP/browser assertions 不修改。browser 使用唯一 attempt、PNG SHA／實際視檢；至少桌機與375／390px完整操作、冲突零寫、取消確認／回焦、same-key503與malformed ACK恢復、409／scope失效、typed移日追溯驗證。

正式人員UAT、OS原生popup、正式部署、正式支付與薪資、跨夜第二階段仍待另行驗收。

## 正式程式接線後實際验收

新memory／HTTP／pure30項actual exit0；普通browser-r02九項actual exit0、17來源SHA一致、16張桌機及375／390px圖由作者實看。另四項局部捲動／最後衝突列補充證據獨立列出。r01取消確認回焦actual1保留，由共用ui.js修正temporarily disabled trigger後，原斷言未放寬，r02通過。整體完整回歸、備份及本機接受見outputs/software/service-billing-series-move-qa/verification-v071.json。原candidate驗收摘要為歷史紀錄；跨夜未由本切片接受。
