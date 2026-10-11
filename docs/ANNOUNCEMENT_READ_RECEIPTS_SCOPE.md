# 公告已讀回執（0.40，獨立本機切片）

2026-10-09 凍結。RM-07；依 0.24/0.25 的公告權限、CRUD、版本歷程與 0.39 合成備份基礎。只用合成 SQLite／隨機 localhost／Chromium。必要整合、全部 configured premium commands、瀏覽器與逐圖檢視通過後才標 implemented_verified。原公告與 180 項原平台全量等價仍未完成。

## 本人動作與版次

- GET 公告、歷程、本人狀態、閱讀名單或報表完全不新增回執。只有本人按「我已閱讀本版公告」才提交；不繼承前版，不計算理解程度、法定簽收、預期閱讀者或未讀率。
- 沿既有四角色：admin/supervisor/finance 可讀同機構原公告；caregiver 仍需有效員工連結，current 與所選保存版皆須 exact published + `all`/`caregiver`。不新增 audience enum、角色或跨機構讀權。
- POST 只能精確 current version、published 且 title/body 是非空原字串；不 trim、不解析 HTML。草稿、非文字或缺失／空文字不可確認。即使 no-op PATCH 也產生新版，新版未讀。
- current 先沿 scopedRows 可讀性，再核對 immutable current head：org/entity/id/version、四個業務欄位的 own-presence／完整 JSON 型別值與 id/orgId/version/createdAt/updatedAt 都一致，row.created_at 等於 snapshot.updatedAt。缺 head、缺必要投影、解析失敗或不一致 409 `ANNOUNCEMENT_VERSION_INVALID`；不改舊 GET/CRUD，不補資料。
- 所選歷史版須存在於既有 readHistory 授權結果，缺失或隱藏 404。current 不可讀時不能繞回舊版；歷史版可查本人回執、不可再 POST。對管理者的草稿仍可查先前版回執。

## 保存與唯一真實來源

- 不新增 SQLite table/index/trigger，不改 initDb；保持 11 表、6 不可變 trigger、既有 schema/headers 與 startup 行為。
- hidden entity `announcement-reads` 不加入 model.entities，不提供泛用 CRUD/history。records 只作 FK locator，data 固定 `{}`；不從 records.data、audit、idempotency 或目前名冊推定已讀。
- 唯一回執來源是 record_versions version=1、source=`announcement.read` 的不可變 snapshot。既有 versions_no_update/no_delete 直接保護它。locator 本身不宣稱 DB 不可變；正常 API 沒有改寫／刪除入口。
- ID 為 SHA256(UTF-8 JSON.stringify([`suiyue-announcement-read-v1`,orgId,announcementId,announcementVersion,userId])) 的完整 64 個小寫 hex。不同 tuple 的污染／碰撞拒絕，不能當作同一回執或覆寫。
- immutable snapshot 固定 11 keys：id,orgId,version,createdAt,updatedAt,announcementId,announcementVersion,userId,userName,role,readAt。version=1；createdAt=updatedAt=readAt，readAt 為 server now 的 canonical ISO。userId/name/role 由本次 auth 決定；姓名與角色是「閱讀時保存」，不 join 目前 users/memberships 改寫。
- 對外 receipt 只有 8 keys：id,orgId,announcementId,announcementVersion,userId,userName,role,readAt。完整型別、id tuple、SQL row metadata、時間與來源需一致，否則 409 `ANNOUNCEMENT_RECEIPT_INVALID`。預期 locator 或 version 存在但缺有效 receipt 也不能當作未讀／另造回執。不可接受舊 initDb 補的 source baseline。
- 首次正常提交在同一 BEGIN IMMEDIATE 交易建立 locator、immutable snapshot、`announcement.read` audit 與可選 idem；audit entity=announcements/record_id=公告 id，detail 只放公告 version 與 receiptId，不污染既有 record.create/update actor。
- 回執不改公告內容／version／歷程／價格／附件；同 tuple 再送返回原回執與保存時間。same key 正常重送 0 durable writes／0 total_changes；不同新 key 重送只新增其 idem（無 key 則 0），不重建 locator/version/audit。
- 交易注入失敗必須還原 durable rows；SQLite total_changes 可包含已回滾的 attempted writes，另列，不能冒稱 rollback counters=0。

## API 與新查詢

新路由都在既有 auth/Origin/CSRF 下，沒有外部服務：

1. GET `/api/announcements/:id/read-state`：optional `version`，無值選 current。回 `{announcement,currentVersion,canAcknowledge,receipt}`。
2. POST `/api/announcements/:id/read-state`：body 只有 `{version}`，positive safe integer；未知 key 422 `UNKNOWN_FIELD`，不接受 caller user/name/role/time/org。首次 201、原 tuple 再送 200；回 `{receipt}`。
3. GET `/api/announcements/:id/read-receipts`：僅 admin/supervisor；optional `version,page,pageSize`，預設 current/1/25、max100。回 `{announcement,currentVersion,items,total,page,pageSize}`。只列選定版實際回執，readAt DESC/id ASC；無 cohort、未讀人數或完成率。finance/caregiver 403 `ROLE_FORBIDDEN`。

announcement 投影固定 id/orgId/version/createdAt/updatedAt/title/body/audience/status，值沿授權 immutable snapshot；currentVersion 為目前公告版次。canAcknowledge 只有 target=current 且上述合法文字/published 規則成立才 true。GET 不能改寫資料。

新 query 拒未知或重複 key，version/page/pageSize 採 canonical 正十進位數字（無 leading zero）；必須 safe integer，page offset 也須 safe。版本非法 422 `ANNOUNCEMENT_READ_QUERY`；分頁非法 422 `PAGINATION`。未支援新路由方法 405 `METHOD_NOT_ALLOWED`（既有安全檢查先行）。

idem 增加第五個 optional preflight，舊 caller 無此 hook 保持行為。新 POST 的 preflight 在 transaction 內、prior lookup 前重新檢查 current 可讀／head、精確 payload version，再檢查 published 與可讀文字；正常新寫 callback 同樣以受檢 current 建回執。current 更新後即使原 key 成功也 409 `VERSION_CONFLICT`，caregiver 撤權 404，草稿 current-version 422 `ANNOUNCEMENT_NOT_PUBLISHED`，不可顯示完整文字 422 `ANNOUNCEMENT_NOT_READABLE`；不得重播舊 response 繞權。Origin/CSRF/active link/membership 每請求沿原 auth。其餘新 receipt integrity 錯誤無原 SQL/row/secrets。

## 共用介面

- 現有 admin/listPage 只增加「閱讀全文」及 admin/sup「閱讀紀錄」入口，原 inline body、新增／編輯／撤回／歷程保持。不在每列隱式 fetch 或提交，不以 list row 當最新內容。
- 沿 ui.js/openDetails wide 加 optional、business-named `readAcknowledgement` 動作；既有 caller 無 opt-in 保持。共享 owner 管 loading、reload、read-action busy、inline error、retry、Close/Escape/focus/abort。公告 adapter 不另造 dialog/MutationObserver/controller。
- 全文由 fresh read-state DTO 顯示 literal text、版次、狀態與保存對象；typed 匯入只顯示安全 tag，明示不可確認。先顯示未讀；只有嚴格驗證的本人精確版 receipt 才顯示已讀時間。
- adapter 可使用 public/data/announcement-read-receipts.js 共用純 DTO/tuple helper，WebCrypto 計算完整 expected ID。POST confirmation 必須核對 id/org/公告版次/userId/role/canonical time/全部固定欄位，再顯示成功。未知 2xx／JSON 失敗保留全文及 inline 未確認訊息；同載入版 payload 手動重試用同一 key。重新讀取才產生新載入／key；409 不自動確認新版。
- pending action 禁重複提交、Close/Escape，不改按鈕文字尺寸；context 失效仍強制清空／abort／close，Abort 不代表伺服器回滾。成功後 fresh reload，toast 明稱已保存第 N 版，不把隨後的新版本標已讀。
- 名冊沿 semantic table/pagination 25 筆、姓名／角色標示閱讀時保存。版次用 canonical createForm 的單一 numeric exact-version 查詢，不生成 1..currentVersion 選項、不 fetchAll；server 重新驗證所選保存版可讀。預設目前版，選定版本、頁與錯誤重試留記憶體，不放敏感值入 URL/storage。
- user/org/role/employee/hash/generation/render/connected 及 startedContext object 身分保護 read/loaded/POST/名冊翻頁和版次；晚回應不復活。沿現有 CSS/tokens、桌機 wide／390px 全文、表格自身橫捲、44px 按鈕、keyboard/reduced-motion。無新 CSS/font/token、OS popup 自訂、PDF/print/訊息。

## 驗收與限制

HTTP/pure gates 覆蓋四角色、current/逐版/機構/撤權、GET 零寫、原歷程 actor、精確 DTO/ID/query、draft/typed、same/new/no key、並行唯一 tuple、衝突、故障交易、immutable versions UPDATE/DELETE、locator data 非 truth、污染拒絕。保留 11 表／6 trigger、全保存欄型別位元組、雙非空 BLOB、版本與核閱快照、31 報表出口。

合成 WAL/backup/restore 將新回執及其 audit/idem/session 全數保存、startup0；兩代有不同閱讀狀態，closed forced rollback 恢復原 live bytes 與值、success 保留 previous。不改原0.39 fixture；必要新合成寫與登入分帳，raw text 用已驗證 SQL full hex oracle。

Chromium 包含本人明確提交／pending防重／新版未讀、admin/sup分頁/版次/empty/503、finance/caregiver無他人名冊、非法2xx與同key重試、409重讀、真requestfailed abort／context切换／same-identity刷新、literalHTML/typed安全、手機/鍵盤/焦點與相關 sibling。所有 premium-ui configured commands 實際執行，初始失敗與修正來源/log/process/outer保留，不自動 mutation retry；最終唯一畫面逐圖檢視。

維持原84/52/28/16/359／4 sources／12 contracts／9 phases、原completed0、前38 local milestones、RM09 scoped partial與正式相依、支付／薪資／評分／介接 needs_contract。只追加本機能力與證據，metadata 後另hash封存。不讀、重啟、reload、probe、登入或写既有 DB/4310，不用原帳密／個資，不做 CI/UAT/申報/付款/外部訊息/正式部署。

原公告 audience/其他原角色/正式閱讀與保留政策仍待核定。immutable 回執僅證明操作紀錄，無理解或法定簽收保證；讀取可能掃描機構 JSON receipt rows，分頁不宣稱索引效能或大型資料 SLA。既有缺 head 的 initDb 修補行為未改，但新receipt驗證拒絕baseline；不宣稱正式資料移轉、DR、RPO/RTO、加密或 retention已驗。
