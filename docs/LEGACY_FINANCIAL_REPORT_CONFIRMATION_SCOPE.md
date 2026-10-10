# 費用／薪資試算回應確認（0.37，本機切片）

> 公開版本文件：記錄此功能版本的設計與驗收條件，並非目前公開副本已執行的驗收證明。私人盤點與 QA 產物未匯出；現行行為以 API.md 與原始碼為準，正式規則及部署仍須核定。

2026-10-09。先凍結本契約，再實作。沿 PRODUCT.md、API.md、0.36 已保存計價快照及既有報表介面；此切片不核定正式支付或薪資規則。

## 交付與界線

僅強化管理者／財務既有 fees/payroll 查詢畫面。純函式 `confirmFinancialReport(kind, result, month)` 置於 public/data/financial-report-confirmation.js；回應完整且一致才傳回原物件，否則拋出 code `REPORT_UNCONFIRMED`、訊息「未取得完整且一致的試算報表，請重新讀取。」。不修改、補值、trim、排序或修復來源資料；不得把 null、缺欄、數字字串、未知回應或不一致合計呈現成正常試算／零金額。

查詢維持既有非空 YYYY-MM 規則（含0000）；費用日期只確認保存字串 startsWith 捕捉的月份，保留 ISO suffix 及非日曆文字前綴。薪資 DTO 沒有月份或組織回顯，也沒有 row id；不得新增猜測的月份／機構驗證或以可見員編／姓名／費率判斷唯一列。組織／角色仍由伺服器及既有捕捉 context／sequence 守門負責。

## 完整回應契約

頂層恰為 title、columns、rows、totals、note；column 恰為 key、label，順序及文字與目前 API 一致。rows 為完整陣列，每列僅允許下列欄位。文字欄皆為 string，可空、原文保持。

| 報表 | title | 順序欄位／標籤 | totals |
| --- | --- | --- | --- |
| fees | 費用試算（未核定規則） | date／日期、case／個案、serviceCode／測試服務代碼、service／服務項目、quantity／數量、unitPriceCents／單價（分）、amountCents／試算金額（分） | count、amountCents |
| payroll | 薪資試算（未核定規則） | employeeNo／員工編號、employee／員工、minutes／核閱服務分鐘、hourlyRateCents／時薪（分）、amountCents／試算金額（分） | count、amountCents、minutes |

note 必須原文完整：「試算、未核定規則。僅計入已核閱服務，以核閱時保存的價格及時薪快照計算；未處理補助、自付額、加班、稅費或正式薪資/核銷規則，不可作正式申報。示範資料與價格均為合成測試值。」

quantity 為 safe integer 1..10000，價格／時薪為 safe integer 0..1e9（沿目前寫入契約）；amountCents 為非負 safe integer，不以 quantity×單價重新推算。薪資每列 minutes 為正 safe integer，不套用單筆服務1439分鐘上限，也不以 minutes×時薪重新推算。totals 筆數等於 rows.length、金額及分鐘為非負 safe integer且等於列值的安全加總；加總使用精確整數拒絕超出 safe integer 範圍。重複可見列合法，列順序保持。空陣列需筆數／金額（薪資含分鐘）皆0。

## 共用互動與匯出

沿 admin.js 既有 load／sequence／完整 context、ui.js canonical errorState／table／button／downloadCsv；保留原類型及月份。失敗清除舊列，以 inline role=alert 及「重新讀取」重試，CSV 保持停用；只有確認當前查詢成功才啟用。載入、空結果、未核定警示、元格式、native month/select、桌機及手機表內橫捲保持；沒有 CSS、token、新控制器、PDF 或列印功能。

CSV 仍由既有下載流程另發 fresh GET，沿 MIME／非空／context／中止守門。畫面確認不是 CSV 內容確認，CSV 可能反映查詢後的新資料；不得宣稱下載內容與畫面快照一致或完整確認。不得由 DOM／已保存 JSON 取代 fresh CSV。

後端全部保持，包括同機構／四角色、失效居服員403、CSRF／Origin、CAS／版本、append-only、approved 核閱快照、選內缺快照409、選外缺快照排除、價格及費率分組、legacy JSON/CSV 相容。其餘七類 advanced 報表及建立／編輯流程保持。

## 驗收條件

1. 純測試覆蓋合法／零值／空資料／重複列、原始月份前綴、數字型別與安全整數邊界、完整欄位／順序／note、精確合計、不可變及不可猜測的薪資月份。
2. HTTP 整合由合成 memory SQLite／隨機 localhost 驗證真回應、四角色／機構、快照及 fresh CSV，相同讀取保持十一表、六 trigger、版本及 BLOB。
3. 真 Chromium 測試錯誤2xx、inline錯誤／重試／CSV停用、loading／empty／success、完整 context及查詢／下載晚回應、键盤／390px／zh-TW／sibling；截圖必須檢視後才標示完成。native OS popup 幾何不宣稱完整人工驗證。
4. 全 Node／source check、premium-ui.json 全部 configured commands及 strict audit、DESIGN lint使用實際退出結果；歷史證據不重加到本輪fresh。

只用合成測試資料。未知正式支付、薪資、評分及介接仍待核定。

## 已知既存顯示界線及後續候選

確認安全整數分及精確合計，不代表既有元formatter對每個safe integer分都無損。Number.MAX_SAFE_INTEGER分（9007199254740991）精確元尾數為.91，既有Number(cents)/100及Intl可能顯示.90。此切片不新增cap或修改formatter；0.38候選須先盤點canonical格式所有呼叫及原語意，再凍結精確分轉元，不新增正式支付／薪資規則。
