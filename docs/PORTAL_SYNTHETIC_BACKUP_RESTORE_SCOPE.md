# 0.45 Portal 十三表合成備份與隔離還原

2026-10-10 凍結的本機切片。以已驗收0.44的Portal schema及0.39的合成scratch能力為基礎；不開啟、複製或寫入使用中care.sqlite、私人備份、實際帳號binding或部署設定。

凍結修訂2：精確Portal exports為createSyntheticPortalWorkspace(0)、syntheticDatabasePath(2)、inspectSyntheticDatabase(2)、captureSyntheticBackup(1)、restoreSyntheticBackup(3)、promoteSyntheticRestore(2)、disposeSyntheticWorkspace(1)。新格式為suiyue-synthetic-portal-sqlite-inspection-v1與suiyue-synthetic-portal-sqlite-backup-v1。原七項legacy exports及原格式維持；所有跨profile操作連path與dispose都須在FS前拒絕，ref還须固定owner/profile與格式。

既有synthetic-backup.mjs保留原七項export、精確arity、無參數十一表factory、v1格式及原錯誤／路徑／檔案身分／typed保存值契約。新增synthetic-portal-backup.mjs明確的createSyntheticPortalWorkspace及同一組inspect/capture/restore/promote/path/dispose操作。兩個facade沿唯一private core，每個操作在碰檔前以WeakMap確認workspace固定profile符合facade；profile不得由inspect/capture/restore的caller option、表名或外部manifest指定。不同profile或owner的capability/reference互餵拒絕，不容11→13或13→11遷移。

十三表schema只由private健康memory model的initDb＋initPortalStorage導出並cache；必須精確13表／6不可變trigger／所有schema SQL與index／header。未知、缺失、多餘或改動schema、損毀、FK與current history缺口拒絕，不修復資料。新inspection/manifest有明確Portal格式；十一表格式與fingerprint不變。每張表的全部欄位以SQLite storage class保存，包括TEXT NUL後完整bytes、integer/REAL/BLOB/null、兩種附件、版本、核閱價格JSON、session、active與inactive binding、consumed/expired nonce。公開summary只含count與digest，不輸出身分、credential或原始nonce。

維持opaque workspace/ref、固定scratch slots、新目標、owned regular單link檔案、0700/0600、closed generation与sidecar守門、VACUUM INTO的已提交WAL一致性、source與backup前後核對、來源變更拒絕、exclusive restore、精確candidate proof及closed promotion／forced rollback。元資料或content改動、cross-owner/profile ref、unsafe path／symlink／hardlink／已存在目標都不能被接受。無外部路徑、跨process manifest匯入、HTTP/operator restore、線上切換或新增掛載端點。

還原是**快照當時**的完整保存值：binding啟用狀態、session及nonce ledger同樣回到快照；不得宣稱保留快照之後的撤權、消費nonce、新記錄或目前Portal政策。測試必須實際展示此差異。已存在於snapshot的nonce仍拒絕重放，snapshot內inactive binding／expired session保持；receiver使用現在時間、現有scope與正式九欄規則，不放寬Origin、Host、簽章或角色。formal restore需另核定撤權／nonce reconciliation、key rotation與外部授權策略，本切片不執行或推定完成。

瀏覽器沿0.44真HTTPS loopback gateway與原Host／Origin，用真正Portal表單POST先在source取得Secure／HttpOnly／SameSite=Lax、Max-Age=28800 cookie，再snapshot/restore；還原後原session的absolute expires_at不得重設，不將載入頁面當作新八小時登入，新handoff才另起八小時。換signing key本身也不會自動撤銷已存DB session；formal key rotation不得等同完整session撤權。本切片只記錄此界線、不設計正式復原政策。

完整合成fixture保留原正常API產生的十一表主檔、歷程、核閱快照與非空BLOB，再加入獨立合成Portal帳號及非空active/inactive binding／nonce／session，不使用使用者指定的實際身分。startup可使用可寫SQLite connection，但必須證明零邏輯寫入而非宣稱readonly connection；登入／nonce消費／session cleanup／撤權驗證的必要寫入另記帳。

必要驗收：原十八項backup tests與CLI/browser；新profile隔離、全部十三表獨立typed oracle、完整schema及負例、WAL與閉合bytes、capture／restore／forced rollback／成功promotion；還原後Portal模式的本機瀏覽器可憑合成session進入、無第二次密碼、報表／附件／版本與保存價格不變；receiver的snapshot nonce重放及inactive binding／expired session／撤權拒絕；快照後狀態明確不被回溯宣稱。宣告最低Node22.13與目前Node跑新舊相關整合測試、完整unit/sourcecheck及兩份合成CLI，保存native exit與失敗，不自動retry。所有API／UI／正式身份owner原bytes保持；沒有產品UI改動時不要求重跑45套無關browser。

原180目錄、status/count、九階段與既有本機milestones保持；只追加本機合成foundation。原備份工具仍拒絕Portal schema；正式帳號DB不能沿此scratch工具備份。未知正式migration、加密、留存、RPO/RTO、效能、人工UAT與正式部署仍待核定。

## 實際接受證據

本機驗收：184份JavaScript檢查、773／773程式測試、最低Node22.13相關60／60測試與兩版新舊合成CLI通過。按實際消費來源承接首輪15個通過程序，補上最終凍結來源的check及新browser，共17個必要程序符合預期退出碼（兩個拒絕caller參數的程序為預期exit2）。三套browser共23關：原十一表備份7、Portal十三表還原8、原Portal登入8；新9張PNG逐張視檢完成。strict零finding；DESIGN零error／10既有warning。原180目錄、九階段、statusCounts、completed0及原43本機里程碑保持後追加為44；原65 currentImplementation來源順序保持後追加3為68。

完整保留首次unit的Host傳輸錯讀與三次新browser失敗：headers()省略cookie header、readonly observer在closed live產生sidecar，以及source capture的WAL狀態被錯當closed candidate。僅收緊新CLI純讀全十三表零寫斷言並窄修新測試observer；未修改原UI、掛載API、Portal receiver、model、舊測試或closed守門。每次修後另凍結source並明確執行，沒有自動retry，不宣稱first-pass或原失敗parent通過。

完整證據：outputs/software/portal-synthetic-backup-qa/verification.json；初始失敗與所有修訂均保留於outputs/software/portal-synthetic-backup-qa。此契約不升格為正式帳號backup/restore或正式DR。
