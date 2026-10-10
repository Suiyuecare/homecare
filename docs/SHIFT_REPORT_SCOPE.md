# 個案／員工班表查詢與本機列印（0.8）

> 公開版本文件：記錄此功能版本的設計與驗收條件，並非目前公開副本已執行的驗收證明。私人盤點與 QA 產物未匯出；現行行為以 API.md 與原始碼為準，正式規則及部署仍須核定。

獨立本機合成資料契約；讀取目前實際shifts，不新建排班、版本、audit、idempotency或報表工作佇列，不改核閱計價快照。未知正式版面、欄位/分組合計、簽章、資格/額度、支付及薪資規則不推定。保留原五類reports API行為；新增同一shifts報表的進階查詢與輸出，不把本機報表種類由5假加成6。

## API

GET /api/shift-report為分頁JSON；GET /api/shift-report/export為完整JSON（供列印重新取得）；GET /api/shift-report.csv為完整CSV。沿membership機構與scopedRows；admin/supervisor/finance可讀本機構，caregiver沿既有自己的shifts API範圍，不新增其reports導覽。先限制資料權限，再篩選/排序/分頁。選擇的caseId/employeeId必須存在於同機構目前可讀cases/employees集合；非法、他人或跨機構識別均404，不用空結果冒充驗權。

三端共同query：startDate/endDate必填、嚴格有效YYYY-MM-DD、含兩端、最多366日、結束不早於開始；caseId/employeeId選填（空字串視未選）、status選填/空白，值僅scheduled/completed/cancelled。JSON列表另接受page=1、pageSize=25（正整數、最多100）；export/CSV不接受page/pageSize。未知、重複query參數、非法日期/區間/status/分頁皆422。沒有月參數；UI以本月首末日預填日期。原/api/reports/:kind[.csv]仍沿原month契約。

結果按date、startTime、caseNo、employeeNo、shiftId穩定升冪，同日排序不靠建立時間。JSON：{title,organization:{name},filters:{startDate,endDate,caseId,employeeId,status},selection:{case,employee,status},generatedAt,columns,rows,totals:{count},total,page,pageSize,note}；filters中未選識別/status為空字串。selection為當前可讀名字或「全部可讀個案/全部可讀人員/全部狀態」，status為中文。title「班表明細」；generatedAt为UTC ISO，前端以zh-TW/Asia-Taipei顯示；note明示本機測試報表、目前主檔名稱、非正式申報。

每列固定業務投影：shiftId、version、date、caseNo、case、employeeNo、employee、startTime、endTime、services（目前同機構服務code/name × 排班數量的文字，缺名稱明示未取得）、status、statusLabel（已排班/已完成/已取消）、note。columns順序：date/日期、caseNo/案號、case/個案、employeeNo/員工編號、employee/服務人員、startTime/開始、endTime/結束、services/排班服務與數量、statusLabel/狀態、version/版次、note/交班備註。不含地址/電話/價格/時薪/billingSnapshot或未宣告欄位；不追加跨機構查名。

total與totals.count為全部符合班次數、非單頁筆數。列表rows只含當頁，page/pageSize為正規化分頁；export rows為全數、page=1/pageSize=total（空結果0），export/CSV若total>1000或完整JSON UTF-8>2 MiB回413 REPORT_TOO_LARGE，完整拒絕、不靜默截斷。列表仍可查頁。空結果200與空rows，CSV仍有欄頭與說明；UI空结果不開啟列印/CSV按鈕。CSV由同一完整投影與toCsv產生、UTF-8 BOM/CRLF/公式注入防護；Content-Type text/csv、attachment固定shift-report.csv、no-store/nosniff。每次export/CSV都重新驗權/查目前版本，列印不用畫面快取。

## 介面與共用元件

reports中心「排班明細」使用public/modules/shift-report.js，其他四類沿原介面。個案/服務人員native select、開始/結束日期native date、狀態native select、查詢/清除條件、25筆分頁、完整筆數摘要與服務明細。選項只取當前已授權主檔，名稱含編號；所有狀態可查，停用/結案主檔的歷史班次仍保留。修改任一篩選立即使舊結果不可下載/列印，明示重新查詢；查詢前後結果核對同一filter echo與counts。清除回本月、全部可讀及第1頁後重新查詢。輸入不存導覽URL/client storage；API query只傳必要識別與條件。

使用shared ui.js table/pagination/errorState/native controls/toast；列表與lookup各有loading/error/retry，先確定lookup成功才可查詢。latest request/AbortController及user/org/role/hash/isCurrent隔離；切類型/換頁/機構或舊回應不覆蓋、不下載、不列印。所有輸出動作捕捉當前已確認filters，讀取期間可取消，失敗保留條件可重試；下載以新的shared downloadCsv(path,{filename,signal,isCurrent})處理401/Content-Type/blob/15秒逾時、late guard與object URL回收，原報表downloadReport維持相容。

「列印預覽」用shared openDetails的printable variant：{title,load,wide:true,printable:true,isCurrent,loadingText}，立即開dialog、loading/error/retry、關閉/Escape取消與焦點恢復。load每次GET export並確認全數/filters回應，顯示機構、日期範圍/個案/人員/狀態、生成時間、完整班次與總數/說明。對話框「列印／另存 PDF」每次再load fresh export、更新內容並確認context後才window.print；忙碌不可重複，失敗或無結果不列印、不用舊快取。close可取消純讀。已載入的printable預覽在路徑/機構/條件失效時自動清空並關閉，瀏覽器原生列印前亦核對；一般history openDetails語意保持。

printable dialog由共用CSS擁有列印樣式：A4橫向named page、12mm邊界，僅列印目前preview的report內容，隱藏背景app/對話框toolbar/footer/toast/backdrop；解除screen max-height/overflow，semantic table重複thead、所有欄位換行、表格內無橫向裁切，可跨多頁，文字非圖片。非列印時延續共享wide dialog與手機表格自身橫捲，操作保持可見。UI只提供瀏覽器列印/另存PDF，不建立正式文件、簽章或送印工作。

## 驗收

Node：篩選組合/366界/invalid/duplicates/unknown/query、稳定排序與26+分頁/整體count、全數export=分頁聯集/CSV同來源、1000及2MiB邊界完整拒絕、公式/引號/換行/中文、四角色與跨機構識別/改派後重驗權、無價格/個資非白名單、零DB total_changes/audit/version/idem/完整資料/billing變動、五舊report相容。

真Chromium：真資料關聯/服務/狀態篩選與清除、25+分頁、改條件立即撤銷輸出、CSV下載bytes同fresh API、預覽及每次print前真更新班次/改派重新取得、列印503/CSV503/late close/context/type/route不輸出、empty/errors/keyboard/focus/1440/390與所有角色。Playwright只攔截window.print確認called-after-fresh而不送實體印表機；另外用page.pdf生成合成多頁驗證PDF，文字核對全部班次及重複欄頭、無背景UI/裁切/方框/空頁，渲染所有頁view_image。不把PDF測試或本機列印當成原正式表單等價或正式上線。所有必要驗證後才標local slice完成；保留0.7里程碑快照並新增0.8快照。
