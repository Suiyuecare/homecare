# 班表個案／人員篩選 0.42 凍結契約

2026-10-09。僅新系統本機合成切片；沿 0.41 日期檢視、既有 API 與共用 UI。原180功能全量等價、RM03 partial、正式權限／支付／薪資／評分／介接均不由此核定。

## 範圍與唯一 owner

public/modules/shift-calendar.js 為 business adapter；public/data/shift-calendar.js 保留日期與完整報表確認，新增 public/data/shift-calendar-person-filters.js 擁有條件與 lookup 確認。共用 api(signal)、openDetails guardedRead、createForm、table、button、errorState 保持；無新 controller、observer、timer、CSS、token、字型、API、後端、schema、寫入、CSV 或 print。

原三欄預設及空 caseId/employeeId、每次一次完整 export 保持。明確操作「啟用個案／人員篩選」後，本 dialog 固定五欄，不隱藏非空條件。管理者／督導預設全部；居服員啟用時固定目前連結的 employeeId，native select disabled 但 createForm getValues 保留精確值。全部名單來自目前伺服器授權：所有可讀個案及人員，包括已結案、暫停、停用或歷史班次關聯，不依當期或工作職稱再篩。財務沒有此入口。

## 完整名單

每次啟用後查詢、翻期、今天、重讀，先用同一 load signal 依序 GET cases 再 employees，固定 pageSize=100，最多100頁／10000筆每類，再 GET 原完整 shift-report/export。日期與 primitive exact ID 條件先確認；每頁及每次 await 後檢查 current／Abort。禁止 ui.fetchAll 或報表模組的私人 reader。

每頁精確 items/total/page/pageSize 四 key，plain/null-prototype、own enumerable data；dense ordinary array；safe total 0..10000、精確頁碼、100 pageSize、精確本頁筆數、跨頁 total 相同、全域 ID 不重複、最終筆數等於 total。原記錄可有額外欄，但全部 own key 必須是 enumerable data string key；ID／orgId／version 必須是 own primitive 非空字串／目前機構／正 safe integer。拒絕 accessor／symbol／prototype，不呼叫 getter。

只投影 id/orgId/version/number/name/status/selectionName/label：number=caseNo/employeeNo、name/status 只保留 primitive string；缺失或其它型別不 coercion；名稱回顯沿 server name || 固定「未取得個案名稱／未取得服務人員名稱」，原空白與 HTML/CR/LF 保留為文字。label 顯示編號（缺失用「未填編號」）、名稱、狀態與精確 ID，區別同名選項。狀態不明顯示「狀態未確認」。每類完整投影 JSON UTF-8 最多2MiB；此為 option 投影上限，非網路 body 上限。名单無 snapshot token，不宣稱跨頁原子快照；排序／total 未變也不能證明所有中途異動不存在。

## 條件與失敗

calendarPersonFilters(person={caseId:'',employeeId:''}) 只接受精確兩 key plain/null-prototype own data primitive strings，無 trim／coercion／推測 UUID。calendarFilters／confirmCalendarReport／groupCalendarRows optional 第三／第四參數沿此條件；舊 default signatures 行為保持。lookup 輸出 frozen；confirmCalendarLookupPage(response,entity,orgId,page,expectedTotal) 回傳投影頁；confirmCalendarLookups(pages,entity,orgId) 回傳完整 frozen 投影陣列；calendarPersonSelection(person,lookups) 在 export 前確認所選 ID 與兩名稱；confirmCalendarPersonSelection(result,person,lookups) 比對完整結果 filter ID 與目前選定主檔 selectionName。純空白姓名沿 server 保存，但舊 shared confirmReport 的 trim 非空要求仍可能拒絕整份結果；本輪不修改此限制。

lookup 任一失敗不顯示部分名單／舊結果；保留五欄條件與精確失效 ID option，兩名單欄 disabled，查詢／重試重新讀整份。完整 lookup 成功但已選 ID 消失：保留相同 ID「原選項目前不可用」option，欄位 help 與結果錯誤立即提示，允許明確換項／全部；查詢提交沿 canonical e.fields 顯示 inline aria-invalid／field-error，禁止 export。不得默默轉成全部。無新即時驗證 widget 或 common showErrors capability。

所有欄位草稿變更立即撤舊 index／agenda，導航停用；重新查詢才恢復。今天／翻期／重新讀取保持精確兩 ID。lookup 成功而 export 413／失敗時五欄可用以缩小條件；不顯示部分結果。新 fresh selectionName 不符亦全體拒絕，可重新讀取。關閉、context primitive/reference、hash/render 失效由原 owner 取消及防晚回應。

報表原12外層key、13 row keys、11欄、1000筆／2MiB、日期／UTF-16 tuple sort、保存字串、版次、row reference 保持；row DTO 無 caseId/employeeId，不以姓名或案號推測列歸屬。列的實際 ID 篩選由真實 HTTP integration 使用獨立 shiftId→caseId/employeeId oracle 證明；前端只能確認伺服器回顯與現有 DTO。

## 驗收

新增 pure、真實 HTTP/integration、browser suite；保留既有0.41 default/no lookup/context suite。涵蓋101+跨頁、同名不同ID、closed/inactive/缺name、完整與空結果、單／雙ID／status、缺失／外機構／getter／重複／改total／超限拒絕、撤權、413縮小恢復、lookup/export取消与晚回應、草稿及精確ID保存。十一表／六 trigger、版本、BLOB、計價快照唯讀保持；setup必要寫獨立對帳。所有 configured premium commands fresh actual，strict/design audit、1440/390px 真圖片與 relevant sibling 驗證完成後才 implemented_verified。原生select鍵盤選值／OS popup、人工UAT、完整WCAG、CI、部署未驗不可宣稱。只用合成 memory/temp/random-loopback，不存取既有DB／4310／原帳密／真實個資／正式申報付款訊息或部署。失敗原始保留、不宣稱 first-pass／自動 retry。
