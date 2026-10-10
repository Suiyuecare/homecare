# 已保存整數分的精確元顯示契約（0.38，實作前凍結）

> 公開版本文件：記錄此功能版本的設計與驗收條件，並非目前公開副本已執行的驗收證明。私人盤點與 QA 產物未匯出；現行行為以 API.md 與原始碼為準，正式規則及部署仍須核定。

凍結時間：2026-10-09T06:25:09.193294+00:00. 狀態：contract_frozen；驗收尚未執行。來源：0.37 下一候選；canonical public/ui.js formatMoney，只有 admin 的費用／薪資試算金額列與合計兩處呼叫。員工／服務單價／歷程另用 formatTrialPriceCents，不改其契約。

## 範圍與相依關係

以 0.37 完整 DTO／BigInt 合計確認、既有機構隔離、伺服器角色授權、context／月份失效及獨立 fresh CSV 為前提。只替換既有 formatMoney 函式內部的格式算法，不改 caller、後端、CSS、token、widget、價格快照、版本或正式薪資支付規則。

## 精確顯示與相容性

僅 primitive Number 且 Number.isSafeInteger(cents) 進入新分支，保留完整正負安全整數範圍。先建立原 zh-TW/TWD/maximumFractionDigits:2 Intl.NumberFormat，以 BigInt 整數分取得帶符號整元與絕對餘分，Intl.formatToParts 格式化整元後只替換 fraction 部分為兩位原餘分。-1 至 -99 分使用 -0 的 parts 留下負號；primitive -0 仍是原 $0.00。MAX_SAFE_INTEGER 分顯示 $90,071,992,547,409.91，MIN 顯示 -$90,071,992,547,409.91。幣別符號、千分位、負號、兩位小數與常用安全整數原輸出保持。

所有其他輸入完整沿原 formatter.format(Number(cents || 0) / 100)：字串、BigInt、boxed primitive、陣列、物件、fraction、unsafe Number、NaN、Infinity、null／undefined／boolean；不新增驗證、coercion、修值、cap、錯誤包裝，維持轉型次數、順序、例外類別及原 thrown object identity。truthy 字串 '-0' 與 boxed -0 保持原負零；NaN 的 falsy 行為保持。

## 驗收

10 個獨立純測試以十進位字串拆分／手工 grouping 為 oracle，不重用 BigInt 商餘或浮點分轉元。包含 MAX/MIN 邊界、末分／進位、4096 確定性正負樣本、原 fallback 與 coercion／error identity。

新 Chromium 測試於 memory SQLite／隨機 localhost：已保存合成 MAX 金額列及合計精確顯示，正常寫入 0／1／99／100／101 分與快照改價後保持，薪資只比較實際 API 回傳安全整數金額的顯示，不宣稱後端乘法／除法精度。MAX 快照屬 INSERT-only 歷史匯入例外，非正常寫入價×量保證。四角色／兩機構、bad 2xx／重試、JSON／CSV 真 abort 和失效、兩 fresh CSV 保存分、BLOB、十一表／六 trigger／版本零寫對帳；390px 表格自身水平捲動與長額文字無 document overflow。新流程無 PDF／print。

新增 browser 失敗保留原因與實際 receipt，不能僅以腳本宣稱成功。month-filter-safety-e2e 只調整新 sourceCount/version，反向 SHA 還原原稿。實作完成須通過整合／瀏覽器並同步追溯及封存。

## 界線

只改善已回傳安全整數分的顯示；不修訂後端預格式計算、官方金額上限、薪資、補助、自付、加班、稅費、核銷或介接規則。CSV 仍是獨立 fresh GET／原始分，不由畫面確認其內容身份；不建立查詢身份 echo。0.37 已知格式限制保留作歷史記錄，本輪另明確驗證修正。僅合成資料、本機驗證，無 CI／UAT、原生 OS popup 完整人工驗收、正式申報／付款／外部訊息／部署。
