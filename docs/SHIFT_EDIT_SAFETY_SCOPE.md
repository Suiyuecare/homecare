# 單班排程安全編輯（v0.33，本機契約）

此切片沿目前 v0.32 的既有單班 API、機構／角色授權、不可變版本、計價快照與共同介面。只用合成資料；不是原平台全功能匹配或正式差勤核定。RM-03 維持 partial/unverified。未增加恢復、手動完成、批次改派、跨夜、假額、資格、額度、工时、支付或外部通知。

## 保存欄位與入口

九保存欄為 caseId、employeeId、carePlanId、date、startTime、endTime、services、status、note。七原控制項依序為「個案與照顧計畫、服務人員、服務日期、開始時間、結束時間、本次服務與數量、交班備註」。caseId 無獨立控制項；新增固定 status=scheduled，編輯不曝光 status。

保留三個新增入口：班表、照顧計畫生效列、個案詳情生效計畫列。只在班表的 scheduled 且無任何 service-record 列提供調整／代班和取消；不增加已完成、取消或已有紀錄的編輯／恢復入口。

## 無損保存

- 修改及改回原值都不覆寫原保存欄。carePlanId 未變時，同時省略 caseId，不用目前計畫的個案修復原班次；只有新增或明確換至不同可選計畫時，才從 captured plan 的可讀 caseId 派生。API 無 immutable-parent 限制。
- 編輯 services 全欄私有保持，不將原數量、異型或未知內文投影到控件。實際禁用 quantity 且 aria-disabled 同步，沿 ui.js 已有 preserveWhenDisabled opt-in；選「以本次輸入取代」才啟用。替換是完整 canonical 清單，1至100項、唯一可選 serviceItemId、數量正整數1至10000，無額外鍵、coercion或稀疏清單。控件0表示不選取。保持保留順序、重複、額外鍵、原型別及 own-presence，失效原資料仍交 merged API 拒絕。計畫數量不是班次数量額度。
- 換計畫不改 services 的保持方式，也不自動覆写保存清單。只更新「明確取代」時可選服務；新計畫不包含保持服務時，API 原 PLAN_SERVICE 拒絕。create 選計畫變更時沿原清空未保存的服務輸入；edit 重新建置替換選項時只保留目前输入中仍可選的數量，不帶入原保存清單，移除的未保存選項需可見說明。
- 計畫候選維持 active 且目前個案 active，加既有 current 可讀計畫；fixedPlan 新增只該計畫。新增預選 fixedPlan 或第一個合法計畫。員工候選 active 加既有 current 可讀員工。未知／異型 current 不改為第一項。服務候選仍為目前可讀 service-items 與所選計畫服務 ID 的交集，不新增 item.status/date 篩選；停用／失效由 API 拒絕。
- 不能無損預填的 missing/null/異型/CR/未知關聯/0000日期/ISO時段保持在 DOM 外，以保持／明確取代選擇。只有 note 可明確清空為空文字；note 保留 LF／空白，不 trim，明確新寫至多10000 UTF-16。保持超長原值不截斷。
- 原生日期只接受可無損表示的0001至9999有效西元日期；原生時間只接受有效HH:mm。不把合法原ISO裁成HH:mm、不轉秒／offset／時區、不以舊字串 timeOrder 推斷原服務時序。所有跨欄、計畫涵蓋、衝突、鎖定仍由原 server merged 驗證決定。
- 保存成功須九欄 own-presence、完整 JSON、id、orgId、安全整數下一 version 全部吻合。status-only 取消同樣確認其他八欄保持。未知2xx、缺欄、錯型／版本／身份回應、409／422保留輸入；不先 toast／refresh。

## 既有伺服器規則不變

timeMinute 接受HH:mm，或同保存date開頭且Date.parse有效的ISO，取字面HH:mm作minute，忽略秒與offset且不轉時區。end minute須大於start，毗鄰可、重疊不可。dateValid原允0000。

非cancelled需要 active個案與員工、同個案active計畫涵蓋日期、服務ID包含於計畫、員工及個案無同日重疊班次（completed也算）、無approved請假重疊。cancelled只跳過這一區塊，仍驗required、日期、references、services有效期及同日時段；取消失效資料仍可能422。全19後端、auth/schema/history/報表/計价寫入不改。

任意狀態的service-record存在時，以整欄JSON.stringify比對鎖caseId/employeeId/carePlanId/date/startTime/endTime/services/status，note除外。此檢查在其餘merged驗證後，測SHIFT_HAS_RECORD须讓先行條件有效。手動完成原REVIEW_REQUIRED；實際完成沿核閱。

admin/supervisor可寫；finance原唯讀API且無班表入口；caregiver只自身班次唯讀。current caregiver不限班次狀態。所有角色歷程逐版case ACL，caregiver另逐版自身employee；精確version−1缺口不跳版，核閱actor沿shift.complete。不cascade關聯主檔、紀錄、檔案或已核閱費薪快照。

## Canonical介面與失效

唯一owner仍operations/renderList、ui/openForm/confirmAction、history/openRecordHistory。新增與編輯沿POST同鍵冪等／PATCH原CAS；所有三新增入口、列表編輯、取消以完整user/org/role/employee/hash/render/container guard保護loaded/pending，失效abort／清空／關閉，不使晚回應復活。真提交後abort不代表回滾。沿既有busy／dirty／焦點／Escape／內捲／native select/date/time；不新增controller、CSS或tokens，不重寫服務紀錄／週期排班流程。單班列表只追加安全保存投影，全球serviceSummary、timeRange與其他模組不改。

## 驗收門檻

有意義pure／HTTP／真Chromium測試：九欄七控制項、單欄變更／改回、省case/status、三態note、所有不相容值、ISO/0000私有保持、整services保持與替換、動態計畫交集、同案及跨案改派、超計畫數量仍合法、server時間分鐘／毗鄰與跨夜、員工／個案／approved請假衝突、各狀態紀錄鎖定及真競態、四角色／跨機構／逐版缺口、CAS／冪等／完整ACK、dirty/busy/focus/Escape、三新增入口與loaded/pending完整context、真已提交晚回應。

讀區段核全十一表零寫；必要寫批次對帳total_changes，非shifts主檔與BLOB、六immutable triggers及核閱快照保持；核31既有報表出口及四BLOB下載。32個既有browser套件保留全部原驗收門檻；其中31個腳本保留原bytes，shift-history僅在原數量輸入前追加明確servicesIntent=replace，沿新核定的全欄保持／取代控制方式，保留原12個驗收門檻與全部既有斷言。新畫面及必要共享流程畫面逐張檢視，root subset不重加。沒有新PDF／marker，七artifact的72指定已封存參照只作SHA核對，不宣稱重看所有歷史複本。

完成必要整合、浏览器、fresh static/design audit與獨立追溯覆核才標implemented_verified；保留每次首次失敗，不自動重試。既有4310只做匿名GET／PID／十一表及六trigger唯讀基準與終驗，不restart／seed／登入／寫資料。新後端若有規則問題需獨立範圍判定，不能弱化守門。OS原生popup幾何與headless popup鍵盤選值、人工UAT及正式上線不宣稱已驗。

首次瀏覽器失敗保留為未通過證據：新切片的慢lookup測試在已位於同一URL時使用goto而未重新載入，故未發出測試預期的lookup；修復僅對同URL分支明確reload。既有shift-history原數量輸入遇到核定的私有keep禁用控制，修復僅追加明確replace。兩者不修改產品、全19後端、ui.js、CSS或既有验收斷言；只在root明確授權並凍結新來源後執行新的驗證分支，沒有自動重試或覆蓋首次失敗。

第二次新瀏覽器驗證因顯式匯入的物件型shift.date觸發原API月份篩選的startsWith型別錯誤而失敗，原失敗及500保留且不得視為通過。後續瀏覽器私有日期fixture改用null，仍核六個原值保持／取代控制、完整ACK與全上下文；這不代表物件日期的月份列表已支援或後端缺陷已修復。物件日期直接merged PATCH的422拒絕另由HTTP案例驗證，正常新增payload仍拒絕非文字日期。原月份列表缺陷列為本切片限制及獨立待辦，不能透過放寬unexpected500或修改正式資料隱藏。
