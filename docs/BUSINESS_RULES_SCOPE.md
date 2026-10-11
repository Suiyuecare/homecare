# 業務規則設定

本機提供機構自己的計價、薪資、差勤、評估、核銷格式及關帳規則保存流程。機構人工核定不代表政府核定、法規合規或原平台演算法對等；本切片尚不執行計算、申報、收付款或薪資結算。

## 資料及授權

`business-rules` 的欄位為 kind、code、name、validFrom、validTo、sourceReference、parameters、status、note。沿原 records、record_versions、audit、POST 冪等與 PATCH 版次 CAS；無新表或資料遷移。只有管理者可維護；管理者、督導、財務可讀同機構目前紀錄及歷程，居服員拒絕。沒有按 email 自動授權。

parameters 採封閉物件，不接受額外鍵、浮點數或字串轉數字：

| 類型 | 保存參數 | 範圍 |
| --- | --- | --- |
| pricing | unitPriceCents、copayBasisPoints、monthlyCapCents | 分 0–100000000、萬分比 0–10000、分 0–1000000000 |
| payroll | baseCents、shareBasisPoints | 分 0–1000000000、萬分比 0–10000 |
| attendance | graceMinutes、roundingMinutes | 分鐘 0–1440、分鐘 1–1440 |
| assessment | minimumScore、maximumScore | 整數 0–1000000，最低不得高於最高 |
| claims | formatVersion | 必填文字，最多100字 |
| closing | reopenWindowDays | 整數天數 0–366 |

數值界限是本機輸入限制，並非正式費率、月額度、學分、薪資、法定寬限或核銷規則。使用者必須提供自己的核定依據與適用方式；沒有官方預設值。

## 版本流程

新增只能保存 draft；類型與代碼建立後固定。validFrom/validTo 必須是年份0001–9999的有效日期，結束不得早於開始。人工核定為 approved 前必填 sourceReference；同機構相同類型及代碼的已核定版本不得重疊有效區間，包含首尾日。approved/inactive 內容鎖定；已核定只能以保持內容的更新停用，變更金額、依據或日期須建立新的待核定紀錄。停用不撤銷任何既有服務核閱快照。

本切片的「版本」有兩層：每筆紀錄的 CAS 保存版次，以及相同類型/代碼不同有效期間的獨立規則紀錄。未建立唯一連續序號或自動接續有效期，也不把草稿及停用版套用到計算。

## API 與介面

`GET/POST /api/business-rules`、`GET/PATCH /api/business-rules/:id`、`GET /api/business-rules/:id/history?compare=previous`。清單接受各一次 page/pageSize/q/status/kind；pageSize最大100，q最多200字；未知、重複、非法類型及狀態拒絕。

`/business-rules` 沿 APM 品牌與 ui.js 表單、確認、詳情、搜尋、表格及分頁。兩步新增先選規則類型，再填相應參數；每頁25筆。核定與停用需要明確操作及確認，督導/財務僅查閱。輸入失敗或無法確認保存回應時保留草稿；同機構、id及版次確認後才顯示成功。詳情及歷程沿共用 guardedRead，路徑或身分失效時撤除內容。

## 接續工作

計算引擎須另保存使用的規則紀錄id、CAS版次、有效期間、依據及參數快照，採整數分及明確的捨入方式；覆核後不得回算改寫。收費、月額度、薪資、核銷、結算等各自完整流程尚在實作清單。正式支付碼、政府交換格式、薪資法定扣項及評分口徑仍沿 requiredContracts 待核定。

驗收採合成資料與隔離資料庫，含六類合法保存、非法參數零寫入、核定來源、期間重疊、內容鎖定、CAS、冪等、機構/角色隔離及瀏覽器人工核定。正式主機、HTTPS、Portal發布與真實公司UAT另驗。
