# 服務紀錄明細查詢與本機輸出（0.9）

> 公開版本文件：記錄此功能版本的設計與驗收條件，並非目前公開副本已執行的驗收證明。私人盤點與 QA 產物未匯出；現行行為以 API.md 與原始碼為準，正式規則及部署仍須核定。

獨立合成資料本機契約。本輪只讀目前service-records、目前可讀主檔，不新增業務、audit、versions、idempotency或報表工作。不重算/變更核閱計價快照；金額/支付/薪資/評分及原介接規則待核定。保留5個舊report與0.8三個shift-report端點語意，localReportKinds仍5。

## API

GET /api/service-report為分頁JSON；GET /api/service-report/export與GET /api/service-report.csv為全數JSON/CSV。三端共用readServiceReport唯讀builder，query/date/pagination/識別與完整輸出上限由新report-query.mjs抽取0.8純helper；shift-report改用相同helper但回應/錯誤契約保持。auth membership/X-Org-Id先檢查，再scopedRows('service-records')，admin/supervisor/finance讀本機構，caregiver沿既有service-records employeeId為自己的範圍，不增加其reports導覽。個案/員工filters僅目前scopedRows('cases'/'employees')可讀識別；非法/不存在/他人/跨機構404，不用空結果冒充驗權。

query與0.8相同：startDate/endDate必填strict YYYY-MM-DD、含兩端最多366日、不得倒置；caseId/employeeId/status選填，空字串未選。status只接受draft/submitted/approved/returned；中文「草稿/待核閱/已核准/退回修改」。列表另page=1/pageSize=25，正safe integer、pageSize≤100；全數端拒絕page/pageSize。未知/重複query、非法日期/範圍/status/page422。原/api/reports/services[.csv]?month行為保持。

按date、實際開始timeMinute(actualStart,date)數值、caseNo、employeeNo、recordId穩定升冪；HH:mm與ISO混用時依文字HH:mm所代表的實際開始分鐘先後，DTO仍保留原actualStart文字。DTO {title:'服務紀錄明細',organization:{name},filters:{startDate,endDate,caseId,employeeId,status},selection:{case,employee,status},generatedAt:UTCISO,columns,rows,totals:{count,serviceMinutes},total,page,pageSize,note}。selection未選為「全部可讀個案/全部可讀人員/全部狀態」，有選為目前名稱/中文status。total及totals.count均為全部符合紀錄數，totals.serviceMinutes為全部符合紀錄實際分鐘總和（包含所選草稿/待核閱/退回/核准，不稱核准工時/可付款/核銷）；不從頁面筆數或排班/service-item預設minutes計算，不使用未核定加成/請假/薪資公式。

每列固定白名單：recordId、version、date、caseNo、case、employeeNo、employee、actualStart、actualEnd、serviceMinutes、services、status、statusLabel、note、reviewNote。serviceMinutes沿現有timeMinute(actualEnd,date)-timeMinute(actualStart,date)既有整數有效interval（HH:mm或日期前綴吻合的ISO datetime；沿既有文字HH:mm語意忽略秒/時差，不改用Date.parse相減；DTO保留actualStart/actualEnd原保存文字）；缺失/非法的歷史匯入時間不可猜0，回409 REPORT_DATA_INVALID（不含個資的說明，無部分rows），待核對資料；列表與全數同規則。services為目前同機構可讀service code/name × 實際紀錄數量的文字（缺名「未取得服務名稱」）；不拿排班數量或核閱價格重建服務名稱。不跨機構查名；case/employee缺失顯「未取得個案名稱/未取得服務人員名稱」，編號空字串。不包含地址/電話/價格/金額/時薪/billingSnapshot/未宣告欄位。

columns順序13欄：date日期、caseNo案號、case個案、employeeNo員工編號、employee服務人員、actualStart實際開始、actualEnd實際結束、serviceMinutes實際分鐘、services實際服務與數量、statusLabel核閱狀態、version版次、note服務備註、reviewNote核閱意見。note明示本機測試/主檔目前名稱/實際紀錄數量/分鐘包含所選狀態/非正式申報與薪資依據。

列表只傳當頁。全數rows全部符合、page=1/pageSize=total，空結果pageSize0、total/兩totals0；全數超過1000筆或完整JSON UTF-8>2 MiB回413 REPORT_TOO_LARGE，全部拒絕不截斷，列表仍可分頁。CSV沿toCsv同投影、BOM/CRLF/公式防護；Content-Type text/csv、固定service-report.csv、attachment/no-store/nosniff。每次都重新驗權與讀取目前版本，無寫入；舊fees/payroll仍原核閱billingSnapshot，名稱/單價/時薪後改不能影響快照。

## 共用介面

報表中心「服務紀錄」選項維持原label，services改advanced module，cases/fees/payroll三類沿原months/legacyUI。新public/modules/report-view.js canonical controller抽取0.8既有lookup/filter/validation/echo/pagination/full-export/CSV/preview/cancel/lateguard；shift-report.js為薄config wrapper保留0.8全部visible labels與columns/DTO；service-report.js為新config wrapper。共用filter keys/date/month default/native select/UI table/pagination/errorState/toast/openDetails/downloadCsv，不複製輸出流程、timeout或guards。

服務 module 標題「服務紀錄明細查詢」、區域「服務紀錄明細查詢」、結果「服務紀錄查詢結果」、預覽「服務紀錄明細列印預覽」、完整區域「完整服務紀錄明細」。status欄「核閱狀態」，查詢「查詢紀錄」；其餘「開始日期/結束日期/個案/服務人員/清除條件/下載 CSV/列印預覽/取消下載」與0.8相同。摘要「符合條件共 N 筆紀錄；實際分鐘合計 M 分鐘；本頁 P 筆。」；全數「符合條件共 N 筆紀錄；實際分鐘合計 M 分鐘；以下為完整資料。」；空結果明示無符合條件紀錄、輸出停用。總分鐘確為全數、分頁也相同；新DTO確認要求total、rows、echo、每row分鐘與totals一致，full時Σrow.serviceMinutes==totals.serviceMinutes，列表row分鐘合計≤整體分鐘。非法/過時回應不確認成功。

修改任一filter即失效舊confirmed並禁輸出，清除回本月/全部/page1並query。列表/lookup loading/errors/retry，lookup完整授權才可查；user/org/role/hash/isCurrent+AbortControllers，切type/route/org/role與取消不顯示、下載或列印晚回應。敏感條件不進URL/client storage。全數CSV前fresh export確認再下載fresh CSV，預覽每次load全數；shared printable每次列印再fresh，失敗/空結果不印快取，已載入preview失效自動清空關閉。原生beforeprint若確認條件失效、載入中或錯誤，print-suppressed隱藏全部body子項直到afterprint清除，避免關閉dialog後回退印背景；恢復後可重查與列印。財務與督導可讀此報表，caregiver無導覽但API自己的service-records可讀。

CSS仍shared styles owner，generic report-query/report-table輔助共用螢幕/print語意；shift既有class可保留兼容，service-report-table 13欄專屬權重。延續A4橫向named page12mm、9pt文字、重複thead、長服務/備註/核閱意見換行、全數多頁、無背景UI/裁切，390px只表格自身捲動、操作可見。產品只瀏覽器列印/另存PDF，QA PDF中間檔不當正式表單。

## 必要驗證

Node：全部4status/組合/含兩端/366日/strictquery/pagination/排序/全數count和分鐘；>25行聯集=full，CSV同來源；精確1000+2MiB邊界和一超完整拒絕；所有角色/跨org/invalidrefs及目前權限重新核對；actual分鐘與排班/預設時間不相同、實際quantity不繼承plan/shift；409非法legacytime無部分輸出；白名單/CSV公式/引號/中文/換行；草稿→提交→退回→改送→核准真流程升版、後改主檔價格/名稱/時薪但快照不變，舊5reports及0.8三端相容，完整9+表及total_changes唯讀不變。

真Chromium：合成40+紀錄25+頁、狀態/個案/員工/日期清除/零結果/全數分鐘、CSV實際下載bytes比freshAPI、preview後真退回/重送/核閱升版下次列印fresh；缺確認/503/empty/MIME錯/AbortError/slow取消/已載入失效不印/下載，四角色/機構/語意label/nativekeyboard/focus/1440/390。新增單一合成多頁QA PDF，第一次page.pdf前成功marker一次，後續同檔修訂不再marker；文字核對所有row markers/最新版本/分鐘/每頁欄頭/A4邊界、render所有頁並view_image，無背景、方框、裁切或空頁。root獨立跑全Node與所有既有8browser，尤其0.8shift全13 gate/PDF/readonly保持。全部必要通過才0.9 local implemented_verified；保留0.7/0.8immutable快照並新存0.9。
