# 機構設定新增與回執確認

本切片補強既有 `/settings` 的新增系統帳號、新增機構與合成示範資料入口。沿用 APM CIS、現有共享表單、dialog、確認、錯誤摘要及 toast，沒有新增 CSS 或另一組元件控制器。只驗本機合成資料；不開通正式帳號、不改真實 Portal 綁定、不部署、不寄送訊息。

## 保存與授權

三條既有 POST 路由仍使用原 SQLite 交易與 idempotency 表；沒有更動 11 表／6 觸發器的本機 schema 或 13 表／6 觸發器的 Portal schema。建立帳號、機構及稽核均在同一交易；稽核失敗整批回滾。已保存後取消 HTTP 請求不代表原交易回滾。

POST `/api/users`、`/api/organizations`、`/api/demo/seed` 只允許目前機構的有效管理者及正確 CSRF。读取 body 後、交易中及接受快取回執前重查目前 session、機構與角色，原本的請求身份失效後不能沿用舊授權。同內容同 key 重送不再寫入；換內容／路由沿用 key 回傳 409。舊呼叫未帶 key 的相容性保留，畫面三個動作都明確帶 payload 對應的 `Idempotency-Key`。

帳號仍依四個角色 admin／supervisor／finance／caregiver 建立。居服員必須連結同機構有效員工；其他角色可不連結。員工與帳號有效狀態不同，不能藉連結另一機構或停用員工繞過授權。Portal 模式沿原本的公司入口管理規則，新增帳號與機構 API 拒絕本機開通。沒有以 email 自動廣開角色。

## 精確回執

帳號 body 沿既有五欄 `name, email, password, role, employeeId`。畫面姓名去首尾空白，email 去空白轉小寫，密碼保持原文，未連結員工明確傳 null。

帳號回應精確為 `{item}`，item 為 `id, orgId, name, email, role, employeeId, status, version, createdAt, createdBy`。新增 status 必須 active、version 必須 0，且識別、機構、建立者與實際本次內容全部一致。不得包含密碼、雜湊、原始登入綁定或其他未知欄位。

機構 body 為 `{name}`；回應 `{item}` 六欄 `id, name, role, sourceOrgId, createdBy, createdAt`。新識別必須異於原機構；新機構角色必須 admin、來源機構及實際建立者必須符合本次請求。

帳號與機構的 `createdBy` 指實際建立者。伺服器接受新回執或重送回執時，同時確認實際保存列、目前有效 membership、帳號生命週期版本，以及不可改寫的原建立稽核。被竄改的快取不能把另一管理者建立的資料冒稱本次 caller 所建。建立後帳號角色／連結／状态／版本或機構資料已改變時，舊回執回傳 `409 SETTINGS_RECEIPT_STALE`，不能冒稱舊內容仍為目前成功狀態。

示範資料 body 為 `{}`；回應精確為 `seeded, message, orgId, requestedBy`。`requestedBy` 只表示這次請求人，**不表示原建立者**。其他管理者以前已建立示範資料時，這次回應 seeded:false，訊息為「示範資料已建立，不重複新增」。初次 seeded:true 訊息為「已建立完全合成示範資料」。兩種情況均確認本次機構、請求人及仍存在的同機構 demo marker。

前端以 descriptor-first 白名單確認回執；錯機構、錯身份、缺欄、多欄、getter、未知 2xx 或無法解析 JSON 都不能顯示保存成功。getter 不執行。輸入及密碼保留，重送相同 canonical payload 沿相同 key，使用者改內容時換新 key，改回更早內容也不復用前一個動作 key。密碼只保留在表單與短期記憶中，不寫應用紀錄或持久儲存。

## 目前身份與機構選單

每個動作固定原 user／org／role／employee／authMode／CSRF／context 物件、hash 與目前 render owner。切換機構、路徑、身份、角色、render 或移除頁面，會沿共用 owner 失效並中止等待。晚回執不關閉新表單、不覆寫別的機構、不顯示晚到成功。

新增機構成功後才讀取 `/api/session`。精確驗完整 session DTO、原 user 姓名／email／識別、原機構仍為 admin 且員工連結未變、新建立的精確機構與 admin/null 連結、唯一且完整機構列表，以及原 CSRF 完全相同；確認後才更新 context。原機構保持目前選項。回應未確認時提示「機構已保存，但機構選單尚未確認」，不猜造新 session；晚到的 session 不取代已轉移頁面的 context。

成功刷新列表後，等待共用 dialog 的 queued close 焦點回復完成，再將焦點移到新建立的同名操作按鈕。更新期間標示 aria-busy，完成代次只表示這次列表更新已結束，不能代替業務回執。401 沿既有 app 政策：有開啟表單時顯示登入失效並保留輸入；明確放棄未保存內容後重新載入，必須實際回到登入畫面。保留輸入不授予後端任何權限。

驗收追蹤發現共用 openForm 在等待 close 事件才清理 listener，快速刷新或失效移除 dialog 時可能留下 beforeunload 提示。本次窄修為保存完成、明確關閉與 owner 失效同步執行同一份 idempotent cleanup，close 事件仍可再次安全呼叫。beforeunload 只保護仍存在、開啟且有效的髒表單；有效髒資料保護保持，沒有 accept 原生提示來繞過失效 owner。

## 驗收與證據

`tests/settings-create-safety.test.mjs` 包含 19 項 pure DTO 與實際 HTTP 測試：四個目標角色、新建及快取重送、每張表與 total_changes 零增寫、異機構／CSRF／匿名／其他角色／無效員工否決、舊回執與偽造建立者拒絕、另一管理者的 seeded:false requester 語意、三路由 new/cached 各一次真實 partial-body 撤權、稽核失敗原子回滾、getter 零執行、key 旋轉及精確 session 更新。

`tests/settings-create-safety-e2e.mjs` 使用 memory SQLite、隨機本機埠與合成帳號，記錄原始結果、HTTP trace、來源 SHA 和 1440／390px 圖。驗錯機構／錯建立者／未知或損壞 2xx 保留輸入、相同 key 重試僅一筆、改內容換 key、機構保存及選單確認失敗、晚 session／晚寫入回執失效、390px 焦點與 44px 操作高度、桌機三個非管理角色 UI/API 拒絕、另一管理者實際停用後不新增／不顯成功，以及重新載入需登入。G0 另以真正 reload 驗有效髒表單正常觸發 beforeunload 並 dismiss 保留內容，明確放棄後 listener 歸零；每個關卡結束均檢查沒有失效 unload owner。

原失敗 QA trace 含明文合成初始密碼，因此原始歷程僅存私人 `outputs/software/completion-20261011-qa/settings-create-safety/`，不收錄於公開倉庫。最終 result 的 trace 僅序列化 stage/url/method，沒有 key、body、密碼、cookie 或 CSRF；測試記憶中的 key／payload 仍作原驗證，沒有放寬 assert。截圖只有合成資料且密碼遮罩。公開回歸產物只可另選最後成功且審核過的安全結果與圖片，不能整批上傳私人 QA。

2026-10-12 最終窄範圍本機驗收：bundled Node v24.19.0；單元加既有 authority-window／backend／Portal companion 第 5 次 72／72 通過，原生 exit 0，無 skipped／cancelled／failed。瀏覽器第 8 次原生 exit 0、8／8 關卡通過、0 errors，11 份 consumed 程式／測試 SHA 前後完全相同，12 張桌機／390px 圖逐張檢視，沒有 document 橫溢、modal 溢出或未標示表單欄位。機構選單更新未确认訊息在頁面內容中，這張頂部截圖未包含該訊息位置；測試另外驗其存在及 context 未遭替換。

瀏覽器第 1–7 次原生 exit 均為 1，完整保留原失敗、結果、圖片、log 與當次 11 份 consumed source snapshot；沒有當作通過。其中包括測試合成 email 重複、焦點時序、既有 401 保留表單政策的錯誤測試預期、原生髒資料保護及實際共享 cleanup 問題。第 8 次才是最終版本。原私人明文 trace 沒有被安全新版覆寫或抹除。

最終 attempt 為 `attempt-fTbXni`，result SHA 為 `7269b3a860b79e1b5fcf4a5005a475f98549c13b2573e1d71332aed03e8c2894`。私人 manifest 保存各次實際退出碼、來源與 artifact SHA。所有程式及測試已凍結供整體回歸；本文件補入上述結果後亦凍結。這些結果只證明本機合成驗收，不代表全系統回歸、人工 UAT、原平台全功能等價、正式帳號、CI 或部署。
