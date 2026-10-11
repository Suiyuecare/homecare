# 離線核銷批次與人工回應對帳

本切片保存公司人工整理的帳單批次、當時來源快照及已收到回應的人工記錄。它不是 FA 或政府正式格式，不會對外申報、傳送訊息、付款或回算服務計價快照。「人工對帳完成」只表示每筆來源已有可核對的人工接受或退件結果，不代表政府核准、核付或正式申報完成。

## 權限與保存

`claim-batches` 僅管理者與財務可讀寫；督導、居服員在解析輸入前即拒絕。資料沿用機構隔離、POST 冪等、版本 CAS、原子 SQLite 交易、版本歷程與稽核。無 DELETE 或批次正式送出操作。來源佔用檢查在保存交易內重讀，兩個同時建立的批次不能各自佔用同一張帳單。

輸入欄位為 `month number billingDocumentIds sourceReference responseSourceReference responses status note`。`month` 和 `number` 建立後固定；同機構編號不可重複，已取消編號仍保留。來源選取為同機構、同月份、1 至 100 筆不重複的已開立人工帳單，且不得已在其他未取消批次。草稿保存或核對時重新讀取帳單；已選來源若版次或快照改變，拒絕靜默更新，需取消原批次後另建。

伺服器派生 `sourceSnapshots`，每筆精確限定六欄：`billingDocumentId version number caseId caseName amountCents`。姓名取來源帳單開立時保存的個案姓名；來源快照於批次草稿保存時擷取，核對時確認同一來源未變，再鎖定。客戶端不得提交來源快照或總額。

伺服器派生 `summary`，精確限定七欄：`amountCents acceptedAmountCents rejectedAmountCents pendingAmountCents unansweredAmountCents sourceCount responseCount`。金額以安全整數分保存，合計透過 BigInt 計算；接受、退件、待定、未回應四類來源金額之和等於批次總額。退件總額指被退件的原來源帳單金額；每筆回應接受金額則為零。

## 狀態流程

| 狀態 | 可操作範圍 | 下一狀態 |
|---|---|---|
| 草稿 `draft` | 調整來源、人工依據、備註；不允記錄回應 | `verified` 或附本次原因 `cancelled` |
| 已核對鎖定 `verified` | 來源、人工依據及備註鎖定；可下載本機資料或首次記錄回應 | `reconciling` 或附本次原因 `cancelled` |
| 人工對帳中 `reconciling` | 保存、補齊或訂正回應與共同回應依據；來源與備註仍鎖定 | 保持 `reconciling`、`closed` 或附本次原因 `cancelled` |
| 人工對帳完成 `closed` | 詳情、歷程及本機匯出唯讀 | 無 |
| 已取消 `cancelled` | 保留來源快照、回應及本次取消原因，唯讀；來源可加入新批次 | 無 |

核對前 `sourceReference` 人工依據必填。取消只可修改 `status` 與本次 `note` 原因；不得沿用舊備註充當未提交的取消原因。來源帳單後來作廢時，仍保留已核對批次及歷程的當時快照；人工回應以凍結快照核對，不回算當前帳單。草稿不可對作廢來源重新核對。當前父帳單及個案仍須存在且屬同機構；不符合時現在、歷程、修改及匯出皆不可取得。

回應精確限定五欄：`billingDocumentId reference status amountCents reason`。每筆原來源帳單最多一筆回應，必須有使用者已收到的人工回應編號或依據，且共同 `responseSourceReference` 必填。結果為接受 `accepted`、退件 `rejected` 或待定 `pending`。接受金額須精確等於凍結來源；退件及待定金額為 0，退件原因必填。部分接受、額外扣款或核付演算法尚未核定，本切片拒絕猜測這些金額規則。完成對帳前，每筆來源須有接受或退件結果，不能仍待定或未回應。

## API 與本機匯出

- `GET /api/claim-batches`：`page/pageSize/q/status/month` 嚴格單值查詢；預設 25 筆、最多 100 筆。搜尋僅已定義的批次／來源編號、保存姓名、人工依據、備註、回應依據與原因，不搜尋機構或內部識別碼。
- `GET /api/claim-batches/:id`：單筆不接受查詢參數。
- `POST /api/claim-batches`：建立草稿；同內容同冪等鍵重試回原結果，變更內容須新鍵。
- `PATCH /api/claim-batches/:id`：正整數 `version` 必填；狀態與鎖定規則由伺服器驗證。
- `GET /api/claim-batches/:id/history`：僅 `page/pageSize/compare=previous`；重新確認現在資料、來源父項、SQL 版次及快照固定月份／編號，不展示未知巢狀值或壞 JSON。
- `GET /api/claim-batches/:id/export?format=json|csv`：僅已核對、對帳中或完成狀態；附件下載、`no-store`，GET 零寫入。預設 CSV，格式參數不可重複或混入其他欄位。

此實體的 POST／PATCH JSON 請求上限為 4 MiB，以容納最多 100 筆人工回應及每筆完整原因；欄位原有長度、數量與型別限制仍逐項驗證。其他一般實體維持 128 KiB，不因本切片擴大。超過上限回 413，資料、版本、稽核及冪等紀錄均不寫入。

JSON 的格式識別為 `local-homecare-claim-v1`，明確 `officialSubmission:false` 與中文用途警語，包含批次版次、完整來源及每筆回應；未回應為 `null`。CSV 每筆重複格式識別及非正式申報警語，含來源原金額、接受值、回應狀態／依據／原因，未回應狀態為 `unanswered`。UTF-8 BOM、CRLF、逗號及引號正確跳脫，使用者文字以 `= + - @` 或含前導空白／控制字元開頭時加單引號，避免被試算表當公式執行。原資料與 JSON 不因 CSV 保護而改寫。

## 可操作介面與共用所有者

`/claim-batches` 標題「離線核銷與人工對帳」，管理者／財務入口。新增先選月份，再以共用 `checkbox-group` 選帳單；使用普通輸入欄位，不輸入原始 JSON。草稿可編輯，詳情可核對鎖定、逐筆登錄／訂正回應、下載 CSV、取消或完成人工對帳，清單有搜尋、月份／狀態篩選、25 筆分頁與版本歷程。

表單、確認、詳情、歷程、表格、搜尋、分頁、下載與錯誤狀態沿 `public/ui.js`、`modules/history.js` 共用所有者；不新增 CSS、相等 dialog、下載 owner 或依賴。核對、取消、完成用清楚確認動作。資料以文字顯示、精確元／分 parser 輸入，失敗保留草稿與 POST 冪等鍵；保存 ACK 必須確認識別、機構、版次、完整業務欄位、來源與總額。textarea 初始 CRLF→LF 顯示不構成更改；未動欄位、未動回應及來源選取集合相同時不送無意義 PATCH。路由、機構、登入角色或父畫面過期會中止讀取與丟棄晚回應。

目前 UI 的本機匯出為共用 CSV 下載；JSON 由明確 API 格式提供。來源選項完整分頁讀取，最多 10000 筆；若總數變動、重複或讀取不完整，拒絕提供不完整選项。

純顯示投影 `claimSourcesForDisplay/claimResponsesForDisplay/claimSummaryForDisplay` 只呈現閉合已知欄位，拒絕 accessor、陣列 index getter、稀疏陣列、額外鍵／symbol，非法值回 `null`；不展開未知內容。

## 驗證與限制

`node --test tests/claim-batches.test.mjs tests/claim-batch-editor.test.mjs` 已通過 25 項：13 項真 HTTP 合成記憶體資料庫／隨機 loopback 埠，1 項伺服器整數與 CSV，11 項 pure adapter／ACK／安全投影。涵蓋角色前置授權、跨機構父項、來源重複／錯月／作廢、原子佔用、冪等、CSRF、CAS、狀態鎖定、回應精確金額、部分／待定不結案、父帳單後來作廢仍保留凍結追溯、現在／歷程未知值與壞 JSON、匯出零寫與公式保護、未動 CRLF／空白與 array getter 零呼叫。另驗證單次 PATCH 六筆各 10000 字中文原因（超過 128 KiB）完整保存、現在與歷程逐字一致；超過 4 MiB 及其他一般實體超過 128 KiB 仍回 413、全資料表零變更。

首次測試只發現 DELETE 預期 405 與既有 generic 未提供刪除路徑回 404 不一致；已修測試期待既有拒絕行為，並確認零寫入。未修改伺服器來放寬刪除。此切片的實際瀏覽器、手機及整體視覺驗收由 root 集成檢查完成後另記，本文不提前聲稱已驗。

未使用真實個資、既有資料庫、原平台帳密、秘密或正式系統。正式 FA 格式、送出／回應介接、官方費率、自付／補助／額度、核付／部分接受、正式帳務及主機部署仍另依核定規則驗收；本切片不宣稱原平台全量等價。
