# Portal 十三表加密備份與安全狀態還原演練

本切片 CP09 已實作合成資料的十三表加密封包、完整獨立還原檢查及安全狀態重新核對，Node 24 與 Node 22 專項測試各 8/8 通過，兩個版本的完整 CLI 也各 native exit 0。這是本機受控的工程演練；正式主機、持久 volume、KMS、營運 RPO/RTO、切換與公司災難復原 UAT 尚未驗收。

## 執行入口與資料邊界

```sh
node --test tests/synthetic-encrypted-portal-dry-run.test.mjs
node scripts/rehearse-synthetic-encrypted-portal-backup.mjs
```

CLI 不接受任何參數，自行取得既有 `synthetic-portal-backup` factory 的新受控暫存工作區、自行產生記憶體中的合成密碼與新簽署 key。只有 factory 擁有的 source、backup、staged 及固定新封包檔，沒有 arbitrary path、正式 DB、真實 binding、其他工作區的 backup、環境秘密或正式服務 4310 入口。HTTP 只連到本次建立的 `127.0.0.1` 隨機 port；完成或失敗都關閉服務與刪除自有 factory。

既有十一表、十三表與十一表加密 facade 的能力、profile 與 source code 不變；演練會比對四個相關 facade/core 來源 SHA。沒有放寬 scratch-only facade、沒有新增正式備份 HTTP 介面、沒有 staged→live promotion。錯誤 CLI 只輸出固定代碼及 sanitized 狀態，不回傳引數、位置、account、cookie、nonce、stack 或簽署秘密。歷次失敗及證據保留於私人 QA 工作區。

純 byte helpers `sealSyntheticPortalBackupBytes(bytes, proof, password)`、`openSyntheticPortalBackupBytes(envelope, password)` 不存取檔案或環境，僅處理 caller 提供的 Buffer。成功解密後取得的 bytes 由 caller 管理及清除；helpers 清除自有的密碼副本、derived key、plaintext 與未驗證解密片段，保留 caller 原 Buffer。它們不是正式備份 operator 入口，也不能以 authenticated hash 取代實際 SQLite 檢查。

## 封包契約

| 項目 | 固定契約 |
| --- | --- |
| format | `suiyue-synthetic-encrypted-portal-sqlite-v1`，version 1、syntheticOnly true |
| recoveryPolicy | `clear-sessions-disable-bindings-rotate-key-v1` |
| KDF | scrypt N=32768、r=8、p=1、32-byte key、32-byte random salt；參數不能由封包提高 |
| cipher | AES-256-GCM，12-byte random IV、16-byte tag；完整 header 與 recoveryPolicy 進 AAD |
| encrypted payload | 長度前綴、完整十三表 inspection proof、完整 SQLite main-file bytes |
| 上限 | SQLite 32 MiB、proof 64 KiB、外層封包 48 MiB；這是技術限制，非正式容量驗收 |
| JSON | closed keys、固定順序、canonical UTF-8／base64；拒絕 duplicate／unknown／重排／尾端空白及跨十一表 profile |

inspection proof 固定十三表／六個 trigger，記錄完整 schema hash、userVersion／applicationId、每表 row count 與所有 typed 原值 hash、兩種附件 BLOB hash、版本與保存計價 hash、content fingerprint、main-file 長度與 SHA。封包錯誤、錯密碼、改 tag／IV／salt／ciphertext 都拒絕且不產生 partial plaintext 或 staged file。純 helper 不判定 bytes 是否 SQLite；解密後必須由既有 Portal 獨立 inspection 確認 integrity、精確 schema、FK、完整型別內容與 proof，才能進下一步。

## 完整還原與撤權驗收

1. 由真實應用程式的合成 fixture 建立十三表資料，涵蓋個案、版本、計價快照、兩種附件 BLOB、四角色與其他機構、Portal session／binding／consumed nonce。加上合成帳號停用生命週期紀錄，透過正常 API 建立並核定合成 pricing rule，保存完整 rule 與 history。
2. 使用既有一致性 capture，包含 committed WAL。獨立 typed oracle 及 `total_changes()` 證實 capture／加密没有修改 source。封包為 exclusive 新檔、0600、ordinary file／no symlink／single link、owned identity 驗證及檔案 fsync；重讀 hash 後刪除此 factory 的 plaintext backup 與 manifest。
3. 在快照之後停用合成主管並撤銷其 session；另消費新的 finance handoff nonce。保存這個目前 source 作為不可被回溯修改的比較基準。錯密碼與 tag 篡改都不能新增 staged。
4. 僅從加密封包建立新 staged，實際 inspection 與独立 typed oracle 確认十三表、全部欄位、完整 schema、六個 trigger、BLOB、版本、生命周期及合成規則與快照完全相同。微型型別 fixture 額外涵蓋 TEXT NUL 尾部、int64 正負邊界、REAL、JSON 原文與 BLOB。
5. **啟動前** transaction 清空全部 `sessions`，停用全部 `portal_identity_bindings`。快照中的 consumed／expired nonce ledger 全部保留。所有其他表、schema、版本、規則、保存價格與附件原值維持一致；這個安全步驟有意改變快照安全表，所以安全重核後不能再宣稱十三表都與快照相同。
6. candidate 使用全新 signing key；舊 key 不保留為 fallback。快照與快照後的舊簽章都拒絕，舊 cookie 的 session discovery 為匿名而 protected API 401；換 key 本身不能撤銷已存 session，所以步驟 5 必須先清 session。新 key 的五個合成身份在未明確重綁前一律 403，拒絕流程沒有 logical writes。
7. 只逐一重綁合成 admin／finance／caregiver：核對**目前 source** 的帳號生命週期仍 active、org／role／employee link，並用完整 issuer／subject／Auth UUID／email／user／org 既有 binding 更新，不能按 email 自動開通。快照後已停用主管及未知 grant 仍 403。快照內已消費 jti 在新 key 下重簽仍 409，沒有重放写入。
8. 三個核准身份重新 handoff 後，正常 API 核對 fees／payroll 保存 DTO、合成核定規則及完整 history、兩種附件下載 SHA、機構隔離、caregiver 403／404。比較全部十三表 raw state 及 `total_changes()`，讀取期間 logical writes 為 0。
9. 原 source 的快照後帳號撤權、session／nonce 及其餘資料完全保留，原 facade 未修改，candidate 不升級為正式 live DB。關閉所有 connection 並銷毀 owned factory。

新 key 策略阻止快照之後但未包含在備份中的舊 token 再使用；它沒有假裝取得完整的目前 nonce ledger，亦沒有把快照之後所有業務變更／生命週期紀錄補回 candidate。合成演練有目前 source 可逐一核准 grant；正式環境若沒有 authoritative 現況來源，binding 必須持續停用。不能以候選快照中的舊 active membership 或舊 session 重建授權。

## 專項負例與證據

八項專項測試包含 randomized roundtrip、錯密碼與多類 AEAD 篡改、closed／canonical／KDF escalation／跨 profile 拒絕、proof／capacity／密碼格式、caller Buffer getter 不執行與原值不改、authenticated 假 bytes 仍由真正 SQLite inspection 拒絕、完整角色撤權還原流程、零參數 API／CLI 不接受 caller path。所有 pass／fail／skip 由 native test runner 記錄。

QA 保留兩次原始 CLI oracle 失敗：新增 business-rule 實際為 201，而初版錯期望 200；已失效 cookie 的既有 `/api/session` 正常回匿名 200，而初版錯期望 401。修正測試判定後另外驗證 protected API 401，沒有改弱服務授權或覆蓋原失敗。收據記錄 owned 來源及既有 facade/fixture SHA、native logs、兩個 Node 的 8/8 結果與完整 CLI report。

## 正式災難復原尚需核定與實測

延續 [營運就緒與正式還原交接](OPERATIONS_READINESS_SCOPE.md)，正式工具還需核定持久主機／storage owner、KMS 與外部 key ID／rotation、加密備份保留及離站保存、authoritative grant／revocation／nonce ledger、backup operator／restore approver、RPO/RTO。正式切換要實測 writer freeze、關閉 connection／sidecar、同 volume atomic promotion 與 directory fsync、每個 rename 失敗點、磁碟滿、失聯 KMS、重建保存、回退也不復活已撤權身份及公司 UAT。

本切片沒有測正式停電、正式負載、實際持久 volume、offsite storage／KMS 或 live switch，`formalDrAccepted`／`formalDeployment`／`promotionPerformed` 固定為 false。不可將此工程報告寫成正式營運備份與災難復原已通過。
