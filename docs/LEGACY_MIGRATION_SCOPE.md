# 原始匯出私人封存與完整性核對

本切片提供未掛載到 HTTP 的 operator CLI，封存明確指定的私人匯出目錄，並核對原檔／副本 SHA-256 及 bytes。它不登入原平台、不自行匯出、不讀環境秘密或本機正式 DB、不執行掃毒、不執行檔案／巨集／公式、不解開 ZIP，也不建立正式業務資料或重新授權帳號。

CSV、XLSX、ZIP、PDF、圖片及其他 regular 檔案全部按原始 bytes 複製，包括同內容的重複檔案；工具不自動去重或跳過未知檔案。未知副檔名以 `.bin` 儲存。若遇不能可靠處理的路徑、symlink、hardlink、socket／FIFO 等非 regular 項目，整次封存拒絕驗證，不能默默略過後宣稱完成。

## 操作前提

- 操作者已授權取得匯出；只把匯出檔案放進 incoming，下載及匯出寫入已全部停止。來源與輸出目錄需由目前 UID 擁有且為 `0700`；來源子目錄不能讓 group／other 寫入。
- incoming、archives、scope 文件使用分開的私人位置；兩個目錄不能互相包含，scope 不能放在其中。先由操作者建立 archives，工具不推定任意目錄可作私人儲存。
- 所有參數用已 canonicalize 的 absolute path，不接受任何祖先或檔案 symlink；Windows、沒有 UID 或必要 POSIX file flags 的環境不屬本工具支援範圍。
- `scope.json` 由目前 UID 擁有、單一 hardlink、權限 `0600`，所在目錄 `0700`。provider／tenant／dataset／缺項／未決代碼只使用無個資的 opaque 小寫英數及 `-` token，不填 email、姓名、帳號、密碼或完整查詢參數。
- 私人 ACL、磁碟權限與同 UID 工作程序由主機操作者管理。來源必須凍結；本工具不是可讓任意 writer 同時修改資料的全域交易快照，也不宣稱能防禦具有相同 UID、可持續改寫整個檔案樹的惡意程序。

## 來源範圍文件

`format`、provider、tenant、匯出 UTC 時間、datasets、missingDatasets、unresolved 為必填。時間使用完整 ISO UTC，例如 `2026-10-12T01:00:00.000Z`。每個 dataset 必填 id、sourceFiles、reportedCoverage、range；sourceRowCount 可省略或為 `null`。

以下全部是合成 label 及檔名，不是實際個案或機構綁定：

```json
{
  "format": "suiyue-legacy-export-scope-v1",
  "provider": "synthetic-provider",
  "tenant": "synthetic-tenant-01",
  "exportedAt": "2026-10-12T01:00:00.000Z",
  "datasets": [
    {
      "id": "cases",
      "sourceFiles": ["cases.csv"],
      "sourceRowCount": 12,
      "reportedCoverage": "partial",
      "range": {"kind": "filtered"}
    },
    {
      "id": "service-records",
      "sourceFiles": ["records.xlsx", "attachments.zip"],
      "reportedCoverage": "unknown",
      "range": {"kind": "date-window", "startDate": "2026-10-01", "endDate": "2026-10-12"}
    }
  ],
  "missingDatasets": ["historical-claims"],
  "unresolved": ["provider-row-total-not-confirmed"]
}
```

reportedCoverage 僅可為 `unknown`、`partial`、`provider-declared-full`。range.kind 僅可為 `unknown`、`all-source-rows`、`date-window`、`filtered`；只有 date-window 帶有效且順序正確的 startDate／endDate。每個原相對路徑最多歸屬一個 dataset；不用同一檔案在多份清單重計。若一個 ZIP 包含多個資料集，先標記檔案容器歸屬及未決代碼，不能直接推定 ZIP 內筆數或附件關聯完整。

sourceFiles 可包含未取得的預期檔案；manifest 會保留它們相對路徑的 hash 並標記 `declared-source-files-missing`。沒有 dataset 清單、未歸屬的實際檔案及使用者列出的缺項均明列。sourceRowCount 是操作者報告的來源筆數；`rowCountVerified:false`，不等於工具已解析或獨立核對筆數。provider 的全匯出宣告也不等於本工具確認原系統完整。

## CLI

使用絕對私人路徑，在已核定且凍結的 incoming 執行：

```sh
node scripts/legacy-migration-archive.mjs capture \
  --input /private/canonical/incoming \
  --output-parent /private/canonical/archives \
  --scope /private/canonical/operator/scope.json
```

成功 stdout 只輸出狀態、隨機 archiveId、manifestSha256、檔案／bytes／資料集及缺項數、是否再次比對來源，以及固定 `sourceSystemComplete:false`、`businessImportCompleted:false`。記下 archiveId 及 manifestSha256，存放在另一個受控私人操作紀錄；不要公開原檔或 manifest，也不要將它們推上 GitHub。

重新核對已封存副本：

```sh
node scripts/legacy-migration-archive.mjs verify \
  --archive /private/canonical/archives/archive-00000000-0000-4000-8000-000000000000 \
  --expected-manifest-sha256 0000000000000000000000000000000000000000000000000000000000000000
```

上例 UUID／hash 只是合成佔位值，必須換成 capture 實際結果。可加 `--input /private/canonical/incoming`，再次比對目前原始檔；不加時只證明指定副本與外部保存的 manifest hash 相符，不能證明來源之後沒有改變。

verify 為唯讀，拒絕缺少外部預期 hash、清單被替換、額外／缺少副本、bytes／hash 不符、連結或私人權限改變。SHA-256 提供完整性核對，沒有取代來源平台簽章、操作身分認證或公司授權。

供後續 private operator 轉換工具使用的 library API：`inspectVerifiedLegacyArchive({archivePath, expectedManifestSha256, inputPath?})` 回傳凍結的 `{proof, manifest}`；`readVerifiedLegacyFile({archivePath, expectedManifestSha256, fileId, maxBytes})` 回傳 `{file, bytes, source, archiveId, manifestSha256}`。reader 先核對完整封存，再以 opaque fileId 取有上限的 regular 檔案，核對該檔 bytes／hash 與前後 manifest；maxBytes 必須明示，最多 32 MiB，不接受 arbitrary path。不會解析／執行 bytes；呼叫者使用完應清除 Buffer。副檔名和 `PK` 檔頭都不能獨立證明 ZIP／OOXML 容器格式，轉換工具要另做完整格式辨識，不能因副檔名直接跳過或誤解析。

原檔名與 opaque fileId 的可回溯關係另存**外部私人 mapping receipt**，不能加回匿名 manifest 或公開文件。建議 schema 為 `{format:"suiyue-legacy-source-map-v1", archiveId, manifestSha256, entries:[{sourceRelativePath, fileId, sourceRelativePathSha256, bytes, sha256}]}`；使用原相對路徑 UTF-8 SHA 與已驗證 manifest 精確配對，一個 path 一個 fileId；保存 `0600`、所在目錄 `0700`。ZIP 內部檔名、工作表、原 row ID／編號及衍生 ID 規則由轉換階段另建私人 receipt，不由此工具猜定。receipt 含原檔名，視同私人資料保存，不印在 stdout。

CLI 不接受秘密參數、不從 env 或 stdin 尋找缺少的路徑或資料。不合法參數 exit `1`，stdout 不產生成功摘要；stderr 只輸出固定失敗碼及已建立的 opaque archiveId，不輸出檔內資料、原檔名、scope 原文、absolute path 或 driver error。

## 封存與失敗語意

1. 有界驗證來源樹、所有 regular 檔案 identity、size／mtime／ctime／link／owner，以及 scope；預設上限為 100,000 檔、1 TiB，另限制 100,000 目錄、200,000 樹項目及 64 層。目錄使用 bounded iterator，拒絕超限而不讀入無界清單。這是工具容量上限，並非核定營運容量或完整性門檻。
2. 在 archives 建立新隨機 `archive-UUID` 目錄，exclusive 且 `0700`，每個副本 `0600`。副本路徑為穩定的 `files/00000001.csv`；manifest 僅存原相對路徑 SHA-256，不存可能含姓名的原檔名或檔案內容。
3. 使用 bounded streaming、O_NOFOLLOW、檔案 lease 前後檢查、完整 write loop 與檔案／目錄 fsync；獨立重讀副本，再重新掃描及 hash 原始來源，拒絕已觀察到的追加／刪除／替換／內容變更。副本檔案目錄的 entries 在 manifest 發布前獨立 fsync。
4. 所有原檔／副本確認後，先寫私人 manifest.pending 並 fsync，再用不可覆寫的 hardlink publication 建立 manifest.json，移除臨時 link，fsync 目錄及做最終唯讀 verify。暫時兩個 link 或 pending 同時存在時，verify 拒絕，不能當成完成包。
5. 失敗保留私人部分副本與能安全寫入的 failure.json，移除本次可確認 identity 的完成 marker；對身份不明、已被替換或已有的檔案不刪除／覆寫。已有外部碰撞 manifest 不屬本工具，會保留但不能通過驗證。不得把殘留資料夾或 `manifest.pending` 當成完成。
6. 重跑產生新包；四個同時 native CLI 封存不共享包、不覆寫舊包。不得為重跑清空 incoming 或整批刪除失敗證據。

此切片沒有正式 DB promotion／rollback、Portal grant 重建、資料列合併或 source-ID 業務映射。它也沒有正式加密／KMS／RPO／RTO 備份契約；私人 filesystem 封存不等於正式災難復原備份。

## 驗收

合成測試包含原 bytes／NUL／非 UTF-8 binary、CSV 公式文字未執行、各檔型與未知檔型、同內容檔案保留、穩定匿名路徑、檔內及檔名 sentinel 不進 manifest／stdout、缺項及來源範圍明列、私有權限、symlink／hardlink／實際 Unix socket 拒絕、來源變更、部分 write／fsync／發布／發布後失敗、manifest 外部 hash、未完成 publication、唯讀 verify 及四個 native process 並行。

後續業務匯入須另取得完整匯出樣本與資料字典，逐 dataset 定義原 source ID、機構邊界、欄位型別、枚舉、時間、金額與版本、關聯／附件映射、衝突／人工去重、保留及分享規格。建立去識別正反例；先產出 dry-run 全量筆數／關聯／附件 hash／金額差異，零靜默略過、可重跑而不重複；核定後才匯入新隔離 DB 並做四角色與回退驗收。沒有这些定義時，不新增猜測性的通用對照或自動合併機制。
