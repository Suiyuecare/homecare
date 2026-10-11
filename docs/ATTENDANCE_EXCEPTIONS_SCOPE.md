# v0.69 人工出勤例外

此切片按年度保存人工出勤例外的種類、原因、來源與人工處理結果。五種封閉種類為遲到、早退、漏打卡、缺勤、其他；不推算打卡事實、GPS、出勤時數、請假、薪資、罰款或法定認定。原始出勤判斷與核定薪資規則仍待使用者提供，不能由此工作流推定。

## 保存、parent 與版次

`attendance-exceptions` 十四業務欄：`employeeId,date,shiftId,shiftVersion,shiftSnapshot,kind,reason,sourceReference,note,status,resolvedOn,resolution,voidedOn,voidReason`。除伺服器衍生的 `shiftVersion` 整數、`shiftSnapshot` 物件／null，其餘為文字；metadata 只接受 `id,orgId,version,createdAt,updatedAt`，保存版次正安全整數。

必填同機構員工、有效 Gregorian 日期、已知種類、人工原因與來源；長文各最多10000字，保留原文及未改動的 CRLF。日期為0001至9999，不接受0000或末尾換行。建立後員工及日期固定，未處理階段可修改其餘內容與 optional 班次參照。班次只能在新建或實際變更 `shiftId` 時由伺服器核對同機構、同員工、同日期、正安全版次及有效HH:mm起迄文字。

衍生快照恰七欄 `id,orgId,version,employeeId,date,startTime,endTime`，不複製 caseId、個案姓名、服務內容或 BLOB。無班次參照為 `shiftVersion=0,shiftSnapshot=null`。客戶端明確 POST／PATCH 衍生兩欄一律422；維持相同shiftId不重新讀取或重算舊保存快照，即便來源班次後來改派或更改時段。current/history 的授權依固定原員工與同機構閉合快照，無 live shift prerequisite，因此合法班次改派不會讓原人工例外消失。UI 的目前班次資訊只有仍符合原員工及日期才顯示；其他狀況顯示「原保存參照仍保留」，不披露他人的目前班次／個案資料。

`recorded` 可編輯；本次原始 payload 須明確帶 `status=resolved,resolvedOn,resolution` 才處理並鎖定。`resolved` 全內容鎖定，只能本次帶新的 `voidedOn,voidReason,status=voided` 作廢，保留完整原處理結果與原快照。`voided` 終態，無刪除 API。保存沿共用 SQL CAS、版本快照與稽核；新增沿共用冪等鍵；安全版次上限不得再寫入。

## 權限、查詢、歷程

管理者／督導可維護；居服員只有本人同機構 current/history 讀取權；財務讀寫皆403，權限先於本文或查詢解析。未知欄、壞JSON、null、unsafe SQL版次、snapshot/SQL版次不符、非閉合或跨機構參照快照隱藏且讀取不得修復資料。每個 snapshot 獨立驗原員工、固定日期、識別碼與保存快照，精確前版不足時不跳版比較。

列表 GET只接受單次 `page,pageSize,year,date,employeeId,kind,status,q`，日期與年度同時提供須一致。單筆GET不接受query；history只接受 `page,pageSize,compare=previous`。未知、重複、尾LF、不合法種類／狀態及過大分頁值拒絕。無聚合出勤時數或薪資。

## 介面與整合 owner

`#/attendance-exceptions` 主標題「人工出勤例外」。普通員工／日期／同parent班次下拉／種類／原因／來源／備註表單，非 JSON 編輯；人工處理及作廢沿共用確認框，取消保留輸入。查詢草稿變更立即撤除原結果，按「查詢年度」才確認；日期／年度為精確文字查詢，不經原生日期輸入轉換查詢邊界。詳情及歷程沿共用owner，關閉、focus、hash／role／org／connection失效、late read與cancel零寫沿既定模式。歷程為typed14欄，七欄保存快照亦為closed typed，不展示rawJSON；關聯名稱只能來自當次有權serverDTO。

自有 core/server/editor/module/tests/scope 路徑獨立；共享model/index/history/guarded reader/app/navigation/歷程型別與追溯metadata由根節點整合，server注入get/fail避免model循環。`jsonFields=['shiftVersion','shiftSnapshot']` 供伺服器衍生值，並不讓客戶端提供兩欄。

## 本機驗證標準

八項pure/memory測試涵蓋：日期／時間邊界、七欄快照排除個資、合法改派後仍本人讀取及後續處理／作廢保留原快照、employee/date固定、recorded shift更正同parent、closed/accessor/injection、角色／嚴格query、普通表單保存原文及ACK拒絕回算、修改無關欄位不得清除原班次選取。

五項真HTTP測試涵蓋：完整HTTP建立服務項目／照顧計畫／班次parent再記錄例外、改派留存、原始操作result/date及voidnewreason/date、closed derived injection、角色先於badJSON、本人current/history、跨機構parent、CAS／idem／MAXSAFE、malformed/null/unsafe current/history與唯讀零修復、無部分寫入與無其他資料改寫。

真瀏覽器須驗普通新增／更改種類保留CRLF／固定員工日期、optional matching shift選取、改派後原參照可保留、處理／作廢必填與nested cancel、typed frozen detail/history、不披露目前他人個案、年度日期種類篩選、ownedscope失效與late transfer零寫、主管／本人／財務角色、桌面1440與375/390標籤／捲動／無全頁溢出。每次唯一attempt、來源及PNG SHA、保留舊失敗，實際view圖像後才認列視覺結果。僅合成`:memory:`、隨機loopback，無私有資料庫、正式打卡、官方申報、付款、外部訊息或正式部署。

本機驗證收據如下；此切片不代表原平台180項全面對等，也不覆寫未核定正式規則。

## 專屬驗收收據（2026-10-10）

八項 pure/memory 與五項真正 HTTP 測試共13項通過，沒有跳過；最終紀錄 `outputs/software/v069-candidates/attendance/unit-http-run-03.log`。HTTP 由本機隨機連接埠建立合成員工／服務／計畫／班次，再合法改派班次，確認原固定員工之 current/history 與後續處理／作廢仍保留七欄原快照。malformed、null、unsafe SQL 版次及跨機構負例維持唯讀零修復；CAS、冪等與上限版次拒寫都有實際證據。

最終瀏覽器紀錄 `outputs/software/attendance-exceptions-qa/attempt-ZxvRuy/browser-2026-10-10T14-46-17-351Z.json`及 `outputs/software/v069-candidates/attendance/browser-run-07.log`。14個操作里程碑通過；14個監測來源開始／結束 SHA 一致，pageErrors、requestErrors、nativeDialogs 均為空。17張 PNG 保存同 run 的 SHA；實際檢視桌面／375／390的普通表單、來源長文欄、實際資料表內捲動、typed 七欄歷程快照與居服員本人只讀保存快照，標籤可讀、控制項及共用footer留在畫面範圍，無整頁水平溢出。

已保留所有先前失敗 attempt 及逐次 log。第二次發現真實表單缺陷：首次刷新下拉選項會清除原班次參照，已修復為只在員工／日期組合變動時更新，並加入專屬 pure 回歸及瀏覽器原參照斷言。其餘失敗包含 selector／同URL未重掛載／close事件前過早reload等測試同步問題；第5次完整行為通過但共用 ui.js SHA改變，依守門保留 failed-source-drift，未認列最終通過。最終測試沒有縮減角色、parent或來源一致性檢查。

8個自有正式檔及保留候選副本的SHA凍結於 `outputs/software/attendance-exceptions-qa/owned-source-freeze.json`。本切片沒有列印、PDF、CSV、打卡推定、薪資計算、GPS或正式部署；未測作業系統列印視窗，不以本機結果表示正式營運驗收。
