# 面試者登錄與紀錄：本機 0.47 驗收範圍

> 公開版本文件：記錄此功能版本的設計與驗收條件，並非目前公開副本已執行的驗收證明。私人盤點與 QA 產物未匯出；現行行為以 API.md 與原始碼為準，正式規則及部署仍須核定。

## 範圍與相容性

提供獨立八欄面試登錄；未核定的完整人事流程、列印與外部欄位映射不由本功能推定。本切片為獨立開發的有限子集；不表示原十八欄位、選項、列印、完整流程或 App 已對等。

## 資料與 API

共八業務欄：`name phone interviewDate city district interviewContent note status`；保存於既有 records／record_versions／audit／idempotency，無新表、trigger 或初始化真實資料。`name`／`phone`／`interviewContent` 必須為非空白文字；`interviewDate` 是本機獨立要求的人工日期，為有效 YYYY-MM-DD（沿用伺服器日期規則）。city／district／note 是可選自由文字，建立預設空字串；status 預設 active，僅 active／inactive，代表名單啟用／停用，不代表錄取或到職。只正規化本次提交字串的首尾空白，未提交既存欄位原樣保存。上限：name 200、phone 64、city／district 100、interviewContent／note 10000；單行 name／phone／city／district 不允許 CR/LF，內容與備註允許換行。不增加電話驗證、行政區登記、配對、評分、期限或招募判定。

API `/api/interview-applicants` 提供 GET 列表／單筆、POST、PATCH，PATCH 正整數 version 必須，沿用版本衝突與同 key／同 payload 冪等；history 沿用同機構及實際稽核操作者。沒有 DELETE、外部通知、自動員工或帳號建立。admin／supervisor 可讀寫；finance／caregiver 所有讀寫、history、錯誤與 query／body parsing 前均 403。單一機構隔離，跨機構 ID 404。

GET 閉合查詢只允許 `page pageSize q status interviewDate`，每 key 單值；沿用分頁規則、q 最多 200 字、status 僅 active／inactive、interviewDate 有提供必須有效且為單一精確日。single GET 也驗證這個 query 與 page 參數。搜尋與日期篩選純讀取，無原始表／JSON／total_changes 改動。

## 介面

機構管理新入口 `/interviews`「面試者登錄」，admin／supervisor 可見，財務與居服員保留原導覽權限。沿 APM CIS 字體、色彩、logo、共用桌機與手機更多入口；不新增設計 token 或 CSS widget。

由既有 admin.js 的 listPage 管理列表、搜尋、狀態、25 筆分頁、讀取／失敗／空狀態、Abort 與 primitive user／org／role／employee／hash／render identity。僅為新 caller 增加 opt-in confirmList 與 dateFilter，使其他列表預設不變。日期使用人工面試日期。shared openForm／confirmAction 擁有焦點、busy、取消、dirty／abort 與 current 判斷；新模組不另建控制器或 dialog。

新增／編輯欄位採純八欄 adapter，未改動欄不送 PATCH；不能在 native control 安全表達的既存 JSON／未知值／CRLF／year 0000／過長等，採 keep／replace／可選欄 clear。不展示未知原始 JSON；不因載入、取消、搜尋、history 或更改別欄自動清理原值。啟用／停用只由確認動作變更，編輯狀態保持原值；未知狀態可明確修復為 active 或 inactive。建立同 payload 重試維持同 idempotency key，payload 變更重新取 key。每次成功提示前驗證 id、orgId、version 與八欄 own-presence／內容完全符合原始保存＋本次提交，不接受 malformed、跨機構、舊版或少欄 acknowledgement；輸入保留並顯示失敗。列表先確認 envelope／identity／分頁唯一 id，容許已保存舊型別安全處理。

歷程展示八欄及實際保存操作者，僅列出允許欄與有限安全文字。非文字值以不展示標記呈現，其隱藏內容不在比較範圍；没有可展示文字差異不能據此判定整份原始 JSON 未變更。提交、啟用、停用不等於簽核、錄取或薪資核定。

## 必要驗收

完整現有 unit、來源檢查與精確最低 Node 22.13.0 相關新測試；HTTP 覆蓋角色／機構／query／歷程／冪等／版本衝突／白空與型別／CRLF 未提交保留／GET 不變及不建立員工帳號。純 adapter 覆蓋 raw 保存、intent、dirty 差異與嚴格 ack。桌機與 390px 手機實際浏览器覆蓋新建、查詢、日期與狀態、分頁、編輯、cancel、確認停用啟用、歷程、操作者、malformed ack 輸入保留及在途 current context；受影響共用列表與 history／CIS／Portal 必要回歸。只對必要範圍標示完成，不宣稱全原平台等同。

保留所有初次失敗、修復及原生程序結果與 frozen source hash，截圖須實際看過後單獨保存 visual review。完成後更新 BUILD／PRODUCT／API／追溯／DESIGN／UX，再精確來源歸檔；根目錄未提交檔、真實 DB、env、帳號綁定、私人備份保持。

正式 host／HTTPS／雙端 SSO secrets／Portal 發布與本人 UAT 依既有部署交接待辦，DNS 不重建、不購買或正式部署。未核定原其餘十二欄、流程、選項、輸出、資格及聘用規則仍待核定。
