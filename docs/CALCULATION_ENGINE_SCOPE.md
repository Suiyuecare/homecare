# 明確核定規則試算引擎

模式 `configurable-calculation-preview-v1`。本切片提供已核定機構規則與原核閱服務的精確唯讀計算；正式自動收費、薪資、核銷與法定判定另有依據與驗收條件。本模組沒有預設官方費率、拆帳比例、捨入、自付身分、月額度意義、稅、保費或特殊加給，也不改寫既有試算快照。

## 來源與授權

僅目前同機構 `admin`、`finance` 可以查閱候選與試算；每次呼叫先重新查核 `memberships`。督導、居服員拒絕。HTTP 接線須沿共用 Origin、CSRF、等待 body 期間授權重查規則，不建立新授權例外。

規則固定為 `business-rules` 的 `pricing`／`payroll`；須為 `approved`、依據非空、參數完整合法，且有效期間涵蓋來源的每個實際佔用日。跨午夜且下一日有服務，須涵蓋下一日；結束恰於午夜時不增計下一日。

來源固定為同機構目前 `approved` 的 `service-records`。SQL 身份、文字原始 UTF-8、精確安全整數版次及目前不可改寫歷程必須一致。個案、員工與原已完成班次仍須同機構存在且一致。服務分鐘、數量、原核閱項目及價格快照完整確認；計算只引用已捕捉的分鐘與數量，不因現行員工／服務價錢改寫歷史。

可試算來源的原快照標記必須是 `approval`。系統建立的 `synthetic-demo` 示範核閱紀錄不具此資格；候選讀取仍先完整驗證其 SQL 身份、不可改寫歷程、七欄封閉快照、精確金額與分鐘、同機構個案／員工及原已完成班次，全部通過才排除，不使正常核閱來源的候選頁失敗。未知標記、損壞的示範資料或父項仍明確拒絕，不能靠搜尋或排除規則隱藏。直接指定示範來源讀取或試算仍回傳 `409 CALCULATION_SOURCE_INVALID`，不改写來源，也不把示範轉為核閱資料。

跨日日期保留於服務紀錄的 `actualEndDate`，原 `billingSnapshot` 仍是七個封閉欄位；支援的 2879 分鐘完整時段不需要添加快照欄位，未知第八欄仍拒絕。

## API 接線契約

`GET /api/calculations/candidates` 使用 `calculationCandidateQuery` 與 `listCalculationCandidates`。僅接受單一 `rulePage`、`sourcePage`、`pageSize`、`q`；分頁預設 1，pageSize 預設 25、最大 100，q 最多 200 字。這些僅為候選查詢預設，實際計算政策沒有預設。

回應固定 `mode`、`orgId`、`rules`、`sources`；兩個清單各為 `items,total,page,pageSize`。核定規則候選欄位固定 `id,orgId,version,kind,code,name,validFrom,validTo,parameters,sourceReference`。來源候選欄位固定 `id,orgId,version,date,label,caseId,employeeId,serviceMinutes,items`，每個項目固定 `serviceItemId,code,name,quantity`。不包含登入帳號、binding 或私人 token。所有候選符合型態、版本及同機構父項，才可供選取。

`POST /api/calculations/preview` 使用 `calculationPreviewQuery`（禁止 query）及 `previewCalculation`。封閉 body：

```json
{
  "rule": { "id": "明確選取的規則識別", "version": 2 },
  "source": { "id": "明確選取的原核閱服務識別", "version": 3 },
  "policy": {
    "operation": "quantity-rate",
    "rateParameter": "unitPriceCents",
    "serviceItemId": "原核閱項目識別"
  }
}
```

這是 DTO 說明，沒有可開通的真實身分。規則或來源版次不同即 409，不以最新值代替使用者看到的版本。未知／缺失欄位、浮點、字串數值、負值、unsafe integer、getter、稀疏陣列與附加欄位拒絕。

## 每次明確選取的計算方式

| 規則類型 | policy 必要欄位 | 語意 |
| --- | --- | --- |
| pricing | `operation:quantity-rate, rateParameter:unitPriceCents, serviceItemId` | 原核閱所選項目整數數量 × 所選核定規則單位分金額 |
| payroll | `operation:flat, amountParameter:baseCents` | 所選規則的完整固定基準金額 |
| payroll | `operation:minutes-hourly, rateParameter:baseCents, rounding` | 明確把基準金額當每小時分金額，乘原核閱分鐘／60 |
| payroll | `operation:basis-points, amountParameter:baseCents, ratioParameter:shareBasisPoints, rounding` | 明確以規則基準分金額為拆帳基礎，乘所選萬分比／10000 |

`rounding` 必須明確選擇 `floor`、`ceiling`、`half-up` 或 `half-even`。不依不同瀏覽器的浮點或 `Math.round` 計算。所有中間乘法用 BigInt，回傳金額須不超過 `Number.MAX_SAFE_INTEGER`；追溯保存原分子、分母、商、餘數及最後整數分值。

計價可明確添加封閉 `allocation`：`capMeaning,consumedCents,capParameter:monthlyCapCents,copayBasisPoints,rounding`。本次人工輸入的自付萬分比必須與核定規則一致，不能省略或自動套用其他身分。`consumedCents` 是本次人工核對的假設額度，沒有查寫正式月額度帳。

- `eligible-gross-ceiling`：額度限制可分攤的總價；剩餘額度內算自付／補助，超額由自付方負擔。
- `subsidy-ceiling`：先就整筆總價算自付，額度限制補助；補助超額由自付方負擔。

零額度就是零，不能當成「無上限」。已用額度超過額度時剩餘為零，不自動修改已用值。自付＋補助逐分等於總價。本切片不推定這兩種語意任一種為官方長照給付規則；正式規則需另外有可核對的法規與分類。

## 回應與保存邊界

回應固定 `mode,currency:TWD,previewOnly:true,ruleSnapshot,sourceSnapshot,policySnapshot,amountCents,trace,allocation,previewHash`。所有快照為獨立、遞迴凍結的副本，沒有保留輸入參照；canonical 欄位順序確保重算 hash 一致。`allocation` 未選取即 null。JSON 上限 2MiB，超出明確拒絕，沒有截斷來源或追溯。

候選與試算只有 SELECT；不建立帳單、薪資、額度異動、申報、付款、audit、idempotency 或新的業務版次。原核閱 `billingSnapshot.trial` 保留其原數字與文字，不改為正式結算。後續自動結算須獨立建立來源占用、覆核、關帳與更正交易，不可把此唯讀回應當成已關帳。

## 可重跑驗收

`node --test tests/calculation-engine.test.mjs` 包含 22 項本機合成測試：人工獨立推導金額、1 分與 half-even 邊界、BigInt overflow、兩種明確額度意義、缺政策／捨入拒絕、來源與規則快照保持、完整日曆日期、版本衝突、核定狀態、四角色／撤權／保留 membership 的停用財務、跨機構、候選固定投影、未知欄位與 getter、SQL／UTF-8／歷程／孤兒污染。每次唯讀呼叫前後比對全部十一表、schema、trigger 與 `total_changes()`。

2026-10-11 本切片 17/17 通過，Node 22.23.2 與 Node 24.19.0 原生退出碼 0。

`tests/calculation-http.test.mjs` 另有 10 個真實 HTTP 測試：實際建立待核定規則後核定、原服務提交及核閱、封閉候選、管理者／財務成功、督導／居服／匿名／跨機構拒絕、三種明確薪資政策、假設額度分攤、canonical SHA、原 trial 保留、未知 query／method／body 與缺政策、停用／過時規則及來源。讀取 body 的非同步窗口實際撤角色、變更規則版次、變更來源版次，拒絕晚到預覽並保持十一表零額外寫入。

HTTP 最終 9/9 通過，Node 24.19.0 原生退出碼 0、無 skip／todo。第一次 HTTP 執行 8/9；測試錯把人工自付比例與核定規則衝突預期為 422，正確契約為 `409 CALCULATION_COPAY_MISMATCH`。只修正測試為明確狀態與錯誤碼，未放寬或修改執行程式；原失敗日誌保留。

2026-10-12 示範候選相容性回歸加入實際 `seedDemo` 的純示範與混合來源、十二種快照／歷程／父項污染、跨機構與目前角色、2879 分鐘七欄快照保持，以及真實 HTTP 的示範候選、直接拒絕、CSRF 與角色邊界。新增成功案例在原版重現原生退出碼 1；修正後 22 項單元加 10 項 HTTP 合計 32/32，Node 22.23.2 與 Node 24.19.0 原生退出碼均為 0，無 skip／todo。示範仍不可試算；不因相容性修正接受未知或損壞保存內容。

官方 BA／AA 固定清冊價格预覽另見 `LTC_CODE_CALCULATION_SCOPE.md`，不能把通用假設額度解讀為法定額度。共用 UI、瀏覽器、真實薪資口徑、全系統 CI 與部署需由整合驗收紀錄另確認；單元及 HTTP 測試不能替代這些驗收。
