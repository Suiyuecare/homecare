# 人工薪資結算工作流（本機）

本切片提供可操作的人工核定薪資紀錄：新增草稿、編輯明細、覆核、關帳、取消、查看詳情及版本歷程。採沿用的機構隔離、伺服器角色授權、版本 CAS、建立冪等重試及共用表單／確認視窗。人工明細由機構依核定依據輸入，系統保存加項、減項及淨額；未提供完整法定薪資演算法，也不執行付款。

## 頁面與權限

路由 `/payroll-statements`，前端入口為 `mountPayrollStatements(container, { isCurrent })`。只有 `admin`、`finance` 可以讀取、建立或修改。`supervisor`、`caregiver` 在解析業務 payload 前即回應 403；業務驗證函式內亦再次守門。列表每頁 25 筆，可按員工、月份、狀態及文字查詢。員工可以是同機構的現職或停用員工。

查看詳情會重新讀取個別紀錄；列表、詳情、保存及歷程均限定目前機構與識別碼。換機構、角色、使用者、路由或移除容器時，停止請求並清除過期內容。表單與確認視窗沿用 `ui.js`，保留焦點、dirty、busy、離開確認與錯誤提示行為。

## 保存資料

| 欄位 | 規則 |
| --- | --- |
| `employeeId` | 同機構員工必填，建立後固定 |
| `month` | `YYYY-MM`，年 0001 至 9999，建立後固定 |
| `number` | 必填，最多 100 字，同機構唯一，建立後固定 |
| `lineItems` | 1 至 100 筆封閉 JSON 明細；不可有額外鍵 |
| `sourceReference` | 最多 500 字；覆核前必填人工核定依據 |
| `status` | `draft`、`reviewed`、`closed`、`voided` |
| `note` | 最多 10000 字；保留明確輸入的空白、LF／CRLF |
| `employeeSnapshot` | 伺服器生成 `{ id, name, employeeNo }`，建立時捕捉，此後不隨員工主檔改動 |
| `summary` | 伺服器生成 `{ earningCents, deductionCents, netCents }` |

每筆明細為 `{ label, kind, amountCents }`。`label` 非空白且最多 100 字，允許名稱重複；`kind` 只能為 `earning` 或 `deduction`；`amountCents` 為 0 至 1000000000 分的非負安全整數。合計以 BigInt 相加，淨額不可負，再轉為安全整數保存。用戶端不能提交 `summary` 或 `employeeSnapshot`。不按目前員工時薪回算保存明細。部分更新未包含的欄位保持原值；替換明細時亦保持沒有修改的明細名稱文字。

## 狀態與確認

| 目前狀態 | 可操作 | 保存限制 |
| --- | --- | --- |
| 新建 | 建立草稿 | 只能是 `draft` |
| `draft` | 編輯、覆核、取消 | 覆核需人工核定依據；取消需本次明確原因 |
| `reviewed` | 關帳、取消 | 員工、月份、編號、明細、依據固定；關帳不可改備註；取消只可更改狀態與本次原因 |
| `closed` | 詳情、歷程 | 任何更新均拒絕 |
| `voided` | 詳情、歷程 | 任何更新均拒絕，紀錄與歷程保留 |

覆核、關帳皆有明確確認視窗。取消使用共用確認表單，原因從空白開始輸入；伺服器要求該次 payload 自己帶有非空白 `note`，禁止沿用既有備註充當取消原因。關帳不代表付款完成。

## 表單與保存確認

正常使用者以名稱、加項／減項及元金額欄位逐筆填写，不顯示 raw JSON。金額沿用既有 service-item 精確元／分解析器，最多兩位小數，拒絕浮點數、指數、符號、千分位及空白金額；顯示使用共用精確金額 formatter，可保留 1 分。

明細筆數可調整為 1 至 100；縮減會隱藏後面的欄位，但本次草稿仍保存它們。若超出的欄位原已有明細或已輸入內容，必須明確勾選移除確認才能提交；增加筆數可以找回輸入。原明細名稱含換行、單行依據或備註含控制項無法無損表示的 CR 時，提供「保持／明確取代／明確清空」意圖，避免載入表單便覆寫。未改動的長文字、空白及原值不送入 PATCH。

保存失敗保留草稿；409 顯示重讀提示。新增對同一表單 payload 使用相同冪等鍵重試；編輯與狀態更新帶目前版次。只有回應機構、識別碼、下一版次、所有業務欄位、金額合計與員工快照吻合，才顯示成功，關閉共用表單後重載列表。狀態變更確認亦檢查每個未操作欄位保持原值。

## API 與整合契約

- `GET /api/payroll-statements`：只接受各一次 `page`、`pageSize`、`q`、`employeeId`、`month`、`status`，未知／重複欄位或非法值回應 422。文字搜尋限編號、核定依據、備註、建立時員工姓名及人工明細名稱。
- `POST /api/payroll-statements`：建立草稿，可用 `Idempotency-Key`。相同鍵、相同內容重試回傳原結果；相同鍵不同內容回應 409。
- `GET /api/payroll-statements/:id`：不接受 query；只讀目前機構紀錄。
- `PATCH /api/payroll-statements/:id`：帶 `version`，沿用 CAS。非法狀態、鎖定內容、重複編號或過期版次拒絕且零寫入。
- `GET /api/payroll-statements/:id/history`：沿用既有 `page`、`pageSize`、`compare=previous`；根整合檢查機構／識別／版次及固定父員工／月份／編號，偽造同機構改父或跨機構快照不得可讀。
- 無實體刪除操作；取消以 `voided` 保留紀錄。

伺服器匯出 `payrollStatementEntities`、`isPayrollStatementEntity`、`guardPayrollStatementAccess`、`normalizePayrollStatementPayload`、`assertPayrollStatementTransitionPayload`、`validatePayrollStatement`、`payrollStatementQuery`，由共用 model／router 整合。純前端 adapter 匯出嚴格資料、列表及 ACK 守門與表單編輯器；歷程顯示需白名單渲染明細、合計及員工快照。

## 驗證及邊界

新增的 HTTP 測試使用 `createApp({ dbPath: ':memory:', port: 0 })`；全部資料為合成資料，未讀取真實資料庫、帳號綁定或秘密。測試涵蓋角色先行拒絕、機構隔離、父員工固定、明細封閉驗證、精確金額、狀態鎖定、獨立取消原因、員工快照保持、零寫入失敗、CAS、冪等、嚴格查詢及不合法歷程不可見。純測試涵蓋精確解析、草稿保持、隱藏明細移除意圖、多行文字、列表及完整保存 ACK。

本切片尚須由根整合完成瀏覽器及全系統驗證後，才能標示本機驗收完成。程式完成與測試通過不等於正式主機、HTTPS、Portal 或付款上線。

待核定事項為法定／機構薪資計算、假勤加班、津貼公式、保險與稅費、正式薪資憑單格式、員工自助權限、銀行付款及外部介接。這些規則未被臆測或以人工結算紀錄冒充。
