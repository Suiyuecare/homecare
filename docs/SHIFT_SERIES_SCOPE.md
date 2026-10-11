# 永久週期與明確整組排班（v0.67 本機切片）

本切片保存可持續使用的週期定義，再由管理者或督導明確指定期間預覽、確認產班。永久保存的是設定；系統沒有背景排班程序。使用合成資料驗收，本機完成不表示正式部署或原平台全量對等。

## 可操作流程

- 「永久週期排班」頁：普通表單新增、編輯、搜尋、狀態篩選、每頁25筆、詳情與產班追溯、型別化版本歷程。
- 保存名稱、同機構個案與照顧計畫、人員、起算日、可留空尾日、每隔1至4週、不重複星期、同日起迄時間、服務與數量、狀態、交班備註。個案与起算日建立後固定，所在週的週一是計算週次的固定錨點。只選取計畫允許的服務，沒有自行推定節日排除。
- 啟用週期可逐期產班；本次含起訖最多93日，所有符合日期顯示「本次建立／已產生／衝突」。已產日期不重複，原班次被取消也不自動補班；全部已產時明示「本次不新增」且 UI 不提供保存。
- 同一週期、明確最多93日範圍內，使用者須勾選全部目前可操作班次（1至50筆）及提供本次原因，才可預覽／確認整組改派、整組取消、整組調整同日起迄時段。清單不默默截斷；超過50筆需縮小期間。已有任何服務紀錄（包括草稿）、完成或取消的班次另列保留，不能重寫。
- 暫停／恢復／結束均有明確確認。暫停不能產班；結束為模板終態，不能恢復或修改。已有班次、追溯與後續整組處理保留；結束本身不取消已排班。

## 資料與原子保存

公開 entity 為 `shift-series`；fields 為 `name caseId employeeId carePlanId startDate endDate intervalWeeks weekdays startTime endTime services status note`。`intervalWeeks` 以整数 JSON、`weekdays` 以密集整数陣列保存，`services` 為封閉 `{serviceItemId, quantity}` 明細。備註最多10000字，保留原空白與 CRLF；未修改欄位不送更新，原生 textarea 換行正規化須由明確取代意圖才覆寫。

内部 entity `shift-series-occurrences` 只存在既有 `records`，不加入公開 CRUD 清單。每筆封閉欄位為 `seriesId/date/shiftId/seriesVersion/seriesSnapshot`，機構從 SQL 欄位取得；id 以機構＋週期＋原日期 SHA256 產生固定 UUID，以現有 PK 保持唯一。原生成模板快照及内部 link 版本1在同一交易保存；沒有新表、索引或 trigger，因此現有11表／13表合成備份 profile 不變。内部 link 不更新、不修補；取消不刪追溯。

單一生成交易每班保存 ordinary shift、内部 link、兩個不可變版本及 actor audit，沒有向 ordinary shifts 開放任意週期 metadata。所有產班與整組 commit 使用必填冪等 key、`BEGIN IMMEDIATE`、完整重新驗證、精確 CAS，全有全無；同 key 重送回原 ACK，不能產生重複版本。預覽只讀，不等於保存或授權。direct API 全已產時回明確 createdCount0，不增加業務資料。

每班重新驗證同機構個案、人員、相符計畫、計畫有效期間、每項服務有效期間、人員有效狀態、核准請假與同案／同人衝突。模板修改只影響後续尚未產生日期，不偷偷修改原快照／已產班。整組改時段仍使用既有 shift validator，並核對整組最终狀態重疊與逐班 fresh CAS。已 link 的 ordinary shift 個案／原日期不可變；原先沒有 link 的人工班次沿原守門。

内部原始 SQLite 資料筆數、id 與 bigint 版次與可解析結果逐筆核對；malformed JSON、unsafe SQL version、錯誤／重複追溯一律 `409 BROKEN_OCCURRENCE`，不忽略成未 link、也不放鬆父案與日期守門。完整 backup／restore 會保留 internal records 與 immutable versions。

## 權限與回應確認

僅同機構 admin／supervisor 可讀寫。finance／caregiver 在 payload 驗證與儲存讀取前403。後端每次重新取得父案及關聯；UI 捕捉 user／org／role／employee／route／入口 context，路由、session 或入口失效時不接受晚回應。

前端使用既有 APM shared ui.js 表單、明細表、確認、dirty guard、focus、busy／abort 與錯誤呈現。完整 ACK 須封閉 own enumerable data descriptors、密集陣列、无 getters／symbols／隐藏鍵、完整 id／機構／版次／時間戳、精確來源快照、日期、計數、原非操作欄位。驗證不執行 getter。失敗或 malformed ACK 保留輸入；尚未完整確認不宣告成功，同原 payload 的 retry key 保留。時間／分頁／版次不以尾換行、指數或浮點輸入暗中 coercion。

## API

通用 `GET/POST/PATCH /api/shift-series` 與 `/:id/history` 使用版本與既有 actor audit。list 僅接受各一次 `page/pageSize/q/caseId/employeeId/status`；未知、重複、錯誤型別拒絕。history 僅一次 `page/pageSize/compare`，保存快照以新型別白名單審核。單筆不接受查詢參數。

- `POST /api/shift-series/:id/generation/preview`：closed `{version,fromDate,toDate}`，200完整期間結果，零寫。
- `POST /api/shift-series/:id/generation/commit`：同 payload＋必填 `Idempotency-Key`，200 `{batchId,series,range,items,total,createdCount,existingCount}`。
- `GET /api/shift-series/:id/occurrences?version=&fromDate=&toDate=`：closed／不重複且最多93日，200 `{series,range,items,total}`。
- `POST /api/shift-series/:id/adjustments/preview`：closed `{version,fromDate,toDate,action,items:[{id,version}],reason,employeeId?}`；`reschedule` 只可另帶 `startTime/endTime`，不得帶 `employeeId`，其他操作不得帶時間。200 `{series,range,excluded,preview}`。
- `POST /api/shift-series/:id/adjustments/commit`：同 payload＋必填 `Idempotency-Key`，200 `{series,range,excluded,result}`。

## 驗收與明確限制

專屬測試位於 `tests/shift-series.test.mjs`、`tests/shift-series-editor.test.mjs`、`tests/shift-series-backup.test.mjs`。真 HTTP／pure 回歸涵蓋原固定週次、開放尾日、year0000、CR/LF、完整 ACK／0 getter、角色／機構／父案、每班服務與計畫有效期、請假／重疊、CAS、全有全無失敗重試、immutable snapshot、internal malformed 資料守門、零寫預覽及 cached replay。backup 專屬驗收以 branded 合成 factory workspace 對比完整11表／6 triggers／逐欄 bytes，包含 capture、restore startup零寫、歷程／actor、内部3 links／3 versions、強制 rollback 與 local promotion。

真 Chromium 專屬 script `tests/shift-series-e2e.mjs` 以 memory SQLite／隨機 loopback 跑普通表單、產班、整組改派／取消／同日改時段、詳情／歷程、狀態、失敗保留、冪等、過期 context、角色、搜尋分頁及桌面／375／390px layout。每次輸出獨立 `outputs/software/v067-shift-series-qa/browser-*`，保留失敗結果及圖，不覆蓋舊證據；通過後另逐張實際像素審核。

本切片最終專屬驗收：22項 HTTP／pure／backup tests 全通過；fresh Chromium 14個 gate、10張桌面／375／390圖全通過，17個相關 runtime／test source SHA 在執行前後一致。證據為 `outputs/software/v067-shift-series-qa/browser-1791640058651/verification.json`，10張圖逐張實際 `tools.view_image` 像素審查及SHA見同資料夾 `pixel-review.json`。未發現阻止操作的視覺缺陷；長表單／歷程需内部捲動、窄表格部分欄需自身捲動與共用預覽提示文案限制均明示在圖檔紀錄。先前失敗 run 保留，僅這次 fresh source-stable run 標示通過。

**未含跨夜班次、整組移動日期、假日政策、自動背景排班、交通路徑最佳化或任何正式介接／外部通知。** 同日改時段不是改日期；保持原日期以避免破壞永久週次與唯一追溯。跨夜需先核定 interval／date schema 及服務紀錄日期語義，不能從此切片推定。此驗收不宣稱正式 HTTPS／Portal 發布、原平台功能全量相等或已上線。
