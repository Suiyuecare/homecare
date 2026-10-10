# 多組聯絡人安全編輯（0.49）

> 公開版本文件：記錄此功能版本的設計與驗收條件，並非目前公開副本已執行的驗收證明。私人盤點與 QA 產物未匯出；現行行為以 API.md 與原始碼為準，正式規則及部署仍須核定。

凍結日期：2026-10-10。這是既有個案詳情的獨立本機安全改進，沿 docs/CONTACTS_SCOPE.md 十個保存業務欄與原 API；不是原平台完整聯絡群組、App、代理人身分或附件規格的核定。

## 範圍與原規則

caseId 固定目前父個案；八個表單欄為 name、category、relationship、phone、alternatePhone、email、organization、note，status 是第十個保存欄。name 必填100字；category 沿五個原選項；relationship／phone／alternatePhone 各100字、email254字、organization200字、note10000字。電話仍是保存文字，不能宣稱已驗證可聯繫；email 非空沿原伺服器 regex。admin／supervisor 維護，finance 與有權個案的 caregiver 唯讀。暫停／結案個案仍可维护聯絡人。

server、model、history、SQLite schema、共用 ui.js、CSS、router 與計價保存保持。原 cases 的 primaryCarer／contactName／contactPhone、案版次、班次、服務、員工及其他業務紀錄不連動。沒有硬刪除、外部訊息、匯入匯出、列印或正式帳號變更。

## 保存與不確定結果

純 editor 在 DOM 外保留十欄原始 JSON 與 own-presence。既有欄位只 PATCH 本次明確變動欄及 version；caseId 不可由編輯傳入。沒有變動不送 PATCH。只有新送字串採原伺服器 trim；省略的保存文字不 trim。原 missing／null／非文字、超限或原生控制項不能無損預填的值，使用「保持原值／以本次輸入取代」，可選文字另有「明確清空」，不 String()、展開 JSON、猜選項或默默轉空。LF 備註可預填；CR 備註與單行 CRLF 由明確處理保留。

已知 active／inactive 状態沿獨立共用確認，僅送 status＋version。未知 status 不猜成停用，卡片不提供狀態轉換；編輯只增加明確修復選項，預設保持，可明確選 active／inactive。這不增加新的生命周期規則。

保持不能繞過原 merged validation：舊 optional null／JSON、未知 category／status 仍可能422；需明確修復才可保存。原空白姓名的 note-only PATCH 可能通過原 required 檢查，本輪不新增後端拒絕或宣稱其已修復。

成功需確認 response.item 的非空文字 ID、目前 orgId、固定 caseId、安全 next-version、十欄值及 own-presence；修改必須同 ID，新增 version1。其餘 metadata 不用作成功證明。非法2xx、中斷、409、422或權限錯誤沿共用 inline error，保留輸入；不關視窗、不成功 toast。新增同 canonical payload 同冪等鍵重試，payload 改變才換鍵；已 commit 但未知回應時重試只建立一次。新建回應無法辨別另一個格式合法的新 ID，此限制不虛稱可由 UI 解決。

## 清單、情境與共用介面

沿原獨立 section、q／category／status／每頁25筆、共用 searchBox／pagination／errorState／history。敏感搜尋只在記憶，不進 URL 或 client storage。清單确认 envelope、精確筆數／頁碼／每頁上限、唯一 ID、org／case／正整數版本；保存業務異型值可讀標記，不因此推測修復。非法清單清空原列並提供重新讀取，其他個案 section 保持可操作。

完整情境為 JSON primitive tuple user.id／orgId／role／employeeId，加 hash、parent render／alive、element 連線及 request sequence。openForm／confirmAction 沿共用 isCurrent、AbortSignal、busy、防重、dirty／Escape、焦點與關閉守門；載入中及已載入 section 失效清空、中止並忽略晚回應。瀏覽器中止不是伺服器回滾；已授權提交後切換情境只能保證晚結果不復活／不錯誤回饋。

唯一 visual/token owner 仍為 DESIGN.md → public/styles.css；原生 select popup 沿 OS，表單／卡片／共用歷程維持 APM CIS。沒有新增平行 modal/controller 或 CSS。

## 必要驗收

純 editor 與合成 HTTP 驗原始欄位保持、明確修復、超限拒絕、精確回應、同機構父項、原四角色／CAS／冪等／真正 actor／精確前版。真瀏覽器完成新增／只改欄／狀態確認、非法2xx、409、offline、commit 後重試、搜尋／分頁／錯誤、loaded／pending context、busy／dirty／Escape／回焦與1440／390px。手機長備註完整尾句位於 sticky footer 上方，以實際捲動、Range／命中及圖片檢視證明，不只靠節點邊界。

每個純讀／拒絕段對照十一表、六 trigger、schema、total_changes；真寫分離對帳，只追加目標 contact、其版次／稽核及新增冪等紀錄。合成非空附件 BLOB、計價／薪資快照及其他紀錄保持。作者／整合失败原始保存；未完成必要整合、瀏覽器與視檢前不標示 implemented_verified。APM CIS／HTTPS 合成 Portal 必要迴歸；不重跑全部無關套件或把未跑命令稱為通過。

僅合成本機。無 DNS、正式部署、支付、薪資、申報、醫事規則或原功能全量等價聲明。
