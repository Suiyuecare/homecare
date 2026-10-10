# 面試者目前保存紀錄詳情切片（0.59.0）

狀態：契約已凍結，本機必要整合與瀏覽器驗收已完成；初始契約與來源凍結另行保留。接續已接受的 0.58.0；不改原八欄面試者契約、角色、機構隔離、CRUD 或版本歷程。本機完成不等於正式網站或 Portal 已發布。

## 功能與資料邊界

管理者／督導在既有 /interviews 清單每筆有明確「查看紀錄」。每次開啟只使用既有 GET /api/interview-applicants/:id，重新取得目前保存版次，不使用清單摘要作全文；伺服器保持財務／居服員先拒 403、同機構、跨機構／不存在 404。停用名單仍可查，名單狀態不是錄取或到職，不建立員工／帳號或核定任何人事規則。

外層回應只允許 own enumerable data descriptor 的 exact {item}；item 必須 plain object。要求 own enumerable data descriptor 的 id、orgId、version、createdAt、updatedAt；id 是路由允許的 [a-f0-9-]+、orgId 與 requested 精確一致、version 是正 safe integer、兩個時間為保存字串。接受 fresh 版次不同於清單版次；時間不解析、不推算。requested 同樣 exact {id,orgId}，確認失敗只顯示可重讀錯誤，不顯示任何欄位。未知 item 額外欄位不讀取、不遍歷、不呈現；已知欄位 accessor 一律拒絕，不執行 getter。

僅投影 name 姓名、phone 電話、interviewDate 面試日期、city 縣市、district 鄉鎮區、interviewContent 面試內容、note 備註、status 名單狀態。每欄分辨 missing、empty、null、non-text、text；文字包括前後空白、CR/LF、未知狀態、舊無效日期與年度 0000 均原樣全文以 textContent 呈現。非文字只顯示型別標記，不 stringify／coerce、不讀物件或陣列內文、不展示未知 JSON。active/inactive 顯示已知中文標籤及保存碼；未知狀態保存字串明示未辨識。資料缺少標為「未保存」、空字串「空白」、null「未提供（null）」；其他非文字「非文字值（型別）」；不得替它們補字串或業務預設。

## 唯一介面 owner

admin.interviews/listPage 保有搜尋、日期／狀態、25 筆分頁及原編輯／啟停／歷程；只加 import 與 row button。public/data/interview-record-details.js 負責 descriptor 確認及凍結安全投影。public/modules/interview-record-details.js 為薄 business adapter，使用既有 ui.openDetails({wide:true,guardedRead:true})、api、el 與 detail-grid/pre-wrap；不新增 controller、Abort owner、CSS、token、共享 UI、server、schema、migration、CRUD 或巢狀 history。

openDetails 管理 loading／錯誤手動重試、busy、Close、Escape、focus restoration、取消與 outer context observer。薄 adapter 捕捉完整 primitive user/org/role/employee、hash 及 caller isCurrent（父 render）；loaded／pending 任一失效清空、abort、關閉，晚回應不能復活；nested 同 primitive 參考替換可保留，outer context 替換保守撤除。開啟前角色與 id 確認，無權／失效不得發 request。每次人工重讀只一個 fresh GET，沒有隱性 writes、CSV、print 或自動重試。

## 驗收與證據

合成記憶資料庫、隨機 loopback，不接觸正式 binding／環境／資料庫／備份／4310。純確認測試覆蓋 fresh metadata、精確 identity、安全 version／own descriptor／已知 getter 拒絕、未知 getter 不觸發、八欄 own-presence 型別、長文及惡意 HTML literal。HTTP 角色／機構沿既有權限驗收；readonly 段確認十一表／六 trigger／schema／total_changes 及保護資料完整不變。

必要 browser 驗桌機／390px、同名不同 ID／停用、fresh 版次、完整八欄及長文首尾、原文換行、未提供與型別標記、literal HTML 無執行、keyboard 開啟／Escape／focus restoration、一次 503 手動 retry、malformed 2xx 安全錯誤、完整 loaded／pending primitive 失效／晚回應／outer reference。真正 PNG 要實際視檢；長文尾端 Range／hit-test 不與 direct close footer 重疊；頁面不橫向溢出。保留原面試 CRUD／搜尋／歷程、APM CIS／Portal 與必要既有回歸。

只報本次實際必要 command subset、退出碼與新 counts；不宣稱全 configured fresh、OS popup、人工作業 UAT 或原完整十八欄／其他選項流程對等。原失敗與既有驗收封存保留。public Git 只 curated 程式／合成 tests／安全文件；本機完整 180 目錄與 nine phases 原順序／狀態、57 舊 local milestones、97 舊 runtime sources 保留，RM-07 維持 partial。正式主機／HTTPS／Portal 發布／人事核定仍 pending。
