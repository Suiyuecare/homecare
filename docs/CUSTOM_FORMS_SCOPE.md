# v0.67 型別化機構自訂表單

本切片提供非正式、自訂模板與個案填答，沿用同機構、伺服器角色、版本歷程、共用表單／對話框／列印 owner。不是原平台 16 份正式模板、評分、申報或原 180 項全面對等完成證據；正式名稱、欄位、題序、核定規則與合格判定仍須使用者提供。

## 操作與資料

- 路由 `#/custom-forms`，僅 admin/supervisor。finance/caregiver 的讀寫及歷程 API 一律 403；機構範圍由伺服器 session/membership 確認。
- 普通控制項建立模板草稿、說明與群組、短／長文字、十進位文字、日期、單選、多選、是／否題項；選項每行「代碼｜顯示名稱」，條件用前序題項及相等值，使用者不用填 JSON。
- 模板 draft 可編輯／移除無其他條件引用的題項；發布後內容鎖定，只可停用。修正以新 record、新 revision 及 previousTemplateId 建立新版草稿，保留前版。至少一題，不允許全空模板。
- 選擇個案与已發布模板版本，新增草稿，依題型填答、引用同個案的既有有效附件識別碼。新增只能 draft；draft 保存及 submitted 提交均須模板目前仍 published，且 SQL version 完全相同。
- required 僅約束 submitted 的可見題項；草稿允許略過。隱藏／未知答案拒收。條件變更會明確確認清除不再適用的既有答案，取消復原控制條件與答案；過期確認不執行晚到清除。
- caseId、templateId、templateVersion 建立後不可換。submitted 永久锁定；修正另建紀錄。模板停用後已保存填答仍依固定快照顯示及唯讀列印，沒有重算／換模板。
- CRLF、空白、`0.10` 等原始文字及未變更多選／附件陣列順序保留；是／否未選擇不推定 false。

## 封閉契約

`form-templates`: `code,name,description,revision,previousTemplateId,groups,fields,status,note`。revision 是正 safe integer，不是任意 JSON；第一版 revision=1、previousTemplateId=''，新版需同機構同 code 前版 published/inactive 的 revision+1。code+revision 唯一。若 raw SQL 模板數與可讀 rows 不同，或既有模板封閉定義／修訂鏈無法確認，模板寫入 409 並零寫，不把損壞佔用當成空白。

`form-records`: `caseId,templateId,templateVersion,date,answers,attachmentIds,status,note`。templateVersion 是已發布模板的 SQL version，例如发布后的 2；與 logical revision=1 分開。伺服器衍生、客戶端不可提交 `templateSnapshot`，其 exact known keys 是 `id,orgId,version,code,name,description,revision,groups,fields`，以精確同機構已發布 record_versions snapshot 證明來源。

groups 最多20，每個 `{id,label}`。fields 1–50，每個 `{key,label,type,groupId,required,options,visibleIf}`；題／組代碼 ASCII 英文字母開頭，最多50字，不接受 reserved/prototype keys、CR/LF／首尾空白。每題 options 最多50，每個 `{value,label}`；單行選項代碼唯一、最多100字，名稱最多200字。select/multiselect 必須有選項，其餘型別必須 options=[]。

visibleIf 只能 null 或 `{field,equals}`，只能指向前序非多選題。相等值符合控制題型別，不支援 eval、函式、任意運算或前向／循環條件；控制題本身可見且存在答案才會啟動其下游。

text 最多500字且單行；textarea 最多10000字且保留 CRLF；number 是精確 decimal text `^-?\d{1,15}(?:\.\d{1,12})?$`，不接受 JS numeric primitives／指數／nonfinite，不做計分或數值運算；date Gregorian `0001-01-01`–`9999-12-31`，拒0000／尾CRLF／無效閏日。select 單一已知值；multiselect 最多50個不重複已知值；boolean 只有真正 true/false。

整份 schema JSON 字元上限1000000、answers 上限600000；50×10000字長文可完整保存。僅這兩個新 entity 的 POST/PATCH body 上限4MiB，其他既有 answers 限制不放寬。附件 IDs 最多20、不重複，寫入時同機構同個案且 active，歷史參照允許同 parent inactive；不複製 BLOB/fileId。

## API 與 owner

沿既有泛用 `GET/POST /api/form-templates`、`GET/PATCH /api/form-templates/:id`，及相同 `form-records` 路徑；`GET /api/:entity/:id/history?compare=previous` 是唯讀。單筆 GET 不接受 query；清單封閉 page/pageSize/q/status，填答另允許 caseId/templateId/date；歷程只接受 page/pageSize/compare。拒重複 query、未知 key、尾CRLF 整數／日期。PATCH 採 version CAS；POST 使用共用 idempotency，UI 同一對話框完全相同 payload 重試沿相同 key。

根節點 owns model/index/app/admin/ui/history 接線，新增 server exports 供注入 get/rows/fail，避免循環依賴：`customFormEntities,isCustomFormEntity,guardCustomFormAccess,normalizeCustomFormPayload,readPublishedFormSnapshot,customFormVisible,customFormHistoryVisible,validateCustomForm,customFormQuery,filterCustomForms,customFormPrintModel`。前端入口 `mountCustomForms(container,{isCurrent})`。

共用 openForm 持有送出、dirty、abort/context 及 cancel；setHidden 隱藏整組／停用子控制項並保留值。自訂頁維護顯示條件確認 generation 及 rollback。openDetails 持有 fresh GET、本機列印、beforeprint 抑制、關閉及 focus；唯讀關閉不任意重載清單破壞 trigger focus。typed history renderer 顯示封閉欄位與保存模板／可見答案，不 raw JSON。

## 驗收與可追溯證據

`node --test tests/custom-forms.test.mjs tests/custom-forms-http.test.mjs`：13 pure/memory 及5 HTTP tests，合成 `:memory:`。驗證所有七型、條件／必填、發佈／提交鎖定、新版、同機構parent、角色先拒、CAS/idem、unknown nested/getter/sparse、尾行識別／query、50題長文、快照來源、附件引用、BigInt SQL version／bad/null JSON及損壞模板佔用的零寫。

`node tests/custom-forms-e2e.mjs`：實際 random loopback app 與瀏覽器；普通模板／群組／七題型／條件／發佈／續版、填答取消复原／明確清除／提交必填及鎖定、typed history、來源停用後快照與列印fresh GET、原生列印抑制、focus，以及 admin/supervisor、finance/caregiver拒絕。desktop1440、375／390像素，控件標籤、對話框邊界、頁面不外溢及表格内捲動。

每次 browser run 建立唯一 `outputs/software/custom-forms-qa/attempt-*`，JSON/PNG/PDF 同目錄、來源 start/end SHA 與artifact SHA；保留 failed logs。先前 fixed-path QA 已封存 exact bytes manifest，舊 JSON 不冒稱其最初 bytes 已可恢復。列印 PDF 是剛由共用 owner 確認 fresh 的畫面靜態 DOM 排版檢查，沒有自動操作 OS 原生列印對話框；不作正式文件或正式部署證據。

本檔是切片範圍；正式完成標記由根節點完成必要整合／browser 與 final source freeze 驗收後統一更新，不更動原180項狀態。
