# 0.43 週／月班表完整報表銜接契約

本機切片，2026-10-10 凍結；本機實作／驗收完成，正式及原功能等價未驗。來源為已驗收 0.42、SHIFT_CALENDAR_SCOPE.md、SHIFT_CALENDAR_PERSON_FILTERS_SCOPE.md、SHIFT_REPORT_SCOPE.md 及現有伺服器授權。

已確認且非空的班表顯示「完整報表／下載」。只捕獲五個 primitive 字串 startDate/endDate/caseId/employeeId/status；週／月衍生區間、0000..9999 與原字串 ID 完整保持，不經 URL、storage、姓名或 native date input 傳遞。草稿改動撤下入口；錯誤、空結果或 pending 無入口。原日曆保持開啟；關閉內層預覽回入口焦點及原條件。管理者、督導、居服員沿原日曆及 API 範圍，居服員不得進入 /reports，不修改導覽、伺服器角色或資料 scope。

shared report-view.js 是唯一報表內容、完整讀取確認與預覽輸出 adapter。既有七類報表的預覽沿同一新抽出的 openReportPreview 預設變體，原外部 CSV 操作保持。班表 opt-in 內層 CSV；ui.js openDetails 保持 sole load/print/retry/close/focus owner，沒有 calendar 私有讀取／輸出 controller、CSS 或新路由。

預覽、重試、列印及 CSV 每次 fresh GET /api/shift-report/export，沿 confirmReport 及較嚴 confirmCalendarReport 驗精確 filters、ordinary envelope、十一欄、完整 rows/count/sort、1000 筆及投影 JSON UTF-8 2 MiB。不得把錯誤／空／非法內容 resolve 為成功可列印。selection 顯示 fresh server 主檔名稱，允許同 ID 更名；沒有新的下拉名單或弱 lookup。row DTO 無 caseId/employeeId，成員篩選須由保存 ID 的獨立 HTTP oracle 證明。

CSV 先 fresh 完整 JSON 確認再 GET /api/shift-report.csv，沿 ui.downloadCsv 的訊號、MIME、非空、15秒逾時及 late guard；完整資料限制沿既有 server 投影驗證，不宣稱 CSV 網路 body 位元組上限。兩次 GET 非原子快照。共享預覽 owner 為 CSV transfer 建立單一 controller，重讀／列印起始中止前次 transfer；精確 body 連線、signal 與 caller/current guards 防 stale 檔案。關閉／Escape／context primitive 或 reference、hash／render 失效取消並清除；不承諾跨頁或跨 GET 原子快照。CSV busy 防重複、可取消；錯誤 inline retry，成功沿共同 toast。

驗收需涵蓋：admin/supervisor/caregiver 與 finance 日曆／入口拒絕（既有班表報表API finance唯讀200保持）、未啟用及啟用人員條件、同名不同 ID、fresh 更名／新版、週月及日期邊界、empty/503/413/malformed/filter mismatch、retry、draft 撤回、close/Escape/focus、nested modal keyboard/390px、native print suppression、fresh print、CSV fresh/取消/重複/print競態/晚回應、loaded/pending 身分與路由失效、唯讀全表版本及快照不變。執行每個 configured command；只保存實際退出與來源雜湊、原始失敗及瀏覽器圖片/PDF。原 0.42 證據不可覆寫。

不新增 schema、主檔、版本、計价、快照、資格／例休／薪資／支付／申報／介接、正式列印表單或部署。原180功能全量對照仍未完成，RM-03 保持 partial；人工 UAT、完整 WCAG 與 OS native popup 不由本機測試推定。

## 本機接受紀錄

本機驗收：同一份255來源／66 public及src檔案，178 JavaScript檢查、755程式測試、45 configured／44 required加2補充，共47個原生子程序全部exit0；含45套browser、CIS9關、HTTPS合成Portal登入8關與班表報表銜接14關。最低Node22.13的24項Portal測試通過；strict audit零finding，DESIGN lint零error／10既有warning。原始失敗、修正與獨立作者視檢證據保留，不宣稱first-pass。metadata在QA後另封存，執行程式與測試保持接受來源的精確bytes。

原glob未匹配/export與busy偽內容改變accessible name的測試失敗保留；只修路由glob與預先捕捉同一CSV按鈕，保持真abort、busy／disabled、防重複、完整CSV、唯讀ledger及原14關／逾時。
