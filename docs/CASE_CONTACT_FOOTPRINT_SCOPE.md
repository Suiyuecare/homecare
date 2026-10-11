# v0.68 人工接觸足跡

**經根節點確認 v0.67 封存後，本批自有新檔已搬入正式 src/public/tests/docs；候選原稿保留於 `outputs/software/v068-candidates/contact-footprints/`。** 根節點已接入 model/index/history/個案頁；自有業務切片已完成真正 HTTP 與 Chromium 驗證。全套 v0.68 跨模組與合成備份驗收由根節點另行封存；本文件不宣稱正式部署、全範圍完成或原平台對等。

## 可落地內容

以既有個案固定維護人工接觸情形。僅同機構 admin／supervisor 可讀寫，finance／caregiver 在 payload／資料讀取前403。公開 entity 為 `case-contact-footprints`，只使用現有 records／record_versions／audit／冪等／CAS，不新增表、trigger 或 arbitrary shift metadata。

| 欄位 | 意義與限制 |
| --- | --- |
| caseId | 必填同機構原個案，建立後不可換案，最多500字識別碼，拒空白與非trim |
| date | 必填人工紀錄日期，有效YYYY-MM-DD、year0001起，拒尾CR/LF |
| time | 人工紀錄時間，可未知留空，否則嚴格HH:mm，00:00至23:59，拒尾換行或推定 |
| location | 必填人工場所文字，最多200字，不轉成座標、不比對地理資料 |
| contactDescription | 必填人工接觸情形，最多2000字，保存原文，不判定傳染或臨床風險 |
| relatedCaseId | 可空或同機構相關個案識別碼；每次寫／讀歷程重讀同機構參照，不跨機構查名 |
| source | 人工資料來源文字，最多500字，可空 |
| status | active／inactive，停用／恢復需明確確認 |
| note | 完整備註最多10000字，可空，原文及CRLF不默默重寫 |

必要日期／場所／說明由人工輸入。未知時間或相關個案可以留空，以避免偽造精確性。場所、來源、說明與備註不 trim。原生欄位無法無損呈現 LF／CRLF 的既存內容顯示明確「保持原文／以本次輸入取代／明確清空（非必填欄位）」意圖選項；保持時欄位停用且不送更新。正常 textarea 支援LF。單欄變更只送實際改動，不暗改未動來源或原時間。

個案 UI `createCaseContactFootprintPanel({caseRecord,isCurrent}) → {element,load}` 沿 APM ui.js canonical owners，提供普通新增／編輯、詳細原文、停用／恢復確認、版本歷程入口、搜尋／日期／狀態篩選／25分頁。relatedCaseId 使用同機構個案 select，不要求使用者輸入識別碼或rawJSON。失敗保留輸入；新建 payload 的冪等key穩定重試。typed ACK 完整確認 id／org／原case／CAS／createdAt／updatedAt／每個欄位／原文，不接受 getter、symbol、hidden或未知欄位，完整分頁拒稀疏／附加鍵陣列。context 捕捉 user/org/role/employee、原case、route與入口connected，晚回應不復活內容。

## 根節點下一輪接線契約

純 server 檔不 import model，避免循環。以下 exported hooks 由 root 用既有 helper 注入：

```js
caseContactFootprintEntities
isCaseContactFootprintEntity(entity)
guardCaseContactFootprintAccess(entity, ctx, readOnly, fail)
normalizeCaseContactFootprintPayload(entity, payload)
validateCaseContactFootprint(entity, data, old, fail, dateValid, db, ctx, get)
caseContactFootprintQuery(entity, params, fail, dateValid, mode = 'list')
caseContactFootprintHistoryVisible(db, ctx, snapshot, current, get, dateValid)
```

- model 合併 schema、server read／write guard、normalize與transaction內 validate。父案及相關案每次重讀；原case不可更換，無關內容不得附加。
- index 在 body／查詢驗證前先 role guard。list query 只接受各一次 page/pageSize/q/caseId/relatedCaseId/date/status；`page=1e0`、尾換行、未知與重複欄位422。單筆(mode='single')拒任何查詢參數；history(mode='history')僅各一次page/pageSize/compare且compare只可previous，用同一strict分頁守門。list/history未提供分頁時明確返回page=1、pageSize=25，避免paginate(undefined)形成空items。
- read scopedRows／get 必須重新核對原case與非空relatedCaseId可讀。orphan／跨機構／無法完整解析的storage不可透過list／single／history洩露；PATCH同樣在驗payload前確認目前完整可讀，非法或孤兒stored資料404且零寫，不修補舊資料。records與history使用guarded SQL讀取，malformed JSON、非法metadata、SQL版次0或超出safe integer皆不可讀／不可PATCH。
- typed history 白名單 entity，field labels 可由 `CASE_CONTACT_FOOTPRINT_PROFILE`／`CASE_CONTACT_FOOTPRINT_FIELDS` 提供；caseId及relatedCaseId皆是 cases reference，date為date、status為active/inactive，其餘scalar原文。history hook檢查snapshot identity／immutablecase／完整fields／當前同機構參照。
- operations 個案详情掛入 panel；只給admin／supervisor建立與load。requiredRelatedCase可空不代表給其他角色擴大個案讀權。
- 通用 `GET/POST/PATCH /api/case-contact-footprints`、`/:id/history` 即可，沿通用createidem／CAS／actor audit；沒有自訂上報／GPS endpoint。

## 專屬驗證與封存前置

正式 `tests/case-contact-footprints.test.mjs` 8個 server callback測試，`tests/case-contact-footprint-editor.test.mjs` 5個 pure editor測試，`tests/case-contact-footprints-http.test.mjs` 9個真正 HTTP integration測試，共22項全通過。證據 `outputs/software/v068-contact-footprints-qa/integration-unit-final.log`（native exit0）。HTTP使用createApp(:memory:,port:0)、合成帳號與random loopback，驗證完整CRUD／actor、角色403先於payload與query、機構隔離／父案不可換、原父與related不可讀時404、unknownpayload／literaldate-time／origin-CSRF／CAS／idem失敗零寫、25分頁、CRLF不暗改、競態只有一winner、一新version、一audit；malformed JSON／unknownnested／metadata injection／SQLunsafe version／偽造歷程全部不可見，不修補資料。

第一次 HTTP 8/9 通過，揭露缺省分頁未返回page/pageSize，已改自有query預設並添加缺省分頁回歸。第一次Chromium到歷程8gates後因e2e用了表單label而歷程實際label不同逾時；只修專屬e2e selector，原失敗紀錄保留 `browser-1791641454954-ae713f99`。第二次15gates與10圖通過，但連續操作的舊toast短暫遮到手機卡片按鈕；已讓e2e等待canonicaltoast自然消失，再取得最後fresh圖。所有失敗／成功attempt各保存，不覆寫。

`tests/case-contact-footprints-e2e.mjs` 採新memory資料庫、random loopback、真Chromium、唯一attempt目錄及14個相關sourceSHA前後比較，包含普通新增、related select、unknown time、LF與邊界保存、dirty確認／取消及focus、單欄保存CRLF10000字、no-op零PATCH、explicit replace／clear、503零寫、錯ACK保留、stablecreateidem retry、停用／恢復、typed詳細與歷程唯讀、375px真新增、390px督導新增、真CAS409保留草稿、換案慢回應不復活、26筆搜尋25分頁／日期狀態篩選、居服與財務無入口與無敏感API讀取、0pageerror。像素審查必須對最後attempt全部10張實際view並記每圖SHA／觀察／限制。

獨立更嚴格的closed歷程純投影候選及3項0getter／unknownnested／metadata／原文測試仍保留候選目錄，已通過（529840）；正式history目前由根節點沿自己的safeown-descriptor投影接線，這3項不計正式22項，不暗示candidate已被採用。

跨模組的stage3合成備份／還原必須另外確認全records／immutableversions／actor／idem response零遺失，以及既有11／13表schema不變；此驗收由根節點合併負責。

**未含GPS定位／地圖／外部自動追蹤、傳染診斷／臨床評分／醫療建議、疫情通報或正式對外消息。** 相關案選取只保存人工關係，沒有自動判定接觸者或計算暴露範圍。

最後專屬Chromium驗收：`outputs/software/v068-contact-footprints-qa/browser-1791641590088-cdf1259d/verification.json`，native exit0（4d043c）、15gates／10screenshots／14 source SHA前後完全一致、0pageerror。全部10張最後attempt圖已实际 `tools.view_image` 查看並逐張SHA核對，觀察與限制封存同目錄 `pixel-review.json`。手機卡片按鈕無toast遮挡；长表單、10000字備註與歷程沿canonicaldialog內部捲動，不宣稱一張图可呈現全部原文。
