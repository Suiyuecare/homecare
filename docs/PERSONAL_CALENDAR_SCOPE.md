# 個人行事曆人工事件（0.51，本機獨立契約）

2026-10-10 凍結。依 RM-07 未完成個人行事曆入口，先提供「本人在目前機構的人工日內事件清單」。原證據未展開事件建立／詳情欄位；這是本機六業務欄的新契約，不是原廠欄位、年度格狀行事曆、機構行事曆或快速例休假映射。原URL-532c325f63c6目前not_started、RM-07整體partial；本機agenda通過後最多只將此入口映射related_only/partial且unverified，其他「我的行事曆」URL-abf2c75f33f9維持needs_contract。不核定正式差勤、假額、支付、薪資或排程。

## 範圍与授權

路由 /personal-calendar、entity personal-calendar-events。既有四角色 admin/supervisor/caregiver/finance 只可讀寫目前 ctx.orgId + ctx.user.id 的本人事件。管理者也不能代理查閱、建立或轉移他人事件。ownerUserId 由伺服器建立，不能輸入、PATCH 或改派；每次單筆／list／write／history 均重驗本人機構，歷史每個 snapshot 的 ownerUserId 固定為 current owner 並等於目前 user.id，snapshot.orgId 也須符合機構。缺失、異型或越界 owner 隱藏，未授權單筆404；未知角色403且在body/query前拒絕。caregiver原有效員工登入守門保持。

只使用既有 records/record_versions/audit/idempotency 十一表及六不可變trigger；不新增表、migration、default種子、帳號或 membership。不連動 employees、cases、care-plans、shifts、leave-requests、service-records、附件或已核閱計價快照。

## 六業務欄

- title：必填單行非空白文字，最多200字。
- date：必填YYYY-MM-DD，0001至9999的有效西元日期，依字面日期保存；不是出勤或服務日期。
- startTime、endTime：必填HH:mm，00:00至23:59，同日end必須晚於start。不接受ISO、offset、秒、跨夜；可重疊，不做資格／衝突／工時計算。
- note：選填原文字最多10000字，預設空字串，保留CR/LF及前後空白。
- status：active/cancelled，預設active，顯示「有效／已取消」。取消與恢復只改status，原六欄及owner保持；沒有硬刪除或自動到期。

只標題需確認nonwhite，但不trim任何有效保存文字。body只允許六欄，PATCH再加version；owner、id/org、未知欄拒絕。PATCH只送明確變動欄，未變值和own-presence保持；不能靜默將異型舊值預填成空文字。未來匯入非相容欄位可保持原值，明確取代後仍沿merged驗證，keep不绕過服務端規則。

CRUD沿原交易、Origin/CSRF、Idempotency-Key（POST同payload同鍵只建一次，錯payload409）、CAS/版本及實際record.create/update actor。成功保存須確認id/org/owner、safe next-version、六業務欄和own-presence；不可信2xx、409及斷線保留輸入，重試沿同POST鍵。Abort只撤除UI，不宣稱交易回滾。

## 查詢與歷程

GET /api/personal-calendar-events 只page/pageSize/q/status/date，各一次；page正安全整數、pageSize1..100，預設1/25；q原文字最多200字、不trim，大小寫不敏感只搜尋title/note的own string；status空或兩碼，date空或上述有效日期，精確人工日期。未知／重複／不合法422。先本人機構及條件篩選，再按既有 created_at DESC,id 排序／分頁；不是時間軸排序、不推到期或逾期。回{items,total,page,pageSize}；UI完整確認目前owner/org、合法id/version、唯一ID、精確筆數／filter行條件。

GET /:id 不接受query。GET /:id/history只page/pageSize/compare，compare空缺或previous，各一次；只讀snapshot、精確version-1差異／实际actor与缺版明示，不能跳版或回寫。原history API其他entity行為不改。非法可見SQL version／identity回409 CALENDAR_DATA_INVALID，不修資料；安全整數邊界沿既有CAS。

## 共用介面与情境

APM CIS與唯一styles.css/ui.js保持。沿admin.listPage日期agenda，25筆分頁、native date/status、searchBox、empty/no-results/loading/error/retry/clear。六欄新增／編輯沿openForm（noValidate、label/error、IME、busy、dirty確認、Escape及回焦），取消／恢復沿confirmAction，歷程沿openRecordHistory/openDetails。dateFilter有限原變體，不新CSS或平行控制器。

完整ctx primitive user.id/org/role/employeeId + hash/generation/render stamp/連線與outer ctx reference，loaded/pending失效清空／abort，晚回應不能重新出現。nested reference替換但相同primitive不失效，outer重建保守失效。所有條件只在記憶體、不進URL/client storage。桌機與390px保留table內橫向捲動、長備註完整歷程可讀。

## 驗收与限制

必要HTTP：四角色本人CRUD、同機構他人和跨機構404、偽造owner拒絕、未知role早403、Origin/CSRF拒絕、closedquery／條件先分頁、時間/日期/長度/型別邊界、CAS/冪等原交易、逐版owner/org污染隱藏、精確actor/前版缺口、GET全十一表/六trigger/total_changes零寫，非事件資料/BLOB/核閱快照保持。

純函式：六欄省略／原值／own-presence、原生不相容date/time/CR/typed保持及明確intent、非法2xx身份/版次/保存內容拒絕、狀態只改一欄、未知狀態明確修復、完整list投影守門。

真Chromium：empty、create/edit/cancel/restore/history、filters/25筆paging/clear/noresults、503/retry/非法保存/409／同鍵重試、loaded/pending primitive/hash/render/outer失效與late、Escape／dirty／focus、1440與390及備註末句真正在footer上方可讀；sibling list/page/branding、APM CIS及HTTPS合成Portal回歸。共享敏感能力有改動才廣跑相關套件；只必要subset，不宣稱全部配置fresh或原生OS popup／人工UAT。

凍結source與必要完整unit、最低Node22.13相關測試、check、strict（沿已核對私人parser，官方未改）、DESIGN lint、browser及每張新圖實際檢視後才能標implemented_verified。原失敗不覆寫，原180目錄及九階段完成門檻保持。實際帳號DB/env/binding/private備份/4310/DNS不存取；不部署、申報、付款、外部訊息或採購，正式主機/HTTPS/Portal發布及本人公司登入仍沿部署交接待辦。


本機接受：952完整程式測試、新13HTTP／21pure、8必要browser共94關、16新圖實際檢視；詳outputs/software/personal-calendar-qa/verification.json。本機六欄agenda不等同原完整行事曆、正式出勤、部署或人工UAT；原失敗與r02範圍澄清保存。
