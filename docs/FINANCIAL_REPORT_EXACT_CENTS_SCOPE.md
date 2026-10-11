# 已保存整數分的精確元顯示契約（0.38，實作前凍結）

凍結時間：2026-10-09T06:25:09.193294+00:00. 狀態：contract_frozen；驗收尚未執行。來源：0.37 下一候選；canonical public/ui.js formatMoney，只有 admin 的費用／薪資試算金額列與合計兩處呼叫。員工／服務單價／歷程另用 formatTrialPriceCents，不改其契約。

## 範圍與相依關係

以 0.37 完整 DTO／BigInt 合計確認、既有機構隔離、伺服器角色授權、context／月份失效及獨立 fresh CSV 為前提。只替換既有 formatMoney 函式內部的格式算法，不改 caller、後端、CSS、token、widget、價格快照、版本或正式薪資支付規則。既有 212 受控來源先逐 SHA 核對 0.37 封存；只讀既存證據 metadata，不走訪舊封存內容樹，不接觸 data.db／既有 4310。

## 精確顯示與相容性

僅 primitive Number 且 Number.isSafeInteger(cents) 進入新分支，保留完整正負安全整數範圍。先建立原 zh-TW/TWD/maximumFractionDigits:2 Intl.NumberFormat，以 BigInt 整數分取得帶符號整元與絕對餘分，Intl.formatToParts 格式化整元後只替換 fraction 部分為兩位原餘分。-1 至 -99 分使用 -0 的 parts 留下負號；primitive -0 仍是原 $0.00。MAX_SAFE_INTEGER 分顯示 $90,071,992,547,409.91，MIN 顯示 -$90,071,992,547,409.91。幣別符號、千分位、負號、兩位小數與常用安全整數原輸出保持。

所有其他輸入完整沿原 formatter.format(Number(cents || 0) / 100)：字串、BigInt、boxed primitive、陣列、物件、fraction、unsafe Number、NaN、Infinity、null／undefined／boolean；不新增驗證、coercion、修值、cap、錯誤包裝，維持轉型次數、順序、例外類別及原 thrown object identity。truthy 字串 '-0' 與 boxed -0 保持原負零；NaN 的 falsy 行為保持。

## 驗收

10 個獨立純測試以十進位字串拆分／手工 grouping 為 oracle，不重用 BigInt 商餘或浮點分轉元。包含 MAX/MIN 邊界、末分／進位、4096 確定性正負樣本、原 fallback 與 coercion／error identity。

新 Chromium 測試於 memory SQLite／隨機 localhost：已保存合成 MAX 金額列及合計精確顯示，正常寫入 0／1／99／100／101 分與快照改價後保持，薪資只比較實際 API 回傳安全整數金額的顯示，不宣稱後端乘法／除法精度。MAX 快照屬 INSERT-only 歷史匯入例外，非正常寫入價×量保證。四角色／兩機構、bad 2xx／重試、JSON／CSV 真 abort 和失效、兩 fresh CSV 保存分、BLOB、十一表／六 trigger／版本零寫對帳；390px 表格自身水平捲動與長額文字無 document overflow。新流程無 PDF／print。

所有 premium-ui configured commands 必須 fresh 執行，並補充未列 manifest 的 legacy 月份測試；全 Node／source check、strict UI audit、DESIGN lint，獨立來源／契約與實際圖片檢視。新增 browser 失敗保留原因與實際 receipt，不能僅以腳本宣稱成功。month-filter-safety-e2e 只調整新 sourceCount/version，反向 SHA 還原原稿。實作完成須通過整合／瀏覽器並同步追溯及封存。

## 界線

只改善已回傳安全整數分的顯示；不修訂後端預格式計算、官方金額上限、薪資、補助、自付、加班、稅費、核銷或介接規則。CSV 仍是獨立 fresh GET／原始分，不由畫面確認其內容身份；不建立查詢身份 echo。0.37 已知格式限制保留作歷史記錄，本輪另明確驗證修正。原 180 全量等價 completed 不提升，RM-03／RM-04 維持 partial。僅合成資料、本機驗證，無 CI／UAT、原生 OS popup 完整人工驗收、正式申報／付款／外部訊息／部署。


## 完成驗證（0.38，本機已驗證）

2026-10-09T06:56:57.326647+00:00。全Node624、149 JavaScript及38套browser534聚合關卡通過；7新UI＋7sibling＋31fresh PDF頁，共45張實際檢視。原凍結條款及時序保留，實作與驗收完成記錄另列本節。

初始strict auditor呼叫誤用--strict／--json而未供必填--mode，argument parser child2／outer2（e0b4d6），原log／process／outer保留；沒有產品缺陷。經明確修正 invocation，以--mode strict／--config／--output執行私人fixed auditor，corrected child0／outer0（2b592a），非自動retry。原39-command matrix實際child／outer1，其中leaveShiftConflicts的requestfailed observer 10000ms逾時、僅7部分關卡不得算完成，另38children各一次fresh actual0。只將該測試完全相同observer移至loading截圖後／Escape前，inverse hash回 sealed037原稿；10000ms、真abort、focus、晚回應及11表唯讀原斷言保持，原逾時原因沒有確認。另建隔離215-source clone並明確執行完整同11關卡suite，corrected child／outer0；保留初始矩陣、failed process／log及兩份freeze，沒有重跑整個矩陣或自動retry。接受39舊configured／補充commands為38原成功＋1完整corrected，37browser523；新增金額browser11另actual0。成功40 unique commands，產品command attempts41含原失敗1；audit失敗／修正與DESIGN另列，不宣稱first-pass。兩freeze runtime57一致，tests／helpers除唯一leave觀察時序提案外消耗bytes保持；metadata後final215另存SHA，不宣稱全部最終文件再次執行。

只修已回傳安全整數分的顯示，不宣稱後端預格式計算精度，不新增官方金額上限、支付／薪資／補助／自付／加班／稅費／核銷或介接規則。薪資DTO沒有月份／組織回顯；CSV仍是獨立fresh GET原始分，畫面精確顯示不證明下載內容身份。MAX合成金額快照是INSERT-only歷史匯入驗證，不代表正常價×量寫入保證。0.37格式限制段落保留作歷史；本輪0.38另驗證修正。只用合成memory SQLite／隨機localhost；未存取data.db／既有4310／原平台帳密或真實個資，沒有CI、人工UAT、原生OS popup完整人工驗收、正式申報／付款／外部訊息／部署。原180全量等價completed仍0，RM03/RM04維持partial。0.39備份還原僅未凍結的合成scratch候選，RM09原not_started／正式4/5/6/7相依及migration-restore、role-matrix needs_contract保持；不提高Node最低版本。
