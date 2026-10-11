# 個案總表查詢與完整本機輸出（0.10）

本輪依RM-04與現有cases製作獨立本機報表，原REPORT-d934fea8697c「個案總表」保持partial/unverified。原收案/結案/停復案日期、完整正式欄位、分組與版面未核對；不宣稱原報表已匹配。使用合成資料，不接原平台，不碰正式申報或支付。舊五類reports端點保持相容，localReportKinds仍5；cases同類改用進階介面。

## 資料與日期

只讀目前scopedRows('cases')。admin/supervisor/finance為當前同機構個案；caregiver沿目前自己所有shifts的caseId集合，包含已完成/取消班，不另加日期或狀態授權限制；沒有報表導覽。每次查詢、CSV與列印重新驗權。所有讀取不得寫入任何資料表、版本、稽核或冪等紀錄；其他主檔與既有billingSnapshot不變。

建立日期明確指records.createdAt換算Asia/Taipei的YYYY-MM-DD，欄名「系統建立日期（臺北）」，不是收案日。篩選startDate/endDate依此日期含兩端最多366日；預設本月。createdAt/updatedAt保留保存ISO文字，更新時間不當成狀態變更日期。timestamp必須為有效YYYY-MM-DDTHH:mm:ss[.1至3位毫秒]Z或±HH:mm，日期與時分秒合法、Date.parse有限；不接受無時區字串或日期自動正規化。createdAt無法換算則REPORT_DATA_INVALID 409，不猜今天、不靜默排除：先case/status/supervisor篩選，再檢查所有候選createdAt後按建立日篩選；符合日期紀錄的updatedAt亦須合法，分頁前確認全部，任何非法整份拒絕。未知/空CMS或名稱不做臨床推論。

督導名稱只來自scopedRows('employees')，不使用raw get查名擴權。督導選項及有效supervisorId集合為「全部目前可讀cases的非空supervisorId」與「目前可讀employees」交集，先授權再篩選，不受查詢期間/狀態影響。已指派但停用或職務文字不同的員工保留，不猜資格；未指派的員工ID亦404。未指派顯示「尚未指定」；已指派但名稱不在可讀主檔顯示「主責督導名稱未取得」、編號留空，不洩露識別或跨範圍查名。未選督導表示所有可讀個案，包括未指派或名稱不可取得。

## API與投影

新增GET /api/case-report（分頁JSON）、GET /api/case-report/export（全數JSON）、GET /api/case-report.csv（全數CSV），共用唯讀builder。startDate/endDate必填，caseId/supervisorId/status選填空視未選；status僅active/paused/closed（服務中/暫停/結案）。不接受employeeId。分頁page=1/pageSize=25、最大100；全數拒絕page/pageSize。沿共用report-query helper以可配置personKey/referenceKey保留班表/服務預設employeeId，未知/重複/非法422、不可讀caseId或督導交集以外404。

穩定排序createdDate→caseNo→caseId。DTO {title:'個案總表',organization:{name},filters:{startDate,endDate,caseId,supervisorId,status},selection:{case,supervisor,status},generatedAt:UTCISO,columns,rows,totals:{count},total,page,pageSize,note}。selection未選依次「全部可讀個案」「全部可讀主責督導」「全部狀態」。全數total/count為全部符合個案，不是本頁；page=1/pageSize=total，空結果0/rows[]。

row固定15keys：caseId/version/createdDate/caseNo/name/gender/cmsLevel/welfare/status/statusLabel/supervisorNo/supervisor/createdAt/updatedAt/note。version正整數，其餘string；CMS保存number轉文字、空/null/未填為空，已有文字原樣顯示，不計分或推定資格。name/caseNo/gender/welfare/note按目前保存文字；不取得或合併contacts、附件或計畫，不輸出電話、地址、生日、聯絡人、主要照顧者、費率或計價快照。主責督導名稱/編號來自目前可讀主檔，明示不是歷史姓名。

12欄固定順序：createdDate「系統建立日期（臺北）」、caseNo「案號」、name「個案」、gender「性別」、cmsLevel「CMS 等級」、welfare「福利身分別」、statusLabel「個案狀態」、supervisorNo「督導編號」、supervisor「主責督導」、version「版次」、updatedAt「系統更新時間」、note「個案備註」。createdAt保留於JSON供日期確認，不另印重複的原始建立時間。note須明示目前主檔、臺北系統建立日非收案日、更新時間保存時區文字、不推定CMS/資格及正式表單未核對。

沿assertReportExportLimit最多1000筆且完整JSON UTF-8含全部metadata不超過2,097,152 bytes；精確邊界成功，多1筆/byte 413 REPORT_TOO_LARGE整份拒絕，不截斷。CSV使用同全數builder/toCsv（BOM/CRLF/引號/中文/換行/公式防護），固定case-report.csv、no-store/nosniff。五類legacy API、shift/service三端、核閱歷史計價不變。

## 共用介面

report-view.js為唯一query/lookup/echo/paging/full/CSV/preview/cancel/late guard controller，有限config.personFilter={key,selectionKey,label,emptyLabel,options(cases,employees)}及config.date={rowKey,startLabel,endLabel,rangeLabel}；預設保持0.8/0.9 employeeId/employee/服務人員/全部可讀人員、date及原日期標籤。所有5filter keys/default/signature/query/echo/lookup/header由同一設定衍生，不複製async流程。case-report.js只domain config、15key/12col、建立日與timestamp額外確認及文案；完整白名單、逐row建立日由createdAt轉臺北吻合、echo與全數count確認。config.options只處理已授權lookup，不能另呼叫API。三類report繼續共享downloadCsv/openDetails/print CSS。

報表中心原「個案清冊」選項保持，cases新增advanced；fees/payroll保留原月份介面。頁區域/標題「個案總表查詢」、結果「個案總表查詢結果」、預覽「個案總表列印預覽」、全數「完整個案總表」。日期控制項「建立日期起」「建立日期迄」，主責人欄「主責督導」，狀態「個案狀態」，查詢「查詢個案」；其他清除/CSV/預覽/取消沿既有元件。摘要「符合條件共 N 個案；本頁 P 筆。」；全數「符合條件共 N 個案；以下為完整資料。」。清除回本月/全部/page1，空結果輸出停用。

所有條件留記憶體，不進URL/storage；lookup失敗禁查、loading/error/retry、修改失效、user/org/role/hash/isCurrent+AbortControllers沿既有guards；每次CSV/預覽fresh全數、每次列印再fresh，失敗不印快取。beforeprint僅放行fresh load成功後同步window.print的單次授權；原生Ctrl/Cmd+P即使預覽已載入也抑制全部介面直到afterprint，保留有效預覽並提示使用畫面列印按鈕，失效預覽仍清空關閉；晚回應不顯示/下載/列印。

CSS .case-report-table螢幕自身橫捲，12欄print權重依序10/6/9/4/4/7/7/7/9/4/13/20%，合計100。沿A4橫向named page、12mm、9pt、重複thead、完整文字換行及全數多頁，只印預覽，無背景/裁切；1440/390控制項具label、沒有整頁溢出。

## 驗證門檻

Node：40跨月cases/25+15與全數聯集、status/督導/case交集、未指派/停用/role改字/缺主檔、四角色/跨org/目前own shift改派立即縮scope；UTC15:59:59.999/16:00與月底16:00臺北跨日、合法offset/非法createdAt/updatedAt整份拒絕、保留建立日非birthday/status日期、白名單/CMS文字/CSV注入、精確1000/2MiB邊界+1拒絕。真case建立/編輯/暫停/恢復/結案與版本/稽核、預覽後真更新version及fresh內容；全10表rawState與total_changes唯讀不變，核閱快照及舊5+shift/service API相容。

真Chromium：40cases/25+15、所有filter/清除/空結果/count、CSV bytes=freshAPI、預覽後真case PATCH升版與下次列印fresh；錯誤MIME/empty/503/AbortError、缺確認、lookup錯誤、slow/cancel/Escape/focus/類型/機構/hash/靜默filterbeforeprint、四角色/標籤/鍵盤/1440/390。新單一合成多頁QA PDF取自fresh按鈕window.print同步beforeprint已放行的實際DOM/CSS snapshot（QA新頁停用JS、無產品授權旁路），第一次page.pdf前marker成功1次，後續同檔修訂envskip；全文40markers各1、最新版本/臺北日期/CMS與備註/每頁欄頭/A4/邊界，render全部頁並逐張view_image。root獨立全Node及7套一般browser，協作重跑shift14/service17；新case18類及舊PDF回歸也逐頁view；必要驗證全過才0.10獨立implemented_verified。原84/52/28/16源目錄/status/parity/源hash/9階段/0original completed保留；0.7/0.8/0.9 immutable不可覆寫，新0.10另存。
