# 本機契約期限提醒

本切片是 v0.70 的本機公司人工工作清單，原候選保留於 `outputs/software/v070-contract-deadlines-candidates/`，八個自有檔已由整合者接入正式來源路徑。實作只保存提醒，不改契約、既有待辦或公告。只有人工新增、指派、查詢、開始、完成、取消及歷程；沒有排程、背景作業、外部訊息、已送達聲明或法定期限推論。本機測試不代表正式部署或真實使用者UAT。

## 最小完整工作流

路由 `/contract-deadlines`、頁名「契約期限提醒」、掛載 `mountContractDeadlines(container,{isCurrent})`。管理者及督導可同機構讀寫，財務及居服員在解析輸入前403，暫不擴本人或代理權限。由使用者選擇目前可讀且已記錄生效的契約，伺服器核對明確來源版次，保存建立時契約的七欄閉合快照；普通表單輸入提醒標題、內容、受指派員工、人工應完成日、優先程度及備註。

提醒是独立保存紀錄，不自動建立或更新 `internal-tasks`、`announcements`、`case-contracts`，不自行發行契約、申報、付款或薪資。人工日期不限於契約結束日前，不推定公司或法律上必須提前若干日續約。來源後來人工終止／處理到期，已保存提醒及來源快照仍可讀，仍由管理者／督導決定如何完成或取消；不會自動完成、取消或另建提醒。

`pending` 可編輯、開始 `in_progress` 或取消 `cancelled`。處理中可改標題、內容、應完成日、優先程度或改派，保持本次開始日期；之後只可完成 `completed` 或取消。開始須明確提交本次日期；完成須本次日期及結果，取消須本次日期及原因，不繼承舊內容推定本次原因。日期不得早於上次處理；不能待處理直接跳完成。完成／取消操作只改狀態、日期及本次結果／原因，不能同時改內容或改派；終態全部鎖定，不刪除、不恢复。

每個來源契約最多一筆待處理或處理中提醒；交易內重讀阻止並行重複。完成／取消後可手動另建新 record，原 reminder/history 保留。若同機構現有提醒壞 JSON／閉合格式或SQL版次無法確認，建立或修改會409，避免略過重複檢查；交易內以原始SQL筆數BigInt核對guarded合法清單筆數，不能只檢查已經過濾的可見列。需另行人工處理壞匯入資料，本切片不暗自修復。

## 封閉欄位與來源

`contract-deadline-reminders` 十三業務欄：`contractId contractVersion contractSnapshot title content assigneeEmployeeId dueDate priority status statusDate result statusReason note`。必要契約ID、來源版次、標題、內容、員工及人工應完成日。`contractVersion` 是安全正整數，`contractSnapshot` 完全由伺服器生成；POST或PATCH任意提交快照422。snapshot 精確七欄 `id version caseId number title startDate endDate`，只接受已核對來源的 scalar，沒有 raw JSON 顯示或未知巢狀展開。

來源ID、版次及七欄快照建立後固定，不從目前來源反算歷史快照。新增時父契約目前active且版次一致，變更版次409；來源須目前同機構可讀、個案及續約鏈遵守 `contractsTasksVisible`。目前／歷程再核對父契約及同機構個案存在，來源目前版次不低於捕捉版次，除目前version/status以外保存來源字段吻合。父項跨機構、失蹤、壞格式、snapshot未知key或不符，清單／目前／歷程隱藏，PATCH404；不修復存檔。

新增／改派需同機構使用中員工；既有受指派者停用後，原指派及管理者／督導讀取處理能力保留。顯示員工目前主檔姓名，來源為建立時契約標題及編號，詳情另明示父契約目前狀態及來源保存版次。這不是歷史姓名快照或送達證明。

`title`200、ID100、日期10；`content/note/result/statusReason`各10000，原文字逐字保存；其他單行／選項trim。metadata精確`id/orgId/version/createdAt/updatedAt`，安全版次及ISO時間、更新不早於建立。新純helper先檢查data descriptors、closed objects/option arrays，未知或accessor拒絕且不呼叫。

## API及整合接口

沿泛用 `GET/POST /api/contract-deadline-reminders`、`GET/PATCH /:id`、`GET /:id/history`。POST共用冪等及原子保存版本／稽核；PATCH必填安全正整數version、CAS，沿CSRF及機構隔離。PATCH沒有伺服器冪等承諾。保存上限沿既有128KiB；來源快照小，單次最多三個10000字長文小於該UTF8上限。不增資料表或背景服務。

列表明確必填`asOf`，預設25最大100，參數單值 `page pageSize q status priority contractId assigneeEmployeeId asOf workState dueFrom dueTo`。workState只對人工应完成日比對`before_due/on_due/past_due/closed`；完成／取消均closed，不改存檔。起訖成對有效、含端最多366日。q最多200，只搜尋提醒已定業務文字及来源編號／標題，不搜尋機構／員工／個案識別碼。排序应完成日再recordID。同機構查詢target不存在404；未知／重複／錯誤日期／末尾CRLF分頁422。single沒有query，history只`page/pageSize/compare=previous`。

候選server exports：

- `contractDeadlineEntities`, `isContractDeadlineEntity`：spread加入entities，加入guarded stored reader安全JSON／SQL版次集合。
- `guardContractDeadlineAccess(entity,ctx,readOnly,fail)`：index前置＋scopedRows／writeGuard／history守門。
- `normalizeContractDeadlinePayload(entity,payload)`、`assertContractDeadlinePayload(entity,payload,fail,patch)`：validatePayload的merge之前呼叫，避免客户端derived及沿用旧结果。
- `validateContractDeadline(db,ctx,entity,data,old,fail,rows,get,contractsTasksVisible)`：generic transaction內，在required/type基礎驗證之後執行，POST生成來源快照。
- `contractDeadlineVisible(db,ctx,entity,item,get,contractsTasksVisible)`、`contractDeadlineHistoryVisible(db,ctx,entity,snapshot,current,get,contractsTasksVisible)`：list/current/PATCH前置可見性，歷程再校SQLsnapshotversion、固定record/created/source映射。注入既有契約守門，不import model，沒有循環。
- `contractDeadlineQuery(entity,params,fail,mode)`、`assertContractDeadlineQueryTarget(db,ctx,entity,query,fail,get,contractsTasksVisible)`、`filterContractDeadlines(entity,items,query)`：専屬GET／history支線；filter不加保存DTO未知派生欄。

純顯示 exports 包含 `contractDeadlineFields/Statuses/Priorities/WorkStates/Labels`、`contractDeadlineSnapshotRows(value)`（安全閉合七欄typed scalar投影）、`contractDeadlineWorkState(item,asOf)`、`checkContractDeadlineRecord`及兩個ordinary表單adapter。Root可用rows建立typed history source table，不能直接rawJSON。全部十三欄及來源快照均需typed history投影；assignee歷程lookup人名。新route／adminwrapper／nav及共用history由root整合，本候選不修改共享owner。

## 介面與驗收狀態

沿APM `ui.js` 的普通選項/date/textarea、詳情、確認、搜尋、25分頁及既有history，無新CSS、dialog owner、下載owner或native alert/confirm/prompt。新建分兩步先核對生效來源，再填普通提醒表單；来源版次變動由409保留輸入而非覆寫。未改長文以native初始顯示值比對省略PATCH，CRLF→LF及前後空白不造成覆寫；故意修改保存本次精確原文。

ACK確認閉合record、ID／org／版次／metadata／全部字段及immutable snapshot，異常回應保留表單與同payload POST冪等鍵。頁面、route、登入／org／role、父render與觸發節點失效，取消讀取及丟棄晚回應；已提交交易不能由client abort宣稱回滾。

`contract-deadline-editor.test.mjs`8項、`contract-deadlines-validator.test.mjs`6項及`contract-deadlines.test.mjs`9項，接線後合計23項已實際exit0，結果保存在私人候選目錄 `http-pure-r04.log`。首輪22/23因歷程損壞fixture誤用不存在的SQL id欄而失敗，改以rowid定位合成fixture；第二輪23/23通過。之後另加真HTTP回歸證明壞JSON列被guarded reader略過會讓重複提醒錯誤201，保留r03失敗，再加入原始SQL count守門，修後r04共23/23通過。原候選及所有失敗保留，未改資料庫或未知值的閉鎖規則。正式接線後Chromium8／8流程actual exit0、pageErrors0／nativeDialogs0；375／390／1440px的19张PNG由作者逐張view_image(original)，沒有阻擋操作缺陷。own-frozen-manifest.json與pixel-review.json見outputs/software/contract-deadlines-qa/。整體接受見outputs/software/internal-workflows-completion-qa/verification-v070.json。原r01至r05選擇器／載入等待／歷程折疊區fixture失敗全部保留，未放寬保存、零寫、版本或權限斷言。歷程PNG只呈上方欄位，七欄snapshot表位於viewport下方，typed DOM／pure／HTTP覆蓋，未宣稱其全部像素；手機native選項長代碼尾端截短，姓名及詳情完整。

真HTTP已覆蓋完整狀態／原文／父源不改、四角色前置守門／CSRF／跨機構、POSTidem／並行open限制／取消新建、source版次／derived鎖定／父terminal可讀、嚴格query分類GET零寫、fresh result/date/reason及closure不可夾改、壞current/historyJSON／SQL版本／unknownnested／foreignparent隱藏、CAS及停用員工保留。只用合成memory SQLite及隨機loopback，不用原平台、私人DB／env／SSO、4310、DNS、正式主機、部署或外部訊息。
