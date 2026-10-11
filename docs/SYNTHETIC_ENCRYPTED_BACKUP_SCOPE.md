# 合成加密備份與還原演練

本機整合驗收已完成：outputs/software/full-system-completion-qa/verification-v077.json。下列候選階段紀錄保留原時間與驗收界限，最新完成狀態以整合收據為準；沒有正式發布、真實營運UAT或原平台全量對等。

此切片提供可操作的本機合成資料演練，沒有一般管理者 HTTP 下載入口，也沒有正式資料庫／檔案路徑參數。只作用 `createSyntheticEncryptedWorkspace()` 建立的新 scratch 根目錄，使用既有十一表、六個不可修改 trigger 的 legacy profile；Portal 十三表的既有工具與格式維持原樣。正式 KMS、密碼政策、保存期限、RPO、RTO、正式 UAT 及真資料還原均未核定或驗收。

## 使用與輸入

新增命令 `node scripts/rehearse-synthetic-encrypted-backup.mjs` 接受零參數，密碼只從有界、非 TTY stdin 提供。不得將密碼放在 argv、環境變數、shell 歷史或公開產物；程式不讀環境取得密碼，不回顯、不打印或保存密碼。程式拒絕 TTY；適合由受控程序提供 stdin，不能直接在裸終端逐字輸入。stdin 只去除一個結尾 LF／CRLF，其餘空白完整保留。16–1024 UTF-8 bytes、內部 NUL／CR／LF 禁止是此演練的技術界線，並非已核定公司密碼政策。

命令自己建立合成 fixture，沿 normal API 產生個案、員工、核閱服務、不可修改附件、歷程與合成登入；使用 random loopback port，拒絕 4310。備份後刪除當次 plaintext backup／manifest，直接從密文還原 live，再透過 normal API 修改合成 live 第二代、執行兩個實際 rename 後的故障回復，最後成功替換並保留 previous。所有工作區於演練結束清除。輸出只有固定分類、筆數與 hash 等合成證明，不包含帳號、密碼、raw rows、binding 或檔案路徑。

## 封包與資料守門

封包格式 `suiyue-synthetic-encrypted-sqlite-v1`、version 1、syntheticOnly true，精確 `{format,version,syntheticOnly,kdf,cipher,ciphertext}`。scrypt 固定 N=32768、r=8、p=1、keyLength=32、maxmem=64 MiB，random 32-byte salt；AES-256-GCM 使用 random 12-byte IV／16-byte tag。版本、KDF、cipher name／IV 為認證 AAD。封包與加密 proof 皆需閉合 canonical JSON，拒絕重複／未知／重排鍵與非 canonical base64；攻擊者無法提升 KDF 參數。

加密內容包括 proof 長度、完整閉合十一表 inspection proof 與精確 closed SQLite bytes。完整 fingerprint 包含 schema、全部欄位 storage type、完整 TEXT（含 NUL 後文）、INTEGER／REAL／BLOB、六個 trigger、FK、current-history、版本及服務計價 JSON 原文的 SHA；不解析或重算已保存計價資料。pure seal／open 只確認結構、hash 與 AEAD，**不能宣稱已做 SQLite schema／FK 驗證**；workspace restore 另沿原 inspection owner 實際驗證 SQLite，完整 proof 必須逐欄相同。

32 MiB DB、64 KiB proof、48 MiB envelope 為明示本機技術容量，不截斷、不壓縮。錯密碼、tag／cipher／AAD 篡改、截斷與非法格式不會返回部分明文；派生 key、內部 passphrase copy、解密 update／完整明文及 workspace 自有 DB Buffer 都在 finally 清零。pure open 成功回傳的 DB Buffer 由呼叫者持有並負責清零；呼叫者傳入的 Buffer 不會被工具更動。JavaScript 字串的實體記憶體清除、OS 暫存／swap 及正式 key rotation 沒有在此演練承諾。

## 檔案與替換

capability 在私有 WeakMap 登記；未登記、偽造、Portal 或已 dispose 在 I/O 前拒絕。只有 source／backup／staged／live／previous／encrypted 固定 owned slots；不接受路徑、schema、profile 或 callback。根目錄 0700，密文與還原檔 0600，root／檔案 dev、inode、uid、regular-file、nlink=1、O_NOFOLLOW／wx 與 sidecar 守門。密文寫入 fsync 並重讀；成功 capture 只刪同次未被換 identity 的 plaintext backup／manifest。

restore 只可建立新 staged／live；AEAD、proof／hash 全部成功前零新檔。已有 target 一律拒絕，失敗只清除自己新建且 identity 仍一致的檔案，既有 live inode／bytes／完整資料保留。promotion 只接受 facade 已驗證且仍相同的 stage、closed live、尚不存在 previous。live→previous、stage→live rename 與目錄 fsync；`after-live-retired`／`after-candidate-promoted` 是明示合成 QA 故障點，兩者均反向 rename，再驗原 inode、精確 bytes 與 full proof。正常成功保留 previous。對不確定 identity 不刪或覆蓋，回傳固定 sanitized code 留供檢查。

此工具未承諾停電／OS 崩潰後自動恢復、並行惡意同 UID 程序隔離、跨裝置替換、正式存取政策或既有資料庫加密搬移。

## 本輪候選驗證

候選來源位於 `outputs/software/v077-encrypted-backup-candidates/`，尚未推入正式來源或部署。最終 `all-owned-r06.log` 十七關（十三 pure／owned-SQL、四真子程序 CLI）全部通過、native exit 0、零 cancelled／skipped；四個自有 JS syntax 結果見最終 source check。新增 Buffer caller 自有 length／valueOf／copy／includes getter 零呼叫回歸：以 typed-array intrinsic 取得實際長度與複製，處理期間只使用自有 Buffer，呼叫者 bytes 保留。先前 `all-owned-r04` 十六關成功與 source freeze r05-before 均保留，最終以 r06／r07 guard 為準。獨立 `cli-rehearsal-r01.log` 已實際取得成功摘要：十一表、六 trigger、刪 plaintext 後 cipher-only restore、兩故障原 inode／bytes 回復、previous 保留、source total_changes 不變、startup logical writes 0；最終候選 source freeze 下另執行 r02，實際結果與 before／after guard 見 READY。真正 PTY `tty-r01.exit=1` 為預期拒絕，只有 `TTY_INPUT_REJECTED`，未提供密碼。

`pure-sql-r01.log` 的初次公開 support dependency 未複製完成而缺 module 失敗完整保留；完成 support graph 後 `pure-sql-r02` 實際 exit 0。support snapshot 只包含公開 runtime／合成 fixture，`SUPPORT.json` 全部 promote false。Root 正式接線後必須 fresh 真 CLI／unit／source guard，不把候選成功當作正式部署或真資料驗收。
