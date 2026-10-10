# 舊報表月份型別安全（0.36）

> 公開版本文件：記錄此功能版本的設計與驗收條件，並非目前公開副本已執行的驗收證明。私人盤點與 QA 產物未匯出；現行行為以 API.md 與原始碼為準，正式規則及部署仍須核定。

契約於 2026-10-09 凍結。

## 行為與範圍

舊 `/api/reports/:kind` 的月份查詢對匯入的 object／array／number／boolean 日期可能拋 500。唯一產品改動是 `src/server/reports.mjs` 的 `inMonth`：非空月份要求 `date` 為字串才比對前綴。型別不符的資料排除；不轉型、不 trim、不驗日期、不取 `validFrom`、不改寫資料。月份未提供或為空仍包含原資料，JSON 原值與 CSV 原有 String 語意保持。

保留五種類型、欄位、備註、totals、created_at DESC/id 原順序及薪資首次出現分組順序。cases 對合法月份仍不篩日期；shifts/services 保留全部原狀態；fees/payroll 只讀 approved。未知 kind 404、財務報表角色 403、月份 422 的既有先後次序不變；URLSearchParams 第一個參數、原 regex、字串前綴及 0000 年相容。沒有引入 advanced report 的日期、分頁或重複參數規則。

同機構及居服員本人範圍沿 scopedRows/membership；fees/payroll 僅管理者與財務。所選 approved 缺 billingSnapshot 仍 409；月外資料不阻塞。所有費用、分鐘、保存時薪與原 Math.round 計算沿已核閱快照，不依現價重算，也不推定正式支付／薪資／核銷政策。

JSON、`.csv`、`format=csv` 共用既有授權及 builder；BOM、CRLF、公式防護、filename、MIME 保持。前台費用／薪資沿原月份、重新查詢及每次 fresh CSV；空月份顯示原提示不發請求。全部 public、其餘後端、schema、保存歷程及共用介面不變。legacy 不新增列印／PDF，advanced 七種報表契約保持。

## 驗收標準

- HTTP：五種 JSON 與兩種 CSV 路徑；非字串含 0/false、null、缺失、空文字、同月／月外、原字串前綴及 0000；不使用 validFrom；無月份／空月份保留原資料與 CSV。錯誤先後次序、四角色／異機構／失效員工、原狀態與順序、核閱快照及月內缺快照 409／月外排除須確認。
- 每組唯讀／拒絕請求比較十一張原始表、total_changes、版本與六個不可變 trigger，並含非空附件 BLOB；合成 setup、匯入、登入與必要業務變更分列，不把測試 fixture 寫入當讀取零寫入。
- 真 Chromium：管理者／財務實際操作費用及薪資月份與 fresh CSV，含異型已核閱日期、不錯誤 500、空結果、重新讀取、舊查詢／下載晚回應不污染目前 context。督導選項與居服員導覽保持；390px 內容與表格捲動及試算標語可讀。逐張檢視本輪新畫面。
- 執行全部 Node 契約與來源檢查，另執行核心及相關報表瀏覽器迴歸；只將實際完成結果計入本輪，不承稱 35 套舊 browser 全部 fresh。必要整合、獨立 review 與追溯更新完成後才標示 implemented_verified。完整原功能等價、人工 UAT、CI 與正式部署未驗證。

原支付、薪資、評分、正式介接與全量映射仍待核定；本切片不需要這些規則即可安全完成。
