# 員工薪資規則與月份服務試算

每位員工可以保存不同期間的時薪或拆帳規則。這是機構核定設定及選取服務試算，不建立薪資單、不發薪、不推定最低工資、加班、假額、保險或稅。實際個人費率、拆帳基數、AA計入及正式薪資仍依 `USER_REQUIRED_INPUTS.md` 核定。

## 權限與生命週期

- 目前機構有效管理者維護；目前機構有效管理者與財務查閱及試算。督導、居服員、匿名及其他機構拒絕。POST／PATCH均沿Origin、CSRF、讀取body後重查登入、目前成員及生命週期。
- 新建必須待核定，建立後員工固定；草稿可調整有效起迄。核定必填明確依據，同一員工核定期間不得重疊。核定後包含日期的內容不可改寫，只可保持原內容停用；修改另建待核定版本。停用不可復活。
- 原records及不可變record_versions、audit、整筆CAS與冪等交易，無資料表遷移。不依email授權，不改員工主檔試算時薪或原服務快照。
- 每次完整驗證SQL身份／型態／UTF-8、目前精確歷程及版本鏈。清單分頁前核對完整候選；損壞資料不當成不存在。讀取body期間撤權、跨機構或版次衝突拒絕；失敗交易回滾完整資料。

## 保存欄位

閉合欄位：`employeeId,validFrom,validTo,payrollMode,hourlyRateCents,shareBasisPoints,splitBasis,aaTreatment,rounding,approvalReference,note,status`。PATCH另有安全正整數version。

| 制度 | 明確設定 |
| --- | --- |
| hourly | 正整數時薪分值；比例及拆帳基數null，AA處理not-applicable；逐筆進位方式 |
| split | 時薪null；1–10000萬分比；approved-service-snapshot或collected-receipts基數；include或exclude AA；逐筆進位方式 |

不提供正式費率、比例、拆帳基數、AA處理或進位的預設政策。介面用元及百分比輸入，精確轉換為分及萬分比保存，不靠浮點四捨五入。核定是機構對設定的明確操作，不代表法規或政府核定。

## API

- `GET/POST /api/employee-payroll/profiles`；清單接受各一次employeeId/status/q/page/pageSize，預設25筆、最多100。
- `GET/PATCH /api/employee-payroll/profiles/:id`；`GET /api/employee-payroll/profiles/:id/history`。單筆與歷程不接受query。
- POST、PATCH保存必須提供Idempotency-Key。同payload重試使用原鍵；回應需目前精確保存列，過時回執409，不以舊成功內容代替目前資料。
- `GET /api/employee-payroll/candidates?employeeId=...&month=YYYY-MM&page=1&pageSize=25`；僅同員工、開始日期屬於明確月份的已核閱服務。示範來源先完整確認快照、歷程及同機構父項後排除，不能試算。
- `POST /api/employee-payroll/preview`，不接受query。body固定`{profile:{id,version},month,sources:[{id,version}]}`，1至100筆不重複、明確勾選的目前來源；讀取body上限1MiB。

清單另返回只涵蓋當頁的員工姓名／編號／版本摘要。它是目前姓名顯示，不是薪資計算或歷史個人費率來源。回應2MiB上限，超出拒絕、不截斷明細。

## 試算追溯

必須目前核定規則、有效員工、來源與規則精確版本。來源沿原 `readApprovedCalculationSource` 的核閱快照與同機構個案、員工及已完成班次檢查。完整實際佔用日需在規則有效期內；結束恰於午夜不多占次日。跨月底以服務開始日期歸月，沒有自動拆成兩個月。

時薪用保存分鐘乘明確時薪／60；拆帳只用核閱時保存的各項金額乘明確比例／10000。BA／AA分類須在固定官方清冊，未知碼不能默認加入或排除。是否計AA由設定明確決定。`collected-receipts`可以保存待核定的制度，但缺少可核驗實收來源時試算409；不能用核付、帳單或服務金額代替實收。

所有中間計算採BigInt、明確floor／ceiling／half-up／half-even，每筆進位至分後加總；不可換成先加分鐘／金額再總體進位。超過安全整數分拒絕。回應固定profile、employee及全部source快照、每筆分子／分母／餘數／金額、選取來源合計與SHA256。前端重新計算並核對完整快照、來源版次、每筆／合計與SHA才顯示結果。

選取來源試算不是完整月薪。每次至多100筆，分頁跨頁勾選明示本次筆數；月份或選取改變撤除舊結果，失效晚回應不復活。既有人工服務轉薪資、覆核、關帳及更正流程保持，不把試算回應自動寫為已關帳薪資。

## 驗收

使用合成記憶體資料庫及隨機loopback，測試完整生命週期、期間重疊、CAS／冪等／過時回執、四角色／機構／撤權、整數精度與逐筆進位、原價及時薪變更不回算、跨日與月底、未知碼及實收來源拒絕、快照污染、SQL失敗回滾與所有表保持。瀏覽器另驗保存／核定／停用、錯回執重試、取消／版本衝突、跨25筆分頁選取、手機及鍵盤。完整結果由本輪驗收紀錄記載，未執行的項目不推定通過。
