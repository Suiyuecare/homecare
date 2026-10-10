# 本頁本人公告回執（0.60，獨立本機切片）

2026-10-10 凍結；本機必要整合、瀏覽器與實際畫面驗收完成；初始契約及source freeze另存保留。RM-07；延續公告 CRUD／版本／本人回執與 APM CIS，只有合成測試。正式主機、HTTPS、Portal 發布、真實公司登入 UAT 及原平台完整對等仍待交接／核定。

## 人工操作與顯示

四既有角色在內部公告清單選擇「查詢本頁本人回執」。初始載入、逐列 render、搜尋／清除、篩選、分頁與 refresh 完全不自動查回執；明確操作才查目前已確認本頁的 distinct IDs，最多 25。空頁、未確認或 loading 清單停用入口。僅 GET 原 `/api/announcements/:id/read-state`，不傳 version/query，不提交閱讀，不呼叫原全文 owner 產生第二 modal。原全文／本人明確提交／admin-supervisor 閱讀名冊／新增編輯撤回及歷程保持。

每列採該次 fresh GET 目前版，不需等於舊名單版次，不能繼承前版回執；整批不是同時點交易快照。完整固定 DTO 及 org/user/id/公告版次/SHA256 receipt tuple 沿 `confirmAnnouncementReadState`。GET 的 receipt role/userName 是閱讀時保存，不核 current role/name。僅顯示 fresh 標題安全原文／typed 標記、精確 ID、目前第 N 版、本人本版回執是否保存及 canonical readAt 原 UTC 字串；不顯示 body、未知內文、保存姓名或其他人資訊。receipt=null 只表示「本版尚無本人閱讀回執」，不得稱未讀、必讀、未完成義務、理解程度、法定簽收或完成率。canAcknowledge=false 另標「本版不可確認閱讀」，不產生 POST。

503／404／409／422／斷線、逾時或非法 2xx 逐列只顯精確捕捉 ID 與「未確認，請重新查詢」，不把未確認誤當無回執，不展示 raw error 或舊標題／版次。結果保留全部捕捉列，只計本次已確認與未確認筆數；此數字不是閱讀完成率。手動「重新查詢本頁本人回執」沿 helpers.reload 清空後重新查相同捕捉 ID 全部，不保留舊成功列、不快取 failed-only；重讀可能是新目前版。無自動 retry／輪詢／POST／storage／print／CSV／外部訊息。

## 清單捕捉與唯一 owner

新增 listPage optional `currentPageAction` 同步 hook，只有公告 opt-in，其餘 consumer 無 opt-in 保持原行為。hook 為 `{label,isCurrent,capture,open}`：capture(result,{page,pageSize,orgId}) 在 paint 前確認，open(snapshot,isCurrent) 只接收已接受 detached snapshot。原搜尋、maxLength、query/status、排序、25 筆頁數、CRUD payload 與縮頁邏輯不變，不額外啟用 config.confirmList 的 interviewDate 預設或 200 字搜尋限制。原泛用 list 沒有 filter echo，本次不宣稱重新證明 q/status 語義。

capture 確認 exact plain own enumerable data envelope `{items,total,page,pageSize}`；page/pageSize 精確 requested 且 pageSize=25、positive safe page/offset、total 安全非負、items 精確分頁長度。每列 plain object own enumerable data id/orgId/version/createdAt/updatedAt metadata 需 route 相容 `[a-f0-9-]+` ID、精確 orgId、positive safe version、非空保存時間字串及 distinct IDs。business/unknown keys 不展開、修補或 coerce。只輸出 `Object.freeze({orgId,page,pageSize,total,ids:Object.freeze([...])})`；snapshot 再次確認 exact metadata、ID 數量／唯一性。非法／duplicate／>25 在任何 batch GET 前拒絕。DTO 為 JSON 資料，純確認拒 accessor／循環／不支援型別且不執行 getter，不放寬原 tuple 確認。

listPage 仍是唯一 list controller／sequence／observer。hook 入口沿共享 outline button，位於 toolbar。load 開始同步撤 capture 並停用入口，合法成功 paint 才發佈 snapshot。搜尋 input 草稿（含 IME）立即撤 capture，不等既有 300ms debounce；status/page/refresh/縮頁同樣 load 前撤。以 body 的 `data-render-version` revision 通知既有 guardedRead observer，不新增 timer/controller/第二 list owner。原 list 失效 observer 的 opt-in 條件只擴為 confirmList 或 currentPageAction，並核 hook isCurrent；其他 consumer 保持。

snapshot current 需 accepted reference 未變、request===sequence、原 alive/generation/render/connected/hash、外層 context 物件及完整 primitive user/org/role/employee 保持。nested 同 primitive 替換保留；outer context 重建即使 primitive 相同也撤除。loaded/pending、搜尋草稿／條件／分頁／refresh／上下文失效要清空、abort、關閉，不復活晚回應。

header 有同步 in-flight gate 防雙開；modal lifetime 以 aria-disabled／aria-busy 與 handler gate 保持 native 可 focus，避免 native disabled 妨礙原 createDialog close 的 trigger.focus；關閉後解鎖。未接受／空頁仍 native disabled。不得另造 focus owner。

唯一 modal owner 仍 `openDetails({wide:true,guardedRead:true})`；不傳 readAcknowledgement，沒有 POST 按鈕。薄 module 以同一 owner AbortSignal **sequential concurrency=1** 逐 ID 讀取，每個 GET／await tuple 確認前後核 signal/isCurrent。Abort／失效即 throw、不啟後續 ID，不被 per-row 未確認 catch 吞掉。每次 load 最多 25 GET，沿原 api timeout，不另加 timer，不能宣稱整批 15 秒或大型 SLA；Close／Escape 可中止。原 GET 仍傳完整 body，25 是請求數上限，非傳輸 bytes／server scan 上限。

純 helper exports：`announcementPageIdentity(context)`、`captureAnnouncementPage(result,requested)`、`confirmAnnouncementPageSnapshot(snapshot,{orgId})`、`projectAnnouncementPageReadState(response,{id,orgId,userId})`。project await 原 confirmAnnouncementReadState 後輸出 frozen `{id,title,version,receiptState,readAt,canAcknowledge}`，receiptState=saved/absent，readAt=canonical 字串或 null，title=savedAnnouncementText 安全投影。UI module export `openAnnouncementPageReceipts({snapshot,isCurrent})`。新檔命名 announcement-page-receipts.*；原 helper、shared ui.js/CSS/app/router、server/model/API/schema 全部 bytes 保持。

## 驗收與追溯

先獨立 review pure 與 list owner 增量，再 freeze source。必要 check／完整 Node unit／最低 22.13 相關／新 batch browser／原公告回執／公告歷程／公告安全編輯／core／APM CIS／合成 HTTPS Portal／visual refresh browser、已接受私人 strict 與 DESIGN lint。本切片只必要 subset，不宣稱全部 61 configured／60 required 本輪 fresh；原官方 auditor 逾時及其他失敗保留，不宣稱官方 pass。新增 test 登錄 premium 與 CI，完成必要 native/browser 與 unique 圖片實際 view 才標本機完成；來源上傳／GitHub CI 另驗證，正式發布不在範圍。

包含 0 隱式 GET、1/25/26、duplicate/invalid/foreign/malformed-page 零 GET；人工每 ID 一 GET、順序、不跨頁；四角色與 org/caregiver audience/有效員工；fresh 新版不繼承，typed/draft 不可確認，舊閱讀時角色仍合法；per-row 503/404/409/非法 DTO 與人工全部重讀、0 POST。loaded/pending 六 primitive/hash/render/outer 及搜尋草稿/status/page/refresh/sequence 失效、真 requestfailed abort、不啟後續 ID；nested 同 primitive 保留、header 雙啟動零重複。原本人明確提交／名冊／歷程／安全編輯回歸。

11 表／6 trigger／total_changes／typed bytes／雙附件 BLOB／approved billing snapshot 逐唯讀段相同，fixture 寫入另分帳。桌機/390px、Enter/Escape/回焦、loading/error/empty-disabled、literal 長標題末字／table 自身橫捲／44px 操作需真 browser 和 unique 圖片實際 view。原 180 目錄/9 phase/12 contracts/2 enhancements 與舊 58 milestone/99 runtime 前綴保持，RM07 仍 partial。R dirty／私人開通／備份保留，不讀真 DB/env/binding/4310、不整批根 git add；公開 checkout 只逐明確安全來源，15 私人工具/QA 不公開。
