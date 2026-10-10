# 合成 SQLite 備份與還原演練契約（0.39）

> 公開版本文件：記錄此功能版本的設計與驗收條件，並非目前公開副本已執行的驗收證明。私人盤點與 QA 產物未匯出；現行行為以 API.md 與原始碼為準，正式規則及部署仍須核定。

2026-10-09 凍結。本切片只建立可重跑的本機合成資料演練工具，沒有 HTTP 備份／還原入口。既有 public 與十九份後端來源保持；新工具不掛載到應用程式。原  正式階段 4／5／6／7 相依、migration-restore／role-matrix needs_contract 不因此完成。

## 工具與能力邊界

- `src/server/synthetic-backup.mjs` 僅輸出 createSyntheticWorkspace、syntheticDatabasePath、inspectSyntheticDatabase、captureSyntheticBackup、restoreSyntheticBackup、promoteSyntheticRestore、disposeSyntheticWorkspace。
- factory 不接受路徑或其他參數，只在 canonical os.tmpdir 建立新的 0700 目錄。workspace 為凍結 opaque capability，WeakMap 留存 root dev／ino／realpath；複製／偽造 capability、改名或替換 root、符號連結均拒絕。
- 固定 slots：source、backup、staged、live、previous，對應工具內固定檔名。slot accessor 只接受 capability 及精確 enum；可供合成 fixture 明確傳入 createApp dbPath。沒有 default DB、DATA_DIR、使用者提供的路徑或 manifest path 展開。
- 已存在檔案必須為 root 下單一連結的普通檔案；符號／硬連結、特殊檔、未知參數或選项拒絕。目標必須全新，不覆寫既有檔案。0700、capability 與路徑守門是此程序的工作流程限制，不宣稱防禦同帳號惡意並行改檔或 TOCTOU 的完整沙箱。
- dispose 只處理仍具有原始身份的 factory 目錄；不能借用任意路徑刪除外部資料。已 disposed workspace 不可重用，重複 disposal 可安全拒絕。

## 一致性備份與保存內容

使用獨立 readonly DatabaseSync 連線及 bound filename `VACUUM main INTO ?`，目標只能是工具獨佔保留的新檔案。不可直接複製正在使用的 main 檔而忽略 WAL。以合成 fixture 在 TRUNCATE checkpoint 後再提交正常 API 修改，確認 main SHA 未變、WAL 非空且 snapshot 包含該提交。未提交 transaction 不屬於備份內容；另一連線的已提交快照必須一致，不宣稱在正式高負載並行寫入下的效能或 RPO。

`VACUUM INTO` 可改變沒有 INTEGER PRIMARY KEY 的 hidden rowid，驗收只比較所有實際保存欄位，不把 hidden rowid／實體 page layout／source 與 snapshot 檔案 SHA 相同列為契約。[SQLite VACUUM 文件](https://www.sqlite.org/lang_vacuum.html)。node:sqlite 新 backup export 不在原最低 22.13；採該版已提供的 DatabaseSync、prepare／run、readOnly 與 setReadBigInts，不提高 engines。[Node 22.13 SQLite 文件](https://nodejs.org/download/release/v22.13.0/docs/api/sqlite.html)。必須以真正官方 22.13 執行及官方下載 SHA 核對後才接受最低版相容，22.23／24 通過不能替代。

驗證 schema 由現有 initDb 在獨立 memory DB 建立後讀取，必須精確吻合所有 table／index／trigger SQL、user_version 與 application_id。十一表全部納入，含六個不可變 trigger、record_versions、audit、idempotency、sessions 及兩類附件 content BLOB。先跑 integrity_check、foreign_key_check，拒絕缺 current record version 的檔案，避免 initDb 啟動時補 baseline。

typed canonical representation 分辨 null、integer（setReadBigInts，十進位精確字串）、REAL（IEEE 754 bytes）、text（完整字串）及 BLOB（精確 bytes），以固定欄位顺序與 canonical row 排序雜湊，包含重複保存列的數量；不使用 hidden rowid 作等價依據。報告只顯示 table 筆數／digest、schema／整體 digest、BLOB／版本／核閱 snapshot digest，不能輸出 raw data、密碼雜湊、session token／csrf 或 BLOB bytes。

manifest 為工具產生的固定 `backup.manifest.json`，版本化且只含有限 metadata／count／hash，不接受外部匯入。backup ref 同樣為 WeakMap opaque capability，保留 workspace owner、manifest exact byte SHA、snapshot file SHA、資料 fingerprint。restore 必須同時驗證這些身份、digest 與 DB schema／完整性，不能靠修改 manifest checksum 取得信任。SHA 是損毀核對，不是簽章或來源認證；此版本不能跨程序匯入任意備份。

## 隔離還原與切換回復

restore(workspace, ref, target) 的 target 必填且只能 staged 或 live。驗證 snapshot 後用 COPYFILE_EXCL 建立新目標，啟動前精確核對十一表／schema／BLOB／版本／保存計價；失敗的工具新建目標只可在持有身份後清理，既有目標及 source 不變。

promotion 只接受精確 `{forceRollback: boolean}`，live 與 staged 必須先由演練者關閉全部 handle，previous 必須不存在，三種 journal sidecar 任一存在均拒絕。sidecar 不存在不能證明沒有外部 open handle，本版本僅允許受控合成工作流程。

closed WAL 檔案即使 readonly 檢查也可能產生 sidecar；因此 closed preflight 在同 root 新建 `.inspect-*` 目錄，以 exclusive main-file copy 檢查並關閉，再清理該 inspection scratch，不在原 closed live／staged 產生或刪除 sidecar。staged 必須吻合先前 restore 的私人 proof，切換前再次核對，不能事後污染而通過。

成功：rename live→previous，再 staged→live；保留 original previous。強制回復的唯一注入點為第二次 rename 後，將 candidate live 移回 staged，再 previous 回 live，核對原 live 的 closed-main SHA 及 typed fingerprint；回傳明確 rolled_back 結果，不把注入的失敗稱為成功切換。任意 I/O 失敗若無法回復須明確報錯並保留可診斷 artifact，不能隱藏或刪除原代。這不是線上原子切換、crash／停電或所有 I/O failure 的復原保證。

## 合成整合與驗收

Node-only fetch fixture 透過正常 API 建立四角色／雙機構、兩筆核閱服務、改價／改時薪後不變的保存快照、兩個非空 BLOB、各版 metadata／個案歷程及正常 idempotency replay。已知過期 session 僅合成 INSERT，另列寫入帳。原 session 原樣保存；restore 精確比較先於 app startup／登入。

完整 fixture restored startup 必須零寫。正常新登入及過期 session 清理另列，不能聲稱登入後 session table 仍零寫。恢復後以随机 localhost port0 驗證舊有效／過期 session、401、角色403、機構403、居服員自身範圍、逐版歷程、原 BLOB bytes、CSV 原始分與報表快照，不重算正式費率。

`scripts/rehearse-synthetic-backup.mjs` 為明確 QA CLI，拒絕任何 caller args；依序演練一致性 capture／restore／startup 及 closed success／forced rollback，結束清理自己的 fixture。tests helper 可供此 QA CLI 使用，不宣稱正式交付工具的部署封裝。新增 test:e2e:synthetic-backup 只跑恢復資料的實際 Chromium 桌機／390px 流程；不新增 UI 或 PDF／print。CLI／18 項 Node 檢查與 scoped restored browser 完整通過、必要圖逐張檢視後才實作完成；舊全 UI 矩陣不因本輪未掛載工具而再稱 fresh。

## 尚未包含

合成 plaintext 本機演練；加密／金鑰保管／留存／存取稽核／備份排程／RPO-RTO／效能門檻及正式安全營運待核定。真實資料備份還原、正式 migration mapping／去重／外部匯入、production disaster recovery、人工 UAT、CI、原生 OS popup 完整人工驗收與正式部署均未完成。
