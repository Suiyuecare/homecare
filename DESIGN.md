---
version: alpha
name: "歲悅居家照顧"
description: "督導的服務調度台與居服員的每日工作簿"
colors:
  primary: "#EA880C"
  navigation: "#B45309"
  background: "#F7F3EC"
  surface: "#FFFFFF"
  text: "#2F2A26"
  muted: "#6E6259"
  accent: "#FFF4E4"
  border: "#F1CFA8"
  danger: "#8A1010"
  warning: "#7A4500"
typography:
  display:
    fontFamily: "'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', system-ui, sans-serif"
  sans:
    fontFamily: "'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', system-ui, sans-serif"
  mono:
    fontFamily: "ui-monospace, monospace"
rounded:
  DEFAULT: "0.5rem"
  sm: "0.25rem"
  lg: "0.75rem"
spacing:
  section-gap: "1.5rem"
  page-max: "90rem"
components:
  button:
    minHeight: "2.75rem"
  input:
    minHeight: "2.75rem"
  dialog:
    maxWidth: "42rem"
---

## Overview

參考督導工作簿與每日服務交接板。這是臺灣居家長照機構作業工具，產品畫面以工作清單、個案身分與下一步動作為中心。zh-TW、Asia/Taipei；桌機調度、手機現場紀錄。

唯一識別設計是個案頁的「服務接力」：計畫、排班、紀錄、核對以實際狀態呈現。其餘介面保持安定、可閱讀，不使用行銷大圖與無用途動畫。

DESIGN.md定義視覺意圖；public/styles.css的:root是唯一runtime token owner，每項顏色一對一映射--primary/--navigation/--background/--surface/--text/--muted/--accent/--border/--danger/--warning。所有模組共用ui.js及styles.css。

## Colors

沿 APM 的歲悅橘色品牌、暖白資料面板與米白背景。狀態成功綠色、警示棕色與錯誤紅色必須附文字，不能只靠顏色。小字按鈕採深墨色文字；目前位置以底色、字重與 aria-current 同時標示。

## Typography

標題與正文都沿 APM 的臺灣黑體字族。正文16px、表格14px，正文行高1.65、表格1.65；資料數字採tabular-nums。所有資源本機可用，不依賴遠端字型。

## Layout

桌機300px側欄，主內容自然捲動。1024px以下側欄以共用 modal owner 開啟可關閉導覽；表格有自己的橫向捲動區域。手機表單單欄、主要按鈕至少44px高。頁面不鎖定100vh高度。

## Elevation & Depth

以邊框及表面色分層；modal 與重要面板沿 APM 的低強度暖色陰影。

## Shapes

輸入與按鈕8px圓角、資料面板12px，狀態標籤使用膠囊外形、圓點及文字。保留表格欄線與組別標題。

## Components

首頁以真實今日服務與下一步工作優先，四項原工作摘要置於下方。今日服務沿單一語義清單，桌機四欄、手機以時段和個案為主的卡片列。四組角色導覽使用同一套本機原生 SVG，decorative icon 不參與 accessible name。個案頁的區塊捷徑只移動焦點與頁內位置，不新增查詢或業務狀態。shared panel/table/form 使用相同留白、44px 動作及文字狀態；手機輸入至少16px。

派生 tokens --line-subtle、--surface-mist、--shadow-surface 只補足安定表面層次，APM 既有品牌／語義值、logo 與外框固定尺寸保持。

ui.js為button/form/table/dialog/toast/search唯一owner。hover以暖色表面與深色邊框回饋、focus-visible清楚外框，disabled帶原因。忙碌按鈕維持尺寸。native select與date/time採OS popup，接受平台外觀，產品文字與數字仍zh-TW。

dialog使用原生dialog.showModal，具有標題、取消、Escape與焦點回復。表單noValidate，錯誤以文字關聯欄位；textarea resize:none。mutations使用伺服器成功後回饋，不使用樂觀成功。

全域scrollbar以--surface為track、--border為thumb、hover以--muted回饋，支援forced-colors。動作只用button，導覽只用a。減少動態偏好關閉過場。

報表列印沿同一semantic table，A4橫向12mm邊界、9pt內容字、重複欄頭與長文字換行。printable dialog只印報表內容，黑白紙本使用white/black與#777欄線作明確列印變體；螢幕延續既有token、wide dialog及表格自身捲動，不另造元件。

員工總表是六欄報表變體：螢幕表格最小960px並沿原表格內捲動；A4橫向列印欄寬依員編／姓名／職務／狀態／資格／區域為8／14／12／8／28／30%。區域保存型別與多行內容完整呈現；這些尺寸只適用員工報表，不改runtime token或其餘三種報表幾何。

請假紀錄總表是八欄報表變體：螢幕表格最小1100px並沿原表格內捲動；A4橫向列印欄寬依請假日期／員編／目前姓名／開始時間／結束時間／假別／狀態／原因為10／10／12／13／13／10／8／24%。保存的ISO時段與長原因完整換行；這些尺寸只適用請假報表，不改runtime token或其他報表幾何。

## Do's and Don'ts

教育訓練紀錄總表是九欄報表變體：螢幕表格最小1200px、日期不折行並沿表格內捲動；A4橫向12mm／9pt，訓練日期／員編／目前姓名／課程／類別／辦訓單位／保存分鐘／狀態／備註欄寬9／7／10／16／7／12／7／7／25%。長課程、辦訓單位與備註完整換行，只本報表使用此幾何，runtime token及其他報表保持。

- 每筆合成資料明示測試用途；正式核銷及薪資規則另行核定。
- 相同儲存、取消、空資料、衝突回復使用同一共同元件。
- 不以隱藏按鈕取代伺服器授權，不把待核閱稱為已核閱。

Leave report screen geometry: first-column saved date stays on one line at desktop and 390px, inside the existing horizontal table scroll. Print widths and tokens remain unchanged.

員工證照紀錄總表為十欄變體：1400px表內橫捲，兩日期不折行；A4橫向12mm/9pt，員編／姓名／證照／證號／單位／核發／到期／紀錄狀態／效期狀態／備註寬7/10/13/10/11/9/9/7/8/16%。核發區間及截至日期分開回顯，長備註完整換行；只此報表geometry，tokens及其他報表保持。

## 內部公告版本歷程（0.24，本機已驗證）

依docs/ANNOUNCEMENT_HISTORY_SCOPE.md，四欄保存文字／精確上一版／實際操作者，沿既有四角色公告入口。caregiver的current及每個raw/compare版本都要求published且all/caregiver；缺口不跳版。已知對象與狀態標示保存碼，未知文字安全保留，非文字匯入只顯示tag。重用admin/listPage、history/openDetails及完整context guard，無新CSS/token/controller/外部訊息。331測試、24套334聚合瀏覽器與85最終圖通過；原公告仍related_only，不宣稱等價。

## 公告安全編輯（0.25，本機已驗證）

依 docs/ANNOUNCEMENT_EDIT_SAFETY_SCOPE.md，編輯僅送變更的四個業務欄；未修改原文、未知／空閱讀對象與無法無損預填值保留。原生保存方式可明確取代，閱讀對象可明確清空。新增、編輯及撤回沿共用表單／確認視窗 opt-in 完整 context guard，只有 id/org/version/四欄 own-presence 與保存投影吻合才顯示成功；未知結果保留輸入，新增同 payload 重試沿同一冪等鍵。原後端角色、任意 audience、必填／狀態、CAS、歷程及價格快照保持；取消請求不代表伺服器回滾。沒有新 CSS/token/通知／已讀。351測試、25套350聚合瀏覽器與63最終圖通過；原公告仍 partial/unverified。

## 服務項目安全編輯（0.26，本機已驗證）

沿 docs/SERVICE_ITEM_EDIT_SAFETY_SCOPE.md，八欄未改省略，異常保存資料明確保持／取代，日期及備註可清空。價格以文字控制項與整數分精確往返，列表沿既有精確 formatter；共用表單僅允許 numeric/decimal inputMode descriptor。新增、編輯及啟停沿共用完整 context guard，保存成功須確認八欄及身份版本。19後端與既有角色、CAS、冪等、分鐘／有效日期／代碼唯一及核閱快照不變；保持仍按原 merged 驗證可能422。375測試、26套366聚合瀏覽器與91最終圖驗證通過；原完整功能仍 partial/unverified。

## 員工主檔安全編輯（0.27，本機已驗證）

沿 docs/EMPLOYEE_EDIT_SAFETY_SCOPE.md，十欄未改省略，原服務區域清單整欄保持，明確改存文字／清空才變更。電子郵件沿原API文字規則，職務不改登入角色；時薪BigInt精確轉分及列表一分完整顯示。新增／編輯／啟停沿共用context、CAS及有效十欄保存確認；停用連結居服員沿原auth下一請求403，舊班次與核閱薪資快照保留。後端與ui/styles/token不變。400測試、27套382聚合瀏覽器及84最終圖通過；原完整功能仍 partial/unverified。

## 請假安全編輯（0.28，本機已驗證）

沿既有canonical元件與樣式，未新增CSS/token或widget。桌機雙欄與390px單欄、固定操作區、明確的keep／replace／clear原生選單、錯誤／busy／dirty與長原因textarea自有捲動均以合成瀏覽器逐圖檢視；保留資料與提交payload驗證分開，不以截圖代替資料確認。 本輪423 Node測試、28套398聚合瀏覽器gates與61fresh畫面通過；另4張封存參照圖分列。詳 docs/LEAVE_EDIT_SAFETY_SCOPE.md 與本輪 verification。

## 證照安全編輯（0.29，本機已驗證）

沿既有canonical元件、原生select、桌機雙欄／390px單欄與長備註textarea內捲，不增CSS/token/widget。型別保持、資料確認及效期提示各自可辨；訓練原流程不改。 本輪446 Node／29套414聚合gates／70fresh畫面，0封存參照另列。詳 docs/CERTIFICATION_EDIT_SAFETY_SCOPE.md 與本輪verification。

## 訓練安全編輯（0.30，本機已驗證）

沿canonical元件與原生controls、1440/390排版，不新增CSS/token/widget。訓練列表僅safe integer分鐘及own已知分類的必要投影防護；證照編輯／附件原流程保持。 全Node470（461頂層＋9巢狀；319 HTTP／151純）、123 source覆蓋；29既有browser414＋新16，共30套430聚合gates。 76fresh圖、0封存參照另列。詳 docs/TRAINING_EDIT_SAFETY_SCOPE.md。

## 個案安全編輯（0.31，本機已驗證）

canonical元件與CSS/tokens保持；兩個guarded document capture busy Escape防護及close移除精確反向可還原原UI，原生controls及1440/390另以最終圖驗證；個案自身必要safe文字／日期／CMS／own狀態投影，不泛改其他實體。 全Node494（485頂層＋9巢狀；331 HTTP／163純）、127 source覆蓋；30既有browser430＋新16，共31套446聚合gates。 100fresh圖、0封存參照另列。詳 docs/CASE_EDIT_SAFETY_SCOPE.md。

## 照顧計畫安全編輯（0.32，本機已驗證）

canonical元件及CSS/tokens保持；僅services的preserveWhenDisabled opt-in同步原生disabled/aria-disabled及validation。計畫自身安全投影，不泛改其他模組；桌機與390px圖逐張agent檢視，無新PDF。 全Node 521（512頂層＋9巢狀；344 HTTP／177純），131 JavaScript來源覆蓋；31既有browser 446＋新16，共32套462聚合驗收。 98fresh圖、0封存參照另列。詳 docs/CARE_PLAN_EDIT_SAFETY_SCOPE.md。

## 單班排程安全編輯（0.33，本機已驗證）

共享ui.js、CSS、tokens原bytes，沒有新widget/controller。單班列表safe保存投影只在自身；不泛改timeRange／serviceSummary。桌機與390px逐張agent檢視，數量keep實際disabled且aria同步；沒有新PDF或marker。 全Node 551（542頂層＋9巢狀；360 HTTP／191純），135 JavaScript來源覆蓋；32既有browser 462＋新16，共33套478聚合驗收。 80fresh圖、0封存參照另列。詳 docs/SHIFT_EDIT_SAFETY_SCOPE.md。


## 月份清單日期型別安全（0.34，本機已驗證）

依 docs/MONTH_FILTER_SAFETY_SCOPE.md，泛用GET清單先沿date||validFrom||空文字選值，只有字串套原startsWith月份前綴。truthy object／array／number／boolean不轉字串、不fallback；falsey原選值及字串前綴相容，沒有新增有效日期驗證或修改資料。機構／角色、q／status／date與分頁順序保持。

全Node561（552頂層＋9巢狀；370 HTTP／191純）、137 JavaScript來源；33舊browser478＋新8＝34套486聚合驗收。11新圖＋6張fresh sibling＝17張逐圖檢視，0封存參照另列；root重疊subset不重加。

原HTTP10／full561及32舊browser462以原actual0及完全相同的runtime／全部.test／33legacy scripts納入。原舊browser batch actual1：shift-edit-safety於120秒逾時，10／16 gates結果保留不驗收；不改原稿或斷言，以300秒界限在final branch獨立fresh執行完整16 gates actual0，再組合33舊套478，原batch與失敗子process仍保留且accepted:false。新browser第一次因財務個案頁heading selector錯誤actual1；heading校正後第二次7／8 gates及11PNG，SQL null-prototype版本列被structuredClone轉為普通物件，strict prototype斷言失敗actual1。兩次rawprocess與失敗結果都保留不驗收；只修新驗收稿heading及版本基線保留原SQL列的兩片段，逐片反向SHA驗回原稿，在final-qa fresh source137／browser8 actual0通過。不宣稱first-pass、同一次batch全33初次通過或全199final來源重新跑全部QA。

只修泛用GET清單month選值為非字串時的500；legacy reports.mjs非空month仍有同類500，未修。actual4310未restart／reload，不能宣稱既有backend已載入本修復；隔離合成環境提供行為證據。服務紀錄安全編輯順延0.35且not_started／契約未凍結。

本輪runtime只改伺服器一行generic month選值型別守門；18個其他後端及全public、共享控制項、字體、CSS、tokens與表格／卡片幾何保持0.33原bytes。新圖逐張檢視，沒有新widget、controller或PDF。


## 服務紀錄安全編輯（0.35，本機已驗證）

依 docs/SERVICE_RECORD_EDIT_SAFETY_SCOPE.md。兩填寫及兩核閱入口沿canonical openForm。新增五控制項、九payload欄不送reviewNote；編輯十保存欄只送改變欄，own-presence／JSON私有保持，services一律保持／明確整欄取代，ISO／0000／缺失／null／typed／CR不猜值。note可明確清空，returned預設returned且只有明確submitted才重送；動作「修正退回紀錄」。2xx未知、空JSON、錯誤id/org/version或任何欄不符不能成功關閉；review確認status/reviewNote及其餘八欄，billing由server交易產生、不從UI推算。

全Node588（579頂層＋9巢狀；382 HTTP／206純），141 JavaScript來源；34舊browser486＋新16＝35套502聚合驗收。35新UI圖＋6張fresh sibling＝41張逐圖view_image；0封存參照，root subset 4重疊圖不重加。

新browser 14段十一表唯讀保持；49批合成setup／fixture／login及業務必要寫精確對帳556 changes，6不可變trigger、已核閱billingSnapshot及四個非空BLOB下載保持。50完整context失效與3真提交晚回應分列；Abort不是已提交交易回滾。72指定sealed034 PDF／pdf-*參照維持bytehash，無新PDF、marker或本輪歷史PDF人工重看。

初始full actual0的588結果只在runtime56、全部.test與其helpers消耗bytes exact時承接。新browser首次因作者假設A/B服務順序actual1；僅改兩個新稿斷言以實際控制項B/A順序確認。第二次因aria-busy使提交按鈕accessible name暫時隱藏，name locator等到API逾時後讀到null而actual1；只改一片段預先捕捉同一原生elementHandle，仍檢查busy及disabled。兩次process／raw JSON／PNG保留且accepted:false，修稿逐片反向SHA驗回；final-qa新browser16 actual0依相同runtime56、新稿及helpers exact承接。final-qa舊matrix actual1：service-report舊修正按鈕selector未更新；B批七套96 gates成功子process承接，失敗batch與child原始保留不驗收。只改唯一label並反向SHA驗回sealed034。legacy-corrected-qa被刻意中斷，C批六套82 gates子process實際close0已觀察，整批summary及outer completion未觀察、不驗收、不推定缺陷或整套逾時；employee-report與leave-report只有raw結果，child close未觀察，兩套原始診斷不承接。resumed-qa保持C的204來源，source141 actual0；D批另五套76 gates成功，announcement-history因真requestfailed的10秒等待逾時actual1，失敗batch及child/raw十個完成關卡保留且不驗收。獨立取消診斷immediate與hold兩模式皆pass、afterClose signal尚未aborted而最後aborted／AbortError；原失敗未重現，不宣稱檔案延遲或產品缺陷為已證明原因，診斷不作一般QA。只將同一真中止斷言移到close後、釋放延遲回應前，finally仍釋放並await handled；同一waiter位置、10秒限制、原abort/cancel斷言及其餘UI／11-table／focus斷言保持，不增加route.abort或產品修正；唯一片段反向SHA驗回sealed034。final-resumed-qa的E204僅announcement-history腳本不同於D，source141 actual0；E批十三套192 gates成功，certification-attachments在第十二段後真requestfailed的10秒等待逾時actual1，failed batch／child／raw保留不驗收，十二個已記錄關卡不是完整15關驗收；未執行的service-history與assessment-history不推定通過。獨立證照附件取消診斷兩模式皆通過，immediate模式afterClose已aborted、hold模式尚未aborted，最後兩模式皆aborted／AbortError且沒有晚下載；原失敗未重現，不能把同步競態或產品失敗當作已證明原因，診斷不作一般QA。只將同一真中止斷言放在close後、釋放slowFile前，finally仍釋放並await handled；waiter位置、10秒、原abort/cancel及零lateDownloads／focus／11-table斷言保持，不新增route.abort或產品改動，唯一片段反向SHA驗回sealed034。未執行的service-history另經靜態發現同一close→release→await真取消的順序，主動只改單一同步片段，waiter／10秒／原abort及其餘focus／11-table保持；沒有觀察本輪該suite失敗，不虛構failed child，相關診斷只作參照且非一般QA。其同步反向還原E，再反向原intent及label適配精確還原sealed034，完整12關在F fresh驗收仍必須通過。final-attachments-corrected-qa的F204僅certification-attachments及service-history兩腳本不同於E，fresh source141與完整串行三剩餘舊套40 gates actual0，承接B7／96、C6／82、D5／76、E13／192共31套446 gates成功子process，逐個驗證runtime／自身腳本／helpers消耗bytes exact，合成34舊套486；28舊稿exact、6必要適配。不得宣稱同一批34套全fresh、first-pass或全部204最終來源重跑full／newbrowser。文件八檔更新後的204hash另外封存，未在metadata後重跑all204 QA。

僅合成本機驗收；本輪actual4310未restart／reload／登入／probe／驗證或寫資料，既有程序是否載入本輪UI未驗。未執行CI、部署、人工UAT、原生OS popup幾何／鍵盤選值、正式工時／薪資／支付／定位／申報／評分／介接／外部訊息。原180功能全量對照未核定；RM-03仍partial。legacy reports非字串日期month500未修，0.36僅未凍結候選。先前certification附件偶發reopen原因未明，通過迴歸不證明修復。

只新增pure服務紀錄editor及operations既有入口整合；服務紀錄自身時間／services／文字typed投影，不執行未知HTML、不coerceJSON。全19backend、ui.js、styles.css、字體、tokens與其他報表投影保持；原生controls、桌機雙欄／390px單欄。


## 公告本人閱讀回執（0.40，本機已驗證）

依 docs/ANNOUNCEMENT_READ_RECEIPTS_SCOPE.md，沿唯一 listPage、openDetails、table、pagination、createForm、errorState 與 toast。openDetails 的 readAcknowledgement opt-in 擁有提交忙碌、錯誤重試、Escape、focus、Abort 及完整 context/render 失效；原 caller 的預設流程保持。閱讀全文沿原字串 pre-wrap，不執行原文中的 HTML。只有本人明確操作且精確目前版保存回應確認後才顯示成功；未知結果保留原文，人工重試同 payload／同鍵。管理者與督導以每頁25筆、精確正整數版次查詢實際保存的閱讀姓名、角色與時間，不推算應讀、未讀或完成率。CSS、fonts、tokens 與原生控制項保持；桌機／390px、鍵盤、表格自身捲動與錯誤路徑經本輪 fresh 瀏覽器驗證；詳本輪verification。僅本機合成切片完成，不等同正式簽收、CI、部署或人工UAT。


## 班表週／月日期檢視（0.41，本機核心已驗證）

依 docs/SHIFT_CALENDAR_SCOPE.md，沿唯一 common openDetails/createForm/button/table/errorState，無新視覺tokens或字型。桌機日期索引為週一至日semantic table：週7格／月42格、外期留空；button跳至同一完整每日表heading。390px隱藏索引，同一agenda依日單欄、十一欄表自身橫捲，原保存時間與長原文pre-wrap。typed原生text日期支援0000..9999，原生select選週／月與狀態。scope CSS只geometry，共用44px操作／focus／scrollbar保持。核心實際瀏覽器及圖片驗收通過；原生選單鍵盤選值仍待人工驗收。

0.41核心fresh驗證通過：日期文字欄真鍵盤輸入、Enter查詢、Tab／label焦點與日期索引同DOM跳日。兩份獨立原生選單探測僅記錄headless環境限制；原生select鍵盤選值、OS popup幾何、人工UAT及完整WCAG符合性仍未驗，不以selectOption或圖片代替。

## 班表個案／人員篩選（0.42，本機核心已驗證）

沿 docs/SHIFT_CALENDAR_PERSON_FILTERS_SCOPE.md，預設三欄與单次 export 保持；明確啟用後固定五欄。native select 沿唯一共用 createForm 與平台 popup，名稱／編號／狀態／精確 ID 顯示為完整文字，無新 CSS／token／字型。居服員本人欄 disabled，精確值仍保存；失效 ID option、共用 help 與提交 fields error 保留原值並說明。桌機1440與390px新13張圖片及15聚合 browser 關卡實際驗證通過；相关 sibling 17張另實際檢視。原生 select 鍵盤選值、OS popup 幾何、人工 UAT及完整 WCAG未驗，不以 selectOption 或圖片代替。

## 班表完整報表銜接（0.43，實作中）

依 docs/SHIFT_CALENDAR_REPORT_HANDOFF_SCOPE.md，已確認非空班表沿共同 outline button 開啟內層既有寬版報表，十一欄、表內捲動、列印樣式、文字及原 tokens 保持。沒有新字型、CSS、picker 或選項；五欄 primitive 條件留記憶體。CSV controls/status 沿共同 actions/error/toast，全部 data-no-print；原日曆保留，關閉回入口。尚待本輪完整整合、瀏覽器與視覺驗證，不宣稱完成。

## APM 品牌與統一入口（2026-10-10）

品牌資產 public/suiyue-logo-transparent.png 直接沿 APM 的透明原檔，SHA-256 7003462e156b3c32116fc76f6cb91e3b2eb999530942144a186948d110c97d6d；不生成另一套標誌。300px sidebar 品牌、user card、82px 桌機 topbar、64px 手機 header 與三入口＋更多的四格 bottom navigation 共用同一 navigation builder；mobile drawer 重用 ui.js openDetails，保持單一 sidebar DOM。Portal 登入與回模組頁流程見 docs/APM_CIS_SSO_SCOPE.md。介面與身份變更不提高原180項功能的完成狀態。

最新 APM 參照 commit 95dc85f16b1bdf7acd1c930d4c57e4c1c6ab8a14；right drawer 88vw/max360px，card shadow 0 2px 8px rgb(180 83 9 / 4%)。品牌文字使用既有 brand-strong #B45309，暖底對比4.83；原 #EA880C／暖底2.52不足大字3:1，故橘色維持品牌背景與圖案用途。主按鈕深墨文字／橘底對比5.42。

## 報表列印字型

螢幕沿 APM 的 Noto Sans TC 優先順序。報表列印在同一 styles.css 的 @media print 中優先 PingFang TC，再回退 Noto Sans TC／system-ui／sans-serif；保持黑體與原表格分页。此窄例外解決本機 Chromium 的 Noto PDF ToUnicode 將「長」抽取成「⻑」的文字層問題，未改保存字串、表格內容或 PDF 全文斷言。已驗證的字型可用性與文字對照限本機 Mac Chromium，不能宣稱所有 OS／字型版本相同。


## 個案暫停與結案追蹤（0.46，本機已驗證）

依 docs/CASE_STATUS_FOLLOWUPS_SCOPE.md，個案詳情的獨立 panel 延續聯絡人卡片雙欄／390px單欄及既有 semantic dl、toolbar 和分頁。沿 APM 品牌、唯一 ui.js 表單／歷程／確認／錯誤／toast 元件；kind 與追蹤 status 分開顯示，原因和結果採完整 pre-wrap 文字。沒有新 token、CSS、字型或 popup。原生 select/date 採平台所有權；人工追蹤與目前個案服務狀態分開標示。本機必要整合、新13關瀏覽器及桌機／390px新14張圖片已實際驗證；正式文件／列印與人工UAT仍待核定。


## 面試者登錄與紀錄（0.47，本機已驗證）

依 docs/INTERVIEW_APPLICANTS_SCOPE.md。機構管理的面試者名單沿 APM CIS、單一 navigation builder、既有 table／toolbar／25筆分頁、桌機表內橫捲與390px手機。姓名、電話、人工面試日期、自由縣市區、內容／備註與名單啟用狀態採原生控制項；共用表單 pre-wrap、textarea 内捲。沒有新 token／CSS／字體／widget；停用明確人工確認，內容安全文字呈現，不推算錄取或到職。 必要整合與新13關browser、桌機／390px新16張圖片實際檢視完成；正式列印與人工UAT仍待核定。


## 督導訪視查詢（0.48，本機已驗證）

沿APM CIS／唯一ui.js與styles.css。admin.listPage只新增有限endpoint／個案ID選單／日期提示與captured query設定；既有面試requested及其他caller保持。十題文字列表160字摘要，wide openDetails完整多行與型別tag，個案姓名明稱目前主檔；不新CSS/token/widget，不新增CSV或print。原生select/date接受OS外觀，桌機／390px表內捲動。必要整合、新12關與桌機／390px16張圖已實際驗證；不宣稱正式輸出或UAT。


## 多組聯絡人安全編輯（0.49，本機已驗證）

依 docs/CONTACT_EDIT_SAFETY_SCOPE.md，沿既有多組聯絡人 section、唯一 ui.js 表單／確認／歷程、APM CIS 與 styles.css token。原十業務欄保存由 pure editor 及完整情境守門；只傳明確變動、新送字串沿原 trim、未知值明確保持／取代／可選清空，成功需 exact 回應。原生 select 接受 OS popup，敏感篩選只在記憶；不新增 CSS、控制項 owner 或後端規則。必要整合、新14關與桌機／390px16張圖已實際驗證；正式UAT及部署未驗。


## 人工追蹤查詢（0.50，本機已驗證）

依docs/CASE_FOLLOWUP_WORKLIST_SCOPE.md，重用唯一admin.listPage、table／searchBox／pagination／errorState、openDetails guardedRead及history；listPage僅opt-in kindFilter，其他caller預設保持。APM CIS與styles.css tokens保持。五條件僅記憶體，人工追蹤日期不推算期限；完整primitive情境撤除loaded／pending結果，fresh內容與型別標記、精確前版及父個案維護連結沿原授權。必要整合、新14關與桌機／390px16張圖已實際驗證；36+6+6情境、Escape真正abort及原因／備註最後文字Range受檢。正式UAT與部署未驗。


## 個人行事曆人工事件（0.51，本機已驗證）

沿APM CIS與唯一styles.css/ui.js。四既有角色目前機構的本人六欄人工日內agenda，重用admin.listPage、native date／time／status、25筆表內捲動、openForm、confirmAction及openRecordHistory，不新增CSS/token/widget。 必要整合、新14關与桌機／390px16張圖實際驗證；長備註末句與footer可讀性受檢。原生OS popup、正式UAT與部署仍未驗。


## 本人事件月份閱讀（0.52）

同個人清單增加月份檢視按鈕；唯一shared openDetails／createForm／table與既有shift-calendar索引／每日agenda樣式保持。桌機日期索引及完整每日表，390px只每日agenda、表內橫捲及完整長備註。狀態、query echo、context與零寫規則源於 docs/PERSONAL_CALENDAR_MONTH_SCOPE.md 及 docs/API.md，未新增tokens/CSS/native popup或導覽owner。


## 需求評估保存查詢（0.53）

來源 docs/NEEDS_ASSESSMENTS_SCOPE.md。沿APM CIS與唯一styles.css／ui.js；新admin/supervisor導覽與原listPage caller：保存文字原文搜尋、紀錄填寫日期／精確個案／狀態、25筆分頁。摘要160字，唯一guardedRead openDetails fresh讀九項完整答案；原openRecordHistory沿逐版授權。長答案及目前／保存姓名分開，型別標記不暴露巢狀資料。390px原表內橫捲，末句真Range/hit-test對direct close footer驗證；shared owner／CSS與十六模板editor保持。


## 附件描述安全編輯（0.54）

来源docs/ATTACHMENT_METADATA_SAFETY_SCOPE.md。沿APM CIS、唯一styles.css/ui.js與原case/cert附件section；描述與檔案操作仍分開。共用native input/select/textarea與openForm的保持／明確取代，未知狀態只修復；卡片非文字只型別、不展巢狀內容。原單欄手機、搜尋與25分頁、busy/dirty/Escape/焦點由共同owner管理，沒有新增token/CSS/平行dialog。


## 本人事件年度閱讀（0.55）

來源docs/PERSONAL_CALENDAR_YEAR_SCOPE.md與docs/API.md。沿APM CIS、唯一ui.js wide guardedRead openDetails／createForm／table／button／errorState及既有shift-calendar樣式；原個人清單增加年度按鈕，沒有新導覽。桌機十二月份索引跳至heading，同一份十二月完整六欄agenda含空月；390px沿原CSS隱藏索引、表內捲動並完整閱讀長文字。年度native text／狀態native select／literal q保持，型別標記不展nested內容；沒有新增tokens／CSS／widget／controller或巢狀月份handoff。

## 個案保存紀錄索引（0.56，本機驗收完成）

延續 APM CIS、唯一 public/ui.js／public/styles.css 與既有個案詳情。管理者／督導按鈕開啟共用 wide guardedRead 視窗，原生 select、明確查詢、semantic metadata table、25 筆分頁與既有歷程保持同一 owner；原更新文字完整換行，保存 ID 使用原生 details 展開。桌機／390px 沿既有表內橫捲，沒有新增 token、CSS 或控制項。長 ID／原時間、錯誤、空結果、回焦及固定關閉區已完成必要本機瀏覽器驗收；新九張桌機／390px畫面已實際檢視。

## 視覺改版（0.57，本機驗收完成）

已完成 APM 品牌視覺整理：首頁優先呈現今日服務與角色可用工作，四組 SVG 導覽、清楚的表格／表單層級、手機服務卡片及個案七區塊捷徑。財務首頁導向可授權報表，鍵盤跳至主內容與選單列印保持正確。原 API、登入／SSO、機構角色、保存／衝突／歷程及計價快照保持。

本機合成驗收：1,112項程式測試、243份JavaScript、58個configured commands（56套瀏覽器）接受；四角色92個頁面組合、250個版面檢查、同一批資料桌機／390px共32張Before／After逐張實看。個案捷徑另驗28次跳轉、14次失效守門與46個唯讀區段。七種PDF列印已驗。保留首輪PDF工具環境與兩個測試setup失敗及受控修正；產品斷言未放寬。strict沿已接受私人parser零finding，原官方auditor逾時保存；DESIGN零error／10既有warning。

這是本機視覺與操作驗收；正式持久主機、HTTPS、Portal發布與真實業務UAT仍待完成，沒有原平台全量等價、正式薪資／支付／申報或完整WCAG宣稱。


## 員工保存紀錄索引（0.58，契約）

延續v0.57 APM品牌、唯一public/styles.css與ui.js元件，不新增色彩、尺寸、token、dialog或表格。員工列「保存紀錄」沿44px outline動作；wide shared details内原生紀錄種類選單、明確查詢、25筆原semantic table與折疊完整ID。共用record-index adapter以case／employee業務profile保持原個案索引外觀，員工分別證照／教育訓練／請假；原更新時間文字完整呈現，長ID與390px table自身捲動沿既有geometry。Loading、無結果、非法回應、manual retry與Escape/回焦沿既有owner。實際畫面及行為驗收另綁固定來源；這段描述不宣稱已正式部署或完整UAT。

本輪0.58必要合成驗收完成：1,144程式／最低Node85／250JS、十一套瀏覽器136項、九張新PNG實看；原個案索引與APM／合成HTTPS Portal回歸通過。strict沿已接受私人parser零finding，原官方auditor20秒逾時保留且不宣稱pass；DESIGN零error／10既有warning／1info。沒有正式部署或完整WCAG／OS原生popup／真實帳號UAT宣稱。完整來源文件於runtime驗收後更新，不將較早full-source map誤稱為最終文件hash。

## 面試者完整保存紀錄（0.59，契約）

沿 docs/INTERVIEW_RECORD_DETAILS_SCOPE.md：現有清單的「查看紀錄」以既有單筆 GET fresh 取得目前八欄原文及保存版次／建立與更新文字。detail-grid／pre-wrap 與 guardedRead openDetails 沿唯一共享 owner；全文不截斷、不解析日期／時間、不轉型未知 JSON，typed／missing／empty／null 分辨。名單啟停仍不代表錄取或到職。loaded／pending 完整 primitive／hash／父render／outer reference 失效撤除，人工重試只一個 GET；無新 CSS／token／表單／CRUD／server／schema／controller。

0.59本輪必要合成驗收：1,164程式／最低Node73／254JS、六套browser65項、十張新PNG實看；APM與合成HTTPS Portal及原面試CRUD／歷程回歸通過。strict沿已接受私人parser零finding，未重跑已知逾時的原官方auditor，原失敗與作者工具腳本失敗保存、不宣稱官方pass或first-pass；DESIGN零error／10既有warning／1info。runtime與tests保持335-source接受稿精確bytes；僅狀態及追溯文件在QA後更新，不把初始freeze全文件hash當成最終hash。正式主機／HTTPS／Portal／OS popup／人工作業UAT未完成。

## 本頁本人公告回執（0.60，契約）

沿 docs/ANNOUNCEMENT_PAGE_RECEIPTS_SCOPE.md，內部公告只有人工「查詢本頁本人回執」才串行讀最多25個已確認本頁ID；清單初載、搜尋、條件與分頁不隱式讀回執。toolbar outline button、表格自身捲動及唯一 wide guardedRead openDetails 沿 APM 與 shared owner，無新 CSS／token／字型／picker／POST。欄位只 fresh 標題／精確ID／目前版／本人本版回執／canonicalUTC保存時間；無回執不代表未讀、義務或完成率，不顯示body。混合錯誤明示未確認，手動全頁重讀；清單搜尋草稿立即撤捕捉，snapshot／sequence／父render／primitive／outer context完整守門。header同步防雙開以aria-busy/aria-disabled但可focus，失效或空页native disabled；共享Close/Escape與原trigger focus不改。必要瀏覽器、桌機／390px與圖片仍待驗收。

0.60本輪必要合成驗收：1,186程式／最低Node73／258JS、十一套browser131項、新查詢12項及十張新PNG實看；APM與合成HTTPS Portal、原公告回執／名冊／歷程／安全編輯、共用清單個案與員工索引及面試詳情回歸通過。新browser原兩次actual1及UI前置守門修正、作者工具與root工具失敗封存；只作最窄修正，不放寬產品斷言或逾時，不能宣稱first-pass。必要命令16種由14個輸入保持的本輪通過與2個最終重驗組成，61 configured／60 required不全部fresh；原freeze、r02/r03與carry provenance分開保存。strict沿已接受私人parser零finding，原官方auditor的逾時失敗與原有效測試證據保持、未重跑或宣稱官方pass；DESIGN零error／10既有warning／1info。340公開來源／101runtime接受稿的runtime精確保持，QA後僅更新狀態及追溯文件。原180目錄／9階段／12契約／2增強與58里程碑及99來源前綴保留後追加59／101；RM07仍partial。正式主機、HTTPS、Portal發布、OS popup及人工作業UAT未完成。

## 員工目前完整保存資料（0.61，契約凍結／待驗收）

沿 docs/EMPLOYEE_RECORD_DETAILS_SCOPE.md；現有管理者、督導與財務可從員工列「查看資料」，每次重新讀取精確同機構員工目前版的十欄。財務只增唯讀查看；原六種維護／索引／歷程操作仍沿既有管理權限，居服員不新增員工入口。

純投影唯一 owner 為 public/data/saved-record-details.js，面試者與員工各自提供固定欄位與錯誤文字；封閉 envelope/request、own descriptor 及 metadata 確認不讀取未知值。regions 先複製合法 own-data string[] 才沿 employee-regions formatter，時薪沿 trial-price formatter，不合併或推算薪資。

共用薄閱讀 adapter public/modules/saved-record-details.js 沿唯一 ui.js openDetails wide/guardedRead；原生 modal、signal、observer、loading、manual retry、Escape／回焦仍由 ui.js 所有。員工資格、區域與備註跨全列，完整原文、空值差異、typed 標記與精確分值；不另造 CSS、dialog controller 或搜尋／分頁。面試者既有 DOM／八欄／文字和原 caller guard 保持。新員工 trigger 失去連接或完整 primitive／outer／hash／父 render 失效即撤除，不復活晚回應。

0.61本輪必要合成驗收：1,213程式／最低Node99／264JS、九套browser104項、新員工詳情12項及十張新PNG實看；APM與合成HTTPS Portal、員工安全編輯／歷程／索引、面試詳情抽取及四角色視覺回歸通過。沿唯一純投影与唯讀對話框owner，原面試行為等價矩陣及原tests保留；347公開來源／105runtime受測輸入SHA前後精確。十四必要命令實際全0，62 configured／61 required不全部fresh；原官方auditor逾時失败與舊有效證據保持，strict沿已接受私人parser零finding，未重跑或宣稱官方pass。DESIGN零error／10既有warning／1info；私人metadata準備encoding工具失敗原件封存，不列作產品測試或CI失敗。QA後只更新狀態及追溯文件；原180目錄／9階段／12契約／2增強與59里程碑及101來源前綴保留後追加60／105；RM01仍partial。正式主機、HTTPS、Portal發布、OS popup及人工作業UAT未完成。

0.61發布前修正紀錄：首次Git差異檢查發現面試純helper末端多一個換行，尚未暫存、提交或上傳。僅移除該LF，所有可執行文字保持；原發布失敗、初始來源與驗收封存。修正後重新通過264份JavaScript與1,213項完整程式測試，另外12個必要命令沿本輪原通過證據，九套104項瀏覽器與十張實看畫面仍綁初始來源；不宣稱全部最終來源在本輪重新跑過瀏覽器。必要14種命令共16次實際執行，修正追溯見verification-r02.json及兩份source freeze。GitHub最終來源CI另行核對；正式主機、HTTPS、Portal與真實公司登入UAT仍待完成。

## 服務項目完整保存閱讀（0.62）

原三讀角色列表沿唯一saved-record-details pure與UI／openDetails guardedRead，只新增service-item薄profile與row入口。八欄順序沿history白名單、備註field-wide／pre-wrap，桌機與390px長文完整閱讀。known狀態及原碼並列、unknown原文、五種保存型別清楚；分鐘只呈numeric primitive，試算分值沿原formatter，日期不解析。每次explicit open／manual retry才fresh單筆；user/org/role/employee、outer context/hash/alive/trigger連線失效沿同一owner撤除與真abort，沒有重複controller或新增CSS。finance僅查看、其他三維護操作保持；caregiver不增導覽，原API範圍不變。來源 docs/SERVICE_ITEM_RECORD_DETAILS_SCOPE.md 與 docs/API.md，業務正式支付契約仍待核定。

0.62本輪必要驗收：1,239程式／最低Node122／268JS、九套browser104項、新12項與十張PNG實看；APM CIS／合成HTTPS Portal、服務項目原安全編輯與歷程、員工與面試共用詳情及四角色視覺回歸通過。原sourcefreeze與失敗保留；只新browser G2補直接inert斷言，runtime107及舊tests精確，十類同消費來源承接、四次affected native通過，共十八次程序含原員工timeout，根因未確立，未宣稱first-pass或所有來源同批fresh。strict沿已接受私人parser零finding；官方auditor原逾時失敗保留，未重跑或宣稱官方pass。DESIGN零error／10既有warning；正式支付／薪資／申報契約待核定。原180目錄／9階段／12契約／2增強及60里程碑／105來源前綴保持，追加61／107；RM05仍needs_contract。正式主機、HTTPS、Portal發布及真實公司登入UAT另驗。
