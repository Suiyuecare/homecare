# BA／AA 官方清冊金額預覽範圍

本功能提供已核閱服務項目的**官方清冊單價預覽**。它不產生正式申報、請款、結算或付款，也不取代照管中心、地方主管機關或機構的資格核定。原服務紀錄的 `billingSnapshot` 與所有歷史版本均不修改。

## 清冊來源與版次

來源為[長期照顧服務申請及給付辦法](https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=L0070059)（2025-06-19 修正）[附表四](https://law.moj.gov.tw/LawClass/LawGetFile.ashx?FileId=0000398331&lan=C)。使用 39 個 BA／AA 代碼：12 個 AA、27 個 BA。一般地區與原住民族地區／離島兩欄價格均經官方 PDF 畫面核對，包含 BA24 的 220／265 元。AA01 使用 1,700／2,040 元；不使用舊表的 1,500 元。

- 固定清冊版次：`MOHW-20250619-Annex4-LTC3-20260101`。
- 官方 PDF SHA-256：`78df59bc8828b7495da524a445c9a000e7bd20b7ce12b41f8b1a47705d95a9e4`。
- 價格與條件核對日期：2026-10-11。
- BA08、BA09、BA09a 自 2026-01-01 適用；其餘已收錄項目自 2025-09-01 適用。服務實際佔用日期須完全落在項目的適用期間。
- 每筆保存官方代碼、名稱、兩欄整數分單價、完整跨頁條件、PDF 頁碼與適用日期。來源只包含官方公開資料。

清冊與計算純函式分別為 `public/data/ltc-ba-aa-catalog.js`、`public/data/ltc-code-calculation.js`。價格採固定已核對清冊；請求不能上傳替代清冊、單價、數量、部分負擔或額度。

## 封閉請求與來源

伺服器 `src/server/ltc-code-calculation.mjs` 提供 `listLtcCatalog`、`previewLtcCodeCalculation`，已整合 `GET /api/ltc-codes/catalog` 與 `POST /api/ltc-codes/preview`。查詢清冊支援明確的 `page`、`pageSize`（最多 100）、`q` 與 `category`（BA／AA）；回應含目前機構 `orgId`、固定清冊來源、條件與分頁資訊。

預覽請求只接受：

```json
{
  "catalogVersion": "MOHW-20250619-Annex4-LTC3-20260101",
  "source": { "id": "已核閱來源的 ID", "version": 1 },
  "policy": {
    "operation": "official-code-quantity",
    "serviceItemId": "原來源內項目的 ID",
    "code": "BA15",
    "region": "ordinary",
    "paymentContext": "standard",
    "rounding": "half-up",
    "eligibility": { "confirmed": true, "sourceReference": "人工資格核定依據" }
  }
}
```

`region` 必須選一般地區 `ordinary` 或原住民族地區／離島 `indigenous-or-island`。`paymentContext` 必須選：

- `standard`：所選區域清冊單價乘原來源數量。
- `shared-family-50-percent`：僅 BA15／BA16，依明確核定的共同區域／家人物品情形取百分之五十支付基數，其餘百分之五十另列個人自費。不能推定臥室、浴室為共同區域。
- `case-management-over-limit-90-percent`：僅 AA01／AA02，依明確核定的個管超額情形取百分之九十支付基數；差額是減付金額，不能列作個人部分負擔。

百分比計算須明確選 `floor`、`ceiling`、`half-up` 或 `half-even` 捨入。`eligibility.sourceReference` 為必要的非空人工核定依據。BA01 此來源恰好兩組時，另必須提供 `eligibility.specialApprovalReference`，記錄必要早晚各一組的特別核定依據；該欄位不能用在其他代碼或數量。這是人工核定聲明，並未自動驗證臨床狀態、核定文件真偽或早晚分段。

數量只能讀取所選已核閱來源中的原項目。官方代碼須精確符合原項目代碼，不能替換、不猜測、不自動添加 AA。未知代碼、舊版次、跨機構、不一致版本、未核閱來源、缺少項目、失效日期、損壞的現存資料／不可變版本頭、父層遺失與停用帳號皆拒絕。

## 已自動拒絕的同來源條件

現有服務來源沒有各項目的獨立執行時段，因此下列互斥採保守拒絕；可接續服務須先另保存可辨識時段，重新核閱後才可預覽。

- AA 單次加計在此單一個案來源合計最多一組，包括相同代碼拆成不同服務項目時的加總。
- AA01／AA02、AA08／AA09 在同來源互斥。
- BA01／BA07、BA01／BA23、BA07／BA23、BA01／BA24、BA07／BA24 在未分段的同來源互斥。
- BA02、BA18、BA20、BA22 與其他 BA 在未分段的同來源互斥。
- BA01 合計超過兩組拒絕；兩組須有上述特別核定依據。一般 `confirmed: true` 不能覆蓋限制。
- BA02 合計最多六組。BA02／BA13／BA15／BA18／BA20 每組三十分鐘，這些代碼的合計必要分鐘不能超過已核閱實際服務分鐘。
- AA08 須實際佔用晚間 20:00–24:00；AA10 須實際佔用 00:00–06:00。以半開時間區間核對，恰好結束於午夜不算佔用下一日。

上列已知條件通過時，回應標記 `sourceConditionsVerification: "verified-known-source-constraints"`。它只表示這份原來源可辨識的有限條件通過。

## 尚未自動核驗的內容

回應固定標記 `eligibilityVerification: "manual-attestation"` 與 `crossRecordLimitsVerification: "not-verified"`。尚未自動核對跨服務紀錄的日／週／月／年次數、AA01／AA02 全機構及跨機構個管組數、臨終日、疾病／障礙資格、訓練證明、國定假日、專業 C 碼同行與完成次數、居住地資格、個案給付核定與臨時服務通知、個別項目執行時段及主管機關確認。不能把勾選人工依據解讀為自動符合全部條件。

AA 依附表列為免部分負擔且不扣照顧額度，回傳 `copayCents: 0`、`capUsageCents: 0`。BA 的部分負擔、核定額度與已使用額度**尚未計算**，回傳 `null`，不能解讀為零。月額、當月按日比例、複評切換、六個月額度保留、跨機構額度帳本與正式申報格式均未包含。不得用通用的人工上限配置宣稱已實作法定額度。

## 金額與唯讀追溯

所有價格與金額以整數分保存；乘除用 BigInt，中間值不經浮點數，超過安全整數輸出拒絕。回應保存固定清冊來源快照、原項目條件、已核閱服務完整快照、明確政策快照、計算數量、單價、支付基數、共同家屬自費／超額減付、每步分子／分母／餘數／捨入結果及可重算 SHA-256。

預覽限同機構目前仍有效的 `admin`／`finance`。`supervisor`／`caregiver` 不可使用。伺服器再次核對目前會員角色與帳號停用狀態。預覽不寫資料庫、不核准服務、不修改原試算、不產生應收／薪資／申報批次。

## 驗證證據

`tests/ltc-code-calculation.test.mjs` 共 19 個測試，包含 39 代碼的獨立手工價格金標、兩區域單價、BA15／BA16 百分之五十與 AA01／AA02 百分之九十金額、所有上述明確條件拒絕、時間及生效日邊界、封閉請求、版次衝突、四角色、跨機構、停用會員、資料／版本頭損壞、不可變追溯與重算。

`tests/ltc-code-http.test.mjs` 另有 18 個真實 HTTP 測試，使用合成 setup／登入、原服務提交及核閱流程，覆蓋完整 39 碼回應、兩區域及百分之五十預覽、四角色、跨機構、原快照保留、來源／清冊版次、未知查詢／方法、CSRF／Origin／內容型態／損壞及超大請求。於讀取 body 的非同步窗口實際撤角色、刪會員／session、讓 session 過期、換 CSRF／Origin／機構／session、更新來源版次及停用財務會員，均拒絕晚到預覽。

上述 19 個單元＋18 個 HTTP 測試，加上通用計算核心 17 個測試，共 54 個，於 Node 22.23.2 及 Node 24.19.0 分別原生結束碼 0、54/54 通過、無 skip／todo。每個伺服器成功及拒絕情境比對 11 個資料表內容、結構與 `total_changes()`，確認預覽零寫入。桌機與手機瀏覽器操作由主程式整合驗收另行記錄；單元與 HTTP 通過不等於正式發布或法定申報通過。
