# 排班批次改派與取消

本切片提供本機可操作的人工工作流程：明確選取尚未執行的班次、預覽每筆結果，再確認整批改派或取消。管理者與督導使用相同的既有 APM 表單、原生選取控制項、預覽表格、錯誤與離開確認。正式部署與原平台功能全量對等不在此驗收範圍。

## 操作範圍

- 班表入口「批次改派／取消」，使用 `openShiftBatch({ data, refresh, isCurrent })`。
- 每批選取 1 至 50 筆不重複的班次，保存時帶入每筆明確的 `id` 與目前 `version`。
- 可依日期與既有排班文字欄位搜尋。日期可清空以選取跨日班次；每次改變篩選會清除選取。符合條件超過 100 筆時拒絕截斷清單，要求縮小條件。
- 改派須選擇同機構使用中的員工；取消不接受改派員工欄位。每批須填寫本次操作原因，最多 2000 字，原文存入稽核資料。
- 任何狀態的既有服務紀錄都鎖定該班次。僅目前為 `scheduled` 且無服務紀錄的班次可操作；`completed` 或 `cancelled` 不能操作。
- 保存只更動員工或班次狀態。日期、時段、個案、照顧計畫、服務明細、原交班備註與建立時間保留；不把本次原因寫入原交班備註。
- 預覽列出可操作數、衝突數、目前人員與預定調整。衝突存在時整批不可提交，沒有略過失敗班次的部分保存模式。

## API 與整合契約

`src/server/shift-batches.mjs` 匯出 `MAX_SHIFT_BATCH_ITEMS`、`guardShiftBatchAccess`、`shiftBatchQuery`、`shiftBatchDefinition`、`previewShiftBatch`、`commitShiftBatch`。沿用既有 model 的 `get`、`rows`、完整 payload validation、業務 validation、角色守門、CAS `replace`、版本保存與稽核。

```text
POST /api/shift-batches/preview
POST /api/shift-batches/commit
```

兩個端點都要求已登入、同機構脈絡、既有 Origin 與 CSRF 防護，只允許 `admin` 與 `supervisor`。角色、方法與查詢守門在讀取 body 之前執行。兩個端點拒絕任何 query。commit 額外要求 `Idempotency-Key`。

```json
{
  "action": "reassign",
  "items": [{ "id": "synthetic-shift-id", "version": 1 }],
  "employeeId": "synthetic-employee-id",
  "reason": "合成本次操作原因"
}
```

`action` 為 `cancel` 時完全省略 `employeeId`。payload 與每筆選取皆為封閉物件，未知欄位、重複 id、非安全整數版次、空白或未 trim 的 id、空白原因與超過上限的選取皆被拒絕。

preview 是零寫入讀取，不建立預覽 token、暫存 draft、版本、稽核或冪等紀錄。它回傳 `{ definition, items, total, readyCount, conflictCount, canCommit }`；每筆 ready 包含同機構完整 `before` 與 `after`，conflict 包含錯誤碼與文字。不可讀或跨機構班次不附任何原快照。

commit 由既有 `idem` 包住單一 `BEGIN IMMEDIATE` 交易，helper 會拒絕非交易呼叫。保存前重新預覽並逐筆重新讀取版次、員工、個案、計畫、服務與服務紀錄，套用既有重疊班次與核准請假限制，另外檢查本批所有最終改派間的互相重疊。任何失敗整批 rollback，包含所有 records、record_versions、audit 與 idempotency 寫入。409 `BATCH_CONFLICT` 附帶重新檢查的 preview；原 preview 並不是保存授權。

成功回傳 `{ batchId, action, reason, items, total }`。每筆記錄版本增加 1、維持原建立時間；各筆稽核記錄共用 `batchId`，保留實際操作人、本次原文原因、動作、變更欄位與新版本。相同 key 與相同 payload 重試回傳原成功結果，不重複改寫或增加歷程；相同 key 改 payload 被拒絕。

## 前端保存與脈絡防護

`public/modules/shift-batches.js` 的 pure guards `shiftBatchFormDefinition`、`confirmShiftBatchChoices`、`confirmShiftBatchPreview`、`confirmShiftBatchCommit` 驗證完整 identity、機構、版次、欄位型別、封閉服務明細、原文與可提交結果。它拒絕部分、重複、跨機構、未知欄位或非操作欄位變動的回應。

讀取、預覽與保存都綁定開啟時的使用者／角色／機構／員工脈絡、`getContext` 物件、路由與 root `isCurrent`。切換篩選或輸入會使預覽失效，保存前必須吻合目前輸入的預覽。慢回應在脈絡失效後不得復活表單或宣告保存成功。

失敗保留選取與原因，原 payload 重試保留冪等 key；完整 ACK 通過後才顯示成功、關閉表單並重新讀取班表。已保存但 ACK 不完整時保留表單，重試取回原成功快照。純文字不透過 HTML 注入；長交班內容及 CRLF 保持原文與原欄位存在性。

## 驗收與證據

測試僅合成 fixture、`:memory:` SQLite、隨機 loopback port，沒有真實個資、私人資料庫、正式帳號綁定、對外訊息或固定 4310 服務。

```text
node --test tests/shift-batches.test.mjs tests/shift-batches-view.test.mjs
node tests/shift-batches-e2e.mjs
```

- 10 項 HTTP/helper 測試：preview 零寫入、改派／取消、保留所有非操作欄位、角色與跨機構不洩漏、封閉 payload/query、最高 50 筆、同批最終重疊、核准請假、晚加入服務紀錄／員工停用／服務停用／CAS 衝突、競態、冪等、Origin／CSRF、交易守門。
- 6 項 pure tests：明確選取、完整候選清單與截斷拒絕、preview 內容與 counts、conflict 不得提交、完整保存 ACK、原 note 缺席與長 CRLF 原文保持。
- 交易失敗測試在第二筆 audit 寫入刻意觸發 SQLite ABORT，確認第一筆已執行的 replace 亦完全 rollback，失敗 key 不殘留且同 key 可再次成功。
- 專屬 Chromium 檢查普通使用者流程、實際持久化、503 與非法 ACK 重試、服務紀錄鎖定、預覽後 CAS 衝突、dirty／Escape／焦點、慢預覽路由失效、390px 與桌面幾何／標籤，以及角色維護入口。每次執行產物放入新 `outputs/software/v066-shift-batches-qa/browser-*`，保留失敗紀錄，不覆寫先前證據。

2026-10-10 本機驗收：16 項 HTTP/pure 全數通過；3 個 runtime／e2e 檔案的 `node --check` 通過。專屬 Chromium 12 個 gate 通過，7 張截圖，0 pageerror；完整通過證據為 `outputs/software/v066-shift-batches-qa/browser-1791637464861/verification.json`。已視讀 390px 表單、手機預覽與桌面預覽，無全頁或 dialog 水平溢出，表格由既有容器提供捲動。

前兩輪 QA 失敗保留於 `browser-1791637328833` 與 `browser-1791637406272`：第一輪測試假設清單排序而錯取第 2 列；第二輪 actor 斷言漏帶既有歷程的 `compare=previous`。分別改為以 shift id 找列與正確比較查詢，沒有修改 runtime 守門或既有測試來迎合 fixture。這兩輪失敗不列為功能通過證據。

## 明示限制

本功能操作已存在、具日期與起訖時間的同日班次；可以人工選取多個日期，沒有新增跨夜或永久週期 schema。沒有服務紀錄刪除、正式薪資規則、政府申報、付款、保險／稅務／銀行介接或自動外部通知。員工與個案的既有狀態、計畫及服務合法性沿用目前 model，沒有發明臨床、支付或勞務規則。
