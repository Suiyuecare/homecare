# 附件描述安全編輯（0.54）

> 公開版本文件：記錄此功能版本的設計與驗收條件，並非目前公開副本已執行的驗收證明。私人盤點與 QA 產物未匯出；現行行為以 API.md 與原始碼為準，正式規則及部署仍須核定。

凍結日期：2026-10-10。沿既有個案附件及證照附件的獨立本機流程、docs/ATTACHMENTS_SCOPE.md 與 docs/CERTIFICATION_ATTACHMENTS_SCOPE.md；這是已授權持續建置範圍內的安全改進。

## 原規則與限定操作

唯一 attachments.js 共用 controller 的 metadata 編輯及既有停用／恢復確認，使用新純 attachment-metadata-editor adapter。個案附件只編輯 title／category／note，固定 caseId；證照附件只編輯 title／note，固定 certificationId 及由父證照推得 employeeId。title 必填1至200字，note 可空、最多10000字；case category 沿 general／care／administrative／other。已知 active／inactive 狀態沿獨立確認只送 status＋version；未知狀態不猜轉換，卡片不提供停用／恢復，metadata 編輯可明確修復，預設保持原值。

server／model／schema／API／CAS／CSRF／history／BLOB／計價與角色保持。admin／supervisor 維護；個案附件 finance 與有權個案的 caregiver 只讀，證照附件 caregiver 本人只讀、finance 拒絕。暫停／結案個案及停用員工既有附件沿原讀寫規則。上傳、更換檔案、下載、精確歷史版本下載及父項紀錄不改；沒有硬刪除、輸出、正式保存期限、掃毒、加密、移轉、外部儲存或新權限。

## 原值、意圖與確認

純 adapter 在 DOM 外保存原始合法 JSON 與各白名單欄 own-presence；編輯只 PATCH 本次明確變動欄與 version，固定父項、employeeId 及 fileName／mimeType／sizeBytes／sha256 不送入 payload。沒有變動不送 PATCH。只有明確新送字串沿原伺服器 trim；省略原值不 trim、不重建。原 missing／null／非文字、超限文字、未知選項，及原生單行輸入不能無損呈現的 CR／LF、textarea 的 CR，沿共用 native select 提供「保持原值／以本次輸入取代」，note 另可「明確清空」。異型與不相容原值只標示保存類型，不 String()、展開巢狀 JSON 或默默猜空值；原 LF 備註可完整預填。

保持不繞過原 merged validation：null／異型／非法分類／狀態／title 等仍可能422，必須明確修復。缺失 note 可保持缺失；不把未知結果宣稱回滾，也不擅改既有 server 的歷史相容規則。

metadata／status 成功須確認 item 非空 ID、精確目前 orgId、固定父項（cert 另精確 derived employeeId）、同 ID 安全 next-version，以及 title／category（僅 case）／note／status 和 fileName／mimeType／sizeBytes／sha256 的保存值及 own-presence。供應欄按原 server trim，未送欄按原完整 JSON 比對。fileId 不接受為公開成功回應。非法2xx、同版／跳版／其他父项或檔案變動、中斷、409、422、權限與連線失敗保留輸入，沒有成功 toast 或關閉。PATCH 重送仍沿既有 version 衝突，不新增冪等、回滚或自動覆蓋語義。

## 清單、情境與共同介面

原 section、搜尋／分類／狀態篩選與25筆分頁保持。清單確認原 envelope、精確 page／pageSize／total／筆數、唯一 ID、目前 org／固定父項／安全版本、cert derived employeeId 及已选分類／狀態；不得顯示跨父項或非法回應，清空舊列且可重新讀取。安全欄位格式僅文字或型別標記，未知 category／status 不展示巢狀值。搜尋只在記憶；不新增 URL 或 client storage。

完整情境包括 user.id／orgId／role／employeeId primitive、hash、父項 render／alive／element 連線及 sequence。outer context 重建保守撤除，nested 相同 primitive 參照替換保留。載入中或已載入 section、metadata form、status confirmation、history 及下載失效時清空／中止；晚回應不復活、不錯誤回饋。既有 lifetime／observer 與唯一 openForm／confirmAction／openRecordHistory／downloadAttachment 延伸守門，不建立平行 async owner。guarded 表單採 AbortSignal、busy／防重／dirty／Escape／回焦點；submit 後 context 中止不等於伺服器回滾。

沿 APM CIS；唯一視覺 owner 仍 DESIGN.md → public/styles.css，共用 UI 仍 public/ui.js。native select popup 沿 OS；無新 CSS、另一 modal、表單或檔案選擇器。桌機及390px 表單沿共用版型，長 LF 備註須讀到尾句且 footer 不遮擋。

## 必要驗收

純 adapter及合成 HTTP核原值／own-presence保持、明確意圖／修復、200／10000字邊界、精確 ACK（含原 file metadata 與 cert employee）、真正CAS／422／角色／機構／父項、實際 actor／精確前版與原download bytes。純讀與拒絕段核十一表／六 trigger／schema／total_changes零寫，成功 mutation 精確只改目標metadata、版本與audit（不新增 BLOB 或冪等）；case／cert父項、其他紀錄、兩種非空 BLOB及已核閱計價快照保持。

真瀏覽器驗 case 及 cert 編輯／status、no-op零PATCH、未改CR/LF／型別／缺失、修復、非法2xx、真正409／422／連線錯誤與原輸入保持、清單拒絕及重試、loaded／pending完整情境、busy／dirty／Escape／回焦、1440／390px。手機長備註尾句以實際捲動、Range／hit-test與 actual PNG檢視核 footer；不能以DOM bounds單獨代替。原附件兩套、聯絡人安全編輯、case安全編輯、history/core、APM CIS及真正HTTPS合成Portal沿必要回歸；不把未執行配置稱為fresh。

凍結來源、實際程序退出碼、原作者／整合失敗、必要瀏覽器與逐圖證據保持；必要整合與瀏覽器完成後才標示 implemented_verified。本輪沒有DNS、正式部署、付款、申報、外部訊息或未核定規則。
