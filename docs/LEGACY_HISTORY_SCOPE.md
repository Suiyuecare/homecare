# 歷史原始紀錄保存與唯讀查閱（0.83）

此切片將授權取得的原始服務匯出、員工／個案原頁與歷史表單保存成可追溯的歷史原列。它不建立新排班、已核閱服務、正式薪資、付款或申報，不建立帳號、會員或 Portal 綁定。原平台全部資料、深層表單、附件、營運轉換與正式規則核定仍須各自驗收。

僅本機構目前有效管理者可以預覽、保存與讀取。每次以資料庫目前角色、機構關聯與帳號生命週期檢核；不能憑呼叫者自稱管理者，也不依 email 增加角色。公開程式及測試僅含合成資料。

## 封包與來源證明

封包格式為 `suiyue-legacy-history-import-v1`，封閉的頂層欄位為 `format / provider / tenant / archiveManifestSha256 / sourceFiles / sourceHash / records`。`sourceFiles` 為 1～16 個 `{fileId,sha256}`；fileId 是已驗封存的 opaque ID，例如 `file-00000001`，不用原檔名或任意路徑。所有宣告的檔案必須在本批使用。

每批 1～1,000 列，整份 UTF-8 JSON 上限 32 MiB；每列 1～500 欄。每列欄位完整且必填：

| 欄位 | 契約 |
| --- | --- |
| category | `service-export / employee-profile / case-profile / care-plan-history / fa-export / company-settings / form-record / attachment-metadata` |
| reportingPeriod | 原來源明確提供的 `YYYY-MM`（year 0001～9999）或 null，不推定服務日期 |
| sourceNativeId | 原文 string 或 null，空字串原样保存，不捏造來源 ID |
| sourceCreatedAt | 原建立時間文字或 null；不推定時區、ROC 日期或來源版本 |
| caseId / employeeId | 已存在的本機構 UUID 或 null，不自動配對、建立或更新主檔 |
| sourceFileId | 本批宣告並核對的 opaque 原檔 ID |
| locator | 下述原檔定位之一 |
| columns | 下述完整欄位原文陣列 |

定位只接受 `{kind:'worksheet-row',sheetIndex,rowNumber}`（1-based 的真正 Excel 工作表／列位置）或 `{kind:'json-pointer',pointer}`（真正 JSON 位置的 RFC 6901 原文字串）。不執行 pointer、公式或連結，不能替 CSV／HTML 捏造工作表。位置與人工轉錄的語意對應須另核對；原檔 SHA 通過不代表全部業務內容已取得或轉換正確。

每欄五個 key 全部必填：`{columnIndex,label,raw,formula,cached}`。columnIndex 是唯一正整數；重複 label 依 index 保留。raw／cached 可為 null、boolean、string 或有限 number（整數必須 safe，不接受 -0）；formula 為 string 或 null。空白、空字串、CRLF、單獨 CR、NUL、null、型別、公式原文及快取值全數保留。拒絕巢狀 scalar、NaN／Infinity、不安全整數、sparse array、accessor、額外 key、無效 UTF-8、未配對 surrogate 及 escaped 重複 JSON key，getter 不會執行。

`src/server/legacy-history-format.mjs`（亦由 import 模組 re-export）的 builder：

```js
legacyHistorySourceHash({ provider, tenant, sourceFiles, records });
normalizeLegacyHistoryPayload(payload);
legacyHistoryHash(normalizedPayload);
legacyHistoryRowId(orgId, provider, tenant, sourceFileSha256, locator);
legacyHistoryBatchId(orgId, provider, tenant, sourceHash);
```

sourceHash 包含穩定原檔 SHA 與本批定位選取，不能只用 file SHA；同一檔可分批選不同原列。來源列身份固定由機構／provider／tenant／原檔 SHA／locator 決定，fileId、分類、日期與 nativeId 不決定平台 UUID。即使換封存或 opaque fileId，同一原檔定位也不得重建另一列。`identityKind` 永遠是 `archive-locator`。

`createVerifiedLegacyHistorySource({archivePath,expectedManifestSha256})` 建立不可偽造的 opaque capability。預覽與提交重驗整份封存權限、links、manifest SHA 及選取原檔內容 SHA；一般物件或普通檔案路徑不能當來源證明。讀取 buffer 使用後清除。HTTP 沒有提交來源或任意私人路徑的入口。

## 保存、重送與容量

只向現有 records／record_versions／audit 新增 `legacy-history-batches` 及 `legacy-history-rows`，歷史頭固定 version 1、來源標記與 audit 必須一致。batch audit 另綁完整 batch data 的 metadataHash，月份／類別／layout 等摘要即使遭外部修改並同步 head，global list 仍會拒絕，無須读取所有 children。不註冊一般 CRUD entity，不新增 SQL 表。以下九個表保持不變，所有已有 records／versions／audit 列亦不修改：organizations、users、memberships、sessions、portal_identity_bindings、portal_handoff_nonces、demo_seeds、attachment_files、certification_attachment_files。

preview 不寫 SQL，也不初始化、修 schema、改 journal、chmod、建立帳號或替未知金額補 0。commit 使用独立 BEGIN IMMEDIATE，交易內重新檢核角色、來源、既有原列、父主檔與 preview hash；全批原子保存，任何一列或封存失敗整批 rollback。同 sourceHash 的不同 payloadHash 拒絕；exact replay 不新增資料。來源封包／原列／父主檔 current head、同機構與 immutable version chain 任何一處不合法均拒絕。

來源建立時間另存 sourceCreatedAt；平台 createdAt／updatedAt 是本次保存時間。既有 case closed、employee inactive 可以保留歷史关联，仍需目前同機構合法主檔／完整 head；case supervisor 亦须为同機構合法 employee。读取摘要只回姓名、編號、ID、version、status，不夾帶電話、身分證、email 或帳號角色。

內部保存使用 batch 共用且去重的 header layouts（每欄 `{columnIndex,label}`），每列只保存 layoutIndex 與完整 `[raw,formula,cached]` 值。沒有截斷、捨棄空欄、快取猜測或金額計算。讀取先完整還原所有 columns，再通過同一封包驗證器、sourceHash 與 canonical payloadHash，才回傳原 DTO。

preview 的 `storageEstimate:{kind:'stored-json-columns-only',bytes,layoutCount}` 精確估計本批將保存的 records data、versions snapshot 與 audit detail 的 UTF-8 JSON bytes。它不含 SQLite page／index／WAL、原封存、備份 envelope／hex 或復原額外空間，不能當整體磁碟容量承諾。大規模資料須逐批累計、在隔離 DB 測實際檔案大小，並驗證磁碟餘裕與既有備份上限；不得自行擴大既有備份防護。

## 封閉的唯讀 API 契約

後端匯出（DB-first）為 `guardLegacyHistoryAccess(db,ctx)`、`listLegacyHistoryBatches(db,ctx,{page,pageSize})`、`readLegacyHistoryBatch(db,ctx,id,{page,pageSize})`、`readLegacyHistoryRow(db,ctx,id)`。page 預設 1，pageSize 預設 25、上限 100；起訖 offset 都必須 safe integer，拒絕未知 query。

list 回 `{orgId,items,total,page,pageSize,...flags}`；batch 回 `{orgId,item,records,total,page,pageSize,...flags}`；row 回 `{orgId,item,batch,...flags}`。

BatchMeta：`id / orgId / version / createdAt / updatedAt / provider / tenant / sourceHash / payloadHash / archiveManifestSha256 / archiveId / importedBy / importedAt / rowCount / categories / reportingPeriods / status / ...flags`。categories 為唯一排序 string[]；reportingPeriods 為唯一排序 YYYY-MM string[]，忽略 null；空陣列表示來源未提供月份。status 固定 `historical-original-records`。

RowSummary：`id / orgId / version / createdAt / updatedAt / batchId / category / reportingPeriod / sourceNativeId / sourceCreatedAt / caseId / employeeId / sourceFileId / sourceFileSha256 / locator / identityKind / caseReference / employeeReference`。caseReference 為 null 或 `{id,name,caseNo,version,status}`；employeeReference 為 null 或 `{id,name,employeeNo,version,status}`。row detail 另含完整 columns。

四個 flags 在各層均固定 false：`sourceSystemComplete / operationalConversionCompleted / approvalCompleted / payrollApproved`。

批次 detail 與 row detail 會驗證該批所有 children、payloadHash、audit、當前父 reference，再做分頁或回傳一列；即使損壞列不在当前頁也拒絕。global list 只按 server pagination 讀取可核對的 batch metadata/head/來源選取摘要，不逐次解析全部歷史原列；列表可見不代表其所有列完整，明細另行完整驗證。

## 操作 CLI 與驗收界線

```text
node scripts/legacy-history-import.mjs preview --source <private-payload.json> --db <existing-private-db> --org-id <UUID> --actor-id <UUID> --archive <verified-archive> --expected-manifest-sha256 <SHA256>
node scripts/legacy-history-import.mjs commit  --source <same-payload.json> --db <existing-private-db> --org-id <UUID> --actor-id <UUID> --archive <verified-archive> --expected-manifest-sha256 <SHA256> --preview-hash <previewHash>
```

需要既有、擁有者正確的私人 DB／0600 檔／0700 目錄；拒絕 alias、symlink、hardlink、不安全權限、未知參數、缺少 preview hash 與不存在 DB。固定錯誤代碼可另含 1-based recordIndex；不输出私人路徑、原始例外、欄位值、秘密或 bank／薪資原文。

合成驗收涵蓋零寫預覽、原子 rollback、exact replay、CAS、同原列跨批防重、來源 SHA／capability、目前角色與撤權、跨機構／異類／損壞父頭、完整分頁前驗證、損壞 layout／audit／metadata、有限 scalar／UTF-8／重複鍵及所有保護表／既有列保持不變。純 JSON shared fixture 位於 tests/helpers/legacy-history-fixture.mjs，使用真正 `/rows/n` 位置。

本輪 1,000×58 欄合成容量、兩 Node domain／CLI 與 HTTP／瀏覽器整合證據須分别登记；過去 0.82 CI 不充當本輪驗收。約九萬真實列的容量、正式來源逐列語意核對、完整制度／附件、權限 UAT、可持久主機／HTTPS／Portal 發布、正式薪資／核銷核定及復原均另待完成，未因此標示正式可用。

## 0.83.1 稽核讀取成本

每批最多1000列的稽核以同機構、entity、action及完整列識別一次讀取，最多取N+1項，當次Map逐列核對原user及完整detail。缺件、重複、錯actor、頁外損壞及下次撤權／稽核修改仍拒絕；不跨請求快取、不改schema或四個false。200列SQL成本反例在原版原生退出1；修正版兩Node各30項分項通過。完整同提交回歸另驗，私人資料量量測不作正式SLA或發布證明。
