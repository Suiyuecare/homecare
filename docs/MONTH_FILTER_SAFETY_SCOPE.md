# 泛用清單月份日期型別防護（0.34，本機切片契約）

> 公開版本文件：記錄此功能版本的設計與驗收條件，並非目前公開副本已執行的驗收證明。私人盤點與 QA 產物未匯出；現行行為以 API.md 與原始碼為準，正式規則及部署仍須核定。

此切片修復泛用 `GET /api/:entity?month=YYYY-MM` 在保存日期為異型合成匯入值時回500的既有缺陷。班表、服務紀錄及我的服務月份查詢沿此清單。

## 唯一產品修改

只修改 `src/server/index.mjs` 的泛用GET月份篩選回呼。選值仍是 `x.date || x.validFrom || ''`，先依原JavaScript truthiness選出原值，僅選值為文字時呼叫 `startsWith(month)`；選中的非文字值不匹配月份。

- 不把數字、布林、陣列或物件轉成文字；truthy異型date不回退validFrom。
- 缺失、null、空字串、0、false的date沿原truthiness回退validFrom；選中的validFrom若也異型則不匹配。
- 不trim、不轉時區、不新增日曆有效性或dateValid判斷；原匹配前綴的文字，包括僅年月、合法ISO時段或異常尾碼，仍按原前綴匹配。
- 沒有月份或 `month=` 時不套月份篩選，原保存欄位及own-presence原樣可讀。重複month仍取第一值。
- 非空非法月份沿原 `INVALID_MONTH` 422；year0000格式及月份1至12原正則保持。
- status/date/caseId/employeeId精確篩選、q與原來源順序、total／page／pageSize及錯誤先後保持。單筆GET及history仍依原路徑，單筆忽略month。

其他18個後端檔、所有public、原33個browser腳本與既有測試不變。新增本契約及兩個月份防護驗收腳本。機構隔離、真實session角色授權、CSRF／Origin、版本歷程、CAS／冪等、紀錄狀態鎖與核閱計價快照保持；不清理、回填或改寫舊資料。

## 驗收

重現稿首個錯誤碼名稱斷言失敗完整保留，修正僅依實際 `INTERNAL_ERROR`，不修改原程式或採納失敗結果。
2. 新HTTP驗收涵蓋有效與另月文字、truthy異型排除、falsey原回退、不新增日曆判斷、查詢組合及分頁、四真session角色／機構／本人範圍、原寫入拒絕、版本及費薪快照保持。每個純讀批次核對十一表raw、六不可變trigger與total_changes零變。
3. 真Chromium依清單入口→月份API→合成SQLite→回應呈現完整驗證；桌機與390手機檢查合法項目、查詢／分頁／重新讀取及本人範圍，逐張檢視本輪新圖。原生popup幾何、OS鍵盤選值及人工UAT不宣稱完成。
4. 全Node與source檢查，以及原33套478個browser聚合驗收需以新後端獨立合成環境通過。沒有自動重試；失敗保留、不弱化斷言；必要修訂後重新凍結與記錄實際程序退出。
6. 必要整合、browser、逐圖及独立覆核完成後才更新狀態。文件更新後執行fresh完整strict設計稽核及官方DESIGN lint；最終199來源與本輪證據逐份封存，實際outer程序完成收據另存在封存目錄外。

## 邊界與仍待處理

`src/server/reports.mjs` 的舊報表 `!month || x.date?.startsWith(month)` 保持原樣：非空月份的shifts/services報表遇到非null異型日期仍可能500；fees/payroll只有approved紀錄進入該分支。JSON、`.csv`與 `format=csv` 共用此實作，不能因清單修復而宣稱报表修復。沒有月份時原短路保持；null/missing原略過。舊cases報表本來不以月份篩選。專用日期區間報表及其 `REPORT_DATA_INVALID` 409維持原契約。

使用合成INSERT-only匯入fixture，並保存匹配的不可變版本；不UPDATE／DELETE版本或BLOB。原支付、薪資、評分、介接、資格、月額度、定位及正式差勤規則待核定；沒有正式申報、付款、外部訊息或部署。
