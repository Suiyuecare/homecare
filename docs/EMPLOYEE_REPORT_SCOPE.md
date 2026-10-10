# 員工總表查詢／完整CSV／本機列印（0.18）

> 公開版本文件：記錄此功能版本的設計與驗收條件，並非目前公開副本已執行的驗收證明。私人盤點與 QA 產物未匯出；現行行為以 API.md 與原始碼為準，正式規則及部署仍須核定。

2026-10-08 凍結。employee-report-v0.18、，沿目前本機員工主檔製作獨立六欄報表。原員工頁僅追加獨立證據，不修改原status/parity/缺口。合成資料、memory/臨時SQLite及本機隨機埠，不用原平台、真實個資、正式付款申報訊息或部署。

## 查詢、權限與原資料

GET /api/employee-report、/api/employee-report/export、/api/employee-report.csv，分頁JSON／全數JSON／CSV共享唯一只讀builder。admin/supervisor/finance同org全部目前employees含inactive；caregiver只目前active、有效同org連結的ctx.employeeId，沒有班次仍可讀。沿原auth/scopedRows，不新增員工资格、班次、case或personnel父項join；未連結／wrongentity／foreign／inactive auth403。每次query/export/CSV/print重驗權；employeeId指定不可讀／非員工／不存在404（即使status/q令結果為空也先驗reference）。caregiver沒有報表導覽，admin/sup/finance既有/reports selector新增員工總表，原維護權與四角色原時薪可見性不改；新報表不輸出時薪。

僅 q/employeeId/status/page/pageSize，全部選填，初載與clear q=''、employeeId=''、status=''、page1，沒有日期或case欄／filter／lookup。export拒page/pageSize。未知／重複參數422，日期/caseId/extraFinance亦未知422；status僅active/inactive（啟用/停用），空未選。沿共用strict page正整數、pageSize1..100/預設25，不增加另一解析器。

q長度≤200 UTF-16 units，超過422不截斷、不trim、不改原input；空字串無限制。以toLowerCase和literal includes只搜employeeNo/name/role/qualification、合法statusLabel及regions合法字串或每個string[]元素，各自比對不跨欄或清單項拼接；不搜ID/version、電話/email/note/時薪/metadata、型別標記或異常巢狀資料。不推行政區同義或職務／資格認定。q echo原字串。所有filter組合AND，穩定字面排序employeeNo→name→employeeId（不locale推排序）。全部符合才count，不用本頁筆數當合計。

不讀createdAt/updatedAt做篩選或投影，沒有到職日／收案日或假系統日期。row version須正safe integer，status須可識別；候選資料非法整份409 REPORT_DATA_INVALID，不猜版次／啟用，ID/status/q先filter再檢候選，分頁前確認全部。name/employeeNo/role/qualification保存string原樣，missing/null/非string安全空文字，不serialize異常object。正常POST/PATCH必填／原型別／版本／唯一／CAS等寫入均不改。

## 九欄DTO、六欄顯示及區域型別

DTO {title:'員工總表',organization:{name},filters:{q,employeeId,status},selection:{employee,status},generatedAt:UTCISO,columns,rows,totals:{count},total,page,pageSize,note}。未選employee/status為「全部可讀員工」「全部狀態」，selected名稱只自目前scoped employees，缺name安全「名稱未取得」，無raw get擴權。page/export shape沿report-query，full page1/pageSize=total，空0/rows[]。q列印條件從filters.q顯示（空「未指定關鍵字」），不新增另一selection key。

row精確九keys：employeeId/version/employeeNo/name/role/status/statusLabel/qualification/regions。employeeId非空string、version正safe integer，其餘string，regions例外為下述canonical值。六columns順序：employeeNo「員工編號」、name「姓名」、role「職務」、statusLabel「員工狀態」、qualification「資格與證照」、regions「服務區域」（type:'employee-regions'）。ID/version/rawstatus只用確認JSON，不加印列。不可輸出phone/email/hourlyRateCents/note/orgId/credential/fileId/billingSnapshot或其他欄，qualification只是摘要、不推法定合格或積分。

新增無DOM/network/Node依賴的public/data/employee-regions.js為唯一區域型別pure owner；從history-fields抽出原regions normalizer，既有history import重用，原25純測保持。normalizeEmployeeRegions：missing/null/''→null；string原样；全string[]拷貝保留順序/重複/空項（不重新套匯入長度、不trim/split/sort/dedupe）；異常只frozen {invalid:true}，無來源資料，避免合法文字'[欄位格式無法判讀]' sentinel碰撞。isNormalizedEmployeeRegions只接受null/string/全string[]或精確單keyinvalid:true，不接受混合/額外secret keys。

formatEmployeeRegions供screen/PDF：null「未提供」、[]「空清單（0 項）」、string「保存文字：」+完整原文、清單「保存清單（N 項）」換行+逐項1.／2.，非空文字以角引號包住原文、空項「空字串」，invalid tag「[欄位格式無法判讀]」。保存的空項 vs實際文字'空字串'、異常 vs合法marker文字皆可辨；換行/空白完整，不猜資料。serializeEmployeeRegions供CSV：string為「保存文字：」+JSON.stringify(string)，array「保存清單（N 項）：」+JSON.stringify(array)（[]明示空清單）；null/invalid同安全提示。JSON literal可逆保存順序/重複/空項/引號/換行，type明示，不能用String(array)或join。所有formatter只處理canonical／先normalize，不將原非法object序列化。

shared toCsv增限定column.type=employee-regions的serialize variant；既有csvCell仍BOM/CRLF/引號/中文/公式注入防護，其他column無type沿原行為。CSV固定employee-report.csv/no-store/nosniff，完整allrows同fullbuilder。1000筆及完整JSON UTF-8含typedregions/metadata≤2,097,152 bytes；邊界相等成功、多1全413拒絕、不截斷。沒有薪資/工時/積分/資格/補助合計，totals僅count。

## 共用UI與列印

report-view仍唯一query/lookup/confirmation/分页/CSV/full/preview/fresh-print/abort controller。只新增date:false、caseFilter:false、search:{key:'q',label:'關鍵字',placeholder,maxLength:200}有限variants，預設舊三report完全相容；personFilter沿既有employeeId/employee改標籤員工／全部可讀員工。員工只lookup employees，不fetch cases。日期/case控制及header/validation/echo不存在；q native search有label/maxLength，filter-signature/clear/request/query/echo全部由同config衍生，不散落特例。

confirmReport仍精確filters/columns/rowkeys/count/page/allrows確認，新增employee-regions欄型及九rowkeys：typedregions用共用pure isNormalized判斷，rawstatus與label一致，selected employeeId逐row一致；q候選確認採相同可見業務搜尋規則／canonical值，不查hidden。columns可選type亦須吻合config，未預期type拒絕；舊column無type保持。employee-report.js只config/copy/domain validator，不持有async控制或額外API。

完整user/org/role/employeeId/hash/isCurrent/render guard：shared report identity補employeeId，沿既有observer/session_updated/AbortControllers。loaded/pending各hash/org/role/employee/render共十情境清空、關閉／abort，晚回應不顯示、不下載、不印；client identity fixture不冒稱真server撤權，四真session和真停用403／恢復另測。每次CSV/完整預覽fresh GET，每次「列印／另存 PDF」再GET及beforeprint單次授權；原生Ctrl/Cmd+P抑制舊快取與背景，失敗不印，Escape/焦點／取消沿openDetails。新輸出不修改任何11表、六trigger、版本、audit、idem、雙非空BLOB或核閱費薪快照。

頁名員工總表查詢／結果員工總表查詢結果／完整員工總表／員工總表列印預覽，query「查詢員工」。總計符合N員工／本頁P筆，clear全部/page1，空輸出禁用。note明示目前主檔、職務文字非權限、資格不認定、regions保存型別、非薪資出勤或正式表單。

沿DESIGN品牌/runtime tokens/native controls，不新ui/controller；只CSS employee-report-table geometry variant：screen min-width960px自身橫捲，1440/390無整頁溢出；print沿A4橫向/12mm/9pt/thead重複/完整pre-wrap，六欄寬8/14/12/8/28/30%=100，沿共享print授權和背景抑制。DESIGN只記此geometry不變tokens；CSS變更需新lint/strict audit且三舊報表PDF全頁回歸，不把舊baseline當本輪新驗證。

## 驗收、PDF及追溯

Node真四角色scopes/foreignID/active link/無班可讀、40筆25+15與full聯集、q大小寫/不trim/200邊界/AND/不匹配secret/不跨array、typedregions及未知marker/empty/literal/非法不洩漏、strict unknown/duplicate/page/export、invalid候選version/status409、1000/2MiB精確邊界+1、CSV正確含JSON literal/公式/BOM/CRLF、11表raw/count/total_changes與兩真BLOB位元組下載/六trigger零寫、核閱snapshot/fees/payroll及19舊report出口相容。原200測完整保留，新增必要integration及共用pure測。

Chromium真UI員工新增/編輯/停用恢復與v/audit，40結果分页/各filter/清除/empty，全CSVbytes=freshAPI；預覽後真PATCH、再次列印只含最新name/資格/區域、真停用caregiver403與回復，lookup只employees。錯誤MIME/empty/503/bodyAbortError/缺echo、取消下載/slowlate/route/kind/org/role/employee/render、原生print抑制、11表/兩BLOB/核閱不變、鍵盤label/1440/390全部必要gate。

同artifact修訂才envskip，舊三PDF不重製。新PDF核全文40員工marker各一次、最新資料、六欄表頭、每頁重複表頭/無裁切/最後一列/A4全部，render每頁PNG逐張view_image。數位QA不是正式文件或實體送印。依PDFskill取目前bundledPython/Poppler已有環境；無新增外部發送。

正式薪資／資格／出勤／輸版規則依然pending。

## 實作時確認的相容邊界

2026-10-08：SQLite讀取超出safe integer的INTEGER會在既有rows.all拋RangeError，早於candidate篩選。新員工builder局部readonly facade只對model既有精確records SELECT開啟BigInt讀取，安全integer版次回Number、超safe保留原BigInt，仍由原scopedRows授權／candidate query後版次guard拒409；不改model、auth、schema或其餘報表。非匹配異常員工與居服員scope外異常版次不誤報409。登入居服員自身的超safe匯入版次可能在既有auth get先500，此為登入驗權前的既有異常資料限制，沒有宣稱已修復；正常POST/PATCH不產生此版次，資料遷移須另核定。

選定員工的header名稱若非string、空字串或純空白，顯示「名稱未取得」以配合共用確認；row.name保存原字串不trim，非純空白header也保留原文。
