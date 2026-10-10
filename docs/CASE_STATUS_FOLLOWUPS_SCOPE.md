# 個案暫停與結案追蹤 — 0.46 凍結範圍

> 公開版本文件：記錄此功能版本的設計與驗收條件，並非目前公開副本已執行的驗收證明。私人盤點與 QA 產物未匯出；現行行為以 API.md 與原始碼為準，正式規則及部署仍須核定。

本輪為本機獨立實作，依  未完成的原因、區間及追蹤補足可操作紀錄。獨立保存個案暫停／結案的人工原因、區間與追蹤；正式欄位、文件、期限與結案標準仍待核定，不表示完整外部流程等價。

## 保存與行為

新 entity `case-status-followups` 使用既有 records、record_versions、audit、idempotency；沒有新表、trigger 或遷移。九業務欄：caseId、kind、startDate、endDate、reason、followUpDate、outcome、note、status。

- 必填 caseId、kind、startDate、reason。kind 只允許 pause（暫停）／closure（結案）。status 只允許 pending（待追蹤）／completed（已完成追蹤）／cancelled（已取消追蹤）；預設 pending，四選填欄位 endDate、followUpDate、outcome、note 中日期與文字預設空字串。這是人工紀錄狀態，不是法定結案或服務狀態。
- 所有送入字串 trim（只處理本次 payload，未改的既有保存原值不再 trim），reason/note 最多 10000 字，outcome 最多 500 字；caseId/kind/日期/狀態沿有限字串守門。必要原因不能只有空白。startDate 必須有效 YYYY-MM-DD；endDate、followUpDate 可空，有值須有效日期。endDate 不得早於 startDate；不自動推定期限或追蹤結果，不要求追蹤日落在服務區間。
- caseId 必須同機構且建立後不可更換，包括相同機構另一個案。一般 PATCH 必須 version；沿 CAS、append-only 歷程及實際稽核操作者。POST 同 payload 同冪等鍵只建立一次，不同 payload 同鍵拒絕；不新增 DELETE。
- 每筆追蹤獨立保存，不改 cases.status、聯絡人、附件、照顧計畫、班次、服務紀錄與核閱計價/薪資快照。個案目前狀態變更後仍保留既有追蹤；追蹤內容不作排班取消、收費、法定資格或正式結案認定。

## 授權與查詢

完全沿個案聯絡人：admin/supervisor 可建立與編輯；四個既有角色只讀其可讀個案的紀錄。caregiver 必須本機有效員工連結及本人班次對應個案；finance 只讀。所有清單、單筆、raw/compare 歷程均依 org 及目前可讀個案範圍，saved history caseId 也必須同原親子關係及目前可讀個案。API 伺服器守門，不以隱藏按鈕替代。

GET `/api/case-status-followups` 沿 page/pageSize（25 預設、最大100）、q（最多200）、caseId、status，新增 kind filter。新 entity 專用查詢守門只接受上述六鍵，拒絕重複鍵、未知鍵、非法 kind/status、空 caseId；caseId 非空有限文字且查詢仍依可讀範圍，不洩漏跨機構個案存在。單筆 GET 無查詢或相同合法鍵沿一致守門；history 只沿既有 compare=previous 與分頁語意。

## 共用介面

個案詳情加入「暫停與結案追蹤」獨立 panel：伺服器分頁、搜尋清除、kind/status 篩選、重新讀取、新增、編輯、版本歷程及精確上一版差異。人工保存九欄，不另建立桌機/手機 widget、CSS、token、登入或角色。共用 ui.js openForm/openDetails/searchBox/pagination/errorState/toast，原生 select/date popup 採既有 OS 所有權；native popup 外觀不宣稱產品可控制。

取消與恢復追蹤沿共用 confirmAction，保留紀錄及全部歷程；已取消紀錄的編輯保持原狀態，先由卡片明確恢復才更改追蹤狀態。

新增/編輯沿完整 user/org/role/employee/hash/render context guard、Abort、busy、防重送及 dirty guard。只有 id/org/version/九欄確認吻合才成功；未知回應保留表單和輸入，重試新增相同 payload 沿同 key。編輯只送變更欄，保持不可無損預填的保存原值；需要取代/清空時明確選意圖。不在 URL、storage、toast 或證據保存真實個資。

## 驗收與邊界

以來源隔離 clone 合成資料驗證：四角色與跨機構、不可改個案、日期/長度/未知欄/查詢/CSRF/Origin、冪等、CAS、歷程 actor 與 exact previous、純讀零寫入、既有案件/班次/核閱快照不變。真瀏覽器：新增編輯、結果確認、篩選分頁、無資料與錯誤重試、衝突/離線/busy/重送、鍵盤 dirty/Escape/焦點、機構/路由切換與晚回應、390px長原因及桌機 sibling 視檢。必要既有 API/個案/聯絡人/history/CIS/Portal SSO regression 通過後才標本機完成。

正式主機/HTTPS/Portal發布依既有交接仍待完成。
