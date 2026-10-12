# 管理者移轉紀錄閱讀

`/legacy-migrations` 提供目前機構管理者的唯讀批次、來源紀錄及完整原欄位閱讀。頁面沿 APM CIS、`DESIGN.md`／`UX-CONTRACT.md`、唯一 `public/styles.css` token 與 `public/ui.js` 的 pageHeader、table、pagination、errorState、button、guardedRead openDetails、toast。沒有新 CSS、字型、modal owner、編輯器、匯出、列印或任意檔案路徑控制項。

主要工作是核對「本次移轉時保存」與「目前主檔」，不表示原平台目前資料同步，也不表示原平台全量資料已取得。所有可確認回應都必須保留 `sourceSystemComplete:false`；首批營運資料匯入完成與原平台完整移轉分開。

## 三個讀取契約

| 操作 | API | 畫面 |
| --- | --- | --- |
| 移轉批次清單 | `GET /api/legacy-migrations?page=1&pageSize=25` | 保存 UTC 時間、來源 opaque label、個案及員工數、查看批次；每頁最多 25 筆 |
| 批次內來源紀錄 | `GET /api/legacy-migrations/batches/:id?page=1&pageSize=25` | 本批目前頁的種類、移轉時姓名／編號、原建立時間、查看原欄位；server 分頁與精確 echo |
| 完整來源紀錄 | `GET /api/legacy-migrations/records/:mappingId` | 移轉時對應欄位與目前主檔有限比較、所有保存原欄位及原公式／cached 值、來源與移轉識別碼 |

純 DTO owner 是 `public/data/legacy-migrations.js`：closed own-data envelope、ID／org／版本／父子、query echo、數量、來源 hash、immutable 批次狀態與完整 scalar 欄位確認後才 render。與 `legacy-operational-import` 的已核定 read schema 一致，不能只因 HTTP 200 先顯示部分敏感值。

完整原欄位依保存列序與 columnIndex 顯示，允許相同欄位名稱，分辨空文字、null、false、0，保留 CRLF、lone CR、NUL 後原文、長文字及原建立時間。公式和含 HTML／URL 的原文只透過 text node 顯示；不執行／不製作超連結。不可信 nested 值、未知 envelope、跨機構、錯誤 ID、父批次或主檔替換均拒絕，提供手動重新讀取。

來源缺少員工編號時，businessNoOrigin=`derived` 必須與已核定 provider／sourceId 的替代規則精確相符，畫面明示「移轉產生的替代編號」，不冒充原員工編號。來源 employee data 不含試算時薪；若目前主檔另有 hourlyRateCents，沿既有精確 formatter 顯示，明示這不是本次移轉核定薪資。

比較只使用本次保存的已對應欄位。相同／不同／目前未提供逐欄呈現；不推定未對應原欄位已同步，不讀原平台，也不把主檔之後的合法編輯覆寫回移轉原文。來源原建立時間保持原文，目標主檔的建立及更新時間／版本仍屬新系統自身。

## 權限與非同步

- 目前同機構有效 admin 才有導覽及所有 server GET；督導、財務、居服員及未登入不新增權限。原欄位可能含身分、銀行或其他敏感資料，沒有對其他角色作模糊的「通用查看」例外。
- module 只提供 `renderLegacyMigrations(container,{isCurrent})`；root 的 app route／index HTTP 仍是各自唯一 owner。HTTP POST／PATCH／DELETE 不接受移轉資料或任意 inputPath；正式 operator 工具另受控執行。
- 讀取以 AbortController、sequence、完整 user/org/role/employee primitives、外層 context reference、hash、父 render stamp、trigger connection 保護。保持相同 primitives 的巢狀 user reference 可繼續閱讀；有效權限或 owner 改變則撤除 loaded 及 pending 內容，晚回應不得復活。
- 新鮮 GET 取得 401／403 時，立即撤除原清單及所有依附的批次／來源視窗，不能只在子視窗顯示權限錯誤而留下舊敏感內容。其它錯誤清掉本次內容，允許一次明確重讀，不自動無限重試。
- row 查看按鈕沿既有 focusable read-busy 變體：aria-busy／aria-disabled 與同步 busy 守門防雙開，保留原生 modal 關閉後的來源焦點。背景由原生 modal inert；沒有第二套 focus／Escape controller。
- 來源條件、ID、結果及頁數只在該次頁面記憶體，不放 localStorage；桌機及 390 px 沿表格自身橫捲、原生 dialog 自身縱捲與 sticky close footer。

## 本機必要驗收

`tests/legacy-migrations-frontend.test.mjs` 的 13 項純契約測試在 Node 22／24 通過。`tests/legacy-migrations-e2e.mjs` 使用 memory DB、隨機 loopback port、共享合成 archive＋27 筆營運匯入 fixture，14 關 browser 通過；保留來源前後 SHA，SQL 全表／total_changes 前後相同，13 張桌機／390 px 合成 PNG 已逐張檢視。沒有接觸真實匯出、真實 DB、原帳密或 4310。

瀏覽器涵蓋真實 admin 導覽／server 25 筆批次與子頁、來源 duplicate labels／完整 NUL 後文字、derived 編號、目前主檔已合法變版的有限比較、長文與公式不執行、空結果、malformed nested 2xx、503 重讀、實際 foreign-org 403 撤除、七種 loaded／pending owner 失效、真實 request Abort、晚回應、相同 primitives、鍵盤 Enter／Escape／回焦、被新清單查詢取代的舊請求、其它三角色真實 403、未登入 401、重複 query 422 與任意 inputPath POST 405。

原首輪長文 probe 只量到自然高度 dialog-body，像素未顯示尾端，因此不保留其尾端可讀宣稱；修正為真正原生 dialog scroller、sticky footer 視區及每行 Range glyph hit-test。一次修正後的 union-box 中心落在兩行間空白造成 native 1，保留原錯誤與 PNG；再按每行實際文字 rect 驗證後，14 關重跑通過。最後尾文及 footer 實際可見，沒有增加 timeout 或放寬產品斷言。

官方 premium static UI 契約 auditor 以 20 秒上限執行，本輪 native 124，沒有完整報告；保留超時證據，不宣稱官方靜態審核通過。它不是掃毒／漏洞掃描；本輪沒有做任何掃毒／漏洞掃描。新頁維持既有 tokens／canonical 元件並有實際必要程式、權限及瀏覽器驗證；完整 CI、主機／HTTPS／真實 Portal 與正式營運 UAT 另驗。
