# 請假紀錄總表：0.19 獨立本機切片

2026-10-08 凍結；本文件不是原平台表單或正式假額規則的核定。完成整合、瀏覽器及逐頁列印驗證前不得標示實作完成。

## 查詢與授權

新增 GET `/api/leave-report`、`/api/leave-report/export`、`/api/leave-report.csv`，同一唯讀 builder。四角色沿現有 membership、active caregiver employee link 與 `scopedRows('leave-requests')`；不增加 caregiver 導覽。employee map 僅由同機構 `scopedRows('employees')` 建立，供目前姓名及指定員工參照；不得以 parent join 刪除原本可讀的請假。缺失、異機構或 wrong-entity 員工識別的請假依原 scope 保留，不 raw get 擴權。指定不在可讀 employee map 的 employeeId 先回 404，停用員工仍供管理角色查詢。

精確 filters `{startDate,endDate,q,employeeId,status}`。日期依保存的請假 date，必填有效 YYYY-MM-DD、含兩端最多 366 日；初載及清除為臺北當月。q 原文最多 200 UTF-16 code units、不 trim、不截短、不解讀語法；逐欄不分大小寫 literal includes，只搜尋可讀目前 employeeNo/name、保存 type/reason、合法 statusLabel，不拼接欄位、不搜尋 ID、日期、時段、版次、fallback 或其他主檔個資。條件 AND。狀態 pending 待審核、approved 已核准、rejected 已駁回、cancelled 已取消；空為全部。page/pageSize 沿共用 strict 契約，未知、重複、非法條件 422；export 不接受分頁。

先 employee/status/q 篩選，再驗這些候選的 dateValid，再套日期範圍。範圍內全部候選的 id、正 safe integer version、已知 status、保存時段有效性在分頁前驗證；異常整份 409 REPORT_DATA_INVALID，不略過、不只驗本頁。外部匯入尚未進入 auth 的 caregiver 本人 employee 超安全 SQLite version 仍是既有已知限制，另列待匯入規則核定。

可以將 0.18 safeVersionReader 原樣移至 report-query.mjs 匯出，僅 employee/leave 報表採用；保留 exact SQL、readBigInts、safe number conversion。不得改 model/auth 或舊三報表的讀取語義。

## 投影、時間與輸出

精確 12 row keys：`leaveId,version,date,employeeId,employeeNo,employee,startTime,endTime,type,reason,status,statusLabel`。employeeId 是原本可讀請假的保存外鍵，供查詢一致性確認，CSV/列印不列識別。employeeNo/employee 只取目前可讀 employee 原字串；缺失、非字串或不可讀為空字串，共用畫面呈現「—」，CSV 保留空欄；不把替代文案寫入業務字串或搜尋。指定可讀但無名員工的 selection.employee 為「名稱未取得」；未指定「全部可讀員工」。selection 精確 employee/status，status 為合法標籤或「全部狀態」。

八個顯示／CSV 欄依序：date「請假日期」、employeeNo「員工編號」、employee「員工（目前名稱）」、startTime「開始時間」、endTime「結束時間」、type「假別」、statusLabel「請假狀態」、reason「請假原因」。totals 僅 `{count}`，不增加分鐘、假額、薪資、actor 或法定推算。排序 date → 既有 timeMinute(startTime,date) → employeeNo → leaveId，字串比較 code units；相同分鐘不以秒或 offset 另推時序。

時段精確沿 model.timeMinute：有效 HH:mm 或保存 date 同日且 Date.parse 有效的 ISO 前綴，end > start；同日 ISO 保留秒及 offset 原文，原比較只看文字 HH:mm，不跨日、不改時區、不宣稱法定時數。新 adapter 可用相同有限純檢查，不改原 service adapter/model parser。任何非字串 type/reason/employeeNo/name 投影為空，明示原資料不足而不造值。

完整 export 最多 1000 筆／JSON UTF-8 2 MiB，邊界允許、超過整份 413、不截短；CSV 沿 BOM、全欄 quoting 與公式注入防護。組織、時間、note 沿既有完整 confirmation 契約。note 明示本機保存請假、目前姓名缺失以「—」呈現，尚未核定假額／薪資／正式表單。

## 共用介面與驗收

薄 leave-report.js adapter，key `leave-report`、title「請假紀錄總表」、date labels「請假日期起／迄／範圍」、caseFilter:false、只 lookup employees。沿唯一 report-view 與 ui.js 的 dispose/context/abort/loaded/pending owner；不新增下載、列印或 stale controller。選單增加請假總表與七種類型說明；不新增主導覽。screen 1100px，日期欄不折行 表內捲動；A4 橫向 12mm／9pt、八欄 10/10/12/13/13/10/8/24%、重复表頭、原 ISO 及長原因换行；DESIGN 只更新幾何。

必要驗收：四真 session、inactive/unlinked guards、保存親項缺失範圍、40 筆 25+15 與全數集合、狀態與篩選 AND/clear/empty、真實建立與改派 A→B→A/核准/駁回/取消、保存 HH:mm/ISO 原文、最新 CSV／預覽／列印、候選異常整份 409（含第二頁）、1000/2 MiB exact/+1、CSV 注入、10 種 loaded/pending context 失效、錯誤／MIME／空 body／late/native print guards。

所有既有 Node 與 18 套瀏覽器驗收照原腳本重跑，22 個既有報表出口、兩種真合成 BLOB 下載、approved 計價快照及 11 表／六 immutable triggers 維持。新 QA 僅合成／memory/temp DB；一份新合成 PDF、首次成功 marker 一次、40 LEAVE 標記與每頁表頭/A4/安全邊界/全文、全頁 PNG 逐張 view_image。逐圖檢查新 UI/PDF、既有四報表及請假歷程的最新 regression 複本，不改舊封存。

完成後同步 API/UX/PRODUCT/BUILD_STATE/追溯清單及唯一 0.19.0 封存，核對前 2866 保存 copies 和當輪 source/evidence hashes。原 84/52/28/16 項順序、來源、狀態、parity、phases、mapping 不變，原完成仍 0；本機種類六→七（新增 leaves），只在相關原請假頁／REPORT-3587fa46c371 追加獨立 evidence，不宣稱原表單匹配。下一切片按 backlog 相依關係選定。
