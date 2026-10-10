# 居家照顧視覺整理契約

本輪以督導的每日調度台與居服員的工作簿為設計中心，讓使用者先看見今日安排、可執行工作及目前機構。只整理既有介面的視覺與資訊層級；不增加正式業務規則或新資料操作。

## 保持項目

沿 APM 歲悅透明標誌、品牌橘色 #EA880C、深棕正文及臺灣黑體。標誌檔案、桌機 300px 側欄／82px header、1024px 切換點與 mobile drawer 保持。public/styles.css 為唯一樣式與 token owner；public/ui.js 為表單、閱讀視窗、確認、搜尋、table、toast 與焦點／dirty／busy／Abort 的唯一 owner。

所有既有 route 與頁名、canView 角色政策、API 路徑與參數、payload、CAS／冪等、歷程、價薪快照、登入／session／Portal 及機構選擇保持。導覽隱藏不取代伺服器授權。資料以目前授權範圍讀取；不推算 urgency、完成率、正式時間、資格或核銷結果。不引入第二個 drawer、controller、遠端圖示或新字型。

## 小範圍 owner

- public/app.js：原路由導覽的四組分類與本機 SVG；首頁原資料的 task-first 編排、角色安全 CTA、快速入口及 await 後原 context／父容器連線守門。
- public/icons.js：以 createElementNS 產生裝飾性的本機 stroke SVG，不 import ui.js、不用 innerHTML；文字標籤繼續提供 accessible name。
- public/styles.css：由主代理統一調整間距、文字層級、表面與操作強度。不得新增平行樣式系統。
- 個案 section 定位由主代理另做窄 caller 改動；沿目前 DOM 焦點／捲動，不新增改寫資料操作、不用會變更 case route 的 hash anchor。

## 首頁與導覽

導覽按日常照顧、人員與機構、紀錄與報表、系統管理分組；每個原 route／label 均保留，各角色看到原 canView 允許的全部入口。無可見入口的分組不留下空標題。sidebar、mobile bottom nav 與公告均沿同一 icons owner。

首頁仍使用原 GET /api/dashboard?date=、cases lookup、employees lookup，不新增請求。主要 CTA：居服員「查看我的服務」，管理者與督導「查看總班表」，財務「查看作業報表」；均只指向既有 canView 允許的 route。原今日日期／機構／角色以文字呈現。

今日服務安排使用單一原生 ul／li 語義清單，每列保留原時段、個案連結、服務人員及狀態值與原 lookup；桌機由 CSS 排為四欄，手機依時段、個案、人員與文字狀態分段排列。沒有重複或隱藏的資料表。空資料沿共用 table 的空狀態分支與原文案。接下來的工作沿原待核閱筆數與角色可用入口。原四項 counts 與原 hint 完整保留於較安靜摘要，不增加百分比、未保存的提醒或假圖表。快速入口只連既有可用 route，沒有無作用的 widget。

概念排列：

    今日服務工作台                         主要操作
    日期 · 目前機構 · 角色
    今日服務安排（單一語義清單）             接下來的工作
    工作摘要：今日班次／待核閱／個案／人員
    快速入口（依原角色政策）

手機沿自然 document scroll，資訊保持完整，不以隱藏欄位或截短長文換取簡潔。SVG aria-hidden，不搶文字或鍵盤焦點。

## class 契約

首頁使用 dashboard-workspace、dashboard-context、dashboard-schedule、dashboard-next、dashboard-summary、dashboard-metrics、dashboard-metric、dashboard-shortcuts、dashboard-shortcut-grid、dashboard-shortcut 與 shortcut-copy。服務清單使用 dashboard-service-list、dashboard-service-row、dashboard-service-time、dashboard-service-case、dashboard-service-employee、dashboard-service-status。保留原 dashboard-grid、panel、section-heading、next-action；SVG 使用 app-icon，導覽保留 nav-icon。主動作仍為共用 button，連結仍為 a。

原「跳至主要內容」連結由 app 的單一 click adapter 阻止 hash 導航，將焦點與捲動交給目前 main#main-content。不修改 router、canView 或登入流程；主內容缺少 tabindex 時只補 tabindex=-1。

## 驗收與限制

作者先做 app/icons 原生語法與來源差異核對；主代理完成整合後以合成資料驗證四角色導覽／CTA、桌機及 390px、鍵盤／focus／drawer、loading／empty／error／慢回應／情境失效、長文與共用 sibling。品牌、auth、API、payload、history 等受保護來源必須逐一比對。本契約不表示該輪瀏覽器或像素驗收已完成。

只用隔離合成環境；不讀取或修改實際資料庫、環境秘密、私人 binding／備份、既有執行中的服務、DNS 或正式主機，不發布或部署。

## 視覺改版（0.57，本機驗收完成）

已完成 APM 品牌視覺整理：首頁優先呈現今日服務與角色可用工作，四組 SVG 導覽、清楚的表格／表單層級、手機服務卡片及個案七區塊捷徑。財務首頁導向可授權報表，鍵盤跳至主內容與選單列印保持正確。原 API、登入／SSO、機構角色、保存／衝突／歷程及計價快照保持。

本機合成驗收：1,112項程式測試、243份JavaScript、58個configured commands（56套瀏覽器）接受；四角色92個頁面組合、250個版面檢查、同一批資料桌機／390px共32張Before／After逐張實看。個案捷徑另驗28次跳轉、14次失效守門與46個唯讀區段。七種PDF列印已驗。保留首輪PDF工具環境與兩個測試setup失敗及受控修正；產品斷言未放寬。strict沿已接受私人parser零finding，原官方auditor逾時保存；DESIGN零error／10既有warning。

這是本機視覺與操作驗收；正式持久主機、HTTPS、Portal發布與真實業務UAT仍待完成，沒有原平台全量等價、正式薪資／支付／申報或完整WCAG宣稱。
