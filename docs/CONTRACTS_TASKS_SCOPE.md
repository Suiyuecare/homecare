# 個案契約、期限查詢與內部待辦

本切片為公司人工管理紀錄；不推定契約法律效力、不提供電子簽章、正式文件發行或通知送達證明，不自動修改到期狀態、產生背景工作或外部訊息。待辦不改排班、差勤、付款或薪資。合成測試、本機整合與正式業務 UAT 分開驗收。

## 契約資料與角色

`case-contracts` 只有管理者與督導可讀寫，財務及居服員在解析輸入前 403。封閉十三欄為 `caseId number title startDate endDate signedDate documentReference sourceReference renewedFromId status statusDate statusReason note`。必要個案、編號、標題與起迄日期；個案須目前同機構存在，日期精確 YYYY-MM-DD、年份 0001 至 9999，起日不晚於迄日。同機構編號唯一；`caseId/number/renewedFromId` 建立後固定。單行編號／標題／文件識別不得换行，長文保留原文，不因未修改而 trim。

草稿 `draft` 可編輯、記錄生效 `active` 或取消 `cancelled`。記錄生效時必填簽署日、文件識別、人工核對來源及本次處理日期；處理日期不得早於簽署日。生效後內容全鎖，只可人工終止 `terminated` 或人工處理到期 `expired`。取消、終止、到期都須本次提交的處理日期與原因；不可用舊備註推定取消。到期處理日須晚於保存結束日，本次日期不早於上次處理日。終止／到期／取消後全部鎖定；不提供刪除、恢復或背後到期排程。

續約建立新草稿，`renewedFromId` 指同機構同個案目前可讀的生效、終止或到期契約；新開始日須晚於原結束日，不修改舊契約。每個來源僅一個未取消的直接後續契約，交易內重讀避免並發重複續約；取消後可另建新編號。這是本機工作流規則，沒有推定法律應簽期限、權利義務或正式續約效力。

## 待辦資料與角色

`internal-tasks` 封閉十欄為 `title content assigneeEmployeeId dueDate priority status statusDate result statusReason note`。必要標題、內容、受指派員工及應完成日；優先程度 `low/normal/high`。新增或改派須同機構有效員工，既有員工後來停用時仍保留管理者／督導的歷程及人工處理能力。此頁無個案關聯或臨床分類。

管理者／督導可讀寫全部待辦；財務／居服員只讀目前 `ctx.employeeId` 指派給本人的紀錄，無建立、修改、代理或代辦。未連結員工的財務清單為空，任意指定受指派者查詢 404；不根據 email 自動建立綁定。居服員登入原有效員工連結驗證保持。

待處理 `pending` 只能開始 `in_progress` 或取消 `cancelled`；處理中可編輯內容、期限、優先程度或改派，保持開始處理日期，之後完成 `completed` 或取消。開始須本次處理日期，完成須本次日期與完成結果，取消須本次日期與原因；本次日不早於上次處理日。不能直接從待處理跳完成。完成／取消只變更本次狀態、日期與结果或原因，不能同時改派或改寫內容；完成／取消後鎖定。

## API、可見性與日期查詢

兩實體沿泛用 `GET/POST /api/{entity}`、`GET/PATCH /api/{entity}/:id`、`GET /api/{entity}/:id/history`，POST 冪等、PATCH 正整數 `version`、CSRF、版本及稽核與主資料原子保存。single 不接受任何 query；history 僅單值 `page/pageSize/compare=previous`。列表預設 25 最大 100，未知、重複、末尾 CR/LF 數字、過長搜尋或日期拒 422，不截斷輸入。

契約 list 接 `page/pageSize/q/status/caseId/asOf/expiry/expiryFrom/expiryTo`；指定個案須同機構存在否則 404。`expiry` 可 `not_started/within_term/past_end`，必須明確 `asOf`；只對目前 `active` 與保存起迄比較，含起訖日，不代表該日歷史法律效力。非生效狀態顯示 `not_active`，不派生修改 record。`expiryFrom/expiryTo` 僅依保存結束日含端篩選，不混用簽署日或處理日。

待辦 list 接 `page/pageSize/q/status/assigneeEmployeeId/priority/dueFrom/dueTo`；受指派對象須同機構存在，本人只讀角色再限定自身，否則 404。兩種日期期間須成對、依序且最多 366 日含端，明確查詢不發訊息或改狀態。q 最多 200 字元，只查已定義的業務文字，不搜尋內部個案／員工／機構識別碼。

目前紀錄精確閉合業務欄位加 `id/orgId/version/createdAt/updatedAt`，未知巢狀值、缺父項、跨機構父項、無效 SQL 版次、壞 JSON 不展開或修復，列表／目前／歷程／PATCH 皆不可取得。契約续約鏈驗同機構同個案、不重疊、無循環；每版契約固定個案／編號／續約来源及 record ID，保存 metadata 與 SQL 版次一致。待辦每版再驗目前同機構員工存在；本人角色只留下每版本人受指派值，改派後舊不同員工版不外洩，不跳版補比較。名稱由現在同機構主檔重新讀取並明示，非歷史姓名快照。

## 共用介面與驗收

路由 `/case-contracts` 的「個案契約與期限」供管理者／督導，`/internal-tasks` 的「內部待辦」供四既有角色並沿上述角色範圍。普通 select／date／textarea 表單、清單搜尋／狀態、25 筆分頁、詳情、人工處理確認、續約新草稿及版本歷程，均沿 `ui.js`／`modules/history.js` 既有 owner；無新 CSS、dialog、通知 owner、依賴或原始 JSON 編輯框。期限查詢有明確日期、期間、分類回顯及清除操作。

純 editor 比對原生控制項初始顯示，未改 CRLF→LF 或前後空白不 PATCH，故意改長文逐字保存。新建失敗保留表單及同 payload 的原冪等鍵；成功 ACK 須确认閉合識別、機構、版次及全部業務欄位，異常回應不關閉或顯示成功。路由、機構、登入／員工身分、父頁 render、觸發元素失效時取消讀取、丟棄晚回應；已提交的交易不宣稱可被 client abort 回滾。

專屬驗收稿 `contracts-tasks-editor.test.mjs` 涵蓋純 adapter、安全 DTO/accessor 零呼叫、精確 ACK、續約與日期、未改長文與故意修改。`contracts-tasks.test.mjs` 真 HTTP 使用合成記憶體資料庫及隨機 loopback 埠，驗完整狀態、並發續約、角色前置守門、跨機構／本人版本、CSRF／CAS／冪等、壞現在／歷程 JSON 和失敗全表零變更。正式接線後兩套專屬測試實跑 25 項通過（12 真 HTTP、13 pure／server unit），包括非正數與 64-bit 超安全 SQL 版次、壞父項 JSON 不造成 500 或暴露資料。

`contracts-tasks-e2e.mjs` 專屬 Chromium 瀏覽器實跑 11 流程通過：普通新建／狀態處理、實際已提交但 ACK 不符時保留輸入與冪等重試、人工到期與另建續約、長文原文保存、型別化版本歷程與可讀當前關聯名稱、明確期間只讀零寫、取消及兩個本人只讀角色。1440px、375px、390px 產生的 20 張 PNG 均實際以原始尺寸檢視，保存私人像素報告；表單／詳情的共用 footer 可見，窄幅表格採局部橫向捲動。首輪測試因同 hash 導航未重新載入新合成 fixture 而失敗，原失敗紀錄保留，只改驗收載入 helper；後續像素檢視发现未傳歷程 lookup 已修並補名稱斷言，修後再跑 11 流程全通過。這是本機合成資料驗收，並非正式部署或實體手機測試。

未使用私人資料庫、秘密、真實個資、4310 埠、背景任務、部署或原平台帳密。正式契約文字、簽署效力、保存／發行、到期義務、通知送達及完整原平台等價仍另依核定規則驗收。
