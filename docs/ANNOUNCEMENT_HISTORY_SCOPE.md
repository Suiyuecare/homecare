# 內部公告版本歷程（0.24 獨立本機切片）

2026-10-08 凍結，announcement-history-v0.24／RM-07。沿既有公告 CRUD 與共用唯讀歷程；合成資料，必要整合、瀏覽器及逐張畫面驗證後才標 implemented_verified。原公告 URL-4c9bc8a4fa47 仍 partial/unverified，原頁面等價、正式通訊與已讀規則未完成。

## current 與每版可讀範圍

current 先沿 scopedRows(announcements)，不存在／跨機構／錯實體404。admin/supervisor/finance 讀同機構所有狀態與閱讀對象；finance 不寫。caregiver 先經既有 active employee link，再僅讀 status 嚴格等於 published、audience 嚴格等於 all 或 caregiver 的 current。audience 是原保存字串，不新增角色權限或收窄原任意字串寫入規則。機構、登入與公共投影保持。

caregiver 的每個保存 snapshot 亦必須 exact published＋all/caregiver；同時用於 raw 與 compare。這修復既有 raw history 只驗 current、可能回傳過去草稿或其他對象內容的缺口。其他角色維持原同機構所有保存版，不依 audience 字串另加限制。current 不可讀時整筆404，不因有較早可見版而繞過。current 可讀但所有保存版不可讀則空歷程。不得回傳隱藏版本、其內容／受眾／操作者或隱藏前版快照。

GET /api/announcements/:id/history?compare=previous 沿既有通道；先逐版授權，再建立版本 map，再分頁。僅比較 exact version−1；第1版 initial、缺失或隱藏前版 unavailable、previousVersion/previousSnapshot=null，不跨缺口跳版。沿25/100分頁，28版25+3及頁外前版。非法／重複 compare 仍422。14個現有泛用 entities 至此均可比較；八套既有整合測試原「公告 previous 不支援」負向 fixture 最小改 next 非法值，保留422斷言及全部既有驗收，不改舊 e2e。

actor 沿精確同 org/entity/id/version 的 record.create/update 稽核 user 與目前 users 名稱。同人重複可辨識；缺失、歧義、錯 scope／action、已刪 user 保持 null，不用 source、時間鄰近、目前負責人或鄰版推測。raw／雙 comparison snapshots 沿 publicRecord：fileId 隱藏，billingSnapshot 原角色遮罩保持。沒有新表、寫入、稽核或還原功能。

## 四欄與共用介面

依序 title「公告標題」、body「公告內容」、audience「閱讀對象」、status「公告狀態」。標題與內容以分開節點的「保存文字：」標記加完整原文呈現，合法字面「未提供」或「非文字保存值；內容未展示。」亦能與缺值／tag辨認；文字保留換行、空白與 literal HTML，用 textContent 安全呈現；空值沿既有 missing/null/空字串合併；公告專屬安全tag表示非文字匯入值，不序列化巢狀內容，tag畫面明示「非文字保存值；內容未展示。」，合法字面「[欄位格式無法判讀]」與tag可區別及比較；隱藏的非文字內文不在比較範圍，畫面不宣稱整份公告沒有變更。其他實體 scalar 規則保持。id/orgId/version/fileId/billingSnapshot、外部訊息與已讀 metadata 不在業務欄位。四欄差異由共用純 helper 比對，只比較已授权 exact 前版，來源不修改。

audience：all全體同仁、caregiver居服員、supervisor督導、finance財務、admin管理者；status：draft草稿、published已發布至本系統。歷程已知值顯示名稱＋保存代碼，未知字串前置「保存文字：」保留原文，避免合法 all 和字面「全體同仁」混淆；own-property 查表避免 __proto__/constructor/toString 誤當標籤；公告清單相同安全查表。發布與閱讀對象只代表保存狀態／原可讀規則，不宣稱已發送、已讀或外部通知。

沿四角色既有 /announcements 導覽，只在可讀列增加「版本歷程」。admin/supervisor 原新增／編輯／撤回保留；finance/caregiver 只有唯讀操作。沿唯一 admin/listPage、history/openDetails、wide dialog、semantic table、25筆分頁、loading/empty/503 retry/Escape/focus。user/org/role/employee/hash/generation/render 完整 guard；loaded/pending 切換均清空、abort、關閉，晚回應不復活。無新 controller、CSS、token、ui.js、lookup 或外部訊息。

## 驗收與追溯

整合四真角色、active link、current撤回／更換對象撤權、每版 draft／其他對象排除、raw/compare同步、缺口不跳、actor、28版分頁、公用遮罩與原CAS/CSRF/POST冪等；純測四欄白名單、精確保存文字／typed scalar、差異及來源不可變。Chromium真 admin草稿→發布→sup修改→撤回／再發布，finance/caregiver可讀入口、異常字串、長文literal HTML、列表搜尋／狀態／分頁、503 retry、Escape回焦點、1440/390px表格內捲及loaded/pending六類context失效。client context fixtures明示，不冒稱 server membership 撤權；真API撤回與active link另驗。

十一表 raw/count/total_changes 逐唯讀段零寫；真正必要合成寫批次另對帳，雙非空BLOB bytes/SHA、六 immutable triggers、核閱費薪 snapshots及31個報表出口保持。原23套browser按原腳本回歸；新與必要 sibling 最終圖逐張 view_image，root另抽查。此切片0新PDF/0新operation marker，既有七報表 artifact僅按原腳本程式核對及同artifact修訂，不冒稱本輪人工舊PDF驗收。

actual 4310/SQLite 只唯讀前後核對並正常重啟驗證，不seed或清除。原84URL/52報表/28機構匯出/16模板/359題、順序/status/parity/statusCounts、四來源SHA、九階段及0原completed保持，localReportKinds仍9。原公告列不變；獨立milestone僅記 related_only，不宣稱原異動／發送／已讀等價。0.7–0.23封存保留；0.24另存程式、契約與本輪證據，各新copy核SHA。
