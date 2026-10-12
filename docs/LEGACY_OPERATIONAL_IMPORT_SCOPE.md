# 舊系統個案／員工主檔操作匯入

本切片只新增核對過的 cases／employees，先取得完整封存證明及零寫入預覽，再由受控 CLI 執行整批交易。這是第一個操作資料切片，不代表全部原系統、歷史班表、服務、附件、表單、金額、帳號或公司上線移轉完成。所有回應固定 `sourceSystemComplete:false`；`operationalImportCompleted:true` 僅表示這批明確主檔已保存。

不建立 users／memberships／SSO、不按照來源員工職稱授權、不推定薪資、單價、資格或服務狀態。status 必須由核對人明確提供。員工 source.data 禁止 hourlyRateCents；不套用既有員工 defaults 的零時薪。原始欄位可含銀行／薪資等個資，只存 private internal entity，僅目前同機構有效管理者可讀。

## 封閉 JSON 契約

頂層正好為 `format,provider,tenant,archiveManifestSha256,sourceFiles,sourceHash,records`。format 為 `suiyue-legacy-operational-import-v1`；provider／tenant 是核對的來源 token；manifest SHA 是外部保存的原封存 SHA。sourceFiles 是 1–16 個 `{fileId,sha256}`，fileId 為 opaque `file-00000001`，每個必須在本批 records 使用。sourceHash 用公開 builder 計算，不包含捕捉時間或 archiveId：

```js
import { legacyOperationalSourceHash, legacyDerivedBusinessNo, legacyOperationalId } from '../src/server/legacy-operational-import.mjs';
payload.sourceHash = legacyOperationalSourceHash({ provider: payload.provider, tenant: payload.tenant, sourceFiles: payload.sourceFiles });
// 缺來源員工編號時，明確提供 origin='derived' 與此替代編號。
const replacement = legacyDerivedBusinessNo(payload.provider, sourceId);
// 明確已核對的同批員工關聯可使用新 target UUID；這不授予任何帳號角色。
const targetEmployeeId = legacyOperationalId(orgId, payload.provider, payload.tenant, 'employees', sourceId);
```

records 為 1–2000 列，每列正好為：

```json
{
  "entity": "employees",
  "sourceId": "000000000000000000000001",
  "sourceCreatedAt": "",
  "businessNoOrigin": "derived",
  "data": {"name": "合成員工", "employeeNo": "SYNTHETIC-000000000000000000000001", "status": "active"},
  "sourceFileId": "file-00000001",
  "rowNumber": 2,
  "columns": [
    {"columnIndex": 1, "label": "編號", "raw": "", "formula": null, "cached": ""},
    {"columnIndex": 2, "label": "備註", "raw": " 首行\r\n第二行 ", "formula": "=A1", "cached": "合成結果"}
  ]
}
```

此例使用 provider `synthetic`；真實來源 provider `icare` 的明確替代員工編號是 `ICARE-${sourceId}`。替代編號不可標為原員工編號；cases 不推定替代案號。sourceId 為小寫 24 位 hex；sourceCreatedAt 為原始字串（含空白／空字串）或 null，不能換成 target 建立時間或宣稱原版本歷程。新 UUID 為 module namespace、機構、來源 provider／tenant、entity 與 sourceId 的 deterministic version 5 UUID。

data 的必要欄為 name、caseNo／employeeNo、status。cases 只允許既有 `name caseNo birthDate gender phone address status cmsLevel welfare supervisorId primaryCarer contactName contactPhone note`；status 是 active／paused／closed，生日為空或有效 ISO 日期，CMS 為空或 1–8。employees 只允許 `name employeeNo role phone email status qualification regions note`；status 是 active／inactive，regions 為文字或有限字串陣列。role 只是員工職稱，不是登入權限。

columns 依 1-based columnIndex 保存，允許重複 label，禁止重複 index；每列 1–500 欄。raw／cached 只接受有限 JSON scalar，保留型別、空白、換行、空字串與 null；formula 是原文字或 null，不執行公式、巨集、HTML 或下載連結。拒絕巢狀 raw、accessor、sparse array、無效 Unicode、unsafe integer、負零及非有限數字，以免默默損失表示。嚴格 UTF-8 JSON 上限 32 MiB，重複鍵（含 escaped aliases）拒絕。

封存 SHA 證明的是原檔 bytes，不自動證明人工欄位轉換與原 XLSX 題目、公式、格式或業務意義相同。核對人須確認原行與欄位對應；原 XLSX 保持封存，新主檔與完整原 scalar 分開保存。

## 預覽、提交與不覆寫

`createVerifiedLegacyImportSource({archivePath,expectedManifestSha256})` 取得私密 opaque capability。preview／commit 都重驗整個封存、manifest、provider／tenant、每個 fileId 及 bytes SHA；普通物件或舊的未核對證明不能代替。封存中途被改變則整批拒絕。

`previewLegacyOperationalImport(db,ctx,payload,capability)` 不做任何 SQL 寫入。重核目前同機構 admin 會員與 lifecycle、目前主檔及保存 head、來源和本批唯一編號／來源 ID／關聯；回 sourceHash、payloadHash、previewHash、兩類筆數及是否已匯入，不回原欄位、帳號、私有路徑或秘密。

`commitLegacyOperationalImport(db,ctx,payload,capability,previewHash)` 自行持有 BEGIN IMMEDIATE；不得嵌入另一個交易。整批新增主檔、不可變版本、私人批次／mapping／原欄位及稽核，再重驗來源、目前 head 和父子關係才 COMMIT。任何錯誤 ROLLBACK，不覆寫既有資料。target.createdAt／updatedAt 為本次實際建立時間；sourceCreatedAt 與 raw 原時間獨立保存。已存在 source ID／target UUID／同機構業務編號拒絕；其他機構相同編號保持隔離。

同 org／provider／tenant／sourceHash 的相同完整 canonical payloadHash 重送只確認原批次，沒有新 SQL 列；不同內容拒絕。CAS 預覽涵蓋目前主檔與權限狀態；失效後須重新預覽。回執中的舊批次 actor、原 snapshot 與原資料不改寫。

## Operator CLI

```sh
node scripts/legacy-operational-import.mjs preview --source /private/import.json --db /private/care.sqlite --org-id ORGANIZATION_UUID --actor-id EXISTING_ADMIN_UUID --archive /private/archive-UUID --expected-manifest-sha256 MANIFEST_SHA256
node scripts/legacy-operational-import.mjs commit --source /private/import.json --db /private/care.sqlite --org-id ORGANIZATION_UUID --actor-id EXISTING_ADMIN_UUID --archive /private/archive-UUID --expected-manifest-sha256 MANIFEST_SHA256 --preview-hash PREVIEW_SHA256
```

命令為待填範例，不設定真目標。source／DB 必須已存在、absolute canonical、owned 0600／private 0700、非 symlink／hardlink，sidecar 同樣受控；不 chmod、建立 DB、initDb、補歷程、checkpoint、改 journal、啟服務或建立帳號。preview 以 SQLite readOnly 開啟，commit 需明確預覽 SHA。stdout 只有摘要、計數與識別／SHA；錯誤只固定代碼，不輸出 SQLite 例外、原欄位、檔名、路徑、帳號、bank／薪資或簽署資料。CLI 的 actor-id 是受控操作者指定的既有 admin，不是網路登入替代機制。

## 管理者唯讀 API 交接

實際 HTTP server 已整合以下三個 GET，不提供 HTTP commit 或任意 path：

- `listLegacyImportBatches(db,ctx,{page,pageSize})` 回 `{orgId,items,total,page,pageSize,sourceSystemComplete:false}`。
- `readLegacyImportBatch(db,ctx,batchId,{page,pageSize})` 回 `{orgId,item,records,total,page,pageSize,sourceSystemComplete:false}`，所有 child／target／head 先驗證，才分頁摘要。
- `readLegacyImportedSource(db,ctx,mappingId)` 回 `{orgId,item,batch,currentTarget,sourceSystemComplete:false}`；item 包含移轉時 data 與完整 columns，currentTarget 為目前主檔，不能宣稱原平台即時同步。

分頁預設 1／25，pageSize 最大100；目前會員／lifecycle、單機構、封閉 stored JSON、metadata、不可變 head／完整版本範圍、來源 mapping／批次／target 的 UUID、原 target version 1及稽核都須符合。壞 child 不能藉分頁隱藏。admin 以外三角色拒絕，停用、改角色或來源／父子損壞拒絕；來源銀行／薪資欄不擴給督導或財務。

本輪合成分項已完成：Node22／24 各23項操作匯入及CLI、44項封存、10項HTTP與13項前端契約測試均通過，移轉瀏覽器14關通過並實看13張桌機／390px合成畫面。包含來源或payload重送、預覽後來源竄改、原子失敗、來源／target／同機構員工head、page範圍安全整數與admin限定讀取。原失敗、before-fix反例與probe修正紀錄保留。

公司資料完整對帳、全量來源範圍、正式主機／Portal與四角色營運UAT仍未完成；整體候選瀏覽器回歸與相同提交CI另外確認。分項程式／瀏覽器、讀得懂檔案或主檔筆數不證明全部來源移轉或正式可用；本文件不記錄真實來源人數、身分、檔案、原帳密或私人QA。
