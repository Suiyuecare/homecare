# 班表週／月唯讀日期檢視（0.41 凍結契約）

這是新系統獨立本機切片；只有完成必要整合與實際瀏覽器驗證後才標示實作完成。原個人行事曆、例休假、我的行事曆三列與正式差勤、定位、支付、薪資、角色／App契約保持未完成或待核定。0.40封存與全部既有來源基線保持。只使用合成資料與自有隨機localhost/memory SQLite；不得存取既有DB／4310、原平台帳密、真實個資、申報、付款、外部訊息或部署。

## 功能與 canonical owner

在管理者／督導 `/shifts` 與居服員 `/my-services` 的既有清單標頭新增「週／月班表」。保留原清單、篩選、維護、週期排班、填寫服務及版本歷程；財務沒有新入口，其既有報表API／導覽權限保持。開啟時為臺北今天的週、全部狀態；本次對話框條件只在記憶體保留，不繼承舊列表條件、不進URL／storage。

唯一對話框、非同步讀取、序列reload、busy、Abort、Escape、關閉／焦點與錯誤owner為 `public/ui.js openDetails`。新增向後相容 `guardedRead:false` 預設參數；只有 opt-in 才額外要求原 context 物件相同，並讓原 observer 監看 `data-render-version` attribute。原 printable/readAcknowledgement 與全部未opt-in caller 行為保持。新adapter使用 `guardedRead:true` 加完整 user/org/role/employeeId/hash/來源render stamp/isConnected guard，不新增 controller、observer、AbortController、timer 或事件協調器。

唯一表單／欄位／驗證owner為 `createForm`。三欄：檢視 `mode` 原生select（week週／month月）、日期 `anchor` 原生文字input（精確西元YYYY-MM-DD，支援0000）、班次狀態 `status` 原生select（空字串全部／scheduled／completed／cancelled）；按「查詢班表」才reload。文字日期是此唯讀檢視的明確 typed 變體，避免原生date把0000清空；不製造日期picker或宣稱OS日期popup驗收。mode選單不得接受空選項為合法模式。查詢錯誤由createForm既有 fields summary/aria/focus呈現；不使用native validation bubbles。

input/change立即保存draft、清空舊索引與agenda，顯示「條件已變更，請查詢班表。」並停用依舊期間產生的上一期／下一期／重讀；不能把舊count冒作新條件。今天以draft有效mode（否則week）及臺北今天／目前draft status重查。上一期／下一期／重新讀取只在已確認當前條件或同條件讀取失敗時可用。切週／月保留anchor；翻週移至前／後週起始可用日；翻月固定月初。HTTP或DTO失敗保留三欄條件、錯誤及重試，不顯示空結果。對話框reload開始移除舊表單，查詢為序列執行；pending只可關閉/Escape真取消，不能宣稱loading中可翻期取消前查詢。

## 日期純契約

`public/data/shift-calendar.js` exports：`parseCalendarDate(value)`、`calendarPeriod(mode,anchor)`、`calendarFilters(period,status='')`、`confirmCalendarReport(result,period,status='')`、`groupCalendarRows(result,period,status='')`。日期算術使用Gregorian整數，沒有Date／時區轉換；年份範圍0000..9999，0000及2000閏年、0099/1900/2100非閏年。精確YYYY-MM-DD，不trim／coerce／補字或接受ISO尾碼。

parse回 `{year,month,day,ordinal}`，ordinal0為0000-01-01（週六），最大3652424為9999-12-31。period回 `{mode,anchor,startDate,endDate,slots,dates,previousAnchor,nextAnchor,rangeClipped}`；只建立新物件／陣列，freeze新結果，不修改任何輸入。slots為 `string|null`，dates為實際本期可用日期，日期格式完整四位年份。

week週一至週日固定7格；越四位日期域的格為null、不可用，query裁到合法域，rangeClipped為true，明示日期邊界。第一個週可只含0000-01-01／02，上一期null；最後週下一期null。month固定6×7=42格、週一第一欄，外月格全部null（不查相鄰月），dates為完整所選月。month首期/末期上一期/下一期null；月域內無裁切，rangeClipped=false。

calendarFilters重新從period.mode/anchor算期間並核對period.startDate/endDate，status只允許上述四值。固定回五key `{startDate,endDate,caseId:'',employeeId:'',status}`。錯日期／模式／狀態丟帶fields的Error（anchor／mode／status），不回修正值；錯period不得形成request。沒有假日、例休、出勤、分鐘、位置或額度運算。

## 唯一完整資料及確認

每次开啟／查詢／翻期／今天／重新讀取沿 `GET /api/shift-report/export`，只有合法五query（空caseId/employeeId可省略），不帶page/pageSize、不用泛用month前綴清單、不拼多頁、不另查lookup。零新API、後端、schema、migration或寫入。

原後端先membership／org／scopedRows授權；admin/supervisor/finance的API沿機構範圍，caregiver須同機構active linked employee且只回本人班次，每次fresh GET重新驗證。名稱及員編不是授權證據；原報表只有 organization.name，無orgId／employeeId echo，完整context綁定不補造回顯。

新確認helper只對此calendar加exact/bounded驗證，再沿 `confirmReport(shiftReportConfig,result,filters,{complete:true})`。外層12 ownkeys：title/organization/filters/selection/generatedAt/columns/rows/totals/total/page/pageSize/note；organization只有name、filters五key、selection只有case/employee/status、totals只有count、每column只有key/label。columns固定11可見欄且不補type；每row固定13key：shiftId/version/date/caseNo/case/employeeNo/employee/startTime/endTime/services/status/statusLabel/note。直接以實際shiftReportConfig確認13個row keys及11個可見columns，候選「13欄」在本契約精確區分；不改已封存候選。

DTO物件只允許普通或null prototype，不允許array／boxed／自訂prototype／非own欄。所有現有confirmed型別／唯一shiftId／safe正版次／篩選echo／保存date與狀態／generatedAt／完整total、totals.count、page1/pageSize=total/rows.length=total皆保持。合法空result為rows=[]/total0/page1/pageSize0，必須接受。UTF-16 `<`/`>` tuple `date,startTime,caseNo,employeeNo,shiftId` 相鄰順序與伺服器保持，不能localeCompare、重排時段或合併同時段班次。

完整上限≤1000 rows及 `TextEncoder().encode(JSON.stringify(result)).byteLength≤2097152`；伺服器超過整體413，新helper也拒絕不可信2xx。上限不是網路headers／CSV大小。任何欄位、數量、identity、範圍、排序、上限、JSON可序列化性不符，全體丟CALENDAR_UNCONFIRMED Error，沒有部分結果或空表。成功返回原result、不trim、不改任何字串／列順序／值；group先確認後按保存date把每row原reference恰放一次，回所有dates的 `{date,rows}` 新freeze分組，保留空日。

## 日期索引與完整每日資料

新 `public/modules/shift-calendar.js` 是business adapter，僅上述純函式、common api/openDetails/createForm/button/el/table/errorState/today。桌機日期索引為普通semantic table，週7格／月42格、週一至日欄頭；不是ARIA grid，不提供拖曳或自訂grid keyboard。每有效格完整日期／星期／班次總數，button跳到同一DOM內當日 tabindex=-1 heading並focus/scroll；不得使用hash anchor、重查或只展示前N班次。不可用格不提供button。scope CSS只索引geometry、daily table文字換行與390px隱藏索引；colors/fonts/tokens與共用44px按鈕／scrollbar保持。

agenda按dates依序，每個日期section有日期／星期／完整count，原report11columns語義table及完整rows（shiftId留data-shift-id、version可見）。空日只有完整確認後才明示；完全空期也保留合法期間與零筆。HH:mm或ISO原時間、案號／員編／目前名稱、服務文字／數量、狀態、版次、note皆原字串呈現，pre-wrap安全文字，不執行HTML、不算工時、不改時區。手機同一agenda DOM自然單欄，每表自有橫捲，文件不溢出；dialog footer不遮focus。沒有新lookup、詳情、CSV／print／PDF、跨日工時或寫入。

## 完成與證據

純函式至少覆蓋嚴格型別、400年獨立weekday oracle／閏年、跨week/month/year與0000/0099/9999、TZ獨立、slot/日期/導航、原DTO與deepfreeze、不完整分頁／重複ID／版次／狀態／echo／排序、1000／1001、UTF-8恰2MiB／+1 byte及恰一次分組原reference。HTTP／整合以真自有server驗fresh scope／改派／inactive/membership／all rows／超限／日期边界及pure讀十一表／六trigger／版本／回執／計價快照／兩非空BLOB全部bytes與total_changes不變；登入／setup另列。

新browser驗兩頁入口、完整>25/>100班次、週／月與日期導航、draft撤銷、空／loading／503／timeout／錯2xx／413與同條件retry、loaded/pending完整context（user/logout/org/role/employee/hash/container stamp／DOM）清空關閉、真取消／晚回應不復活、server撤權與client fixtures分開、keyboard/label/focus／長原文／desktop與390。本輪不宣稱loading可換期，亦不以截圖取代DTO／SQL證據。

所有premium-ui.json配置指令各自fresh實際執行，保存每個child completion/log SHA及outer工具結束；原39個local里程碑、229來源基線與57來源ordered prefix、180原盤點／359題／4來源／12契約／9階段保持。source／evidence／副本SHA及獨立review封存；失敗／診斷／必要修稿原始保留，不宣稱first-pass、自動重試、CI、人工UAT、正式部署或原完整功能等價。
