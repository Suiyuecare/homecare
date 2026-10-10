# 本機測試版資料與API契約

> 公開版本文件：記錄此功能版本的設計與驗收條件，並非目前公開副本已執行的驗收證明。私人盤點與 QA 產物未匯出；現行行為以 API.md 與原始碼為準，正式規則及部署仍須核定。

Node 22內建HTTP與SQLite；伺服器預設只監聽127.0.0.1。所有正式業務資料留在本機SQLite，不使用原平台API。

## 共同格式

GET /api/setup/status回傳{needsSetup}。POST /api/setup建立首位管理者及機構：{name,email,password,organizationName,seedDemo}，密碼至少12字，不提供預設密碼。GET /api/session回傳{user,organizations,csrfToken}；POST /api/login與POST /api/logout處理登入與登出。Cookie HttpOnly、SameSite=Strict；所有已登入寫入要求X-CSRF-Token，首次setup/login驗證Origin。

已登入API均以X-Org-Id選取機構，伺服器核對membership；單靠傳入機構ID不能取得資料。角色：admin、supervisor、caregiver、finance。管理者與督導可維護作業；居服員只能讀取自己的排班、相關個案及建立自己的服務紀錄；finance可讀核對所需資料與費用報表，不能變更排班。敏感欄位的額外遮罩規格列待確認，測試資料不含真實個資。

GET /api/:entity?q=&status=&date=&caseId=&employeeId=&page=1&pageSize=25 回傳{items,total,page,pageSize}；pageSize介於1至100。POST回傳{item}，PATCH /api/:entity/:id回傳{item}。每筆item均有id、orgId、version、createdAt、updatedAt。PATCH必須傳version，衝突回409；未知欄位拒絕。錯誤格式{error:{code,message,fields?,details?}}。POST可用Idempotency-Key避免重送重複；同鍵不同內容回409。取消以PATCH狀態完成，第一版沒有硬刪除。

## Entity欄位

- employees：name,employeeNo,role,phone,email,status(active/inactive),qualification,regions,note,hourlyRateCents。
- employee-certifications：employeeId,name,certificateNo,issuer,issuedOn,expiresOn,status(active/revoked),note。必填員工、名稱、核發日期；到期日期可空白，否則不得早於核發日。
- employee-training：employeeId,name,category(pre_service/in_service/other),provider,date,trainingMinutes,status(completed/cancelled),note。訓練分鐘為1至60000整數；時數僅為紀錄，沒有法定積分換算。
- cases：name,caseNo,birthDate,gender,phone,address,status(active/paused/closed),cmsLevel,welfare,supervisorId,primaryCarer,contactName,contactPhone,note。
- case-contacts：caseId,name,category(general/primary_caregiver/secondary_caregiver/case_manager/other),relationship,phone,alternatePhone,email,organization,status(active/inactive),note。固定同機構個案，建立後caseId不可更換；原cases聯絡欄位不自動同步或搬移。詳細驗證及分類契約見docs/CONTACTS_SCOPE.md。
- case-attachments：caseId,title,category(general/care/administrative/other),note,status(active/inactive)；fileName,mimeType,sizeBytes,sha256由伺服器產生。內部fileId不出現在任何API回應。固定同機構個案，PATCH可以重送相同caseId，更換則409；衍生檔案欄位不能直接PATCH。詳見docs/ATTACHMENTS_SCOPE.md。
- certification-attachments（0.14本機合成驗證）：certificationId,title,note,status(active/inactive)；employeeId由證照推得、file metadata及fileId僅server保存，不可client寫入。固定父證照，finance403/caregiver自身唯讀；詳docs/CERTIFICATION_ATTACHMENTS_SCOPE.md。
- service-items：code,name,minutes,unitPriceCents,validFrom,validTo,status(active/inactive),note。價錢為整數分；示範價格僅為合成測試值。
- care-plans：caseId,validFrom,validTo,status(draft/active/ended),services([{serviceItemId,quantity}]),goals,note。
- shifts：caseId,employeeId,carePlanId,date,startTime,endTime,services([{serviceItemId,quantity}]),status(scheduled/completed/cancelled),note。
- service-records：shiftId,caseId,employeeId,date,actualStart,actualEnd,services([{serviceItemId,quantity}]),status(draft/submitted/approved/returned),note,reviewNote。
- leave-requests：employeeId,date,startTime,endTime,type,reason,status(pending/approved/rejected/cancelled)。
- assessments：caseId,templateId,date,answers(object),status(draft/submitted)。
- announcements：title,body,audience,status(draft/published)。

caregiver帳號的user.employeeId必須連到本機同機構employees。所有外鍵必須同機構且存在。新增排班要求active個案、active員工及涵蓋當日的active計畫；服務項目必須存在於計畫。員工或個案時段重疊、已核准請假時段均拒絕。月額度及支付政策未定稿，不假造法定規則。

證照與訓練僅admin/supervisor可維護，caregiver只讀自己的紀錄與歷程，finance無權讀寫。建立後employeeId不可變更；停用員工既有紀錄保留。證照GET接受asOf=YYYY-MM-DD（預設臺北今日），附expiryState、daysToExpiry、asOf：撤銷為revoked；未填到期日為no_expiry；到期日早於asOf為expired；當日到期至30日內為due_soon；超過30日為valid。這是提示規則，未驗證法定資格，也不自動阻擋排班。列表expiry篩選在分頁前完成，支援以上5種狀態；訓練支援category篩選。歷程保存原資料，不保存隨日期變動的到期提示欄位。

服務紀錄必須對應班次及其個案/員工，實際結束須晚於開始；一個shift最多一筆有效服務紀錄。draft/returned可編輯、submitted僅督導/admin可核閱為approved或returned；approved不可無痕改寫。POST /api/service-records/:id/review接受{version,decision:approved|returned,reviewNote}。提交與核閱的資料均須再次驗證。

GET /api/dashboard回傳至少{counts,todayShifts,pendingRecords}。GET /api/audit回傳分頁列表，admin可讀。POST /api/demo/seed僅admin，已有demo資料時不重複。

GET /api/users供admin分頁查詢機構使用者；POST接受{name,email,password,role,employeeId}建立帳號與機構成員關係。caregiver必須指定同機構員工。POST /api/organizations接受{name}，新機構會將當前使用者加入為admin；前端重新取得session更新機構選單，切換時也更新該機構的角色及employeeId。

GET /api/:entity/:id/history供有權限讀取該筆資料的使用者取得分頁版本快照{version,snapshot,createdAt,source}。版本表拒絕UPDATE/DELETE；history與一般資料皆套用機構與居服員範圍。核閱服務紀錄會產生billingSnapshot，保存服務單價、數量、實際分鐘及當時員工時薪。只有admin/finance回應包含此快照，其他角色回應會移除；核閱後主檔改價不影響歷史試算。缺少快照的舊核閱資料回409，等待歷史費率核對。

個案、照顧計畫、多組聯絡人、個案附件、排班、服務紀錄、員工證照、訓練、請假紀錄、服務項目、員工主檔、評鑑填答及內部公告history可加compare=previous。每列追加actor:{id,name}|null及comparison:{status:initial|available|unavailable,previousVersion:number|null,previousSnapshot:object|null}。操作者只依同機構、實體、紀錄及精確version的record.create/update實際使用者辨認；shifts亦接受核閱自動完成的shift.complete，service-records亦接受退回/核准的service.review，皆限該entity及精確scope/version，name為目前姓名；缺失或身份衝突為null。只有授權後可見的精確version-1能供比較，包含分頁邊界；缺失或被篩掉的前版回unavailable且previous兩欄null。version=1為initial。前版與本版均套用publicRecord。未傳compare保持raw回應形狀；公告歷史可讀範圍亦套用下述逐版授權；重複或不合法compare回422；目前14個泛用entities皆支援previous，未知entity沿404。詳細契約見docs/HISTORY_SCOPE.md、docs/CONTACTS_SCOPE.md、docs/ATTACHMENTS_SCOPE.md、docs/SHIFT_HISTORY_SCOPE.md、docs/SERVICE_HISTORY_SCOPE.md、docs/PERSONNEL_HISTORY_SCOPE.md、docs/LEAVE_HISTORY_SCOPE.md、docs/SERVICE_ITEM_HISTORY_SCOPE.md及docs/EMPLOYEE_HISTORY_SCOPE.md。

shifts歷程先要求目前班次可讀；所有角色的raw/compare均只保留snapshot.caseId仍在當前同機構可讀cases集合的版本，caregiver另限snapshot.employeeId為自己。歷史個案不要求等於目前個案；改派出去目前班次不可讀，重回同員工或跨個案的前版缺口回unavailable、不跳版。finance沿既有唯讀API，不增加班表入口。shifts的核閱完成actor僅採精確scope/version的shift.complete；讀取不修改班次或核閱快照。完整新增契約見docs/SHIFT_HISTORY_SCOPE.md。

service-records的raw/compare歷程先要求目前紀錄scopedRows可讀；所有角色逐版只保留snapshot.caseId存在於目前同機構scoped cases的版本，caregiver再限snapshot.employeeId自己。歷史case可不同current case，不加shift join或日期/狀態授權限制，缺版不可跳版。service.review精確實際核閱者追加沿同一actor resolver，缺失/歧義null；前後snapshot維持publicRecord財務遮罩。只讀不改計價、核閱寫入及CAS。詳docs/SERVICE_HISTORY_SCOPE.md。

employee-certifications／employee-training raw及compare先沿目前紀錄scopedRows授權，不新增目前employee join。所有角色逐版要求snapshot.employeeId===current.employeeId，且父項在目前scopedRows(employees)集合；不可改父項的污染版本／缺失或跨機構員工版本隱藏。管理者／督導包含停用員工，居服員auth仍要求有效員工，財務403。原目前紀錄可讀但父員工已缺失時歷程為空；精確前版缺口不跳版。只用record.create/update actor，不採其他entity的review/complete事件。歷史不依asOf重新計算效期或法定積分，保存日期／實際分鐘不改寫。詳docs/PERSONNEL_HISTORY_SCOPE.md。

leave-requests（0.13獨立本機切片）沿目前scopedRows授權，不新增目前員工join；raw/compare所有角色逐版要求snapshot.employeeId在目前scopedRows(employees)，caregiver再限自身。歷史employeeId不要求等於current，允許原合法A→B→A；缺權精確前版不跳版。current父員工缺失但目前紀錄可讀時，較早合法父項版仍可留。admin/sup可維護停用員工，finance可讀不能寫，caregiver沿active auth link。核准／駁回／取消仍record.update actor；不採虛構leave.review。原合法狀態寫入、employeeId改派、核准請假與非cancelled班次的雙向半開區間衝突保持，不新增假額或時數折算。詳docs/LEAVE_HISTORY_SCOPE.md。

## 請假衝突班次（0.15獨立切片）

GET /api/leave-requests/:id/shift-conflicts?page=1&pageSize=25僅admin/supervisor（finance/caregiver403）；每次由最新scoped leave保存員工/日期/時段計算，必須目前同機構scoped employee可讀，缺/跨org/錯entity父項404。停用員工管理讀權保留；原leave current/history與寫入授權不新增join。四leave狀態均可查，不回canApprove或寫入，核准仍原PATCH/CAS/CSRF/fresh衝突驗證。

共用逐筆generator沿interval/timeMinute與同員工/同日/非cancelled班次、半開重疊；completed包含，相接排除，同日ISO依字面HH:mm忽略秒/offset。原approved write遇首hit即原SHIFT_CONFLICT，保留錯誤短路。新reader完整檢查後排序/分頁，非法目前日期/時段或匹配班次時段409 CONFLICT_DATA_INVALID，全份拒絕。任意status同org service-record對應shiftId即hasServiceRecord；false不保證可修改，原SHIFT_HAS_RECORD保持。

白名單回{leave:{id,version,employee:{id,name,employeeNo,status},date,startTime,endTime,type,status},generatedAt,items:[{shiftId,version,date,startTime,endTime,status,employee,case:{id,name,caseNo,status}|null,hasServiceRecord}],total,page,pageSize,note}。目前case/scoped lookup缺失回null且仍保留阻擋班次，不漏未授權caseId；沒有原因/備註/服務/個資/計價內容。只page/pageSize，未知/重複422；分頁沿泛用pageParams Number/default/positive-safe-integer/25/100語意。按起始分鐘→結束→ID排序後分頁，total全數；每次GET零寫，11表/6trigger/版本/父項/核閱快照保持。詳docs/LEAVE_SHIFT_CONFLICTS_SCOPE.md。

case-contacts由admin/supervisor維護；finance沿個案唯讀，caregiver只讀目前有權查看個案的聯絡紀錄與歷程（含停用）。列表支援caseId、category、status、q，先限制資料範圍與篩選再分頁，不合法或重複category回422。歷史快照須caseId與目前紀錄相同且個案同樣可讀，再比較精確前版。新增／更新聯絡紀錄只修改自身版本及稽核，不修改cases的版本。

case-attachments由admin/supervisor維護；finance與有權個案的caregiver唯讀，包含停用與可讀舊版。一般POST拒絕（405 UPLOAD_REQUIRED）。POST /api/case-attachments/upload接受{caseId,title,category?,note?,status?,fileName,mimeType,contentBase64}；POST /api/case-attachments/:id/replace-file接受{version,fileName,mimeType,contentBase64}。兩個端點皆支援Idempotency-Key，成功請求重送不增加檔案或版本；同鍵不同內容409。角色與CSRF驗證在讀取上傳body之前。只有這兩個端點body上限8 MiB；其他維持128 KiB。

單檔1至5 MiB；canonical base64、不含data URL或空白。副檔名/MIME/基本檔型簽章須一致，只接受PDF、PNG、JPEG；不宣稱完整文件有效或掃毒。檔名1至180字，拒絕控制字元及路徑分隔符。大小與SHA-256由伺服器計算，檔案和metadata/歷程/稽核/冪等回應同交易保存；BLOB不可變。更換檔案保留舊版，只改描述沿用舊檔。列表category非法或重複422，先限制case範圍再篩選分頁。

GET /api/case-attachments/:id/download省略recordVersion下載目前版，單一正整數recordVersion=N下載精確metadata版本。每次重驗目前個案權限、當版caseId、BLOB完整機構/附件/個案/檔案關聯，以及metadata與bytes/hash一致；版本或檔案缺失/越界/篡改回404，不回退其他檔案。回應安全attachment Content-Disposition、UTF-8檔名、Content-Type/Length、nosniff、no-store。列表、歷程及下載不寫入；正式下載稽核、保留期限、加密、掃毒、備份/還原及外部儲存另待核定。原個案資料與版本不因附件改變。

## 證照附件（0.14獨立切片）

新增certification-attachments/upload、/:id/replace-file及/:id/download[?recordVersion=N]，沿個案附件File/版本/冪等與安全下載格式；專用immutable certification_attachment_files表，不改原case BLOB。新一般POST405，metadata PATCH/version沿共用CAS，certificationId相同可重送、更換409；employeeId及file metadata皆server衍生不可寫。title1..200、note最多10000字、active/inactive，不加category。list的certificationId有限filter先核對父項可讀、scope再分頁。

admin/sup維護，caregiver自己只讀，finance所有端早403。每次current讀寫驗目前可讀cert與employee、derivedemployee一致，缺父/跨org/污染404；不依revoked/expiry/inactive附件授權，caregiver inactive auth仍403。所有raw/compare歷史固定certificationId和employeeId與current及目前cert一致；精確version-1、actor/null與publicRecord沿共用。下載完整org/attachment/cert/employee/file tuple、當版metadata/bytes/hash/檔型核對，fileId永不public。新upload/replace在成功idem回應前也重驗parent，callback再驗，新寫CAS；同key合法重試不增版本/BLOB。

檔案canonical base64/decoded1..5MiB/PDF PNG JPEG/安全檔名沿validateAttachmentFile；只有新兩專用端加原兩端8MiB，其他128KiB保持。新metadata/version/BLOB/audit/idem原子保存、BLOB不變，11表與6trigger；原cert/employee/case附件與計價不因新附件更動。GET零寫，正式下載稽核/保留/加密/掃毒/備份與storage待核定。完整docs/CERTIFICATION_ATTACHMENTS_SCOPE.md。

GET /api/reports/:kind?month=YYYY-MM回傳{title,columns,rows,totals,note}。0.36非空month只匹配date字串前綴；非字串排除、不轉型／解析／validFrom fallback，缺省或空month保留原資料。cases忽略合法月份，其餘狀態／順序／錯誤次序及快照計算保持。初期種類cases/shifts/services/fees/payroll；fees/payroll僅admin/finance，標明「試算、未核定規則」。GET /api/reports/:kind.csv?month=YYYY-MM沿用同一授權與資料來源，防公式注入。核銷外部串接尚未實作。

## 班表查詢與本機輸出（獨立切片）

GET /api/shift-report為分頁JSON；GET /api/shift-report/export與GET /api/shift-report.csv為完整JSON及CSV。三端共用一個唯讀builder，先套用目前機構與scopedRows角色範圍，再篩選及排序。caseId/employeeId若不在目前可讀同機構集合回404；caregiver僅自己班次且不新增報表導覽，admin/supervisor/finance沿既有可讀範圍。舊五類reports端點與計價快照維持。完整契約見docs/SHIFT_REPORT_SCOPE.md。

startDate/endDate必填有效YYYY-MM-DD，含兩端最多366日。caseId、employeeId、status選填（空值視未選），status僅scheduled/completed/cancelled。分頁JSON另接受page及pageSize（預設1及25、最大100）；完整輸出拒絕這兩參數。未知、重複或非法參數422。按date、startTime、caseNo、employeeNo、shiftId升冪；total及totals.count均為全部符合班次數。

JSON回{title,organization:{name},filters:{startDate,endDate,caseId,employeeId,status},selection:{case,employee,status},generatedAt,columns,rows,totals:{count},total,page,pageSize,note}。generatedAt為UTC ISO；名稱取目前可讀主檔、數量為排班數量。每列僅shiftId/version/date/caseNo/case/employeeNo/employee/startTime/endTime/services/status/statusLabel/note；services為code/name及數量文字，不含價格、地址、電話或計價快照。完整輸出page=1/pageSize=total，空結果0；超過1000筆或完整JSON UTF-8超過2 MiB回413 REPORT_TOO_LARGE，全部拒絕不截斷。CSV沿toCsv提供BOM/CRLF及公式防護、固定shift-report.csv、no-store/nosniff；每次重新授權與查目前資料，無DB寫入。

## 服務紀錄明細與本機輸出（0.9獨立切片）

GET /api/service-report、/api/service-report/export、/api/service-report.csv分別回分頁JSON、全數JSON及全數CSV。先membership及scopedRows('service-records')，四角色沿既有讀取範圍；caregiver只employeeId自己，沒有報表導覽。查詢對象須目前scoped cases/employees可讀，非法或跨界識別404。startDate/endDate、caseId/employeeId、分頁、未知/重複參數與完整上限沿共用report-query.mjs的0.8 strict契約；status僅draft/submitted/approved/returned（草稿/待核閱/已核准/退回修改），非法422。詳見docs/SERVICE_REPORT_SCOPE.md。

JSON {title:'服務紀錄明細',organization:{name},filters,selection,generatedAt,columns,rows,totals:{count,serviceMinutes},total,page,pageSize,note}。date→實際開始timeMinute數字→caseNo→employeeNo→recordId穩定排序；actualStart/End保留原HH:mm或同日ISO文字，分鐘沿現有timeMinute忽略秒/時差，不從排班/單位預設時間計算。total/count為全部符合紀錄數，serviceMinutes為全部符合紀錄分鐘（包含所選草稿/退回/待核閱，不稱核准工時或薪資依據）。匹配歷史時間非法409 REPORT_DATA_INVALID，整份拒絕、不猜0或傳部分rows。

row白名單recordId/version/date/caseNo/case/employeeNo/employee/actualStart/actualEnd/serviceMinutes/services/status/statusLabel/note/reviewNote；services採目前同機構名稱及實際紀錄quantity，不用排班量，不跨權限查名；無地址/電話/費率/金額/billingSnapshot。13欄含實際分鐘與核閱意見。全數最多1000筆及完整JSON UTF-8 2 MiB，超出413全拒；空結果各totals0、rows[]、pageSize0。CSV同投影/BOM/CRLF/公式防護、固定service-report.csv/no-store/nosniff。所有讀取零寫入，批准紀錄缺快照仍可查非財務明細；舊fees/payroll維持缺快照409及原核閱費率。

## 個案總表與本機輸出（0.10獨立切片）

GET /api/case-report、/api/case-report/export、/api/case-report.csv回分頁JSON、全數JSON及CSV。先membership/scopedRows('cases')，caregiver依目前自己所有班次的caseId（含完成/取消），沒有報表導覽。督導名稱不raw get擴權，選項及supervisorId有效集合為全部可讀cases已指派ID與scoped employees交集；停用或職務異動仍保留，交集以外與不可讀caseId404。未指派「尚未指定」，指派但缺可讀名稱「主責督導名稱未取得」，不回其識別。詳見docs/CASE_REPORT_SCOPE.md。

必填startDate/endDate依createdAt換算Asia/Taipei的「系統建立日期（臺北）」含端最多366日，不稱收案日。選填caseId/supervisorId/status(active/paused/closed)；拒絕employeeId及未知/重複參數422，分頁/全數上限沿report-query的可配置personKey/referenceKey helper，shift/service預設不變。先case/status/supervisor過濾，候選createdAt須strict有效含時區ISO才作日期篩選；符合日期的updatedAt亦strict合法，任何非法409 REPORT_DATA_INVALID整份拒絕。排序createdDate→caseNo→caseId。

DTO {title:'個案總表',organization:{name},filters:{startDate,endDate,caseId,supervisorId,status},selection:{case,supervisor,status},generatedAt,columns,rows,totals:{count},total,page,pageSize,note}。15rowkeys為caseId/version/createdDate/caseNo/name/gender/cmsLevel/welfare/status/statusLabel/supervisorNo/supervisor/createdAt/updatedAt/note；version正整數其餘string，CMS只轉保存文字不計分。12欄無電話/地址/生日/聯絡人/費率/計價；督導目前主檔，updatedAt保存ISO時區文字。完整1000筆及JSON UTF-8 2 MiB、超出413全拒；CSV同全數builder/BOM/CRLF/公式防護、case-report.csv/no-store/nosniff；零寫入及舊五類/shift/service端相容。

## 週期排班（獨立本機切片）

POST /api/recurring-shifts/preview與/commit都接受{caseId,employeeId,carePlanId,startDate,endDate,intervalWeeks?,weekdays,startTime,endTime,services,note?}。僅admin/supervisor，先角色/Origin/CSRF再128 KiB body；日期含兩端最多93日，週一為週起始、開始日期所在週為第1週、intervalWeeks預設1/允許1至4、weekdays為不重複非空1至7整數。只接受同日HH:mm，不跳假日。指定區間產生班次，不持續自動排班，未知支付/額度/資格/假日與原週期規則另待核定。完整定義見docs/RECURRING_SHIFTS_SCOPE.md。

preview回{definition,items:[{date,startTime,endTime,status:ready|conflict,conflicts:[{code,message,fields?}]}],total,readyCount,conflictCount,canCommit}，逐日期沿既有shift驗證，回首個問題，不暴露既有他人班次資料；全程零records/versions/audit/idempotency寫入，忽略Idempotency-Key。

commit要求Idempotency-Key，在同一交易內重展日期/重驗全數；任何衝突409 BATCH_CONFLICT，error.details.preview為新的逐日結果，全部不建立。成功201{batchId,items,total}，items為scheduled shifts、每筆version1及record.create audit，audit detail含operation=recurring-shifts及同batchId；回應key與records/versions/audit原子保存。儲存失敗全部rollback，同鍵同成功body重送先回原結果，同鍵不同body409，失敗不留key。不接收client候選/判定/status/batchId，不改既有核閱價格快照；後續仍逐班既有調整/取消。

## 前端共同介面

public/ui.js匯出api(path,{method,body,...})（錯誤保留status/code/fields/details）、el(tag,attrs,...children)、pageHeader(title,subtitle,actions)、table(columns,rows,{emptyText})、badge(value)、button(label,handler,{variant})、openForm({title,fields,initial,onSubmit})、toast(message,tone)、formatDate、formatMoney、today、getContext、navigate。

fields為[{name,label,type,required,options:[{value,label}],help,min,max,step,wide}]；type支援text,email,password,tel,number,date,time,select,textarea,file,checkbox-group。checkbox-group回options原值的已勾選陣列，至少一項驗證、整組ARIA、native checkbox/label及44px操作範圍。file為單檔native picker，使用accept及maxFileBytes，回傳File|null，不預填；選檔即驗空檔/大小/格式，顯示實際檔名及大小，提供移除選檔。openForm擁有驗證、dirty狀態、取消確認與busy；onSubmit收到values，成功後關閉並由呼叫者重新讀取頁面。可傳onPreview(values,{signal})→{content:DOMNode,canSubmit:boolean}及previewLabel；有預覽時提交先disabled，只在相同輸入已確認且可提交時開放。輸入/連動改變立即abort/失效，preview取消可abort且dirty確認，commit忙碌鎖輸入/不關閉。error.invalidatePreview與error.previewContent可取消提交資格並保留更新的衝突清單；一般連線或儲存確認失敗保留輸入/預覽/重送鍵。

openDetails({title,load:async(signal)=>DOMNode,wide:false,printable:false,isCurrent,loadingText})為共用唯讀dialog；開啟立即顯示載入，失敗可重試，關閉中止請求、恢復觸發按鈕焦點；差異歷程使用wide:true。所有details監看hash/session-updated/body子樹，isCurrent失效時清空/abort/關閉，default isCurrent=true未改；歷程傳入user/org/role/employeeId/hash/renderVersion guard，已載入資料也會撤除。printable variant沿共用CSS只印完整預覽，A4橫向/12mm/跨頁表頭；每次「列印／另存 PDF」再load重新驗權並確認context/isCurrent才呼叫window.print，載入失敗/過時不使用舊內容；已載入預覽在context/路徑/條件失效時自動清空關閉，beforeprint僅放行fresh load成功後同步window.print的單次授權；原生Ctrl/Cmd+P即使預覽已載入也以print-suppressed隱藏全部body子項直到afterprint清除，保留有效預覽並提示使用畫面按鈕，失效仍清空關閉，避免印出未重新驗權的快取或背景。personnel.js匯出renderPersonnel(route,container)，支援/certifications與/training。

history.js匯出openRecordHistory({entity,id,lookups,isCurrent,versionActions?})，使用已授權lookup、不追加跨權限查詢。history-fields.js提供cases/care-plans/case-contacts/case-attachments/shifts/service-records/employee-certifications/employee-training白名單及純diffHistorySnapshots；只比較業務欄位，空白／null／未提供視同未提供，服務排序不構成變更。服務紀錄十欄只顯示實際保存時間/數量/狀態/服務觀察及核閱說明，關聯班次使用目前可讀日期/起訖/狀態；不推算工時/金額。personnel各八欄只顯示保存日期／原實際整數分鐘與紀錄狀態，空到期日明示未填到期日；不顯示衍生效期/asOf或法定積分。personnel.js兩頁以目前已授權員工Map、完整user/org/role/employee/hash及generation/renderVersion guard呼叫共用history，移除自訂歷程controller。歷程不提供寫入或還原操作。附件可傳versionActions({version,signal,isCurrent})→DOMNode提供精確版本下載，不提供fileId或檔案內容差異。

contacts.js匯出createContactsPanel({caseRecord,isCurrent})→{element,load}；在個案詳情插入element後啟動load，區塊獨立管理搜尋、分類／狀態及分頁，不因讀取失敗替換周圍個案內容。以目前使用者／機構／角色／路徑及isCurrent阻擋過時回應，建立與修改沿用共用表單。

attachments.js匯出createAttachmentsPanel({caseRecord,isCurrent})→{element,load}，位於個案詳情聯絡人之後；獨立搜尋、分類/狀態篩選、25筆分頁與重試。上傳、metadata編輯、更換檔案分開表單，失敗/409保留FileList與輸入，POST每表單固定冪等鍵。ui.js提供MAX_ATTACHMENT_FILE_BYTES、ATTACHMENT_FILE_ACCEPT、formatFileSize、attachmentFilePayload(file,{signal})與downloadAttachment(id,{recordVersion,signal,isCurrent})；下載15秒逾時、401處理、關閉/切案/切機構阻擋晚回應自動下載，object URL用後撤銷。busy沿共用表單不關閉，不宣稱取消已提交交易。成功status但JSON body逾時/格式失敗或缺有效item確認仍保留選檔與表單，同POST鍵可重試取得確認。

operations.js匯出async renderOperations(route,container)，支援/cases、/cases/:id、/plans、/shifts、/records、/my-services。admin.js匯出async renderAdmin(route,container)，支援/employees、/service-items、/leave、/assessments、/announcements、/reports、/settings、/audit。每個模組透過共同api讀取資料，不存放個資於localStorage。表單輸入使用DOM textContent，不拼接未跳脫HTML。

recurring-shifts.js匯出openRecurringShifts({data,refresh,isCurrent})，使用已授權lookups和共用preview form；只列active plan/case/employee/service，合併plan selector派生caseId，變更計畫清除services。按當前user/org/role/hash/renderVersion guard過時回應，成功需完整batch確認，回應中斷/缺確認不關表單。

shift-report.js匯出mountShiftReport(container,{isCurrent})→{dispose}，報表中心排班明細使用日期/個案/人員/狀態查詢及25筆分頁；輸出前確認filter echo、白名單欄位、整體count與完整rows。修改條件即撤銷舊輸出；關閉預覽/切類型/機構/路徑中止並忽略過時回應。CSV及預覽均重新讀完整export，每次列印再讀取，不存入URL/client storage。downloadCsv(path,{filename,signal,isCurrent})共用15秒逾時、401、CSV MIME/非空body、context/late guard及object URL回收；舊報表downloadReport維持相容。

report-view.js為班表與服務明細的唯一query/lookup/echo/分頁/CSV/preview/cancel controller，mountReportView(container,{config,isCurrent})→{dispose}。shift-report.js及service-report.js只提供domain欄位/狀態/額外分鐘驗證/文案，不能重寫async。服務分頁摘要顯示全數紀錄及實際分鐘，完整回應確認Σrow.serviceMinutes=totals.serviceMinutes；修改條件立即失效，清除回本月/全部/page1。服務紀錄與班表沿共同downloadCsv/openDetails/printCSS；0.9時cases/fees/payroll保留原月份介面，services/shifts是同5種類的進階變體。

case-report.js提供個案domain adapter；report-view有限personFilter/date設定衍生五個query keys與selection/header/lookup/default/echo，預設employeeId與原date標籤使shift/service相容。個案UI顯示系統建立日篩選，cases/shifts/services進階，fees/payroll保留月份；CSV/fresh列印/取消/beforeprint抑制沿同一共用owner。

## 服務項目主檔歷程（0.16）

依docs/SERVICE_ITEM_HISTORY_SCOPE.md，GET /api/service-items/:id/history 加compare=previous，沿原current scopedRows授權、全部同org/entity/id歷史及publicRecord。admin/sup/finance讀全機構，caregiver僅目前自己班次service引用（含完成/取消）；不加父項/有效期join。精確version-1、record.create/update actor及原25/100分頁，raw格式保持。價格unitPriceCents仍可讀，billingSnapshot原角色遮罩保持；11表GET零寫，model/index/schema/計价/寫入規則不改。

## 員工主檔歷程（0.17）

沿原GET /api/employees/:id/history增加compare=previous，raw不變；先沿目前主檔讀權，再讀同org/entity/id全部保存版本，精確version-1在分頁前比較。admin/sup/finance可讀同org含停用員工；caregiver只目前有效同org active員工連結的本人，沒有班次仍可讀，停用連結auth403。目前role是職務文字非登入權限；時薪四角色原可見性及publicRecord雙snapshot遮罩保持。

十欄白名單與regions string|string[]保存型別／空項／順序沿docs/EMPLOYEE_HISTORY_SCOPE.md；時薪沿精確非負safe integer分值，不推正式薪資。原POST/PATCH/CAS/CSRF/idem及唯一員編保持；不改表單array.join轉文字或核閱快照。

## 員工總表（0.18）

契約docs/EMPLOYEE_REPORT_SCOPE.md。GET /api/employee-report、/api/employee-report/export、/api/employee-report.csv沿同一唯讀builder；四角色沿當前員工scopedRows及登入active link，指定不可讀employeeId先404。q原文≤200 UTF-16字元、員工與active/inactive狀態AND，沒有日期或個案條件，未知／重複／export分頁拒422。q只匹配六個業務欄與合法regions每個原字串，不跨欄／項拼接或搜隱藏個資。

六個可見欄位與九key row DTO，regions共享employee-regions normalizer／安全formatter／CSV JSON字串序列化，保留type、順序、重複與空項，不洩漏非法巢狀資料。matching candidates先驗版次／狀態，再分頁；完整1000筆與整個JSON UTF-8 2MiB超出拒413、不截斷。總計僅筆數，職務非權限、資格非合格／積分判定、不是薪資或出勤。

唯一report-view加入date:false/caseFilter:false/search及typed column有限variants，原三報表預設不變；員工lookup只讀employees，identity含employeeId，loaded/pending完整context失效清空abort關閉。每次下載／預覽／按鈕列印fresh驗權，原生Ctrl/Cmd+P禁止快取／背景。螢幕960px表內捲動，A4橫向12mm／9pt六欄／重複表頭；新合成QA PDF四頁及全部畫面已逐張驗證，原正式表單仍未匹配。

## 請假紀錄總表（0.19）

契約docs/LEAVE_REPORT_SCOPE.md。GET /api/leave-report、/api/leave-report/export、/api/leave-report.csv共用唯讀builder；沿原四角色leave-requests scope及caregiver active auth，不新增parent join漏紀錄。只scoped employees取目前名稱，缺失名稱row為空（畫面—），CSV空欄；保存employeeId供選定條件確認，不印出或跨scope取名。指定不可讀employeeId先404。

精確filters=startDate/endDate/q/employeeId/status，日期必填保存請假日、含兩端≤366日；q原文≤200 UTF-16字元，只逐欄literal搜可讀員編／姓名、假別、原因與合法狀態標籤，條件AND。先員工／狀態／q，驗候選dateValid後套日期範圍，範圍內全數id／safe正version／狀態／原時段先驗再分頁，任一異常整份409。HH:mm或同日有效ISO完整原文，排序date→原model.timeMinute起分→員編→ID；不計秒／offset時序或法定時數。未知／重複／非法422、完整export禁分頁。完整≤1000筆／2MiB（等於允許、超過整份413），沿CSV BOM／quoting／公式防護。八visible／12row keys，totals僅count。

safeVersionReader原樣移至report-query，僅employee/leave採用，不改model/auth/其他報表。唯一report-view配置date labels、caseFilter:false、q及employee/status，只lookup employees；前台不另造async/export/print owner。原生列印禁快取，按鈕每次重讀驗權，1100px表內捲及A4橫向12mm／9pt八欄重複表頭。假額、薪資、正式輸出版面未核定。

## 評鑑填答版本歷程（0.20）

依docs/ASSESSMENT_HISTORY_SCOPE.md，GET /api/assessments/:id/history支援compare=previous。current沿原scopedRows，admin/supervisor/finance讀、caregiver原403；逐版snapshot.caseId必須在目前同org scoped cases，不要求等current、不按模板ACL。原公用模板不是歷史定義版本，template/case均可合法PATCH。精確version-1、既有record.create/update actor及分頁；raw/compare雙snapshot沿原publicRecord，原answers payload不清理，只新UI題項白名單安全展示。

五欄與答案專屬型別：missing/null/空字串/文字/有限數字/布林各別呈現；array/object等不展開巢狀內容，合法字面提示文字不與safe tag碰撞。逐版用自身templateId的目前fields；同模板只比較已知題項，換模板只metadata比較並分開展示两組答案。未知模板/鍵不在歷程DOM輸出，不宣稱raw API已遮蔽。保留原CRUD/CAS/CSRF/冪等/answers guard與提交含義；finance不增導覽。

normalizeHistorySnapshot(entity,snapshot,templatesMap?)及diffHistorySnapshots(entity,previous,current,templatesMap?)以可選已授權assessment模板Map處理上述答案型別；其他實體原scalar/service/cents/region語義保持。新assessment-answers helper只作展示，不把投影寫回API或editor。

## 評鑑編輯安全（0.21）

原assessments API與model未改。createAssessmentEditor(template,row,defaultDate)只為已知模板UI產生安全initial及buildPayload；一般已知題未改保持，無損預填不了的own值明確keep/replace/clear，clear為空文字。metadata-only或異常匯入root省answers，修改題項時合併完整原answers，不清理unknown keys或特殊own keys；原50000字元/128KiB守門與CAS/CSRF/POST冪等保持。詳docs/ASSESSMENT_EDIT_SAFETY_SCOPE.md，編輯仍用列表快照與原version，競爭更新拒409。

共用createForm新增可選lockDuringSubmit=false及helpers.setDisabled；openForm可選isCurrent，啟用時沿完整context中止/清空/關閉及pending鎖定、失敗恢復原disabled。confirmAction可選signal，dirty確認隨父form失效關閉；其他表單未opt-in時原行為。編輯不fresh GET覆寫清單快照，原version競爭409保留輸入與保存方式。只有已確認item/id/org/version/主欄/answers才成功close；回應不確定不保證server rollback，POST同鍵可重試，PATCH重試仍CAS。

## 教育訓練紀錄總表（0.22）

GET /api/training-report、/api/training-report/export、/api/training-report.csv共用readTrainingReport；guardPersonnelAccess先403，沿scopedRows及safeVersionReader，14keys/9columns/count-only。精確日期/q/employeeId/status，保存日期含端≤366日、q原文≤200；無category query或case lookup。matching資料整份409，完整1000/JSON UTF-8 2MiB超過413；原CSV與寫入守門保持。詳docs/TRAINING_REPORT_SCOPE.md。

精確filters只有startDate/endDate/q/employeeId/status，沒有category或case；totals只有count，1..60000逐筆分鐘不加總。完整JSON envelope最多2MiB，非CSV實體bytes獨立限制。UI413與錯DTO為攔截fixture，server邊界由整合實測；原caregiver本人employee超safe version會先auth500的匯入限制未修改，正常API不產生。原dateValid含0000年行為保持。

## 員工證照紀錄總表（0.23）

依docs/CERTIFICATION_REPORT_SCOPE.md，核發日期區間與效期截至日分開，十五保存／提醒欄位、十可見欄、count-only；admin/sup中心可用、caregiver本人API保持、finance403。三GET共用builder，sharedquery/view只有限asOf/expiry opt-in，其他預設保持；完整CSV/fresh列印不作生效、资格或薪資認定。

GET /api/certification-report、/api/certification-report/export、/api/certification-report.csv；filters精確startDate/endDate/q/employeeId/status/asOf/expiry，selection employee/status/expiry，15row keys/10columns/count-only。asOf必填，expiry空all；先全範圍驗有效issuedOn/expiresOn/順序/status/id/version再helper及expiry。missing到期可空、null409，原0000年及caregiver超safe employee auth500匯入限制保持。共用parseReportQuery的asOf=false/expiryLabels=null和view的asOf/expiry/date.displayRowKeys只是opt-in；其他報表預設不變。原JSON envelope1000/2MiB護欄不等同CSV實體bytes限制。

## 內部公告版本歷程（0.24）

依docs/ANNOUNCEMENT_HISTORY_SCOPE.md，四欄保存文字／精確上一版／實際操作者，沿既有四角色公告入口。caregiver的current及每個raw/compare版本都要求published且all/caregiver；缺口不跳版。已知對象與狀態標示保存碼，未知文字安全保留，非文字匯入只顯示tag。重用admin/listPage、history/openDetails及完整context guard，無新CSS/token/controller/外部訊息。

## 公告安全編輯（0.25）

依 docs/ANNOUNCEMENT_EDIT_SAFETY_SCOPE.md，編輯僅送變更的四個業務欄；未修改原文、未知／空閱讀對象與無法無損預填值保留。原生保存方式可明確取代，閱讀對象可明確清空。新增、編輯及撤回沿共用表單／確認視窗 opt-in 完整 context guard，只有 id/org/version/四欄 own-presence 與保存投影吻合才顯示成功；未知結果保留輸入，新增同 payload 重試沿同一冪等鍵。原後端角色、任意 audience、必填／狀態、CAS、歷程及價格快照保持；取消請求不代表伺服器回滾。沒有新 CSS/token/通知／已讀。

## 服務項目安全編輯（0.26）

沿 docs/SERVICE_ITEM_EDIT_SAFETY_SCOPE.md，八欄未改省略，異常保存資料明確保持／取代，日期及備註可清空。價格以文字控制項與整數分精確往返，列表沿既有精確 formatter；共用表單僅允許 numeric/decimal inputMode descriptor。新增、編輯及啟停沿共用完整 context guard，保存成功須確認八欄及身份版本。19後端與既有角色、CAS、冪等、分鐘／有效日期／代碼唯一及核閱快照不變；保持仍按原 merged 驗證可能422。

## 員工主檔安全編輯（0.27）

沿 docs/EMPLOYEE_EDIT_SAFETY_SCOPE.md，十欄未改省略，原服務區域清單整欄保持，明確改存文字／清空才變更。電子郵件沿原API文字規則，職務不改登入角色；時薪BigInt精確轉分及列表一分完整顯示。新增／編輯／啟停沿共用context、CAS及有效十欄保存確認；停用連結居服員沿原auth下一請求403，舊班次與核閱薪資快照保留。後端與ui/styles/token不變。

## 請假安全編輯（0.28）

API、schema與19個後端檔保持原樣。安全editor只送已明確修改欄位；全未改沿version-only PATCH。新增完整七欄且status=pending；編輯不送status，審核獨立status-only PATCH。前端以七欄own-presence／JSON、id/orgId及安全版本確認回應，未知2xx保持表單；POST同鍵重試，PATCH仍CAS。核准時fresh重驗半開區間衝突。詳 docs/LEAVE_EDIT_SAFETY_SCOPE.md 與實際測試結果。

## 證照安全編輯（0.29）

既有後端/schema/auth不變。新增完整八欄且status=active；編輯不送employeeId/status，全未改沿version-only PATCH。新寫名稱按原trim；未改省略、日期原merged驗證保持。八欄own-presence/id/org/safe version確認後成功，狀態動作亦保留其他七欄，derived效期不參與保存投影。詳 docs/CERTIFICATION_EDIT_SAFETY_SCOPE.md 與本輪verification。

## 訓練安全編輯（0.30）

既有後端／schema/auth不變。新增完整八欄固定completed；編輯不送employeeId/status，全未改version-only PATCH。hours僅前端alias，原數值容差不變；成功須八欄own-presence與id/org/version吻合。詳 docs/TRAINING_EDIT_SAFETY_SCOPE.md。

## 個案安全編輯（0.31）

既有後端／schema/auth不變。新增固定active；編輯不送status、未改省略與version-only PATCH；十四欄精確JSON及own-presence/id/org/version確認。原同機構督導FK、CMS與0000生日規則保持。詳 docs/CASE_EDIT_SAFETY_SCOPE.md。

## 照顧計畫安全編輯（0.32）

後端schema/auth不變；model僅同機構關聯ref型別守門，異型id安全422，未放寬引用或排班驗證。PATCH未改省略、version-only仍沿原CAS；七欄精確確認。services保持原JSON，明確取代只canonical完整清單；PLAN_IN_USE只scheduled且不比較數量，completed/cancelled不鎖。詳 docs/CARE_PLAN_EDIT_SAFETY_SCOPE.md。

## 單班排程安全編輯（0.33）

既有後端及schema/auth不變。PATCH未改／改回省略；計畫未變同時省caseId，明確換計畫才派生case。ISO／0000無裁切或時區轉換，merged時間分鐘／衝突／紀錄鎖沿原API；九欄完整ACK。cancelled仍可能原422，不新增恢復或手動完成。詳 docs/SHIFT_EDIT_SAFETY_SCOPE.md。

## 月份清單日期型別安全（0.34）

依 docs/MONTH_FILTER_SAFETY_SCOPE.md，泛用GET清單先沿date||validFrom||空文字選值，只有字串套原startsWith月份前綴。truthy object／array／number／boolean不轉字串、不fallback；falsey原選值及字串前綴相容，沒有新增有效日期驗證或修改資料。機構／角色、q／status／date與分頁順序保持。

只修泛用GET清單month選值為非字串時的500；legacy reports.mjs非空month仍有同類500，未修。服務紀錄安全編輯順延0.35且not_started／契約未凍結。

月份語法沿原YYYY-(01..12)及INVALID_MONTH422；只影響泛用GET列表，單筆GET及寫入驗證保持。finance仍讀原month API且無新增班表／核閱導覽，caregiver沿自己的employee scope。不可把型別守門解讀為日期清理、報表遷移或正式差勤規則。

## 服務紀錄安全編輯（0.35）

依 docs/SERVICE_RECORD_EDIT_SAFETY_SCOPE.md。兩填寫及兩核閱入口沿canonical openForm。新增五控制項、九payload欄不送reviewNote；編輯十保存欄只送改變欄，own-presence／JSON私有保持，services一律保持／明確整欄取代，ISO／0000／缺失／null／typed／CR不猜值。note可明確清空，returned預設returned且只有明確submitted才重送；動作「修正退回紀錄」。2xx未知、空JSON、錯誤id/org/version或任何欄不符不能成功關閉；review確認status/reviewNote及其餘八欄，billing由server交易產生、不從UI推算。

新browser 14段十一表唯讀保持；49批合成setup／fixture／login及業務必要寫精確對帳556 changes，6不可變trigger、已核閱billingSnapshot及四個非空BLOB下載保持。50完整context失效與3真提交晚回應分列；Abort不是已提交交易回滾。72指定sealed034 PDF／pdf-*參照維持bytehash，無新PDF、marker或本輪歷史PDF人工重看。

未執行CI、部署、人工UAT、原生OS popup幾何／鍵盤選值、正式工時／薪資／支付／定位／申報／評分／介接／外部訊息。legacy reports非字串日期month500未修，0.36僅未凍結候選。先前certification附件偶發reopen原因未明，通過迴歸不證明修復。

原API合法draft／returned整組改派仍允許，UI本輪不提供改派而保持捕捉的四關聯／日期，不能宣稱API parent immutable。submitted／approved PATCH鎖、CSRF／機構／角色／逐版授權／CAS保持；POST及review同dialog同payload重試同Idempotency-Key，PATCH不自動換version。merged完整驗證保持，污染必要欄或服務可能422，不自動修資料。同日HH:mm或符合當日ISO、end>start與原0000相容，不限制落在排班時段、不推工時；服務1..100項且quantity1..10000，不推排班／計畫quota。核准沿同一交易完成班次並保存價格快照；admin／finance可讀、supervisor／caregiver遮罩，後續主檔變動不重算。

## 舊報表月份型別安全（0.36）

依docs/LEGACY_REPORT_MONTH_SAFETY_SCOPE.md。

唯一產品改動為 reports.mjs 的 date 型別守門；其餘18後端及全部37 public來源與0.35完全一致。只用date、不轉型／trim／解析日期／validFrom fallback；缺省或空month保留原JSON與CSV。cases仍忽略合法month，shifts/services狀態與created_at DESC/id順序保持；fees/payroll仍僅approved及核閱快照，選內缺快照409、選外排除不阻塞。角色／機構／失效居服員403及原錯誤次序保持。

本輪只重跑核心／七類作業報表／泛用月份及新舊報表月份安全，沒有宣稱35套舊browser全部fresh。

新browser8段十一表／6trigger零寫，前置setup／合成匯入／核閱／主檔後改／附件／四角色登入精確對帳103 changes；2筆核閱快照、全部版本及4次非空BLOB下載保持。5張settled新UI已逐張檢視；root2為重疊subset。legacy新增PDF／print均0；七套advanced報表迴歸另生成7份合成QA PDF，不是正式表單。

僅合成memory SQLite、隨機localhost與真Chromium。

## 費用／薪資回應確認（0.37）

後端API無變更。UI只為fees/payroll加入完整5-key DTO確認，exact columns／row keys／note、字串原文／月份prefix、合法保存數字及BigInt安全合計；返回同物件，不修資料／補值／去重／排序／重算金額。詳 docs/LEGACY_FINANCIAL_REPORT_CONFIRMATION_SCOPE.md。

回應未知時code REPORT_UNCONFIRMED、訊息「未取得完整且一致的試算報表，請重新讀取。」；原查詢條件保持，以canonical errorState重試，CSV停用。既有CSV獨立freshGET及伺服器驗權保持；薪資無month/org echo，不能由此確認其查詢身份。

本機合成資料；薪資DTO無月份／組織回顯，畫面確認不證明CSV內容相同。既有Number(cents)/100元formatter在大額safe integer分可能顯示一分差，不宣稱精確每分顯示；0.38候選另凍結。

## 金額精確顯示（0.38）

所有後端API及JSON／CSV保存分無變更。canonical public/ui.js formatMoney僅對primitive safe integer以精確整元／餘分及Intl parts呈元；不重新計算金額，不修回應資料。admin row／totals caller、0.37完整DTO／合計確認及錯誤／重試／context保持。詳docs/FINANCIAL_REPORT_EXACT_CENTS_SCOPE.md。

只修已回傳安全整數分的顯示，不宣稱後端預格式計算精度，不新增官方金額上限、支付／薪資／補助／自付／加班／稅費／核銷或介接規則。薪資DTO沒有月份／組織回顯；CSV仍是獨立fresh GET原始分，畫面精確顯示不證明下載內容身份。MAX合成金額快照是INSERT-only歷史匯入驗證，不代表正常價×量寫入保證。0.37格式限制段落保留作歷史；本輪0.38另驗證修正。0.39備份還原僅未凍結的合成scratch候選，原not_started／正式4/5/6/7相依及migration-restore、role-matrix needs_contract保持；不提高Node最低版本。

## 合成備份還原工具（0.39）

不增加HTTP endpoint。七個限定合成workspace的exports及QA CLI詳docs/SYNTHETIC_BACKUP_RESTORE_SCOPE.md；rehearse:synthetic-backup拒絕caller args，固定slots／opaque refs，restore必填staged或live。新module不被現有server import。

完成0.39合成SQLite一致性backup/restore與closed切換／forced rollback演練。bound VACUUM INTO包含checkpoint後正常API提交的WAL；manifest與opaque ref核對schema／十一表typed欄位／BLOB／版本／核閱快照與原session。缺current version、schema/FK/損毀／改檔／unsafe path／已有target拒絕，不補資料或重算金額。成功保留previous；強制失敗回復原live closed bytes及全部保存值。完整還原startup零寫，新登入及expired session cleanup另列。第一修正版四commands均1因新fixture欄名守門錯拒實際sha256；18 tests在hook前全未執行、browser0關，不驗收；僅一regex允許合法欄名數字並inverse exact。原freeze／來源／log／process／outer及初始成功syntax/browser保持。另fresh final221 clone明確執行10commands，9 actual0及args預期2；共18執行attempts、6失敗原始保留，不宣稱first-pass／自动retry。既有active57、browser／CLI sources保持；最後metadata另hash。Node22.13一般應用程式TEXT讀取未改，此修正只補備份／還原核對。

全部public38／既有backend19 exact0.38；新unmounted後端工具1及合成fixture／test／browser／CLI／scope共6新增來源，215→221。舊0.38全UI534仍為歷史，本輪未重跑其全矩陣。

只完成合成plaintext本機演練：十一表／六trigger、WAL提交、附件／版本／session／保存價格精確核對與受控closed切換／回復。沒有任意路徑或HTTP restore，不是跨程序外部manifest匯入；SHA是損毀核對而非認證。sidecar不存在不能證明沒有open handle；不保證crash／停電／所有I/O失敗或線上原子切換。加密、金鑰、留存、排程、存取稽核、RPO-RTO、效能及正式migration/UAT待核定。

## 公告閱讀回執（0.40）

GET `/api/announcements/:id/read-state` 可選version，回announcement/currentVersion/canAcknowledge/本人receipt。POST同路由只收 `{version}` 且無query；首次201，合法tuple重送200，同key保留savedstatus。GET `/api/announcements/:id/read-receipts` 僅admin/supervisor，可選version/page/pageSize（預設目前版/1/25，上限100），只回實際回執。詳細固定DTO、currenthead／receipt完整性、錯誤碼、授權與snapshot唯一真值見docs/ANNOUNCEMENT_READ_RECEIPTS_SCOPE.md及QA scope-clarifications.json。

公告清單新增「閱讀全文」與管理者／督導「閱讀紀錄」。本人明確提交目前已發布文字版才保存回執；GET不代簽，新版未讀，舊版回執保存當時姓名／角色。名冊每頁25筆並可查精確有權版次，僅計實際回執。沿既有十一表／六不可變trigger，隱藏locator不提供CRUD；真值僅announcement.read版本1快照，完整tuple SHA與原子寫入／冪等／目前版重驗保持。共享openDetails opt-in忙碌、取消與context失效；未知2xx人工同鍵重試，409重新讀取。

40個設定commands全部fresh、另legacy月份與backup browser；40套554聚合gates。新8圖及fresh報表／shared sibling視覺檢視，7份31頁PDF屬既有報表迴歸；新公告無PDF／print。strict0 finding，design lint0 error／10既有warning。所有失敗／診斷／修正原始保留；不宣稱first-pass。

僅本機合成驗證，閱讀回執不代表內容理解或法定簽收。原公告對象／其他角色／應讀群體／未讀率／保留與法定規則未核定；JSON掃描不宣稱索引效能或SLA。既有baseline backfill不改，new receipt拒絕baseline。正式role-matrix、支付、薪資、評分、申報、介接、migration/DR/加密/留存與人工UAT未核定。

## 班表週／月唯讀日期檢視（0.41）

零新API／後端／schema／寫入。每次開啟／查詢／翻期／今天／重讀使用 `GET /api/shift-report/export`；固定精確 startDate/endDate、空caseId/employeeId及合法status，不带page/pageSize或拼多頁。新前端確認外層12key、每列13保存key及11可見欄、完整total/page1/pageSize=total、日期與UTF-16 tuple順序及整體1000筆／2MiB上限；不符全體拒絕CALENDAR_UNCONFIRMED，超限413不顯示部分結果。完整合法空結果接受。依保存date分組原row reference，不trim或轉時區。Gregorian整數日期0000..9999，週7格／月42格。完整契約見docs/SHIFT_CALENDAR_SCOPE.md。

管理者／督導的班表清單與居服員的本人班次新增「週／月班表」。可依日期、週／月及狀態查詢，翻期、回今天與重新讀取；每次取得完整有權班次。日期索引跳至同一份每日明細，十一欄與版次、原時間及備註字串完整保留；手機使用同一份每日明細及表格內捲動。草稿立即撤下舊結果，失敗保留條件並顯示重試，關閉與context失效取消讀取。

僅本機合成核心切片驗證；原生下拉選單鍵盤選值、OS popup幾何、人工UAT及完整WCAG符合性未驗。日期文字欄位支援0000..9999；未計工時、薪資、假日、例休、定位或額度。原個人行事曆／例休假／我的行事曆三列及正式支付、薪資、評分、申報、角色／App、介接、migration/DR/加密/留存規則仍未核定。

## 班表個案／人員條件（0.42）

零新 API／後端／schema／寫入。明確啟用後每次沿原 load signal 依序 GET cases、employees，pageSize=100 完整確認，最多100頁／10000筆每類；再 GET /api/shift-report/export。查詢固定 primitive exact caseId／employeeId、日期及狀態，不 trim、coercion 或猜 UUID，不拼分頁報表。逐頁精確四 key、組織／version／dense array、total 與全域 ID 唯一；投影八欄的 JSON UTF-8 每類2MiB為名單上限，非網路 body 上限。名單無 snapshot token，不宣稱跨頁原子快照。

新 helper 在 export 前驗所選 ID，完成原全報表確認後比對精確 filters 與目前主檔 selectionName；row DTO 無 caseId／employeeId，實際成員篩選由獨立保存 shiftId→person ID 的 HTTP oracle 證明。lookup／selection 未確認全體拒絕，保留精確條件；沿原1000筆／2MiB完整報表及413。居服員啟用後固定目前本人 ID，財務無入口；伺服器原授權與原错误次序保持。完整契約見 docs/SHIFT_CALENDAR_PERSON_FILTERS_SCOPE.md。

僅本機合成核心切片驗證。lookup 每類最多10000筆／100頁及投影 JSON UTF-8 2MiB，非網路 body 上限，沒有跨頁原子快照 token；報表維持1000筆／2MiB。純空白姓名仍可能被既有 shared confirmReport 拒絕；本轮不修改該限制。報表 row DTO 沒有個案／人員 ID；前端只確認回顯，實際篩選由獨立保存 ID 的 HTTP oracle 驗證。仍partial；正式工時、例休、資格、支付、薪資、評分、申報、角色／App、介接及 migration/DR/加密/留存規則未核定。

## APM CIS／Portal 登入（0.44）

完整契約見 docs/APM_CIS_SSO_SCOPE.md。GET /api/setup/status 在原 needsSetup 之外提供 authMode；Portal 模式另回 portalLoginUrl/portalHomeUrl，不能由 browser 自訂來源。createApp() 預設 local，只有 executable startup 讀 HOME_CARE_* 環境。POST /api/auth/handoff 僅明確設定之 Host 與 Portal Origin、form-urlencoded payload/signature，strict 九欄 HMAC claims；一次性 nonce、已開通 identity binding、目前 membership 與 own session 交易保存，成功 303 /#/。Portal 模式不開放 /api/setup 或 /api/login；session 每次檢查目前有效 binding/membership，撤權立即失效。Portal cookie HTTPS Secure/HttpOnly/SameSite=Lax 以支援跨站 POST 後 303，local 原 Strict 保持，普通寫入 CSRF／Origin 不變。

SSO／明確開通才增加 portal_identity_bindings、portal_handoff_nonces。既有 synthetic backup 仍只支援十一表，新增 schema 會明確拒絕，不能把舊還原工具用於已開通 SSO 的 DB。正式共用入口與持久主機發布尚未完成，本機合成驗收不代表正式可用。

## Portal十三表合成備份與還原（0.45）

只使用factory自建合成scratch與記憶體假Portal身分，保留實際帳號、私人DB／備份及原部署設定。還原保存十三表、schema／六trigger、附件BLOB、版本、核閱計價JSON、binding／session／nonce的快照當時值；初次還原沿同一真HTTPS瀏覽器cookie且absolute expires_at不續期。promotion邊界另以合成原cookie重新放回瀏覽器驗證，不能混稱全程自動登入。快照之後的撤權／nonce消費實際不保留；正式reconciliation、key rotation、移轉、加密、留存、RPO/RTO與人工UAT仍待核定。原十一表facade仍拒絕Portal schema，兩profile所有操作在FS前隔離；無HTTP/operator還原入口，不能用於使用中的實際帳號資料庫。

正式homecare主機、HTTPS與Portal發布狀態沿0.44交接保持未完成，本輪沒有DNS、正式部署、真實帳號DB存取或外部訊息。

不增加HTTP endpoint。原synthetic-backup.mjs七項exports／arity／格式維持，新增synthetic-portal-backup.mjs的createSyntheticPortalWorkspace(0)及相同其餘六項固定操作，由private synthetic-backup-core.mjs隔離固定profile。新inspection／backup格式分別為suiyue-synthetic-portal-sqlite-inspection-v1及suiyue-synthetic-portal-sqlite-backup-v1；禁止跨owner/profile、外部路徑或caller manifest。CLI不接受參數，只使用明確產生的合成fixture。

GET /api/case-status-followups、GET /api/case-status-followups/:id、POST /api/case-status-followups、PATCH /api/case-status-followups/:id、GET /api/case-status-followups/:id/history（可compare=previous）。九业務欄：caseId、kind、startDate、endDate、reason、followUpDate、outcome、note、status；必填前四者中的caseId/kind/startDate/reason，kind=pause|closure、status=pending|completed|cancelled。選填日期與文字預設空字串。只trim本次送入字串，reason/note上限10000、outcome500；日期有效YYYY-MM-DD，endDate不可早於startDate，followUpDate不推定服務區間。PATCH需version且父個案不可改。清單與單筆GET只接受page/pageSize/q/caseId/status/kind六鍵，拒絕重複、未知及非法值；pageSize預設25／最大100、q最多200。history沿既有分頁與精確前版，所有保存snapshot重驗目前父案權限；管理者／督導可寫，財務／符合有效員工與本人班次個案範圍的居服員只讀。無DELETE或自動狀態／排班／計價異動。

## 個案暫停與結案追蹤（0.46）

個案詳情新增獨立追蹤區塊，可保存類型、開始／結束日期、原因、追蹤日、結果、備註與人工追蹤狀態，固定父個案。支援搜尋、類型／狀態篩選、25筆分頁、建立編輯、明確取消恢復與九欄版本差異。管理者／督導維護，財務及有權個案的居服員只讀；清單、單筆與每個保存歷程均重驗機構及父個案授權。沿既有版本／CAS／冪等、APM品牌及共用表單／確認／歷程元件；新增／編輯須九欄保存確認，異常原值保持或明確取代／清空。

人工追蹤獨立記錄，不自動變更個案服務狀態、照顧計畫、班次、服務紀錄或核閱計價快照；沒有新表／trigger／migration。

GET /api/interview-applicants、GET /api/interview-applicants/:id、POST、PATCH /api/interview-applicants/:id及GET /api/interview-applicants/:id/history（compare=previous沿既有精確前版）。八欄 name/phone/interviewDate/city/district/interviewContent/note/status；必要 name/phone/interviewDate/interviewContent，名單active/inactive，city/district/note預設空字串。只trim提交字串；上限200/64/100/100/10000/10000，姓名／電話／行政區單行。日期沿有效YYYY-MM-DD；PATCH須version。GET只允許單值page/pageSize/q/status/interviewDate，q最多200、精確日與分頁合法；財務／居服員所有路徑在query/body前403，跨機構ID404。沒有DELETE或自動聘用／員工／帳號異動。

## 面試者登錄與紀錄（0.47）

機構管理新增「面試者登錄」，管理者／督導可建立、編輯、明確啟用／停用及閱讀八欄版本差異與實際操作者。保存姓名、電話、人工面試日期、自由縣市／鄉鎮區、面試內容、備註及名單狀態；支援關鍵字、精確日期、狀態與每頁25筆查詢。伺服器在query／body前拒絕財務與居服員，所有讀寫及歷程沿同機構隔離、CAS／版本／稽核／冪等。

沿 APM CIS、共同導覽、listPage／openForm／confirmAction／history；原生欄位、390px及桌機表內捲動。編輯只送本次改變欄，異常舊型別或換行保留原值，明確意圖才取代／選填清空。八欄／id／org／版本精確保存確認後才提示成功；同payload新增重試沿原key。無新表、trigger、migration，也不建立員工／帳號、外部通知或自動錄取／資格／薪資計算。

48 configured／47 required只執行必要子集，未宣稱全部fresh或first-pass。原失敗及修訂完整留證。

原完整十八欄／選項／列印／流程／App映射仍有缺口，保持partial，不宣稱原對等或完成。

static auditor沿0.46私人一行parser修正，provenance／負控制與原停滯stack留存，外掛與規則保持，未宣稱原官方程序通過。

## 督導訪視查詢（0.48）

管理者／督導可專用查詢目前同機構assessment-04訪視保存紀錄：十白名單題文字、填寫日期、個案ID、狀態與25筆分頁，閱讀fresh完整十題及原assessments精確前版／實際操作者歷程。姓名為目前主檔，不能按同名猜ID；非文字只顯示型別，未知鍵與巢狀內容不展示或搜尋。填寫仍沿既有評估表單。

只讀切片沿APM CIS、唯一listPage／openDetails／history與原生控制項。伺服器先拒財務／居服員，再驗closed query、同機構與父個案；回顯條件／完整DTO不符不顯示成功。沒有新entity／表／trigger／migration／寫入／CSV／print，不判定臨床訪視頻率、資格、評分或期限；十一表及schema與total_changes零寫由合成測試確認。

static auditor沿已接受私人一行parser，原官方停滯／负控制及parser provenance保持，外掛／規則不改，未宣稱原官方程序通過。

## 多組聯絡人安全編輯（0.49）

個案詳情多組聯絡人現在只保存本次明確變動欄，保留未改原始文字及 own-presence；異型／原生無法無損預填的舊值可明確保持、取代或可選清空。固定父個案，原十業務欄與分類／電話／信箱／長度規則沿原 API。已知狀態沿獨立確認，未知狀態需明確修復，不能猜成停用。

成功需精確 ID／機構／個案／next-version／十欄與 own-presence 回應；非法2xx、409、斷線保留輸入，同payload新增重試沿同鍵只建立一次。清單確認個案歸屬與分頁，loaded／pending 情境失效沿共用 Abort／busy／dirty／Escape／回焦守門，晚回應不復活。原 cases 聯絡欄、版次、班次、快照及附件保持；server／model／history／ui.js／CSS／router未改。keep不繞過原 merged422；原空白姓名note-only行為未修。

static auditor沿已接受私人一行parser，原官方失敗／負控制與provenance保存，外掛與規則未改。

## 人工追蹤唯讀 API（0.50）

GET /api/case-followup-worklist 及 /api/case-followup-worklist/:id 僅admin／supervisor，獨立prefix先驗角色；global Origin／auth／CSRF傳輸順序保持。原case-status-followups generic四角色讀取／兩角色維護不變。

清單僅接受page、pageSize、q、kind、status、followUpDate、caseId各一次；page正安全整數，pageSize1..100，預設1／25。q最多200字、不trim，僅reason／outcome／note各自own string大小寫不敏感搜尋；kind空／pause／closure，status空／pending／completed／cancelled。followUpDate空或有效YYYY-MM-DD，只匹配保存人工日期；caseId空或目前有權非空白精確ID，最多500字。非法／重複／未知query422，跨scope父個案404，符合條件的非法ID／安全版次409 FOLLOWUP_DATA_INVALID。先確認全部符合紀錄，再沿原created_at DESC,id分頁。

清單回{items,total,page,pageSize,filters}，filters精確五鍵q／kind／status／followUpDate／caseId。單筆回{item}，不接受任何query。每item精確七鍵id／orgId／version／caseId／caseNo／caseName／fields；姓名編號只取目前有權主檔原文字，否則空。fields精確八鍵kind／startDate／endDate／reason／followUpDate／outcome／note／status，各為{kind:'string',value:保存原文}或{kind:missing|null|array|object|number|boolean}，後者不帶值。未知kind／status及日期原文字保持可讀。fresh讀取重驗同機構當前父項，單筆UI確認capture ID／org／case，接受新安全正版次。既有entity原九業務欄歷程維持。

沒有新entity／schema／寫入／CSV／print／通知或自動期限規則；GET冪等header不建立ledger。完整契約見docs/CASE_FOLLOWUP_WORKLIST_SCOPE.md。

## 人工追蹤查詢（0.50）

日常作業新增「人工追蹤查詢」，管理者／督導可跨目前同機構個案查閱既有暫停／結案人工追蹤。支援關鍵字、類型、人工追蹤日期、狀態及精確個案ID五條件與25筆分頁；目前姓名只來自主檔，包含可讀暫停／結案個案。fresh單筆完整八欄文字／型別、原九欄版本差異／實際操作者與精確父個案維護連結沿既有共用介面。

新GET入口先拒財務／居服員，再驗封閉query、目前機構與父個案。list／single完整DTO及條件回顯需確認；缺失所選個案保持條件，不能自動轉全部。非文字只顯示型別、未知鍵或巢狀值不展示／搜尋。原generic追蹤讀寫、CAS／歷程／稽核／冪等及個案狀態保持；沒有新表／trigger／migration／寫入／輸出或提醒，不推算到期、逾期、臨床或法定期限。

沿APM CIS、唯一listPage／openDetails guardedRead／history與原生select／date；條件只在記憶。loaded／pending清單、詳情及歷程以完整primitive、hash／render與outer context守門，失效清空／abort、晚回應不復活；nested相同值參考替換保留，outer context重建保守撤除。

static auditor沿已接受私人一行parser，原官方失敗／負控制與provenance保存，外掛與規則未改。

## 本人個人行事事件 API（0.51）

/api/personal-calendar-events 沿既有四角色認證，只能讀寫ctx.user.id及ctx.orgId的本人紀錄。管理者不能代理；ownerUserId由server建立，body只六欄title/date/startTime/endTime/note/status，PATCH另帶正安全整數version。有效文字不trim；標題單行非空白最多200字，日期0001..9999有效YYYY-MM-DD，HH:mm同日endTime晚於startTime，備註最多10000字預設空文字、status active/cancelled預設active。沒有硬刪除、跨夜、自動到期、提醒或差勤／班次連動。

GET list只page/pageSize/q/status/date各一次，預設1／25、page正安全整數、pageSize1..100；q原文最多200字、不trim，僅own string title/note各自大小寫不敏感搜尋。日期精確、status空或兩碼，先本人機構及條件再created_at DESC,id分頁，回{items,total,page,pageSize}，沒有query echo。UI確認捕捉的條件、owner/org/id/version、唯一ID及精確頁筆數，空結果不能證明伺服器完整查詢身份。

GET /:id不接受query；GET /:id/history只page/pageSize/compare各一次，缺席compare為raw，明確compare=previous取得精確前版／實際actor，空compare或其他碼422。每個snapshot仍須本人owner及org，可見SQL身份／安全版次錯誤409 CALENDAR_DATA_INVALID；無法確認owner的匯入值不展示，不修資料、不跳缺版。CAS／Origin／CSRF／POST冪等及既有交易沿共同owner，GET維持十一表／六trigger／total_changes零寫。完整契約見docs/PERSONAL_CALENDAR_SCOPE.md。

## 本人事件完整月份唯讀 API（0.52）

GET /api/personal-calendar-events/calendar，只接受month/q/status單值。month必填0001..9999年精確YYYY-MM，q原文最多200字不trim、status空或active/cancelled；角色先驗，非GET405，非法query422。封閉回{month,q,status,orgId,ownerUserId,items,total,undatedCount}，本人機構與文字／狀態先篩，合法當月日期完整date/startTime/endTime/id字面升冪；非文字時間以空排序key。日期無法確認者只計本人條件下undatedCount且驗身份／safeversion；合法他月不阻塞。完整1000筆／2MiB UTF-8 JSON界限超過422 CALENDAR_LIMIT，無部分結果；不新增寫入或変更原list/single/history/CRUD。

本人事件月份檢視（0.52，本機功能）：四既有角色只讀目前機構本人事件；完整月／q／status回應與每日六欄原值、Gregorian索引、上下月／本月。日期不相容只計本人條件下無法歸月筆數，沒有猜日期或寫入；完整回應1000筆／2MiB界限超過拒絕，不截斷。草稿變動即撤去舊結果；身份／機構／角色／員工／hash／render與outer情境失效清空abort、晚回應不復活，nested同primitive參考保持。

沿既有 APM CIS、唯一openDetails guardedRead／createForm／table及shift-calendar樣式；shared UI／CSS／日期計算／原CRUD與歷程未改。桌機六週索引可鍵盤跳至當日，390px沿既有樣式隱藏索引並保留完整每日資料與長備註。原失敗與封存保持。

## 需求評估保存查詢 API（0.53）

GET /api/needs-assessments、GET /api/needs-assessments/:id；admin／supervisor current-org＋逐父個案授權。其他角色先403，其他方法先角色後405。List只接受page/pageSize/q/status/date/caseId單值：page正safe decimal、pageSize1..100預設25，q原文最多200 UTF-16，status空或draft/submitted，date有效YYYY-MM-DD含保存年0000，只匹配metadata紀錄填寫日期；caseId精確最多500非空白，非法422。Single有query422；其他模板／entity／機構／父個案不可讀404。符合模板／授權及條件的全部候選分頁前驗識別／safe version／原日期／狀態，異常409 NEEDS_ASSESSMENT_DATA_INVALID，不修、不截斷。

List exact {items,total,page,pageSize,filters}、filters exact {q,status,date,caseId} 原文echo；single exact {item}。Row exact {id,orgId,version,templateId,caseId,caseNo,caseName,date,status,answerContainerKind,hasUnknownAnswerKeys,answers}，templateId assessment-03。answers exact q001..q009；own string 完整原文含空文字／CR／不相容日期為 {kind:string,value}，其他 missing/null/array/object/number/boolean 僅 {kind}；非object容器九題missing，unknown只布林，巢狀內容不展示。搜尋九個own字串各自lowercase literal，不跨題或搜metadata／目前主檔。原 assessments CRUD／十六模板／history未改，完整契約參見 docs/NEEDS_ASSESSMENTS_SCOPE.md。

需求評估保存紀錄查詢（0.53，本機功能）：admin／supervisor 可跨目前可讀個案閱讀既有 assessment-03 九項保存答案，包含 paused／closed 個案。原文 q 不 trim，只搜九題文字；紀錄填寫日期、狀態、精確個案 ID 與25筆分頁保留條件。完整內容每次重新讀取，明確分開目前個案姓名與保存姓名；訪視／審閱／填表日期保留原文，非文字只呈現型別，未知題名與巢狀值不外洩。沒有新增寫入、評分、簽核、匯出或第二編輯器。

沿 APM CIS、原 admin.listPage、唯一 openDetails guardedRead 及原 assessment history；shared UI／CSS、十六模板、原 CRUD 與其他角色既有讀權保持。角色與機構、精確 DTO／echo／版本／原日期候選於分頁前確認；loaded／pending list、details、history 六種 primitive 失效清空 abort，nested 同 primitive 保留、outer 重建撤除，晚回應不復活。390px 表內橫捲，長答案末句以真 Range／hit-test 對 direct close footer 驗證。

## 附件描述安全編輯（0.54）

API及server未改。case-attachments只PATCH明確變更title/category/note或確認status；certification-attachments只PATCHtitle/note或確認status。固定父項、derived employee及四檔案欄不可client寫入；新送字串沿原trim，省略原始JSON及own-presence保持。原CAS／CSRF／merged422、四role讀寫／cert finance403沿舊契約。PATCH無Idempotency-Key語義，已commit但回應未確認的原版重送仍409。新純editor確認同ID/org/parent/cert員工/精確next版本、描述及fileName/mimeType/sizeBytes/sha256全部own-presence／保存值；fileId不公開。原list envelope {items,total,page,pageSize}與25筆清單精確scope／count確認，搜索沒有filter echo不假稱額外語意。詳docs/ATTACHMENT_METADATA_SAFETY_SCOPE.md。

附件描述安全編輯（0.54，本機功能）：管理者／督導維護原個案與證照附件描述；只PATCH本次明確變更欄，保留原文字、CR／LF、異型值及own-presence。不能無損預填的欄位以保持／明確取代，備註另可清空；未知狀態只能明確修復，已知停用／恢復仍沿原確認。保持不繞過原merged422。

保存需確認精確ID／機構／固定父項／證照derived員工、安全next-version、全部保存描述與四檔案欄位及own-presence。非法2xx、409、422及斷線保留輸入；沒有變更零PATCH。原PATCH沒有冪等：已commit但ACK未知時原版重送仍409，重新讀取／歷程確認後才可再改。原server、model、CAS／CSRF、檔案上傳／更換／下載、BLOB／歷程及核閱計價快照保持。

沿APM CIS及唯一共用form／confirm／history／download、原搜尋／25筆分頁；清單精確同org／parent／cert員工及page確認。user／org／role／employee／hash／父render與outer情境失效清空abort，nested相同primitive保持；晚回應不復活。390px長備註末句以實際捲動、Range／hit-test及圖片核footer。

## 本人事件完整年度唯讀 API（0.55）

GET /api/personal-calendar-events/year：四既有角色先驗，再限定ctx.orgId／ctx.user.id本人；管理者不能代理。只year/q/status各一次，year必填四碼0001..9999，q原文最多200字不trim，status空或active/cancelled；非法422，非GET角色守門後body前405。exact回{year,q,status,orgId,ownerUserId,items,total,undatedCount}，保留完整DTO六欄原值／own-presence。有效本年按date/startTime/endTime/id字面升冪，非文字時間排序鍵為空；其他有效年排除，無法歸年的本人條件候選只計undatedCount，並確認身份／safe version。total等於全部items.length，1000筆及整個回應2MiB UTF-8界限超過422 CALENDAR_LIMIT；縮小q/status或改月份／原清單，不回部分資料。GET零寫，原month/list/single/write/history與附件BLOB／核閱快照保持。

本人事件年度檢視（0.55，本機功能）：四既有角色只讀目前機構本人事件，管理者不能代理。年度／原文搜尋／狀態的完整回應依保存日期及時間字面排序，十二月份含空月列出完整六欄及月／年筆數。異型只顯示保存型別，不能歸年的本人事件只計數、不展示或猜日期；全年1000筆及整個2MiB UTF-8回應界限超過拒絕，沒有部分結果或新增寫入。

沿APM CIS、唯一openDetails guardedRead／createForm／table及既有shift-calendar樣式；桌機月份索引可鍵盤定位至heading，390px保留完整十二月agenda、表內捲動與長備註。年度0001至9999翻年／今年／重讀；草稿變更立即撤去舊結果並停用導航，明確查詢才fresh讀取，失敗保留條件可手動retry。user／org／role／employee／hash／父render與outer情境失效清空abort、晚回應不復活，nested同primitive參考保持。原CRUD、月份、歷程、shared UI／CSS與日期演算未改。

## 個案保存紀錄索引 API（0.56，本機驗收完成）

`GET /api/cases/:caseId/record-index` 僅限 `admin`／`supervisor`。角色守門後非 GET 回 405；目前同機構且實體為 `cases` 的精確父 ID 才可讀，包含暫停與結案個案。未知、缺失、跨機構或錯實體父項回 404。

查詢只接受各一次的 `entity`／`page`／`pageSize`。`entity` 必填 `care-plans`、`shifts`、`service-records` 或 `assessments`；page 為正安全十進位整數、預設 1；pageSize 為 1 至 100、預設 25，介面固定 25。未知、重複或非法條件回 422。

精確回應為 `{items,total,page,pageSize,entity,orgId,caseId}`，每列僅 `{entity,id,orgId,caseId,version,updatedAt}`。只取目前 SQL 紀錄與原資料 own `caseId` 精確相符者，依 `created_at DESC,id ASC` 排序；不回 createdAt，也不把 updatedAt 當排序或事件時間。所有符合候選先驗安全版次、歷程路由相容識別及原文字 updatedAt，再分頁；不合法候選整份回 `409 CASE_RECORD_INDEX_INVALID`。

識別沿既有歷程路由小寫十六進位與連字號，不新增 UUID 形狀或長度上限。無法確認父案歸屬的異型原資料不展示、不修復；業務欄、答案、狀態、備註、檔案、操作者、稽核、版本快照與計價內容不進索引。讀取沒有新表、trigger、版本或任何寫入；既有逐版歷程與授權保持。必要本機合成驗收已完成；各提交的公開 CI 結果以 GitHub Actions 實際紀錄為準。

## 0.57 視覺整理

本版本只調整共用視覺與既有導覽／頁內定位。所有 API schema、角色與機構授權、查詢參數、payload、CAS、冪等、歷程與計價快照保持；沒有新增業務端點。Portal 接收與明確身分綁定規則沿原契約，視覺驗收不代表正式入口已發布。

## 員工保存紀錄索引 API（0.58，本機驗收完成）

`GET /api/employees/:employeeId/record-index` 僅限 `admin`／`supervisor`；角色先驗，非GET在body前回405。同機構實體為employees的精確父ID可讀，包含停用員工；不存在、跨機構、錯實體父項回404。

只接受各一次的entity/page/pageSize；entity必填employee-certifications、employee-training或leave-requests。page正安全十進位整數預設1，pageSize 1..100預設25，介面固定25；未知、重複、空或非法條件回422，無寬鬆數值轉型。

精確回 `{items,total,page,pageSize,entity,orgId,employeeId}`，每列只 `{entity,id,orgId,employeeId,version,updatedAt}`。原資料是JSON object且own employeeId文字精確等SQL父項才取，包含目前所有狀態；typed、missing、shadow或異型歸屬不修復也不展示。SQL created_at DESC,id ASC排序後所有matching metadata先確認安全version、原文字updatedAt、同org/entity及既有歷程路由相容ID，再分頁；任何不安全候選（含off-page）整份回409 EMPLOYEE_RECORD_INDEX_INVALID。不回createdAt或業務／資格／課程／請假原因／薪資／BLOB／actor／快照內容。

讀取無新表、migration、trigger或寫入。索引嚴格確認完整echo／own descriptor／安全數字／分頁長度／唯一ID後才呈現；草稿變更撤舊結果，失敗人工重讀，合法越界頁至多一次最後頁fresh讀。共用case/employee index owner沿原ui.js guardedRead與單筆history；現在同員工不代表過去每版仍屬該員工，原逐版權限及歷史關聯保持。必要本機合成HTTP、純確認、桌機／390px實際瀏覽器及原case回歸已完成，詳docs/EMPLOYEE_RECORD_INDEX_SCOPE.md。

## 面試者目前保存紀錄詳情（0.59，本機驗收完成）

重用既有 `GET /api/interview-applicants/:id` 回 `{item}`；伺服器先驗管理者／督導，機構與 SQL metadata 原規則保持，停用名單仍可讀。沒有新 endpoint、寫入、schema 或正式錄取／到職規則。

「查看紀錄」每次 fresh GET，目前 version 可以不同於清單。嚴格 exact envelope、own data descriptor id/orgId/version/createdAt/updatedAt 及精確 requested identity；version 正 safe integer、保存時間原字串不解析。只投影八個既有欄位，missing／empty／null／non-text／text 分辨；完整原文含 CR/LF、無效舊日期與未知狀態 literal 呈現，typed 只型別 tag，未知額外欄不取值或遍歷。Known getter 拒絕且不執行，unknown getter 不讀；無HTML執行或隱藏JSON展示。

沿唯一 openDetails guardedRead、原 listPage、detail-grid／pre-wrap，兩長文欄复用 field-wide。角色／ID 開啟前確認，user/org/role/employee/hash/父render與outer context完整守門；loaded／pending失效清空abort關閉、晚回應不復活；nested同primitive保留。失敗僅人工重讀、一個fresh GET，原CRUD與歷程入口保持，無print／CSV／POST。必要合成驗收與限制見 docs/INTERVIEW_RECORD_DETAILS_SCOPE.md。

## 本頁本人公告回執（0.60，本機验收完成）

重用既有 GET /api/announcements/:id/read-state；只有人工操作捕捉目前已確認頁的精確識別碼、最多25個，以同一AbortSignal循序讀取，不傳version或query，不新增API／POST／schema。每列採fresh目前版，可不同於清單舊版；完整固定DTO及本人、機構、ID、版次與SHA256 receipt tuple沿原confirmAnnouncementReadState。回執角色與姓名是閱讀時保存，不以現在的角色或姓名否定舊回執。

只投影安全標題、精確ID、目前版次、本人回執保存狀態、canonical UTC readAt及canAcknowledge。未保存不代表未讀、應讀或法定簽收；不可確認另標示且不產生閱讀提交。每筆HTTP／斷線／逾時／非法2xx只顯捕捉ID與「未確認，請重新查詢」，其餘逐筆繼續；人工重查同一頁全部ID，先清空舊結果。25是請求數界限，並非整批15秒、傳輸位元組或server掃描SLA。

listPage新增optional currentPageAction同步capture hook，只有公告opt-in。exact分頁metadata與distinct ID驗證後才paint／發布snapshot，不驗證舊API未提供的filter echo。原controller／sequence／observer為唯一清單owner；搜尋草稿含IME、條件、分頁、refresh與primitive／外層context失效立即撤除、abort、關閉，不復活晚回應。openDetails guardedRead為唯一對話框owner；雙啟動有同步gate、關閉回焦沿原owner。完整凍結契約與必要合成驗收見docs/ANNOUNCEMENT_PAGE_RECEIPTS_SCOPE.md。

## 員工目前完整保存資料（0.61，本機驗收完成）

重用既有 GET /api/employees/:id；每次人工開啟或重讀只送精確同一識別碼，以canonical openDetails的AbortSignal讀取單筆，沒有query、批次、自動重試、持續查詢或寫入API。原管理者、督導、財務同機構讀取與居服員本人啟用員工範圍保持；居服員沒有新增介面入口。

共用confirmSavedRecordDetails確認封閉{item}與{id,orgId}、own data metadata及正安全整數版次；保存timestamp是原文字，空字串與CR/LF保留，不轉日期。員工固定十欄投影區分未保存、空白、null、文字、非文字型別；未知欄位與巢狀值不讀取，已知getter拒整筆且不執行。regions確認dense own string[]後detach沿原formatter，不join/de-dupe；holes、混合、extra/symbol顯array標記。hourlyRateCents僅原primitive沿formatTrialPriceCents，安全整數精確BigInt元/分，不coerce或另加邊界。

共用薄UI adapter呼叫唯一openDetails，沒有另一個controller/observer；原面試profile不套入員工專用preflight。員工額外要求非空user/org與三既有角色，捕捉四primitive、外層context、hash、alive與trigger連接；失效清空、abort、關閉，巢狀sameprimitive reference replacement保持結果、外層重建撤除。503或非法2xx不展示保存欄位，僅人工重讀。詳細契約見docs/EMPLOYEE_RECORD_DETAILS_SCOPE.md。

0.61發布前修正紀錄：首次Git差異檢查發現面試純helper末端多一個換行，尚未暫存、提交或上傳。僅移除該LF，所有可執行文字保持；原發布失敗、初始來源與驗收封存。修正後重新通過264份JavaScript與1,213項完整程式測試，另外12個必要命令沿本輪原通過證據，九套104項瀏覽器與十張實看畫面仍綁初始來源；不宣稱全部最終來源在本輪重新跑過瀏覽器。必要14種命令共16次實際執行，修正追溯見verification-r02.json及兩份source freeze。GitHub最終來源CI另行核對；正式主機、HTTPS、Portal與真實公司登入UAT仍待完成。

## 服務項目目前完整保存資料（0.62）

原 GET /api/service-items/:id 的單筆完整目前版沿伺服器機構與 scopedRows 授權，無新 API。原 /service-items 管理者、督導及財務增加人工查看八個保存欄位，metadata先確認精確 id/org/version及保存時間文字；居服員原有本人已使用項目GET範圍保持，無新入口。前端只投影 code/name/minutes/unitPriceCents/validFrom/validTo/status/note，未知資料不展開、descriptor確認不執行getter。分鐘、日期與試算價格不代替正式服務或支付規則；原維護、CAS、歷程及計價快照保持。契約 docs/SERVICE_ITEM_RECORD_DETAILS_SCOPE.md；本機證據 outputs/software/service-item-record-details-qa/verification.json。正式主機及Portal發布另驗。
