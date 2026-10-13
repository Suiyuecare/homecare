## 0.83.3 單一候選資料庫的串流讀取（本機完整已驗，同提交 CI 待驗）

v1 magic、header、AAD、AES-256-GCM、加密 proof／SQLite wire 排列及 writer 保持。reader 只辨識前四個 framing bytes，將最多 1 MiB proof 留在自有 buffer，其後資料庫 bytes 寫入一份新建 `0600` 私人工作檔；這時尚未以 SQLite 開啟。每次使用後清零解密 chunk，自有 proof／prefix 在結束時清零。

framing 為零、超限、截斷或資料庫超限時，reader 記錄無效狀態並繼續驗證 GCM；不因不可信長度分配大於上限的 proof，不寫超過 maxBytes 的 DB。錯 key／tag 先回 `AUTHENTICATION_FAILED`；完整認證後的損壞 framing 回 `ENVELOPE_INVALID`。明文 header、envelope 總容量與來源私人檔的原守門仍可先行拒絕。I/O 與私人路徑故障沿原固定錯誤守門，不保證取代實際 I/O 故障的錯誤優先序。

GCM final 成功後先重新核對來源 lease，再檢查 framing、UTF-8、canonical JSON、proof／DB bytes／SHA 與精確十三表；候選檔 fsync、身份、無 sidecar、隔離清 sessions／停 bindings 及 `RECOVERY_PENDING` 的原流程保持。成功或失敗關閉自有 FD，只清理身份仍屬本操作的暫存；不刪除被替换的外部原件。

空間驗收須用實際合成 v1 檔，同時觀察原版和候選 reader 的全部工作區檔案 bytes。D 表示資料庫、E 表示 envelope：verify 的工作區目標由约 2D 加 proof 縮為 D；若計已存在的 envelope，則约 2D+E 縮為 D+E。create 原本已在加密結束後釋放 snapshot，本次目標再從 E+2D 加 proof 降為 E+D。這不包含 caller 原DB／WAL、其他備份、SQLite cache／journal、隔離輸出或系統餘量；恢復 quarantine 可有短暫 journal，不宣稱完整程序任何時點均嚴格只占 D+E。

驗收待辦：錯 key／tag 與 0–3 byte prefix、0／超限 proof、無效 JSON／UTF-8、短／超限 DB 的交叉反例；來源替換發生在認證和 proof 解析之間；写入／fsync／路径身份失敗的 FD 與原件保護；buffer 清零；舊 v1 真實跨版檔；十三表／附件／nonce 與隔離停權；新舊 workspace 實測。公開兩 Node 各 47 項分項及獨立各 4 項整合原生退出 0。獨立舊版 writer 的實際合成檔 D=4,354,048、E=4,356,371 bytes：原 create／verify 工作區峰值 13,066,614／8,710,243，候選 8,710,419／4,354,048；恰少一份 4,356,195 bytes 的舊明文 payload。4 MiB 合成 BLOB、13 表、quarantine、FD 故障與來源／候選身份替換另有完整保護斷言。完整兩 Node 各 2521 項程式測試／595 份語法原生退出 0，執行前後來源 SHA 一致。相同提交 CI 結果另補，不承接前版 CI 來宣稱本輪完成。

## 0.83.2 工作區副本釋放

`createProductionBackup`在`encryptSnapshot`成功返回、快照讀取FD與密文寫入FD皆關閉後，呼叫工作區`discardOwned`丟棄這次捕捉的暫存明文。保存的十三表inspection、資料庫bytes／SHA及proof仍用於密文重開與完整比對。任何加密／釋放／重開失敗均不發布結果，不修改原來源或呼叫者金鑰；原v1格式、GCM接受後才解析DB、備份容量上限及隔離恢復禁啟動守門保持。

`discardOwned`只允許位於工作區根內、已捕捉且caller expected identity一致的檔案；目前路徑仍須通過原canonical／owner／600／single-link及captured inode／dev／uid守門。即使`adoptSidecars`曾登錄外部sidecar也不能捨棄；caller不能以新replacement identity取代原Map lease。unlink与根目錄sync成功後才移除追蹤；錯誤由原closed operator guard處理，沒有HTTP入口。

新增合成實際FS寫入觀察器：原流程4份、修正後3份資料庫大小暫存檔；此数字只描述本次工作區，不計操作人員另留快照、原DB、其他備份、元資料或餘量，不是正式主機容量與SLA。Node22/24分項34項全過，完整回歸與CI另列；原錯誤及native非零保留，不能由后續成功推定先前操作失敗唯一成因。

# 受控加密備份與隔離恢復

本工具供操作人員指定現有居家系統 SQLite 資料庫進行備份與驗證。它使用獨立的正式備份格式，不限制資料庫來自合成 workspace；本次開發與測試仍只使用工具自行建立的合成資料。沒有讀取實際資料庫、既有私人備份或公司帳號綁定，也沒有正式切換服務。

已實作 `backup`、`verify`、`restore-isolated`、`prepare-reconcile`。沒有覆蓋 live 資料庫、啟用還原權限、付款、政府申報、購買儲存空間、外部上傳或自動切換流量的操作。

## 執行條件

- POSIX 主機上的 Node 22.16 以上或 Node 24；已用目前 Node 22／24 驗證。低於支援版本時拒絕執行，不改用不一致的 main-file 複製。
- 明確、絕對、無符號連結的備份路徑；來源及目的地的直接父目錄必須由執行者擁有且為 `0700`。檔案必須為同一擁有者的 `0600` regular file，拒絕 symlink、hardlink、非私人權限及來源三種 journal sidecar 的不安全身份。
- 加密金鑰為隨機產生的 **32-byte binary AES key**，由 `0600` 檔案或已結束的 pipe 讀入。不是人類短密碼；沒有密碼 KDF，也不接受 argv、URL 或環境變數中的明文金鑰。金鑰需另外安全保存，遺失後無法解密。
- 預設單資料庫容量上限 2 GiB，可明確指定 `--max-bytes`，最大 32 GiB，低於單個 AES-GCM IV 的安全資料量上限。這是技術上限，並非已完成 32 GiB 主機負載驗收。備份及驗證需要私人暫存空間；請保留充足磁碟與記憶體。

以下路徑均為操作範例，不代表已有正式主機或已設定的金鑰；實際目錄、服務帳號、保留天數與異地儲存由營運核定。

```sh
node scripts/production-backup.mjs backup \
  --database /srv/homecare/private-data/care.sqlite \
  --output /srv/homecare/private-backups/approved-generation.hcb \
  --key-file /srv/homecare/private-keys/backup.key

node scripts/production-backup.mjs verify \
  --backup /srv/homecare/private-backups/approved-generation.hcb \
  --key-file /srv/homecare/private-keys/backup.key

node scripts/production-backup.mjs verify \
  --backup /srv/homecare/private-backups/approved-generation.hcb \
  --key-stdin < /srv/homecare/private-keys/backup.key

node scripts/production-backup.mjs restore-isolated \
  --backup /srv/homecare/private-backups/approved-generation.hcb \
  --destination /srv/homecare/private-recovery/new-generation \
  --key-file /srv/homecare/private-keys/backup.key

node scripts/production-backup.mjs prepare-reconcile \
  --destination /srv/homecare/private-recovery/new-generation \
  --authority-database /srv/homecare/private-data/care.sqlite
```

目的備份檔及隔離目錄必須不存在。工具沒有 `--force`、`restore-live`、`activate`、忽略當前授權或覆寫目的地的選項。重跑需要另一個新目的地，保留原件及原失敗證據。

## 備份內容與完整性

以獨立唯讀 SQLite connection 的已固定讀取交易，透過 SQLite online backup API 取得已提交的一致快照。包括 WAL 中已提交內容；不包含尚未提交的交易，也不 checkpoint、初始化或回填來源。SQLite 的一般讀取鎖／shared-memory 協作不等同修改業務資料；測試另核對來源邏輯內容及 main/WAL bytes。

目前接受固定 13 張表：`attachment_files`、`audit`、`certification_attachment_files`、`demo_seeds`、`idempotency`、`memberships`、`organizations`、`portal_handoff_nonces`、`portal_identity_bindings`、`record_versions`、`records`、`sessions`、`users`。包括密碼雜湊、登入安全狀態、audit、版本、JSON 中完整計價快照及兩類附件 BLOB。11 表的舊 schema、未知／額外表或變動的 schema 會被拒絕；不能以初始化現有資料庫來掩蓋差異。

檢查精確 schema SQL／indices／六個不可更新或刪除 triggers、schema headers、SQLite integrity、foreign keys、當前同機構／entity／version 的歷程，以及全部保存欄位的 typed hashes。TEXT 經 hex 保留 NUL 後綴，INTEGER 以 BigInt 保存，REAL 以 IEEE bits 核對，BLOB 大小與原 SHA-256 同時核對。依既有主鍵 index 串流讀取；實際 query-plan 測試確認 13 表的排序不產生額外 sort temp B-tree。這是完整儲存驗證，沒有將未知評分／支付／薪资規則當成已核定的業務驗收，也不捏造 legacy 缺少的版本鏈。

二進位 envelope 使用 AES-256-GCM、新的隨機 12-byte IV；format、版本與 header 一併認證。資料庫 bytes、SHA 與 13 表 proof 位於加密 payload 中，clear header 不含資料庫路徑、個資、帳號、密碼或金鑰。備份完成前會自行解密到另一個私人暫存檔，核對完整 SQLite proof，fsync 後以不覆蓋既存路徑的 atomic link 發布新的加密檔。正式格式不接受合成 envelope，也沒有把合成格式的標記改為正式。

解密時未認證的串流輸出只落在新建 `0700` workspace 的 `0600` 暫存檔；GCM tag 完整驗證前不解析 proof、開啟 SQLite 或發布還原。成功與失敗會清理仍能確認屬於本操作的暫存身份；身份不明時保留私人原件，避免刪除他人檔案。刪除檔案不等同 SSD／快照的安全抹除，正式主機需使用已核定的磁碟加密與保留策略。同 Unix 使用者或 root 的惡意競態超出私人目錄防護邊界，不能宣稱抵禦任意特權修改。

## 恢復權限與啟動封鎖

恢復只建立新的 `0700` 隔離目錄，資料庫檔名固定為 `isolated.sqlite`。在該新副本上單一交易清除所有 sessions、停用全部 Portal bindings；其餘十一張表、原 memberships、password hashes、版本、audit、計價 JSON、BLOB 和已捕捉 nonce ledger 保持精確。備份快照後的撤權與 nonce 不能由舊快照推定。

發布隔離資料庫**之前**先保存 `RECOVERY_PENDING.json`，固定 `productionReady=false`、`oldSigningKeyMayBeReused=false`。工具不刪除此標記、不重新開通帳號、不依 email 對應權限、不恢復舊 cookie。必須撤換所有舊 Portal 簽章金鑰，才能阻止快照後已消耗或已簽出的舊 token 在日後重綁時重播；本 CLI 沒有讀取或輪替實際 Portal signing key，也不聲稱該要求已完成。

共用函式 `assertProductionRecoveryStartAllowed(databasePath)` 已掛入實際 `createApp`，在持久目錄 mkdir、持久 `DatabaseSync`／`initDb` **之前**呼叫；直接啟動與容器沿同一 entrypoint，不能只在 Docker 路徑檢查。原記憶體 SQLite runtime 支援 probe 仍先執行，不建立或開啟持久資料。該 guard 保留記憶體、正常相對路徑及尚未建立資料目錄的相容性，也會檢查實際 file/directory alias 所指的隔離標記；標記缺損或無法辨識的檔案亦不得被視為批准。

`tests/production-recovery-runtime.test.mjs` 登錄兩項實際整合測試：用正式格式建立合成隔離副本，確認直接路徑、目錄 alias 與檔案 alias 在 `createApp` 拒絕，副本 bytes、目錄內容及 sidecar 保持；另一項確認一般 memory runtime 的原 setup／登入契約仍可用。這兩項測試已包含於 Node22／24 各2,445項完整程式測試、均原生退出0；backup核心與CLI／inspection的27項分項亦在兩Node通過。這只證明合成副本的實際 runtime 拒啟動及相容性，不能稱整個候選的瀏覽器回歸或正式主機啟動驗收通過。

`prepare-reconcile` 先核對隔離資料庫 SHA／13 表 proof、session 空表及 binding 全停用，再保存新的 `RECOVERY_RECONCILIATION_PLAN.json`。有指定當前 authority DB 時，以唯讀一致快照逐筆比較 user／機構／角色／員工、完整 Portal binding、停用生命周期與居服員有效員工狀態；同 email 的其他 subject 不會取得 grant。缺少 lifecycle 的 legacy active 相容狀態仍不能證明當前外部身分授權。

提供一個資料庫路徑不等同取得公司 Portal 的即時權威證明。因此有無 authority DB 都保持 `freshAuthorityAttested=false`、`providerAuthorityValidated=false`、`grantsEnabled=0`、`productionReady=false`。缺少 authority 時產生明確 blocked preparation，操作完成可退出 0，但不代表恢復已啟用；錯誤／格式不符退出 1，CLI 參數不合法退出 2。真正 cutover 仍須新金鑰、目前公司權威、逐身份明確核可、nonce／撤權對帳、主機與持久儲存核定及營運 UAT，另行實作與驗收；不提供 naive live restore。

## 接入與驗收界線

公開 server exports 是 `createProductionBackup`、`verifyProductionBackup`、`restoreProductionBackupIsolated`、`prepareProductionRecoveryReconciliation`、`assertProductionRecoveryStartAllowed`。前三個接受 caller-owned `key: Buffer`，工具只清零自有 copy；呼叫者仍須清零自己的 key。沒有 HTTP 掛載，避免普通管理帳號取得全部機構／安全表內容。CLI stdout／stderr 只回固定結果／錯誤碼，不反射 path、row、cookie、password、signing key 或原始 SQLite 錯誤。

驗收測試以新建合成資料覆蓋：已提交及未提交 WAL、備份等待期間另 connection 的實際 commit、13 表完整 proof、型別與附件、未知 schema、原件不改、備份／目的地已存在、source/key/sidecar 的 symlink／hardlink／mode、安全 key copy、錯 key／tag／header／截斷、還原後舊 cookie／bindings 禁用、nonce 保存、快照後真撤權及 identity mismatch、被竄改 stage／marker 拒絕、無 authority 不啟用、private modes、原生 CLI exit 與沒有秘密反射。Node 22／24 的本機原生結果會保存私人 QA；實際 operator 主機、真資料容量、金鑰保管、異地保留及正式災難復原演練仍需各自證據；本機 runtime 整合由上述實際 createApp 測試確認，不由模組 proof 推定。

SQLite online backup API 及支援版本依据：[Node.js SQLite 官方文件](https://nodejs.org/api/sqlite.html#sqlitebackupsourceDb-path-options)。
