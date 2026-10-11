# 教育訓練紀錄總表：0.22 獨立本機切片

2026-10-08 凍結。沿現有保存資料與權限，不是原52報表或法定積分規則的核定。完成整合、瀏覽器及逐頁列印驗證前不得標示實作完成。

## 授權與查詢

新增 GET `/api/training-report`、`/api/training-report/export`、`/api/training-report.csv`，共用唯讀 builder。先沿 `guardPersonnelAccess('employee-training',ctx,true,fail)`：admin/supervisor可讀同機構全部保存訓練（含停用員工），caregiver僅本人且原登入 active employee link 每次驗權，finance三出口一律403，早於參數或參照錯誤。不修改model/auth/原CRUD、不可更換的employeeId、資格或排班規則。

原 `scopedRows('employee-training')` 為資料範圍，不能新增parent join排掉原可讀保存列。employee map僅目前 `scopedRows('employees')`；缺失、foreign、wrong-entity父項仍保留原scope訓練列，姓名／編號空字串，不raw get或借用其他實體取名。指定不在可讀employee map的employeeId先404。既有caregiver本人超safe SQLite employee version在auth可先500的匯入限制不於此切片修復；正常API不產生這類版次。

精確filters `{startDate,endDate,q,employeeId,status}`。日期依保存的訓練date，必填YYYY-MM-DD，含兩端最多366日；初載及清除臺北當月。沿現model.dateValid（含其既有0000年行為），不另換年限。q原文最多200 UTF-16 code units，不trim/截斷/語法解讀；不分大小寫逐欄literal includes，只搜可讀目前員編／姓名、課程name、辦訓provider、備註note及合法categoryLabel/statusLabel，不拼欄、不搜ID/分鐘/日期/版次/fallback或其他PII。條件AND。狀態completed「已完成」、cancelled「已取消」；空為全部。沒有category query/filter，不擴共用query/controller，類別可用原文關鍵字搜尋。page/pageSize沿strict parser；未知、重複、非法422，完整export拒分頁。

先employee/status/q篩候選，再驗全部候選dateValid，再套日期範圍；範圍內全部列在分頁前驗非空string id、正safe integer version、合法status/category、safe integer trainingMinutes 1..60000。任何異常整份409 REPORT_DATA_INVALID，不略過或只驗本頁。直接沿已有safeVersionReader，不改共用SQL/auth/model及其他報表。

## 投影與輸出

精確14 row keys：`trainingId,version,date,employeeId,employeeNo,employee,name,category,categoryLabel,provider,trainingMinutes,status,statusLabel,note`。category為pre_service「職前訓練」、in_service「在職訓練」、other「其他訓練」。employeeId沿原可讀保存string外鍵供filter確認，CSV/列印不列ID；其他文字只有保存string原樣保留，異常非string安全空字串，不stringify、trim或洩漏nested。缺名字畫面「—」、CSV空欄，不把fallback寫回資料或搜尋。selection精確employee/status，指定可讀無名員工「名稱未取得」、未指定「全部可讀員工」。

九個可見／CSV欄依序：date「訓練日期」、employeeNo「員工編號」、employee「員工（目前名稱）」、name「課程名稱」、categoryLabel「訓練類別」、provider「辦訓單位」、trainingMinutes「訓練時間（分鐘）」、statusLabel「訓練狀態」、note「訓練備註」。分鐘保持保存整數，不換算小時或積分。totals僅 `{count}`，包含全部符合狀態的保存列，不算完成時數、薪資或資格。排序date→employeeNo→name→trainingId，code units。title「教育訓練紀錄總表」。note明示本機保存、目前姓名、保存分鐘及未核定法定積分/資格/正式表單。

完整export最多1000筆及完整JSON envelope UTF-8 2MiB（等於允許、超過整份413），不截短。此為JSON守門，不聲稱CSV實體bytes另有2MiB門檻；CSV沿BOM、全欄quoting、公式防護及固定filename training-report.csv/no-store/nosniff。組織、generatedAt、echo、row白名單及完整confirmation沿既有report-view。

## 共用介面

薄 `training-report.js` adapter，key training-report、date labels「訓練日期起／迄／範圍」、caseFilter:false、只lookup employees，既有positiveInteger型別加adapter上限與categoryLabel驗證。沿唯一report-view/downloadCsv/openDetails/print CSS的context/dispose/abort/loaded/pending/fresh-print owner，不新增controller或改ui.js。管理者/督導在原報表中心增加「訓練總表」；finance不顯示此選項，其他可用報表保持。caregiver原/training本人列表與API沿用，本切片不新增其報表中心導覽或擴大其他報表權限。八本機種類（新增trainings），原五legacy API仍五類；標頭按實際可用種類數呈現。

九欄螢幕1200px並沿表格自身橫捲、日期不折行；A4橫向12mm/9pt、九欄寬9/7/10/16/7/12/7/7/25%、重複表頭、長辦訓及備註完整換行。DESIGN/styles只新增此報表幾何，不改tokens或其他報表規則。

## 必要驗收及追溯

真admin新增→sup改課程/日期/類別/分鐘→取消→恢復，immutable employee/CAS/CSRF/冪等沿原；四真session、finance早403、caregiver本人/他人/active停用/恢復及缺父scope。40筆25+15、AND/q原文/clear/empty/lookup-only、14keys/9columns/count-only、合法1/60000與異常分鐘/版次/status/category/日期（含頁外及filter/scope排除）、exact1000/JSON2097152/+1、BOM/quotes/newline/公式防護、freshCSV及預覽後真PATCH再fresh列印。

10種loaded/pending完整context失效與真角色session分開；503/MIME/空body/AbortError/錯DTO/取消/晚回應/native-beforeprint抑制沿既有owner。所有原272 Node與21套browser按原script SHA回歸，28報表出口（原25＋新3），11表raw/count/total_changes唯讀段与必要真寫分開，六immutable trigger、兩種非空合成BLOB原bytes/SHA、核閱計價快照及原fees/payroll保持。全部QA合成memory/random port，actual DB不複製；實際試用重啟前後11表/六trigger SQL/health/setup/session只讀核對。

一份新合成QA PDF，首次成功marker一次；取actual fresh授權print DOM/CSS至JS-disabled snapshot產生，同artifact修訂skip marker。40 TRAINING標記各一次、每頁九欄頭/A4/安全邊界/全部長文/末頁文字，PDF全部頁及新UI逐張view_image；相關訓練/人員歷程與既有請假總表最新回歸複本亦逐圖，原五報表PDF按原腳本相容檢查，不冒稱新人工PDF審查。

同步API/UX/PRODUCT/BUILD_STATE/backlog及唯一0.22.0不可覆寫封存；135基準source及15舊verification SHA（4012歷史copy不寫）與當輪新copy逐份核對。原84/52/28/16/359題/順序/四來源SHA/status/parity/9階段/0原completed保持。沒有精確原報表映射，僅新增獨立localMilestone及RM-04局部證據，不變更任何原row；localReportKinds7→8不等同原52完成。未核定支付/薪資/評分/外部介接繼續待核定。
