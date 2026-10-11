# 個案家系／生態關係與醫事意見

本切片提供同機構個案的人工關係紀錄與醫事意見；延續 records、不可變 record_versions、audit、版本 CAS 與新增冪等鍵。它是 RM02 的新增能力，不表示原平台全量對等或正式上線已完成。

## 資料與 API

兩類型均支援 `GET /api/{entity}`、`GET /api/{entity}/{id}`、`POST /api/{entity}`、`PATCH /api/{entity}/{id}`、`GET /api/{entity}/{id}/history?compare=previous`。

- `case-relationships`：caseId、kind、name、role、relationship、direction、support、date、source、status、note。kind 為 family／community；direction 為 toward_case／from_case／bidirectional；support 為 supportive／strained／neutral／unknown。未提供 kind 預設 family，支持狀况預設 unknown。
- `medical-opinions`：caseId、date、practitionerName、profession、organization、summary、recommendation、followUpDate、source、status、note。追蹤日期由使用者輸入；不依醫療規則自動推算。
- note 最多 10000 字，姓名／職類／角色／關係最多 100 字，其餘文字最多 500 字。必要文字不得空白。日期為有效 Gregorian YYYY-MM-DD，年份 0001–9999；可選追蹤日期可留白。
- 清單僅接受 page、pageSize、q、caseId、status、date；pageSize 1–100、q 最多 200 字，重複／未知參數拒絕。預設每頁 25 筆，UI 敏感查詢只存記憶體。
- admin／supervisor 才能讀取或寫入兩 entity。finance／caregiver 不新增敏感讀權。caseId 必須屬於目前機構，建立後不可移轉父個案；current 與每個 history snapshot 都再確認同機構父項。
- 停用／恢復沿 active／inactive CAS 更新，保留原文與歷程；不提供實體刪除。新建採 Idempotency-Key，PATCH 採 version；失败不得增加 records、versions、audit 或 idempotency。

## 介面

個案詳情以 `createCaseRelationshipsPanel` 與 `createMedicalOpinionsPanel` 掛載。重用 ui.js 的表單、確認視窗、搜尋、分頁、錯誤、toast 及既有 history.js；無新依賴、CSS 或視覺 tokens。

關係卡顯示原生 SVG 個案與關係對象、人工方向箭頭及完整文字說明。未知方向不推定箭頭；圖形不編碼性別、血緣世代或臨床狀態。這是個案中心的支持關係閱讀圖，尚非標準多代家系圖編輯器。

兩類表單未修改欄位省略；未知／異型／無法無損預填的保存值，明確保持／取代／選擇清空。summary／recommendation／note 沿 textarea 保存 LF 多行原文；CR 原值仍需明確保持／取代，避免控制項無聲正規化。成功須確認非空、無前後空白的 id、orgId、caseId、下一版及全部業務欄 own-presence／值。無法確認的 2xx、422、409 或斷線保留輸入。共用 owner 處理 dirty、busy、Escape、焦點、Abort 及 context 失效；取消請求不代表已提交交易回滾。

## 範圍限制

不自動診斷、處方、計分或判斷緊急程度；不改照顧計畫、排班、收費、薪資或醫療服務。不由 email 開放權限，不查詢真實個資，不發送外部訊息。

醫事附件仍沿現有個案附件模組管理，尚未增加本紀錄與附件之專屬關聯。原平台正式欄位／文件、完整標準家系圖／生態圖編輯、角色細目與真實機構 UAT，仍需後續對照及驗收。

## 驗證

`node --test tests/case-support.test.mjs tests/case-support-editor.test.mjs` 已在完全合成、`:memory:`、隨機 loopback port 環境通過 15 項測試（7 項 HTTP、8 項純編輯）。覆蓋必要 CRUD、admin／supervisor、finance／caregiver 拒絕、跨機構 current/history、父项不可移轉、原表資料不變、冪等重送、CAS 並行衝突、失敗零寫入、合法 query／分頁、純安全編輯回應確認、多行醫事 textarea 的 draft／ACK 精確往返，以及空白／前後空白 id 拒絕。

首次 HTTP 執行因測試將有 family 預設值的 kind 誤列為「省略即拒絕」而失败；修正測試以真實預設契約驗證，不改產品 guard，後續整合全 13 項通過。只讀審查另外發現 textarea 的 LF 被前端拒絕與空白 id 可通過 ACK 的兩個邊界問題；修正純 editor 並增加兩項回歸後，全 15 項通過。根節點另進行瀏覽器與必要回歸驗證，未取得該證據前不宣稱畫面驗收或正式部署。
