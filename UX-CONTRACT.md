# UX Contract

## Product context

Audience：歲悅機構管理者、督導、居服員、行政與薪資人員。Primary jobs：個案維護、排班、現場紀錄與核對。市場臺灣，locale zh-TW，timezone Asia/Taipei，西元日期。Accessibility target：WCAG 2.2 AA。

## Business-context sources

PRODUCT.md：實作與資料範圍。docs/API.md：測試版permission model、版本控制、服務紀錄狀態及試算限制。notes/*-evidence.json：原系統介面證據，不作為已知後端驗證規則。

## Visual contract

DESIGN.md與public/styles.css一對一token映射，ui.js共用元件，單一light theme。

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Select/Listbox | public/ui.js openForm | DESIGN.md | native | E2E keyboard/popup |
| Date | public/ui.js openForm / createForm | UX contract / docs/SHIFT_CALENDAR_SCOPE.md | native / calendar typed YYYY-MM-DD | locale / exact date / E2E |
| Form | public/ui.js openForm / createForm | docs/API.md / docs/ATTACHMENTS_SCOPE.md / docs/CERTIFICATION_ATTACHMENTS_SCOPE.md | create/edit/single-file/preview-batch/assessment-preserving-edit | validation / file selection / retry / checkbox-preview E2E |
| Scrollbar | public/styles.css | DESIGN.md | table geometry | computed style |
| Toast | public/ui.js toast | UX contract | success/error/info | live-region |
| CRUD | public/ui.js api/openForm | docs/API.md | refresh owning list | full-flow E2E |
| File Upload | public/ui.js createForm / attachmentFilePayload / downloadAttachment | docs/ATTACHMENTS_SCOPE.md / docs/CERTIFICATION_ATTACHMENTS_SCOPE.md | native single-file picker | file validation / retry / exact download bytes E2E |
| Read-only history | public/modules/history.js openRecordHistory / public/ui.js openDetails | docs/HISTORY_SCOPE.md / docs/SHIFT_HISTORY_SCOPE.md / docs/SERVICE_HISTORY_SCOPE.md / docs/PERSONNEL_HISTORY_SCOPE.md / docs/LEAVE_HISTORY_SCOPE.md / docs/CERTIFICATION_ATTACHMENTS_SCOPE.md / docs/ASSESSMENT_HISTORY_SCOPE.md | default / wide | load/retry/cancel/focus E2E |
| Metadata record index | public/modules/record-index.js openRecordIndex / public/ui.js openDetails | docs/CASE_RECORD_INDEX_SCOPE.md / docs/EMPLOYEE_RECORD_INDEX_SCOPE.md | case / employee profiles; domain DTO confirmation | exact parent / manual query / paging / guarded Abort / original history E2E |
| Report query/export/print | public/modules/report-view.js / public/ui.js downloadCsv / openDetails / public/styles.css | docs/SHIFT_REPORT_SCOPE.md / docs/SERVICE_REPORT_SCOPE.md / docs/CASE_REPORT_SCOPE.md / docs/EMPLOYEE_REPORT_SCOPE.md / docs/LEAVE_REPORT_SCOPE.md / docs/TRAINING_REPORT_SCOPE.md / docs/CERTIFICATION_REPORT_SCOPE.md | shift/service/case/employee/leave/training/certification adapters / CSV / printable details | full rows and totals / fresh authorization / cancel / multi-page PDF E2E |
| Read-only date overview | public/ui.js openDetails / createForm / table; public/data/shift-calendar.js; public/modules/shift-calendar.js adapter | docs/SHIFT_CALENDAR_SCOPE.md | guardedRead / wide / week-month / typed date | complete fresh DTO / draft retraction / context / keyboard / 390px E2E |

## Dataset navigation

伺服器分頁，預設25最大100。搜尋IME完成後提交、提供清除按鈕、取消過時请求。姓名搜尋及篩選屬敏感資訊，留在記憶體，URL僅保存導覽路徑及非敏感分頁。每張表有loading、empty、no-results、error/retry。表格semantic table、僅自身overflow。

## Flow ledger

新增/編輯：開dialog→忙碌→伺服器確認→關閉→重讀列表→成功toast；失敗保留輸入及錯誤。取消有dirty警告，未修改直接關閉。軟取消/停用先確認影響；硬刪除不提供。搜尋不更改資料。報表下載再次伺服器驗權限。

## Navigation and responsive behavior

hash routes與document title同步。無權限顯示403説明與回到首頁。手機側欄可收合，操作焦點不被固定區域遮擋。純文字多行顯示；敏感輸入不進URL或localStorage。

## Overlays and feedback

native dialog.showModal擁有模態焦點；自訂取消/確認dialog，不使用alert/confirm/prompt。toast右下方aria-live polite，錯誤保留於表單，Escape與完成回復原觸發元素。dialog比toast高，原生top-layer遵循平台。

連續操作最多顯示最近兩則toast，避免回饋堆疊遮住手機工作清單；表單錯誤仍保留在表單中。

唯讀歷程使用ui.js openDetails；立即開啟並顯示載入、錯誤重試，Escape或關閉中止請求並回復焦點。證照提示以截至日期計算，30日內含到期當日；撤銷及未填到期日分開顯示，不以提示宣稱法定資格通過。

個案／計畫歷程以可展開版本卡片及單欄保存內容呈現，使用共用openDetails的wide選項；桌機視窗最多960px，手機維持視窗內。差異表格最小620px，前後欄各至少220px，只在自身範圍捲動。僅精確相鄰且有權讀取的版本才比較；缺口明示上一版本不可取得。操作者以精確版本的實際稽核身份呈現，缺失不猜測。原關聯值保存為識別，畫面名稱標示來自目前主檔。

多組聯絡人依docs/CONTACTS_SCOPE.md呈現在個案詳情的獨立區塊，以同一組卡片DOM適應桌機／手機；欄位桌機雙欄、手機單欄，長信箱及備註換行。列表獨立載入／重試，分類、狀態及搜尋留於記憶體；共用表單、停用／恢復確認及唯讀差異歷程，不自動修改原個案聯絡欄位。

個案附件依docs/ATTACHMENTS_SCOPE.md置於聯絡人之後，延續卡片桌機雙欄/手機單欄。每次一檔PDF/PNG/JPEG最大5 MiB。共用file欄位顯示實際檔名與大小，提供移除選檔；選檔立即驗證，失敗保留選檔/metadata。上傳、更換檔案與修改描述各有獨立表單，metadata不重傳檔案。卡片下載目前版，歷程下載精確版；不預覽、不提供公開網址。晚下載回應在關閉歷程/切案/切機構後不自動落地。停用保留檔案與歷程。收到成功HTTP狀態但JSON讀取失敗/無有效附件item確認仍保留表單，使用原POST鍵重試，避免誤關表單或重複保存。

週期排班沿docs/RECURRING_SHIFTS_SCOPE.md，班表頁入口使用共用openForm的onPreview及checkbox-group；日期摘要/逐日卡片桌機兩欄、手機單欄。預覽只讀可取消，改輸入中止並忽略過時結果；提交鎖住輸入，任一衝突整批不建立，更新清單後須重新預覽。不提供跳過衝突的部分建立。週一起算、93日、只建立所選區間的說明可見；不暗示持續自動排程。checkbox native keyboard/label可操作，群組錯誤首項focus；儲存確認失敗保留表單與原key重試。

排班歷程沿docs/SHIFT_HISTORY_SCOPE.md，在班表及我的服務提供相同的唯讀入口、版本卡片及精確前版差異。改派後目前班次及每一歷史個案/員工仍需可讀；不可見的前版明示缺口，不跳版比較。核閱完成採精確shift.complete操作者。排班服務標示排班數量，照顧計畫關聯以目前可讀期間/狀態辨識，無名稱則明示並保留保存ID展開。沿已有表格內捲動、25筆分頁、重試、取消/焦點及過時回應防護，不提供還原/改寫。

證照及訓練依docs/PERSONNEL_HISTORY_SCOPE.md以兩頁既有版本歷程入口重用history/openDetails，移除自訂raw歷程controller。各八欄只有保存日期／實際分鐘／狀態／備註，空到期日明示未填到期日；不依基準日重算效期、不推積分。員工用已授權people Map目前名稱與保存ID；raw/compare逐版先驗不可改父項與目前員工可讀集合，缺版不跳版。完整身分／generation/renderVersion guard保護loaded與pending，維持既有列表篩選、新增編輯、撤銷取消恢復及焦點／失敗重試；桌機wide與手機局部橫捲／單欄快照，不新增CSS。

服務紀錄沿docs/SERVICE_HISTORY_SCOPE.md重用相同歷程owner，在服務核閱列表／我的服務有紀錄卡／個案詳情提供入口；十業務欄位的實際時間與數量、服務觀察及核閱說明不推算工時或金額。service.review精確actor只採實際身份；每版case/employee scope與精確前版缺口先驗權。關聯班次顯示目前可讀日期/時段/狀態，缺lookup明示保留ID，不額外跨scope取名。current包含user/org/role/employeeId/hash/render，傳給共用openDetails，載入及已載入後失效都清空/abort/關閉；錯誤/重試/分頁/Escape焦點沿同一owner，不新增CSS。

請假紀錄依docs/LEAVE_HISTORY_SCOPE.md在既有admin/sup管理入口追加全狀態版本歷程，沿同一history/openDetails與授權employees Map。七欄保存日期／時段／自由假別／原因／狀態，不折算假額或時數；狀態明稱待審核、已核准、已駁回、已取消。員工可合法更換，逐版驗目前可讀父項，不強制等於current；精確前版缺口不跳版。原編輯／核准／駁回／取消規則保持，名稱為目前主檔、保存ID可展開。完整identity／generation／container stamp保護載入及已載入後失效，重試、Escape焦點及手機局部橫捲沿共享元件；不新增finance/caregiver導覽或CSS。

證照附件依docs/CERTIFICATION_ATTACHMENTS_SCOPE.md，在證照頁每筆「附件」選定同頁單一父項panel；附證照/員工身份與關閉回復焦點，不用列表外層modal。沿唯一attachments controller有限case/cert設定與原File/metadata/replace/status/history，原case分類保持、新cert無分類。固定證照父項與derived employee每次驗權；管理者/督導維護、居服員自身唯讀、財務拒絕。download helper有限entity allowlist、default case沿原API；完整identity/panel/generation/render guard阻止已關閉/改選/身分切換後晚載入或下載。版本九保存欄位及精確下載、不做檔案內文diff；不更動原證照或計價版本，不稱上傳等於資格通過。未知成功回應保留File及原key重試、CAS/503錯誤可修復；原卡片/手機/焦點與6trigger/11表唯讀驗證，不新CSS。

請假衝突依docs/LEAVE_SHIFT_CONFLICTS_SCOPE.md在既有/leave各狀態列提供「檢視衝突班次」，沿唯一openDetails wide及semantic card/dl/分頁。load callback第二參數{reload,isCurrent}向後相容，重查/分頁沿共同reload，無新controller/CSS。每次fresh GET目前請假員工/保存時段/狀態/版次，不沿清單舊row猜結論；無衝突仍明示核准需重驗，非pending僅查保存時段。顯示目前班次/個案/員工/已有服務鎖定，case缺失仍留衝突並明示。單一前往排班管理link不假稱已過濾定位，視窗不執行寫入。完整user/org/role/employee/hash/generation/stamp/連線沿共用dialog防loaded/pending失效與晚回應，Escape回焦點、503/非法DTO可重試；原核准guard與計價保持。

## Async and resilience

個案總表沿docs/CASE_REPORT_SCOPE.md使用同一report-view有限personFilter/date設定，不另寫查詢或輸出controller。原employeeId/日期預設維持；個案明稱系統建立日期（臺北）、主責督導，日期不是收案日。督導選項為可讀cases已指派ID與可讀employees交集，保留停用或職務變更；無名稱明示，不猜資格。12欄含保存CMS/福利/狀態/版次/備註，不合併聯絡人或推定臨床評分；完整數量與fresh版本確認、CSV/print/cancel/native suppression保持一致。報表種類仍五類，只有費用/薪資保留月份介面。

服務明細與班表共用report-view.js，adapter只放欄位/文案/狀態及domain驗證。依docs/SERVICE_REPORT_SCOPE.md，服務摘要為全部符合紀錄數與實際分鐘，不能誤稱已核准工時；actual起訖及quantity來自保存服務紀錄。13欄表格自身捲動，所有欄位可讀；列印沿共用A4/12mm/9pt及13欄權重，完整服務、備註與核閱意見可換行。兩類查詢/清除/失效/重試/CSV/print timing遵循同一controller，不新增重複的async流程。

班表報表沿docs/SHIFT_REPORT_SCOPE.md，native日期/個案/人員/狀態選項使用共享欄位、semantic table及25筆分頁。查詢確認filter echo/完整count，修改條件立即停用下載與列印。每次CSV/預覽重新讀資料；共用printable openDetails於每次列印前再重新驗權及讀全數，錯誤只提供重試，不印快取。手機表格自身橫捲、操作可見；列印以A4橫向與12mm邊界解除高度/overflow，只印完整報表及重複欄頭、文字可換行與跨頁，無背景導覽或按鈕。切機構/類型/路徑與關閉後的晚回應不顯示、不下載、不列印；已載入預覽失效時自動清空關閉。beforeprint僅放行fresh load成功後同步window.print的單次授權；原生Ctrl/Cmd+P即使預覽已載入也以body.print-suppressed隱藏全部介面直到afterprint清除，保留有效預覽並提示使用畫面按鈕，失效仍清空關閉，避免印出未重新驗權的快取或背景。沒有在產品建立正式PDF文件或送印工作。

伺服器確認才成功。寫入Idempotency-Key、防重送；PATCH version避免靜默覆寫。斷線保留輸入並提供重試，不在client storage保存個資或queue。401轉登入，403顯示權限説明；衝突提示重新讀取資料，不自动覆盖。

## Validation

前後端驗證，form noValidate。每欄label、aria-invalid、aria-describedby，錯誤summary並focus第一欄。密碼masked且可切換顯示；允許貼上與密碼管理器。textarea resize:none。

## Verification

node scripts/check-source.mjs、node --test tests/*.test.mjs、node tests/e2e.mjs、node tests/personnel-e2e.mjs、node tests/history-e2e.mjs、node tests/contacts-e2e.mjs、node tests/attachments-e2e.mjs、node tests/recurring-shifts-e2e.mjs、node tests/shift-history-e2e.mjs、node tests/shift-report-e2e.mjs、node tests/service-report-e2e.mjs、node tests/case-report-e2e.mjs、node tests/service-history-e2e.mjs、node tests/personnel-history-e2e.mjs、node tests/leave-history-e2e.mjs、node tests/certification-attachments-e2e.mjs、node tests/leave-shift-conflicts-e2e.mjs及strict premium audit。瀏覽器1440px與390px、核心CRUD、權限拒絕、重複送出、排班衝突與核閱。本機測試證據不構成正式上線或核銷規則驗證。

## 服務項目主檔歷程（0.16，本機已驗證）

依docs/SERVICE_ITEM_HISTORY_SCOPE.md，只在service-items原admin/sup操作加共用history/openDetails入口，8保存欄、精確相鄰版/actor與trial-price-cents新專屬formatter；非負安全整數精確商/餘數呈元及原分，空值不轉0、非法值不coercion。date空明示未設起/迄日；分鐘預設值不換算法定工時。完整identity/hash/generation/stamp/alive沿現有guard，無新CSS/controller/ui.js/role導覽，原CRUD/列表/formatMoney/核閱快照保持。

## 員工主檔歷程（0.17，本機已驗證）

Canonical owner仍history/openDetails、admin/listPage及既有context guard。admin/sup原員工操作列加版本歷程，finance原列表/API保持，不增caregiver導覽。十欄保存內容／相鄰版／actual actor；regions以保存文字或保存清單及逐項空字串標示，不拆/排序/去重；未提供、空清單、含空項可區別。試算時薪重用trial-price-cents，資格文字不判定資格，不重算已核閱快照。沿桌機與窄屏、503 retry/Escape/loaded-pending十失效，無新CSS/ui/controller。詳docs/EMPLOYEE_HISTORY_SCOPE.md，本機十欄切片已完成整合及瀏覽器驗證，原完整欄位與正式規則仍未完成。

## 員工總表（0.18，本機已驗證）

契約docs/EMPLOYEE_REPORT_SCOPE.md。GET /api/employee-report、/api/employee-report/export、/api/employee-report.csv沿同一唯讀builder；四角色沿當前員工scopedRows及登入active link，指定不可讀employeeId先404。q原文≤200 UTF-16字元、員工與active/inactive狀態AND，沒有日期或個案條件，未知／重複／export分頁拒422。q只匹配六個業務欄與合法regions每個原字串，不跨欄／項拼接或搜隱藏個資。

六個可見欄位與九key row DTO，regions共享employee-regions normalizer／安全formatter／CSV JSON字串序列化，保留type、順序、重複與空項，不洩漏非法巢狀資料。matching candidates先驗版次／狀態，再分頁；完整1000筆與整個JSON UTF-8 2MiB超出拒413、不截斷。總計僅筆數，職務非權限、資格非合格／積分判定、不是薪資或出勤。

唯一report-view加入date:false/caseFilter:false/search及typed column有限variants，原三報表預設不變；員工lookup只讀employees，identity含employeeId，loaded/pending完整context失效清空abort關閉。每次下載／預覽／按鈕列印fresh驗權，原生Ctrl/Cmd+P禁止快取／背景。螢幕960px表內捲動，A4橫向12mm／9pt六欄／重複表頭；新合成QA PDF四頁及全部畫面已逐張驗證，原正式表單仍未匹配。

請假總表依docs/LEAVE_REPORT_SCOPE.md重用report-view，日期明稱保存請假日期、q只五種業務文字、無case lookup。八欄保存原時段、目前員工名稱與缺失—；統計僅count，不推算假額。所有fresh CSV／preview／print與完整context失效沿既有owner；A4八欄與手機1100px表內捲，不新增controller或主導覽。新合成QA PDF四頁與全部畫面已逐張驗證，正式輸出版面仍未匹配。

## 評鑑填答歷程（0.20，本機已驗證）

Canonical owner仍admin/listPage、history/openDetails與history-fields；答案專屬pure helper按目前模板題項白名單與保存型別呈現，不另造controller/CSS/token或導覽。五欄與精確前版/actor，same template逐題比較、換模板兩組分開；明示目前題名及不可比較的隱藏內容。共用wide dialog/表格內捲/25筆分頁/503 retry/Escape焦點與完整identity/hash/render loaded/pending失效。只admin/sup既有操作入口，finance原API唯讀/caregiver403。詳docs/ASSESSMENT_HISTORY_SCOPE.md；新33圖與共用歷程74圖已逐張檢視，必要整合及20套瀏覽器通過。原editor預填問題未在此唯讀切片修正。

## 評鑑編輯安全（0.21，本機已驗證）

Canonical owner仍openForm/createForm；新assessment-editor pure adapter只做安全預填與答案合併，沿native select明確保留/取代/清除，不另造DOM/controller/CSS。helpers.setDisabled控制不相容題目；openForm可選isCurrent、confirmAction可選signal，評鑑失效清空abort關閉，其他表單無此參數時原行為。已提交到server的交易不宣稱可被abort撤回；有效item確認才close/success。詳docs/ASSESSMENT_EDIT_SAFETY_SCOPE.md。guarded form opt-in pending鎖定所有控制項，失敗按原disabled恢復；明確keep/replace/clear與主欄單改省answers已驗。新23、人員11、聯絡人11、既有評鑑歷程33共78圖逐張檢視，21套288聚合瀏覽器及fresh strictpremium0/designlint0error。原生select三態保存、Tab/ShiftTab焦點與Escape已驗；headless OS popup鍵盤選值及幾何未驗，不冒稱人工驗收。

## 教育訓練紀錄總表（0.22，本機已驗證）

薄training-report adapter沿唯一report-view／downloadCsv／openDetails／fresh單次列印，不新controller。只有admin/sup報表中心新增訓練選項、finance隱藏且server403，caregiver本人原列表/API保持。九欄保存分鐘/count-only、1200px表内捲／九欄A4權重；不推法定積分／資格。詳docs/TRAINING_REPORT_SCOPE.md，293測試、22套304聚合瀏覽器與84圖已驗證；每次重新查詢/下載/列印驗權。原映射仍未核定。

## 員工證照紀錄總表（0.23，本機已驗證）

依docs/CERTIFICATION_REPORT_SCOPE.md，核發日期區間與效期截至日分開，十五保存／提醒欄位、十可見欄、count-only；admin/sup中心可用、caregiver本人API保持、finance403。三GET共用builder，sharedquery/view只有限asOf/expiry opt-in，其他預設保持；完整CSV/fresh列印不作生效、资格或薪資認定。315測試、23套320聚合瀏覽器與92圖通過，原盤點row不變。

## 內部公告版本歷程（0.24，本機已驗證）

依docs/ANNOUNCEMENT_HISTORY_SCOPE.md，四欄保存文字／精確上一版／實際操作者，沿既有四角色公告入口。caregiver的current及每個raw/compare版本都要求published且all/caregiver；缺口不跳版。已知對象與狀態標示保存碼，未知文字安全保留，非文字匯入只顯示tag。重用admin/listPage、history/openDetails及完整context guard，無新CSS/token/controller/外部訊息。331測試、24套334聚合瀏覽器與85最終圖通過；原公告仍related_only，不宣稱等價。

## 公告安全編輯（0.25，本機已驗證）

依 docs/ANNOUNCEMENT_EDIT_SAFETY_SCOPE.md，編輯僅送變更的四個業務欄；未修改原文、未知／空閱讀對象與無法無損預填值保留。原生保存方式可明確取代，閱讀對象可明確清空。新增、編輯及撤回沿共用表單／確認視窗 opt-in 完整 context guard，只有 id/org/version/四欄 own-presence 與保存投影吻合才顯示成功；未知結果保留輸入，新增同 payload 重試沿同一冪等鍵。原後端角色、任意 audience、必填／狀態、CAS、歷程及價格快照保持；取消請求不代表伺服器回滾。沒有新 CSS/token/通知／已讀。351測試、25套350聚合瀏覽器與63最終圖通過；原公告仍 partial/unverified。

## 服務項目安全編輯（0.26，本機已驗證）

沿 docs/SERVICE_ITEM_EDIT_SAFETY_SCOPE.md，八欄未改省略，異常保存資料明確保持／取代，日期及備註可清空。價格以文字控制項與整數分精確往返，列表沿既有精確 formatter；共用表單僅允許 numeric/decimal inputMode descriptor。新增、編輯及啟停沿共用完整 context guard，保存成功須確認八欄及身份版本。19後端與既有角色、CAS、冪等、分鐘／有效日期／代碼唯一及核閱快照不變；保持仍按原 merged 驗證可能422。375測試、26套366聚合瀏覽器與91最終圖驗證通過；原完整功能仍 partial/unverified。

## 員工主檔安全編輯（0.27，本機已驗證）

沿 docs/EMPLOYEE_EDIT_SAFETY_SCOPE.md，十欄未改省略，原服務區域清單整欄保持，明確改存文字／清空才變更。電子郵件沿原API文字規則，職務不改登入角色；時薪BigInt精確轉分及列表一分完整顯示。新增／編輯／啟停沿共用context、CAS及有效十欄保存確認；停用連結居服員沿原auth下一請求403，舊班次與核閱薪資快照保留。後端與ui/styles/token不變。400測試、27套382聚合瀏覽器及84最終圖通過；原完整功能仍 partial/unverified。

## 請假安全編輯（0.28，本機已驗證）

沿canonical openForm／confirmAction的完整user/org/role/employee/hash/render guard、busy、dirty與native焦點。不可無損預填的員工／日期／ISO時段／型別／CR文字不進控制項；保持／明確取代及原因清空可辨。pending表單cancel enabled但inert、審核確認cancel disabled；失效清空關閉且晚回應不復活。390px長原因末段可讀；OS-owned popup幾何及headless popup鍵盤選值未宣稱通過。 本輪423 Node測試、28套398聚合瀏覽器gates與61fresh畫面通過；另4張封存參照圖分列。詳 docs/LEAVE_EDIT_SAFETY_SCOPE.md 與本輪 verification。

## 證照安全編輯（0.29，本機已驗證）

沿canonical openForm/confirmAction完整context/Abort/busy/dirty/native焦點。編輯員工永久disabled；無法無損預填的六欄以原生保持／明確取代控制、四optional可清空，資料不coerce入DOM。未知成功回應保留輸入，已提交後Abort不假稱回滾；OS popup幾何和headless popup鍵盤選值未驗證。 本輪446 Node／29套414聚合gates／70fresh畫面，0封存參照另列。詳 docs/CERTIFICATION_EDIT_SAFETY_SCOPE.md 與本輪verification。

## 訓練安全編輯（0.30，本機已驗證）

沿唯一openForm/confirmAction完整context/Abort/busy/dirty/native焦點，員工edit永久disabled；原生number完整minutes/60預填，異常資料不coerce入DOM，未知回應保留，真已提交後Abort不宣稱回滾。 全Node470（461頂層＋9巢狀；319 HTTP／151純）、123 source覆蓋；29既有browser414＋新16，共30套430聚合gates。 76fresh圖、0封存參照另列。詳 docs/TRAINING_EDIT_SAFETY_SCOPE.md。

## 個案安全編輯（0.31，本機已驗證）

列表與詳情兩入口沿唯一openForm/confirmAction完整context/Abort/busy/dirty/native焦點；異型原文DOM外保持，明確取代或選填清空；晚回應不復活，已提交不假稱回滾。 全Node494（485頂層＋9巢狀；331 HTTP／163純）、127 source覆蓋；30既有browser430＋新16，共31套446聚合gates。 100fresh圖、0封存參照另列。詳 docs/CASE_EDIT_SAFETY_SCOPE.md。

## 照顧計畫安全編輯（0.32，本機已驗證）

沿唯一openForm/confirmAction、完整context/Abort/busy/dirty/native焦點；services keep原生數量禁用且opt-in略過組validation，replace啟用，失敗保留。已提交後中止不宣稱回滾。 全Node 521（512頂層＋9巢狀；344 HTTP／177純），131 JavaScript來源覆蓋；31既有browser 446＋新16，共32套462聚合驗收。 98fresh圖、0封存參照另列。詳 docs/CARE_PLAN_EDIT_SAFETY_SCOPE.md。

## 單班排程安全編輯（0.33，本機已驗證）

重用canonical openForm／confirmAction／history、busy/dirty/native焦點與完整context／Abort；services沿既有preserveWhenDisabled opt-in。plan換選保留keep，replace僅保留仍可選未保存量並提示移除；409／422／未知ACK保留輸入，已提交失效不是回滾。 全Node 551（542頂層＋9巢狀；360 HTTP／191純），135 JavaScript來源覆蓋；32既有browser 462＋新16，共33套478聚合驗收。 80fresh圖、0封存參照另列。詳 docs/SHIFT_EDIT_SAFETY_SCOPE.md。


## 月份清單日期型別安全（0.34，本機已驗證）

依 docs/MONTH_FILTER_SAFETY_SCOPE.md，泛用GET清單先沿date||validFrom||空文字選值，只有字串套原startsWith月份前綴。truthy object／array／number／boolean不轉字串、不fallback；falsey原選值及字串前綴相容，沒有新增有效日期驗證或修改資料。機構／角色、q／status／date與分頁順序保持。

全Node561（552頂層＋9巢狀；370 HTTP／191純）、137 JavaScript來源；33舊browser478＋新8＝34套486聚合驗收。11新圖＋6張fresh sibling＝17張逐圖檢視，0封存參照另列；root重疊subset不重加。

原HTTP10／full561及32舊browser462以原actual0及完全相同的runtime／全部.test／33legacy scripts納入。原舊browser batch actual1：shift-edit-safety於120秒逾時，10／16 gates結果保留不驗收；不改原稿或斷言，以300秒界限在final branch獨立fresh執行完整16 gates actual0，再組合33舊套478，原batch與失敗子process仍保留且accepted:false。新browser第一次因財務個案頁heading selector錯誤actual1；heading校正後第二次7／8 gates及11PNG，SQL null-prototype版本列被structuredClone轉為普通物件，strict prototype斷言失敗actual1。兩次rawprocess與失敗結果都保留不驗收；只修新驗收稿heading及版本基線保留原SQL列的兩片段，逐片反向SHA驗回原稿，在final-qa fresh source137／browser8 actual0通過。不宣稱first-pass、同一次batch全33初次通過或全199final來源重新跑全部QA。

只修泛用GET清單month選值為非字串時的500；legacy reports.mjs非空month仍有同類500，未修。actual4310未restart／reload，不能宣稱既有backend已載入本修復；隔離合成環境提供行為證據。服務紀錄安全編輯順延0.35且not_started／契約未凍結。

原operations/renderList、ui.js、CSS/tokens bytes保持。月份／q／狀態／25筆分頁與route-return、503明確重新讀取沿原記憶狀態；full browser reload仍重置查詢。桌機／390px無頁面overflow、實際focus及表格自身橫捲已驗；OS-owned popup幾何、原生鍵盤選值及人工UAT未驗。


## 服務紀錄安全編輯（0.35，本機已驗證）

依 docs/SERVICE_RECORD_EDIT_SAFETY_SCOPE.md。兩填寫及兩核閱入口沿canonical openForm。新增五控制項、九payload欄不送reviewNote；編輯十保存欄只送改變欄，own-presence／JSON私有保持，services一律保持／明確整欄取代，ISO／0000／缺失／null／typed／CR不猜值。note可明確清空，returned預設returned且只有明確submitted才重送；動作「修正退回紀錄」。2xx未知、空JSON、錯誤id/org/version或任何欄不符不能成功關閉；review確認status/reviewNote及其餘八欄，billing由server交易產生、不從UI推算。

全Node588（579頂層＋9巢狀；382 HTTP／206純），141 JavaScript來源；34舊browser486＋新16＝35套502聚合驗收。35新UI圖＋6張fresh sibling＝41張逐圖view_image；0封存參照，root subset 4重疊圖不重加。

新browser 14段十一表唯讀保持；49批合成setup／fixture／login及業務必要寫精確對帳556 changes，6不可變trigger、已核閱billingSnapshot及四個非空BLOB下載保持。50完整context失效與3真提交晚回應分列；Abort不是已提交交易回滾。72指定sealed034 PDF／pdf-*參照維持bytehash，無新PDF、marker或本輪歷史PDF人工重看。

初始full actual0的588結果只在runtime56、全部.test與其helpers消耗bytes exact時承接。新browser首次因作者假設A/B服務順序actual1；僅改兩個新稿斷言以實際控制項B/A順序確認。第二次因aria-busy使提交按鈕accessible name暫時隱藏，name locator等到API逾時後讀到null而actual1；只改一片段預先捕捉同一原生elementHandle，仍檢查busy及disabled。兩次process／raw JSON／PNG保留且accepted:false，修稿逐片反向SHA驗回；final-qa新browser16 actual0依相同runtime56、新稿及helpers exact承接。final-qa舊matrix actual1：service-report舊修正按鈕selector未更新；B批七套96 gates成功子process承接，失敗batch與child原始保留不驗收。只改唯一label並反向SHA驗回sealed034。legacy-corrected-qa被刻意中斷，C批六套82 gates子process實際close0已觀察，整批summary及outer completion未觀察、不驗收、不推定缺陷或整套逾時；employee-report與leave-report只有raw結果，child close未觀察，兩套原始診斷不承接。resumed-qa保持C的204來源，source141 actual0；D批另五套76 gates成功，announcement-history因真requestfailed的10秒等待逾時actual1，失敗batch及child/raw十個完成關卡保留且不驗收。獨立取消診斷immediate與hold兩模式皆pass、afterClose signal尚未aborted而最後aborted／AbortError；原失敗未重現，不宣稱檔案延遲或產品缺陷為已證明原因，診斷不作一般QA。只將同一真中止斷言移到close後、釋放延遲回應前，finally仍釋放並await handled；同一waiter位置、10秒限制、原abort/cancel斷言及其餘UI／11-table／focus斷言保持，不增加route.abort或產品修正；唯一片段反向SHA驗回sealed034。final-resumed-qa的E204僅announcement-history腳本不同於D，source141 actual0；E批十三套192 gates成功，certification-attachments在第十二段後真requestfailed的10秒等待逾時actual1，failed batch／child／raw保留不驗收，十二個已記錄關卡不是完整15關驗收；未執行的service-history與assessment-history不推定通過。獨立證照附件取消診斷兩模式皆通過，immediate模式afterClose已aborted、hold模式尚未aborted，最後兩模式皆aborted／AbortError且沒有晚下載；原失敗未重現，不能把同步競態或產品失敗當作已證明原因，診斷不作一般QA。只將同一真中止斷言放在close後、釋放slowFile前，finally仍釋放並await handled；waiter位置、10秒、原abort/cancel及零lateDownloads／focus／11-table斷言保持，不新增route.abort或產品改動，唯一片段反向SHA驗回sealed034。未執行的service-history另經靜態發現同一close→release→await真取消的順序，主動只改單一同步片段，waiter／10秒／原abort及其餘focus／11-table保持；沒有觀察本輪該suite失敗，不虛構failed child，相關診斷只作參照且非一般QA。其同步反向還原E，再反向原intent及label適配精確還原sealed034，完整12關在F fresh驗收仍必須通過。final-attachments-corrected-qa的F204僅certification-attachments及service-history兩腳本不同於E，fresh source141與完整串行三剩餘舊套40 gates actual0，承接B7／96、C6／82、D5／76、E13／192共31套446 gates成功子process，逐個驗證runtime／自身腳本／helpers消耗bytes exact，合成34舊套486；28舊稿exact、6必要適配。不得宣稱同一批34套全fresh、first-pass或全部204最終來源重跑full／newbrowser。文件八檔更新後的204hash另外封存，未在metadata後重跑all204 QA。

僅合成本機驗收；本輪actual4310未restart／reload／登入／probe／驗證或寫資料，既有程序是否載入本輪UI未驗。未執行CI、部署、人工UAT、原生OS popup幾何／鍵盤選值、正式工時／薪資／支付／定位／申報／評分／介接／外部訊息。原180功能全量對照未核定；RM-03仍partial。legacy reports非字串日期month500未修，0.36僅未凍結候選。先前certification附件偶發reopen原因未明，通過迴歸不證明修復。

忙碌鎖定、dirty／Escape、錯誤保留輸入與完整user/org/role/employee/hash/render guard、signal保持。失效清空／關閉、中止並忽略晚回應。桌機／390px、鍵盤focus與表格自身橫捲已按實際browser驗；OS原生popup及人工UAT仍未驗。


## 費用／薪資試算回應確認（0.37，本機已驗證）

依 docs/LEGACY_FINANCIAL_REPORT_CONFIRMATION_SCOPE.md，admin.js 費用／薪資沿既有 load、完整 context、sequence、月份與類型記憶。由 shared 純確認函式確認完整 DTO／精確合計，再呈現原列順序及快照金額；未知2xx清除舊列、沿 ui.js errorState inline alert／重新讀取，CSV停用。重試保留查詢條件，零金額／空報表合法。價格、時薪、補助及正式薪資不由畫面重算。薪資無月份／組織回顯不能宣稱完整查詢身份驗證；CSV仍是獨立fresh GET，確認畫面不等於確認下載內容。沒有新增CSS/token/widget/controller/PDF，原生month/select及table內捲動保持。

DTO及BigInt合計確認不證明既有元formatter對大額整數分每分無損；精確格式列為0.38尚未凍結候選。


## 金額精確顯示（0.38，本機已驗證）

Canonical formatter：public/ui.js formatMoney，沿用兩個 financial row／totals 呼叫、zh-TW／TWD、兩位小數及 native Intl currency/group/sign。僅 primitive safe Number 分以 BigInt 整元／餘分及 Intl parts 無損呈現；primitive -0 原正零，小負分留負號。所有其他輸入與原 Number(cents || 0)/100 fallback／coercion／exception 完全相同。未改 CSS/token/widget、backend、admin 或 formatTrialPriceCents。

依 docs/FINANCIAL_REPORT_EXACT_CENTS_SCOPE.md；列值與合計一致、390px 表格自身捲動／文件無水平溢出，invalid 2xx／重試及 JSON/CSV Abort、角色／機構隔離、價格快照沿0.37。畫面精確保存分不宣稱後端計算精度或正式薪資／支付規則。CSV 原始分與 fresh GET 保持；本輪fresh Node624、149 JavaScript、38套browser534聚合關卡及45張實際圖片檢視通過。0.37限制段落保留作歷史；本輪只修顯示，後端預格式計算與正式規則不由此核定。


## 公告本人閱讀回執（0.40，本機已驗證）

依 docs/ANNOUNCEMENT_READ_RECEIPTS_SCOPE.md，沿唯一 listPage、openDetails、table、pagination、createForm、errorState 與 toast。openDetails 的 readAcknowledgement opt-in 擁有提交忙碌、錯誤重試、Escape、focus、Abort 及完整 context/render 失效；原 caller 的預設流程保持。閱讀全文沿原字串 pre-wrap，不執行原文中的 HTML。只有本人明確操作且精確目前版保存回應確認後才顯示成功；未知結果保留原文，人工重試同 payload／同鍵。管理者與督導以每頁25筆、精確正整數版次查詢實際保存的閱讀姓名、角色與時間，不推算應讀、未讀或完成率。CSS、fonts、tokens 與原生控制項保持；桌機／390px、鍵盤、表格自身捲動與錯誤路徑經本輪 fresh 瀏覽器驗證；詳本輪verification。僅本機合成切片完成，不等同正式簽收、CI、部署或人工UAT。


## 班表週／月日期檢視（0.41，本機核心已驗證）

沿 docs/SHIFT_CALENDAR_SCOPE.md，openDetails guardedRead opt-in 共用序列reload、busy、Abort、Escape及focus；預設caller保持。createForm擁有三欄／field errors與submit，日期唯讀typed YYYY-MM-DD支援0000；不新造picker、controller或observer。週／月切換保留anchor，輸入撤銷舊結果與導航；錯誤保留條件。同一完整報表fresh GET重新驗權，日期索引只focus/scroll同一每日agenda；十一欄原字串及版次完整呈現，390px同一DOM及表內橫捲。無新API或寫入，核心驗收證據已保存；原生選單鍵盤選值仍待人工驗收。

0.41核心fresh驗證通過：日期文字欄真鍵盤輸入、Enter查詢、Tab／label焦點與日期索引同DOM跳日。兩份獨立原生選單探測僅記錄headless環境限制；原生select鍵盤選值、OS popup幾何、人工UAT及完整WCAG符合性仍未驗，不以selectOption或圖片代替。

## 班表個案／人員篩選（0.42，本機核心已驗證）

依 docs/SHIFT_CALENDAR_PERSON_FILTERS_SCOPE.md，business adapter 沿原 openDetails guardedRead 的唯一 signal／序列 reload／busy／context／Escape／focus。名單逐頁及完整確認由 business pure owner 擁有，沒有第二 controller 或共用 ui.fetchAll；lookup 任一失敗不展示部分／舊結果。native createForm 保留 disabled select 值，失效 ID 加入精確 option，help 立即說明、提交沿 e.fields 的 aria-invalid／描述／focus。草稿撤下舊結果，今天／翻期保持 ID；完整名單成功而413可縮小，不自動轉全部。無 common widget／CSS 改動。桌機／390px、新13張圖片與15聚合 browser 關卡已驗證，相关 sibling 17張另檢視；原生選單鍵盤選值、OS popup、人工 UAT及完整 WCAG仍未驗。

## 班表完整報表銜接（0.43，實作中）

來源 docs/SHIFT_CALENDAR_REPORT_HANDOFF_SCOPE.md。shared report-view 的 readCompleteReport/openReportPreview 擁有 fixed-filter 完整讀取與 opt-in CSV；既有七報表 preview 共用預設 downloadable=false，外部 CSV 保持。ui.openDetails 唯一擁有 preview reload/print/cancel/focus；calendar 不增 controller。每次 fresh report 嚴格確認後才啟用列印；空／錯誤必 throw。CSV controls/status data-no-print，每次 load abort 前 transfer，每個 await 與 link.click 重驗精確 body/identity/signal；舊 finally 不碰新狀態。只在外 calendar confirmed section 保持連線及沒有 draft 改動時提供入口與 caller current；不要用新 preview body 當 preview current。nested native dialog 提供 inert/focus；Escape／close 回入口及原條件。角色、API、schema 與 pricing 不变；0000/9999 仍字串區間，無 URL/storage 傳送。尚待驗收。

## APM CIS 與入口登入（2026-10-10）

沿 docs/APM_CIS_SSO_SCOPE.md：300px 桌機側欄／1024px mobile，APM 原標誌與暖橘 tokens。唯一樣式 owner styles.css，表單、選單、toast、報表與歷程 owners 保持。手機側欄使用共同 openDetails/native dialog，Escape 和焦點回復沿共同機制；mobile 安全區保留內容與可點操作。Portal 模式以伺服器 setup status 提供的 fixed URL 導向入口，不另顯示本機 password form，失敗仍有可理解文字與入口連結。登入後原 session／機構選擇／role 導覽不依 signed client role。回入口是明確 link，不登出其他模組。


## 個案暫停與結案追蹤（0.46，本機已驗證）

business 與 API 輸入／父個案授權來源為 docs/CASE_STATUS_FOLLOWUPS_SCOPE.md；四既有角色沿可讀個案，管理者／督導維護。獨立 panel 的 q/kind/status/25筆分頁只留記憶體；載入與錯誤重試不替換周圍個案詳情。共用 openForm、confirmAction、history/openDetails、searchBox、pagination、errorState 及 toast 為 canonical owner，沒有 screen-local widget 或 CSS。新增／編輯只在九欄及 id/org/version 保存確認後成功；未知結果保留輸入，相同 payload 新增重試沿原冪等鍵，改 payload 才換鍵。編輯只送變更欄，異常原值留 private adapter，需要取代／選填清空時明確意圖；父個案固定不可編輯。取消追蹤使用共用影響確認並保留歷程，重新追蹤亦沿相同保存確認；追蹤狀態不改目前個案服務狀態、計畫、班次或核閱快照。完整 user/org/role/employee/hash/render context、Abort/busy/dirty/Escape/focus 沿共用 owner，晚回應不顯示舊 context 的成功或重讀。本機runtime、新13關及桌機／390px新14張圖片已驗證。已取消紀錄的編輯保持原狀態，恢復須先沿共用confirmAction；錯誤、busy／dirty與晚回應驗收保持。


## 面試者登錄與紀錄（0.47，本機已驗證）

依 docs/INTERVIEW_APPLICANTS_SCOPE.md。唯一 CRUD owner 為 admin.js:listPage，confirmList／dateFilter 僅新 caller opt-in，原 q／status／分页／current context／Abort 與其他caller預設保持。shared openForm／confirmAction／history 擁有表單、busy、dirty、Escape、focus與現在context；新 pure adapter 只管理八欄保存意圖、差異及 exact ack，新 POST 同payload重試沿原冪等鍵。原值 unsafe 時保持／明確取代／選填清空；啟用停用由共用確認，未知保存不成功關閉；不新增controller。admin／supervisor機構隔離，finance／caregiver不能讀取名單或歷程。 必要整合與新13關browser、桌機／390px新16張圖片實際檢視完成；正式列印與人工UAT仍待核定。


## 督導訪視查詢（0.48，本機已驗證）

依docs/SUPERVISORY_VISITS_SCOPE.md，唯一admin.listPage擁有endpoint／caseFilter／dateFilter變體、25筆搜尋篩選、query echo確認及loaded/pending context撤除。readonly保存内容使用唯一openDetails guardedRead/freshsingle，歷程仍assessments的sharedhistory，不縮減合法舊模板／父個案歷程。q只十own string答案，date僅填寫日期；不是臨床訪視日或期限判定。條件只記憶體，錯誤／重試保持選擇，失效ID不轉全部。全部非寫入，只往既有評估表單填寫。必要整合、新12關與桌機／390px16張圖已實際驗證；不宣稱正式輸出或UAT。


## 多組聯絡人安全編輯（0.49，本機已驗證）

依 docs/CONTACT_EDIT_SAFETY_SCOPE.md，沿既有多組聯絡人 section、唯一 ui.js 表單／確認／歷程、APM CIS 與 styles.css token。原十業務欄保存由 pure editor 及完整情境守門；只傳明確變動、新送字串沿原 trim、未知值明確保持／取代／可選清空，成功需 exact 回應。原生 select 接受 OS popup，敏感篩選只在記憶；不新增 CSS、控制項 owner 或後端規則。必要整合、新14關與桌機／390px16張圖已實際驗證；正式UAT及部署未驗。


## 人工追蹤查詢（0.50，本機已驗證）

依docs/CASE_FOLLOWUP_WORKLIST_SCOPE.md，重用唯一admin.listPage、table／searchBox／pagination／errorState、openDetails guardedRead及history；listPage僅opt-in kindFilter，其他caller預設保持。APM CIS與styles.css tokens保持。五條件僅記憶體，人工追蹤日期不推算期限；完整primitive情境撤除loaded／pending結果，fresh內容與型別標記、精確前版及父個案維護連結沿原授權。必要整合、新14關與桌機／390px16張圖已實際驗證；36+6+6情境、Escape真正abort及原因／備註最後文字Range受檢。正式UAT與部署未驗。


## 個人行事曆人工事件（0.51，本機已驗證）

本人owner由server決定，admin不能代理；沿canonical清單與表單／歷程，raw搜尋文字只由新calendar caller opt-in保留。只送變動六欄，異型原文保持／明確取代與未知狀態修復；exact ack及完整outer／primitive／hash／render guard，失效撤除abort、不宣稱已提交交易回滾。 必要整合、新14關与桌機／390px16張圖實際驗證；長備註末句與footer可讀性受檢。原生OS popup、正式UAT與部署仍未驗。


## 本人事件月份閱讀（0.52）

來源 docs/PERSONAL_CALENDAR_MONTH_SCOPE.md／docs/API.md：四角色self-only與完整月份有界回應。UI影響：原/personal-calendar同頁按鈕→canonical guardedRead openDetails→createForm明確查詢，草稿變動撤除舊結果／停用導航，失敗保留條件並可重新讀取；上下月／本月只用已確認條件。原文q附clear，typed月份YYYY-MM及native status沿既有決策。桌機重用日期索引／daily table，390px沿既有隱藏索引、保留完整每日agenda；長文不截斷。shared焦點／Escape／abort／完整ctx/hash/render及outer失效由原owner管理，不建平行controller。沒有新寫入、輸出或第二登入。


## 需求評估保存查詢（0.53）

來源 docs/NEEDS_ASSESSMENTS_SCOPE.md及docs/API.md：admin/supervisor目前org＋可讀父個案。UI影響：新/needs-assessments導覽→既有listPage；q保留空白原文、日期只metadata、exact caseId含closed及missing selection保留，明確清除。唯一shared guardedRead details重新GET九題與原歷程；無新提交或匯出。失敗／不可信2xx撤去舊結果，保留條件可手動retry；loaded/pending六種primitive／hash／render／outer失效清空abort，nested同primitive保持，晚回應不復活。390px表內橫捲、末句完整可讀；焦點／Escape／loading由原canonical owner管理，無平行controller或第二登入。


## 附件描述安全編輯（0.54）

来源docs/ATTACHMENT_METADATA_SAFETY_SCOPE.md：附件section→metadata openForm／獨立status confirm→原section重讀。no-op零PATCH；成功須精確scope/next版本/描述/own-presence/原file四欄確認，異常2xx/409/422/斷線保留draft。PATCH沒有idem，commit後ACK未知原版重送409不可自動覆蓋；重新讀取及歷程確認。user/org/role/employee/hash/父render及outer重建清空abort晚回應不復活，nested同primitive保持；list/page/scope確認與型別標記。沿原upload/replace/download/history/CIS/shared UI，長備註真捲動與footer視檢，沒有新CSS或第二登入。


## 本人事件年度閱讀（0.55）

來源docs/PERSONAL_CALENDAR_YEAR_SCOPE.md／docs/API.md：原/personal-calendar年度按鈕→唯一guardedRead openDetails→createForm明確查詢全年本人六欄原值。year四碼及literal q／native status仅modal記憶；清除搜尋撤去結果並回q焦點，草稿变更即停用前後年／重讀，明確查詢／手動retry保留條件。0001／9999越界停用並說明，月份索引以heading焦點定位；390px完整十二月agenda／長文不截斷。loaded/pending primitive／outer／hash／render／連線失效清空abort晚回應不復活，nested同primitive保持，Escape／關閉／回焦由shared owner管理。沒有新寫入、匯出、下載、歷程、巢狀月份操作或第二登入。

## 個案保存紀錄索引（0.56，本機驗收完成）

來源 docs/CASE_RECORD_INDEX_SCOPE.md 與 docs/API.md。管理者／督導個案頁按鈕→唯一 guardedRead openDetails→原生紀錄種類 select 與 createForm 明確查詢→25 筆 metadata table／pagination→既有 openRecordHistory。初次開啟不自動查詢；草稿變更即撤去舊結果並停用分頁／歷程。錯誤與不可信 2xx 保留條件並提供手動重新讀取，不呈現舊索引。

loaded／pending 的本人、機構、角色、員工、hash、父 render 與外層 context 失效清空並 Abort，晚回應不復活；相同 primitive 的巢狀參考替換保持。主視窗關閉或條件撤除亦使巢狀歷程失效。原時間文字與長 ID 保持完整，桌機／390px 使用既有表內橫捲；Escape、取消與回焦沿 canonical owner。必要本機瀏覽器／桌機與390px視覺驗收已完成；不新增 CSS、dialog controller、第二登入或業務寫入。

## 視覺改版 0.57（本機驗收完成）

同一套 APM 品牌、logo、外框與 shared components。首頁先呈現今日實際服務與角色可用的下一步，原四統計保留在下方；財務首頁 CTA 導向可授權報表。四組導覽保留全部 route/name/canView。原生 decorative SVG 由 public/icons.js 唯一所有，全部 aria-hidden，不參與 accessible name。個案區塊捷徑只移動主頁現有標題焦點及捲動位置，完整 context guard，不新增 API。

主要動作與表格按鈕至少44px，手機表單字級至少16px。鍵盤跳至主內容保留目前 route；native dialog 的 Escape、焦點回復與表單保留沿原 owner。長表與所有報表沿自己的橫捲、原 A4 geometry。照顧/服務四欄首頁沿一份語義 ul/li responsive呈現，沒有 duplicate hidden table。

驗收證據由 tests/visual-refresh-e2e.mjs 配合所有 configured commands、嚴格靜態檢查及相同合成資料桌機/手機 Before/After 實際像素構成；文件的實作與正式發布狀態分開記錄。


## 員工保存紀錄索引與共用索引 owner（0.58，契約）

唯一public/modules/record-index.js承接原個案索引的查詢、重新讀取及分頁，原case-record-index薄caller四類預設保持；employee-record-index薄caller新增三類業務variant。沿ui.js guardedRead openDetails、createForm、table、pagination/errorState與history.js單筆歷程，原schema、角色、CRUD及SSO保持。員工列只有admin/supervisor新增保存紀錄，既有證照／訓練／員工主檔歷程保留。

敏感父項及query只在記憶；草稿變更撤結果，合法完整echo/metadata確認後才呈現。manual retry不自動error重送；合法超後頁一次last-page重讀沿原case behavior。讀取/loaded/context/hash/render/outer失效清空Abort、晚回應不復活、nested相同primitive保持。現在歸属此員工不代表所有過去版本都屬此人，原history授權保持。沿v0.57 APM、native labelled select、44px操作與wide dialog/table內捲；不改styles/token或再造dialog/controller。必要整合與真瀏覽器證據由本輪接受收據另列，不由契約文字推定通過。

本輪0.58必要合成驗收完成：1,144程式／最低Node85／250JS、十一套瀏覽器136項、九張新PNG實看；原個案索引與APM／合成HTTPS Portal回歸通過。strict沿已接受私人parser零finding，原官方auditor20秒逾時保留且不宣稱pass；DESIGN零error／10既有warning／1info。沒有正式部署或完整WCAG／OS原生popup／真實帳號UAT宣稱。完整來源文件於runtime驗收後更新，不將較早full-source map誤稱為最終文件hash。

## 面試者完整保存紀錄（0.59，契約）

沿 docs/INTERVIEW_RECORD_DETAILS_SCOPE.md：現有清單的「查看紀錄」以既有單筆 GET fresh 取得目前八欄原文及保存版次／建立與更新文字。detail-grid／pre-wrap 與 guardedRead openDetails 沿唯一共享 owner；全文不截斷、不解析日期／時間、不轉型未知 JSON，typed／missing／empty／null 分辨。名單啟停仍不代表錄取或到職。loaded／pending 完整 primitive／hash／父render／outer reference 失效撤除，人工重試只一個 GET；無新 CSS／token／表單／CRUD／server／schema／controller。

0.59本輪必要合成驗收：1,164程式／最低Node73／254JS、六套browser65項、十張新PNG實看；APM與合成HTTPS Portal及原面試CRUD／歷程回歸通過。strict沿已接受私人parser零finding，未重跑已知逾時的原官方auditor，原失敗與作者工具腳本失敗保存、不宣稱官方pass或first-pass；DESIGN零error／10既有warning／1info。runtime與tests保持335-source接受稿精確bytes；僅狀態及追溯文件在QA後更新，不把初始freeze全文件hash當成最終hash。正式主機／HTTPS／Portal／OS popup／人工作業UAT未完成。
