# 個案主檔安全編輯（0.31 獨立本機切片）

2026-10-09 凍結；cases-edit-safety-v0.31 / RM-02。沿既有 cases CRUD、機構隔離、角色、CAS、POST 冪等、個案版本歷程及個案總表。本輪只使用合成資料，不增加正式 CMS 評分、暫停／結案原因及區間、資格、支付或外部介接規則。

十四保存欄：name、caseNo、birthDate、gender、phone、address、status、cmsLevel、welfare、supervisorId、primaryCarer、contactName、contactPhone、note。原十三控制項不含 status，保留姓名／案號 text、生日 native date、性別 native select、電話 tel、CMS native number（min1/max8/step1）、督導 native select、注意事項 textarea 及其餘文字。新增固定 active；狀態只由詳情原暫停／結案／恢復服務動作處理。

createCaseEditor({existing,employees}) 是純 adapter；捕捉十四欄 own-presence／JSON 與 id/orgId/version 到私有保存投影，不把 item、未知欄位或原異型內容展開到 initial。十三控制項未改／改回即省略；missing/null/非文字、單行 CR/LF、備註 CR、無法 native 無損預填的日期／CMS／督導留 DOM 外保持。每個不相容控制項提供保持／明確取代；除姓名、案號外十一欄均可明確清空為空字串。保持不繞過原 merged 驗證，仍可能 422。

姓名與案號沿 cases 原規則，不 trim、不轉大小寫、不重新編碼；新送文字最多500 UTF-16字元、非空字串，空白原文保持。案號按原同機構精確字串唯一。其他新送文字最多500，note 最多10000；LF textarea 可無損預填，CR 原文保持在 DOM 外。性別保留原四個選項及原保存的安全未知字串（含既有 female/male/other 標籤），標籤只用 own lookup；未知字串字面呈現，非文字不猜成選項。性別與福利不新增分類或臨床判定。

生日 API 原 dateValid 接受有效 YYYY-MM-DD（包含0000年）。native 可預填僅空字串或0001..9999有效日期；合法0000年保持在 DOM 外、不轉年，明確取代沿 native 合法日期或清空。CMS 保存只對 safe integer1..8 或原空字串無損預填；number 空控制的 null 是表單空值，新增／明確清空轉為保存空字串，不能把原保存 null 當成空字串。原空字串以 initial null、未改先省略；新送只有限安全整數1..8或明確空，不 Number() coercion、不新增評分或容差。異型省略後原 merged 判斷依 server 實際結果，不宣稱全部拒絕。

督導 API 原規則僅驗同機構 employees 存在，不要求職務或 active。UI 保持原 active admin/supervisor 加原已指派且目前可讀者的集合（停用／職務變更亦可保持）；新選值只能來自這個集合，空值為尚未指定。原缺失、異型、不可讀或缺父項保存在私有投影，可明確取代成目前選項或清空；保持仍由原同機構 FK 決定是否422。primaryCarer 是描述文字，不當外鍵，不搬移或自動同步多組聯絡人。

列表新增／編輯及詳情編輯兩個入口，沿唯一 openForm／confirmAction、dirty／busy／native焦點。用個案專屬 current guard 捕捉 userId/orgId/role/employeeId/hash/renderVersion/container stamp/連線，查詢完成及表單 loaded/pending 都確認仍有效；傳 AbortSignal、captured id/version，不新增全域 controller 或改其他作業流程。成功須 plain item、id/orgId/安全next version及十四欄 own-presence／精確 JSON 保存投影吻合，才 toast／refresh。未知2xx／本文中斷／409／422／403／503保留輸入與處理方式，POST同payload重試沿共用同鍵、PATCH沿原CAS；真已提交後 Abort 不代表回滾。

暫停／結案／恢復保留原按鈕名稱、確認後果與 status-only PATCH，只增加完整 current/signal 及十四欄保存確認，安全文字名稱或固定稱呼，不展開異型原值。暫停／結案阻止新增班次，恢復後新排班仍核生效計畫；動作不 cascade 改多組聯絡人、附件、照顧計畫、已排班次、服務紀錄或核閱計價快照，不硬刪除。

admin/supervisor 維護；finance 可讀個案／歷程／總表但不能寫；caregiver 依目前自己的全部班次 caseId（含完成／取消）讀個案，paused/closed不自行撤 scope。個案歷程 current 可讀後依原同org/entity/record取歷史，不套人事紀錄的逐版父項規則，不額外查督導擴權。跨機構隔離、歷程相鄰版本／操作者、搜尋與25筆分頁及報表出口保持。共用 styles、十九後端、history/contact/attachments/plan/shift/record workflows 不變；共用 ui.js 只增加下方補充的 guarded busy Escape 保護。

只窄修個案列表／詳情自身的必要讀取投影：文字只接受原字串，不把清單展開為 children、不 String() coercion 異型物件；異型顯示固定未取得提示。姓名／督導名稱使用目前可讀安全文字或固定文案；生日只有原合法 YYYY-MM-DD 才沿 formatDate 顯示（0000保持0000），CMS只有1..8合法整數才呈現，原空白仍未提供。個案狀態 badge 只查 own 已知狀態標籤，未知字串字面顯示、非文字固定提示；不把未知值交給共用原型lookup。其他實體欄位／badge/textValue 不泛改。這些只改呈現，不改原保存內容與 API。

驗收含 pure 保存／取代／清空／own confirmation 全矩陣及 meaningful 真 HTTP：十四欄 create、無trim與精確唯一、version-only／可空／原merged422、0000生日、CMS端點、督導原參照、CAS／POST鍵、四角色。真 UI admin新增→sup列表及詳情編輯→暫停→結案→恢復、異型 private keep、所有新送欄與status-only確認、錯誤保留、dirty／native鍵盤／忙碌、1440與390長備註真正末段逐圖驗證。loaded/pending edit/status六context共24與兩真先提交晚回應分列；28版25+3、目前主責督導名稱與原CMS、最新個案總表及個案history/contact/attachment sibling。

十一表唯讀／必要寫入分段完整對帳，雙非空合成 BLOB 四份目前／版本下載、六不可變 trigger、核閱費薪快照及31報表出口保持；關聯紀錄副本另核不因個案編輯／狀態改寫。0新PDF／marker，七既有artifact72指定參照檔只程式核對，不新增人工舊PDF頁驗收。三十既有browser430個聚合gates沿0.30封存，collector須辨識 leave/certification/training安全切片 new-browser-work，禁止自動重跑。證照附件歷史偶發失敗原因仍未確認，本輪不宣稱修正根因。

基準0.30為181來源、24 prior proof及10505已存copy計數；不覆寫舊封存、不重掃全部舊內容，新186來源與證據逐份封存核SHA。actual4310／PID83631／DB不重啟、seed、清除或寫入；原180目錄列／16模板359題／四来源／九階段／12待核契約／0原completed／localReportKinds9保持，只完成獨立 localMilestone。原正式附件 needs_contract 不因安全編輯完成；headless OS popup幾何／鍵盤選值、人工UAT、正式规则及原全量功能匹配未宣稱完成。

0.31 第二次凍結補充：首次正式瀏覽器前五組通過，第六組在第三次忙碌 Escape 因 Chromium 原生 cancel 事件不可取消而失敗。原始失敗、兩份診斷與未採用的第一候選完整保留。最終候選只讓 guarded openForm／confirmAction 在 current 且 busy 時以具名 document capture keydown 阻止 Escape 預設行為，並在原 once-close 清理移除監聽；非忙碌、原 dirty／native 控制／context abort、角色及保存規則沿原行為。定向合成診斷確認兩表單六錯誤階段、狀態確認六次真 Escape、BODY 焦點、三次 context abort 及關閉後正常 Escape；instrumented 診斷不計入正式16流程或圖片驗收。

修正前的494 Node、127來源、30舊套件430 gates與當時唯讀本機證據均留作追溯。僅核准 ui.js 與此規格補充後，重新凍結53runtime／186來源，正式驗收需使用修正後來源的494 Node、127來源、30舊套件及16新流程、全部指定fresh UI圖片、唯讀本機與最終稽核；不得以修正前通過結果代替。
