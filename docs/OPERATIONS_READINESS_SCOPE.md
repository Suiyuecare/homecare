# 營運就緒檢查與持久主機候選設定

本切片提供 `GET /ready` 的就緒探測、受限的唯讀 CLI、Node 24 容器候選設定與正式十三表還原交接。既有 `/health` 回應保留。程式通過合成測試及設定檢查，與正式主機發布、TLS、Portal producer、實際掛載、營運壓力或災難復原驗收分開記錄。

## 就緒判定

`createReadinessProbe()` 接收目前由 `createApp` 持有的 SQLite connection、DB 路徑、Portal 設定、關閉狀態及明確儲存政策。`createApp` 開啟已知 read/write connection 後傳入 `databaseWritable:true`；Node 的本介面沒有唯讀 connection 旗標供探測，不執行 INSERT 或試寫交易來推定。未知 connection、`PRAGMA query_only`、已關閉或失聯資料庫皆不能 ready。

回應固定 `{ok,service:"suiyue-home-care",checks:{database,schema,storage,portal},issues:[固定代碼]}`。成功 HTTP 200；缺表／欄／不可變 trigger、無效 Portal 設定、模式與儲存不符、不可寫目錄／檔案、少於預設 64 MiB 可用空間、應用關閉、必要持久政策未確認，均 HTTP 503。不返回位置、容量數值、account、schema 原文、row、cookie、nonce、簽署秘密或例外訊息。Host／method 守門沿既有伺服器契約。

SQL 只讀 schema、最小欄位及 `LIMIT 0`，不呼叫 `initDb`、補歷程、checkpoint、BEGIN／INSERT、清 session／nonce 或寫探測檔。這是有界的依賴檢查；不宣稱完整 schema 鑑識、所有頁面 integrity check、實際磁碟寫入成功或完整業務 UAT。六個 trigger 僅驗存在與所屬表；精確 SQL、index、全部 storage class／BLOB／歷程及 FK 的備份檢查仍由既有獨立 inspection 契約負責。

| 設定 | 意義 |
| --- | --- |
| `HOME_CARE_REQUIRE_PERSISTENT_STORAGE=1` | 必須為實際普通檔案；memory store 不接受 |
| `HOME_CARE_STORAGE_DURABILITY=persistent` | 操作者已確認持久 volume 的聲明；本旗標本身不能證明重建後保存 |
| `HOME_CARE_MIN_FREE_BYTES` | 非負 safe integer bytes；缺省 67108864 |
| `NODE_ENV=production` 或 `HOME_CARE_AUTH_MODE=portal` | executable startup 強制必要持久政策，明確設 0 亦拒絕 |

imported `createApp` 保持明確輸入，不自動讀部署環境；合成測試可明確 `requirePersistent:false`。正式 executable 或容器則使用 `readinessOptionsFromEnv()`。memory 合成的就緒成功，不是持久儲存已驗收。

## 唯讀操作檢查

`node scripts/check-runtime-readiness.mjs --url http://127.0.0.1:8080 --public-origin https://核定主機名稱` 只向明確 loopback port 的 `/ready` 發送 GET；拒絕外部 TCP 目標、4310、userinfo、路徑／query／fragment及 redirect。`--public-origin` 只設定既有 Host 守門需要的 header，不改 TCP 目標、不連外。native HTTP 確認實際 Host，5 秒 timeout、4 KiB 回應上限，陌生回應只輸出固定 sanitized code。exit 0 就緒、1 已確認不就緒、2 引數／通訊／回應不能確認。

`node scripts/rehearse-runtime-probes.mjs` 零參數，自行建立新的 memory Portal 十三表與 random loopback port，100 次 `/health`／`/ready`、4 個 worker，確認 schema／所有表筆數／`total_changes()` 前後不變。只輸出合成延遲指標；這項程序沒有業務資料、真實帳號、正式服務流量或容量門檻，不能當作營運壓力验收。

## 容器與反向代理

`ops/Dockerfile` 使用 Node 24、鎖定 pnpm 11.21.0 與 frozen lockfile、production dependencies、非 root 的 node 使用者與 `/var/lib/homecare` volume。`ops/Dockerfile.dockerignore` 依 Dockerfile-specific 規則排除 private context；COPY 只列指定源碼及操作檔，不複製整個 workspace。正式發行前應在核定環境把 base image pin 到已核對 digest，再完成真正 build／漏洞掃描／runtime smoke。此輪不下載 image、不購買主機、不發布。

`ops/container-start.mjs` 在開啟 DB 前要求 production、Portal HTTPS、明確持久政策、absolute 且已存在／0700／目前非 root UID 擁有的資料目錄及 1024–65535 port（拒絕4310）。候選預設8080；容器內監聽0.0.0.0，宿主發布只綁 `127.0.0.1:8080` 交給核定 HTTPS proxy。先由主機操作者建立受控 volume 與 UID 權限，啟動程式不建立示範資料或自動開通帳號。環境檔、Portal 獨立秘密與 durable volume 由私密主機管理，不嵌入 image 或公開命令。HEALTHCHECK 使用同一 `/ready` 契約。

`ops/Caddyfile.example` 保留核定 public Host 並轉至宿主 loopback8080；檔案只是候選，沒有改 DNS／申請憑證／正式發行。應確認現有 DNS 目標、指定主機、防火牆、TLS、受控環境注入、持久掛載、process restart、日誌與告警。proxy header 不授予機構或使用者權限；Portal Host／Origin／CSRF／receiver 簽章守門不放寬。

操作發布與驗收：來源 exact commit → image digest／設定清單 → 合成私有 staging → TLS 與四角色 Portal handoff → 停止／重啟／容器重建後比對資料及附件 → 備份與切回演練 → 真實核定 UAT → 明確 release。就緒變503時停止導入新流量；告警僅含固定代碼／部署版本／時間，不送秘密或帳號。保留原失敗、候選與回退來源，不以 health200 或單一 probe 代替正式完成。

## 正式十三表備份／還原交接

目前 `synthetic-backup`、`synthetic-portal-backup` 及 `synthetic-encrypted-backup` 保持 factory capability／scratch-only profile 守門。十三表合成的啟停 binding、session 及 nonce 是快照當時資料；十一表加密工具不能拿去處理 Portal DB。本切片沒有新增 general-path restore、HTTP 下載備份、live DB promotion 或讓 scratch facade 接受正式路徑。

正式 operator 契約至少包含以下相依步驟，核定後才另作正式工具：

1. 指定 DB／private backup store／UID、版本、完整十三表 schema、密鑰管理與留存、RPO/RTO、backup operator／restore approver。備份不得從任意使用者 path 或 HTTP body 取得；角色及機構映射不按 email 重建。
2. 一致性 snapshot 沿 SQLite 官方 backup API 或受控 VACUUM INTO，捕捉已提交 WAL；比對13表所有欄位的 SQLite storage class、TEXT NUL 尾部、整數／REAL／BLOB、完整版本／保存價格、六個不可變 trigger、index、FK 與 current-history。所有附件目前保存在兩張 BLOB 表，不能只複製 records。
3. 封包採核定 AEAD／KMS、外部 key ID 與 envelope version；schema／完整 bytes proof 與封包同時認證。建立新目的檔／exclusive／no symlink/hardlink／0600、fsync／重讀，私密存放並記錄 hash 及受控 operator 證據；不能把帳號、nonce、session 或完整私有路徑寫入公開驗收。
4. 還原至新隔離目的地並做全量獨立 proof。此時只可 staging，不服務網路；取得**快照之後目前**的 authoritative grant/revocation 及 consumed-nonce ledger。若遺失／不可取得，fail closed，不能憑旧 active binding 或 snapshot session 放行。
5. 所有舊 session 一律撤销並要求新 handoff；單換簽署 key 不會撤销已保存 session。binding 以目前核定 grant、subject／Auth UUID／email／org／role／employee 重新核對，撤權不得復活。若不能取得不可回溯的完整 nonce ledger，另核 key rotation／舊key停止接收與所有 handoff 最大 TTL＋clock skew 的停流策略；不得只是清空 nonce 後回復舊key。相關「安全狀態重新核對」要生成明確變更帳，不能宣稱與 snapshot security 表 byte相同。
6. 凍結 writer、close app／connection與 sidecar 檢查、同 volume atomic staged→live、previous保留與directory fsync，再以目前授權／nonce／cookie策略做四角色／附件／不可變版本／結算價格驗證。若失败，用已核對 rollback目標回退，且同样套用目前撤權／nonce防重放；回退不能恢復已撤權帳號。
7. 模擬停電、磁碟滿、KMS不可用、錯密鑰、封包篡改、備份後撤權與消費 nonce、各rename後失敗，記錄是否保留唯一可恢復來源及是否在核定 RPO/RTO 內。restore rehearsal 的工程結果及實際公司 UAT 分開簽认。

未知正式 KMS、保留、authoritative grant／nonce 保存位置、RPO/RTO、主機 volume 與切換 owner 仍待使用者／營運核定；沒有自動推定正式災難復原完成。

## 一手參考

- [Docker build context與Dockerfile-specific ignore](https://docs.docker.com/build/concepts/context/#dockerignore-files)：build context須排除私密檔案，特定Dockerfile的ignore檔優先。
- [Node Docker官方建議](https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md)：使用non-root user及明確process啟動。
- [SQLite官方online backup API](https://www.sqlite.org/backup.html)：正式一致性備份需沿備份API契約，不只複製可能仍使用中的main file。
