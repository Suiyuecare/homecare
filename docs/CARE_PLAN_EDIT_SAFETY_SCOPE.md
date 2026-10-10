# 0.32 照顧計畫安全編輯：凍結實作契約

> 公開版本文件：記錄此功能版本的設計與驗收條件，並非目前公開副本已執行的驗收證明。私人盤點與 QA 產物未匯出；現行行為以 API.md 與原始碼為準，正式規則及部署仍須核定。

本輪是既有本機合成系統的照顧計畫安全編輯與保存確認；不是正式照顧計畫表、額度引擎或原平台全量複製驗收。原十九後端、API 權限、資料驗證、版本與稽核機制保持。僅新增純 editor adapter，窄接既有 operations 照顧計畫表單／狀態動作及必要計畫專屬安全呈現；共用 services 控件只加入下述有限 opt-in。不得改其他 editor、排班、服務紀錄、報表、附件或歷程授權規則。

七個保存欄位依原 schema 為 caseId、validFrom、validTo、status、services、goals、note。新增七控制項沿原順序與標籤：個案、生效日期、結束日期、計畫狀態、服務項目與計畫數量、照顧目標、計畫備註；新增狀態僅 draft／active，預設 draft，生效日期採合法 native defaultDate，結束日期空，服務空清單，兩描述欄空字串。新增送齊七欄。編輯六控制項不曝光 status，狀態只由原獨立確認動作維護；不新增 ended 的 UI 恢復動作。原標題『新增照顧計畫／編輯照顧計畫』、draft 的『啟用』與 active 的『結束計畫』、確認標題及按鈕『啟用照顧計畫／結束照顧計畫』保持。詳情原有新增計畫入口、計畫歷程與新增排班保持，不新增詳情計畫編輯入口。

純介面 createCarePlanEditor({existing,cases=[],serviceItems=[],defaultDate,fixedCaseId}) 回傳 fields、initial、needsIntent(name)、enabled(name,values)、buildPayload(values)、confirm(item,orgId,payload)。不新增 helper onChange；operations 沿既有兩參數 onChange(values,helpers) 為控制項呼叫 setDisabled。私有保存投影只取七欄 own presence／JSON 與 id/orgId/version，不把完整 row、unknown keys、異型／複合原值塞到 DOM 或 initial。未改／改回原值省略，空、missing、null、false、0、字串／陣列／物件不得互相猜測。editor 不改傳入 row／options，也不能藉事後修改 fields、initial、caller row 擴增私有 membership 或改確認基準。JSON 必須可安全深拷貝；不接受循環、undefined、函式、非有限數值、sparse陣列或帶非索引額外屬性的陣列作私有原保存值，不使用 toString 異型 coercion。

caseId 原 API 可更換成同機構 cases，沒有不可變父項規則，也不要求 active 才能保存計畫。UI 保持原 active cases 加目前已指派且可讀個案的選項集合；已指派 paused／closed 可保留，未知或不可讀 ID 不新增選項、不回退第一項。新增 fixedCaseId 只有在當前新增可選 active 集合才預填，否則空。選項安全文字只由可讀字串案號／姓名建立，異型固定提示，不展開其內容。原 caseId missing/null/異型／無法表示的字串私有保持，必要時明確取代成目前集合；不可清空。保持仍由原 merged REQUIRED／INVALID_REFERENCE 決定結果，不以 editor 繞過。

原 validFrom／validTo 均必填，API dateValid 支援合法 YYYY-MM-DD，含 0000 年。native 只允許 0001..9999 有效日期無損預填；0000、CR/LF、missing/null/異型或非法日期一律空控制項、禁用、私有保持，不截字或換年。明確取代只能有效 native 日期，不能清空必要日期；日期順序仍由原伺服器 merged DATE_RANGE 判斷（editor 可在兩端皆可判讀的預期保存值上提示，但不猜非法原值）。正常 API 可寫入的 0000 日期不是匯入異常。goals／note 沿原文字最多10000 UTF-16、無 trim；LF textarea 可原樣預填，CR／CRLF 或 missing/null/非文字保持於 DOM 外。兩欄不相容時才提供 keep『保持原值』、replace『以本次輸入取代』、clear『明確清空』，clear 保存空字串；新送值不得截斷。其他不相容欄僅 keep／replace。intent name 為原欄名＋Intent，label 為原標籤＋『處理方式』。

所有編輯中的 services（包括正常 canonical array）一律整欄私有保持。servicesIntent 預設 keep，label『服務項目與計畫數量處理方式』，只有 keep『保持原值』／replace『以本次輸入取代』。數量控件初始空清單且實際禁用，不投影既有服務的一部分、不排序、不去重、不丟 extra keys、不由異型 ref 猜 ID。保持即省略 services，精確保存原 own presence／順序／重複／額外 JSON／scalar／非文字 ref／unknown 或 inactive ID；這只保證請求不覆寫，原 merged 驗證仍可能 422，不能宣稱非法舊 services 可成功保存。服務目前名稱是 lookup 呈現，不回寫原 services。

明確 replace 才啟用數量控件，取代整個 canonical array。可選服務沿原 active 項目，加 existing array 內 own string serviceItemId 所指向的目前可讀項目；既有已引用 inactive 或超出日期的項目可選，其他 inactive 項目不加選項，unknown／非字串 refs 不擴權。計畫 API 原本不限制 service-item active／生效期；排班與服務紀錄仍依原各自驗證。原控件數量0代表未選，因此 shared values 只輸出正數列；helper 收到的 payload rows 必須1..100項，每項只有 own serviceItemId／quantity、ID為可選字串、quantity為安全整數1..10000、ID不重複。直接傳入0、負數、小數、數字字串、extra keys、unknown ref或空清單必須拒絕，不能默默修成合法。原保存與明確 canonical replacement 的 JSON 完全相同則省略；順序不同是整陣列更換。

共用 createForm services descriptor 新增 preserveWhenDisabled:true，僅此 opt-in 生效。原 group 與每個實際 quantity input 的 disabled／aria-disabled 在初建、setDisabled、fillOptions 後一致；表單 busy 既有 snapshot／restore 不因這個 opt-in 丟失原 disabled。validation 僅在此 opt-in services 已 disabled 時跳過空清單與數量驗證；啟用或沒有 opt-in 的原所有 services 控件仍完整驗證，0仍表示未選。不得新增第二套服務 widget、放寬 submit 時的數量檢查或影響原排班／服務／週期排班控件。

保存沿原 openForm／confirmAction、dirty、focus、busy、AbortSignal 與完整 current identity（user/org/role/employee/hash/render stamp／container連線）。保留原 POST 同一表單 Idempotency-Key、PATCH version CAS；真伺服器先提交後取消／context失效不代表回滾。只有 plain item 的 id/orgId／正確安全 next version，加七欄 own presence與精確 JSON 保存投影吻合才顯示成功／重讀。新增須 version1及七欄皆有；編輯／status-only確認原未提供欄仍須缺省，不能自動 null/''。排除 timestamps、衍生顯示或 lookup name，不把它們當八個保存欄。無item／2xx錯誤identity或欄位／JSON body中斷／403／409／422／503皆保留輸入與意圖；失效不能晚顯成功或重讀舊頁。status-only動作不改原 case/date/services/goals/note。

PLAN_IN_USE 沿原 server：僅已有 scheduled 班次才限制更換 caseId、使status非active、縮短日期至不涵蓋該班日期，或移除該班使用的 serviceItemId。它不比計畫 quantity 和班次 quantity，不累計使用量、不限制額度、不新增分配資格。只改 goals/note、涵蓋日期延長、保留所有必要serviceId的數量更改可通過原規則。completed／cancelled 班次不觸發此鎖；completed 必須由真核閱完成，不手動 PATCH 製造完成。fresh status／edit提交須接受伺服器當時重新驗證，不依先前列表快照推定可改。計畫更換或結束不 cascade 改個案、聯絡人、附件、班次、服務紀錄與已核閱計價快照。

admin／supervisor維護。finance原 plan GET／history 可讀但不能寫，不新增/plans入口。caregiver原 current plan依目前自己所有班次所涉case（含completed/cancelled、無日期限制）可讀且不能寫；只有caregiver的歷史逐版再限該snapshot.caseId目前可讀，不要求等currentcase。admin/supervisor/finance目前可讀後保留同org的原計畫歷史，不新增全角色歷史父項過濾。raw／compare範圍相同，精確v−1缺版不可跳，actor依原確切稽核。缺／異型個案與服務關聯的表單或計畫列表／詳情必要投影不得拋錯或展開私有值；僅計畫專屬固定提示及own已知狀態標籤；unknown非空status字串或非文字固定「狀態未取得」，空／未提供為「未提供」，不泛改其他實體、shared serviceSummary 或歷程純模型。

驗收先作者 pure／真HTTP測試，完整產品凍結後才執行。涵蓋七欄create、原選項/新選值、未改與改回、所有私有keep／明確replace／兩optionalclear、services全值順序／extra／duplicates／unknown／inactive、date0000／CRLF、seven-field confirmation矩陣；真合法同org換案、原 merged errors、scheduled鎖定／race／數量不當額度、completed/cancelled不鎖、CAS／CSRF／POST同鍵、四真角色、28版25+3與逐版case缺口。瀏覽器由獨立擁有者建立新script；30既有script位元保持，history既有驗收目標保持，但因編輯服務預設whole-keep，必要fixture先明確選replace並重建原完整清單；首次失敗另存；包含原plans新增／編輯與case detail新增、狀態、busy／dirty／keyboard、1440／390、長文真末段、services keep禁用/replace啟用/回keep及失敗復原、24 loaded/pending edit/status×六context與兩真先提交晚回應分列。

全部使用 :memory: SQLite／隨機本機port／合成資料。required異常、複合JSON、缺parent等必須明示INSERT-only memory import，不能當成正常API產生；不得UPDATE／DELETE不可變歷史。十一表唯讀區間與必要寫入分開，雙非空合成BLOB四份目前／版本下載、六不可變trigger、核閱費薪快照及31報表出口保持，另核不cascade關聯。正式附件needs_contract、人工UAT、OS-owned popup幾何或headless原生popup鍵盤選值、正式額度／CMS／給付／積分／資格與全量匹配均不宣稱已完成。

model僅加非空關聯參照必須為字串的型別守門，沿同一INVALID_REFERENCE／422拒絕，不寫資料、不新增業務規則或放寬權限；undefined／null／空字串沿原空值語意。false／0／數字／object／array均不能bind。新HTTP同一驗收列擴充異型矩陣，新browser精確驗422與省略caseId，所有未預期500仍拒絕。新長文fixture搜尋必須使用實际已保存的唯一目標片段；保留其首次查無結果終止。最終完整來源重新凍結、整合與browser通過後才驗收；不把首輪521／14新browser gates或部分old31當成最終成功。
