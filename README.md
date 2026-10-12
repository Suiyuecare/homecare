# 歲悅居家照顧系統

目前原始碼候選版本 0.82.1。臺灣居家照顧機構的本機作業系統，沿 APM 品牌及 Portal 單一登入契約，具機構隔離、伺服器角色授權、版本歷程與不可變計價快照。

已提供個案與家庭／健康紀錄、照顧計畫、完整日期跨日排班與永久週期、服務核閱、員工／證照／訓練／請假、契約／待辦／站內通知、自訂表單、匿名問卷與 QR、群組營運總覽、完整 CSV／授權列印，以及人工帳單／收款／薪資與離線核銷對帳。金額以整數分精確保存；不預設未核定的正式支付或薪資規則。

## 開發與測試

需要 Node.js 22.16+（22.x）或 24.x、pnpm 11.21.0。QR 執行依賴 qrcode 1.5.4；瀏覽器測試使用 Playwright 1.62.1。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm test
pnpm exec playwright install --with-deps chromium
pnpm test:regression
```

全部配置由 premium-ui.json 維護。測試只使用合成資料、記憶體或工廠自有暫存資料庫及隨機 loopback，不需要正式環境、帳號或既有資料庫。分組使用 `pnpm test:regression --shard=1/6` 至 `6/6`；每個命令恰好落入一組，保留實際退出碼與原始 log，失敗不中斷其餘模組。

PDF 測試需要 Python pdfplumber 0.11.9 與 Poppler pdftoppm，可用 HOME_CARE_QA_PYTHON 指定工具。完整指南見 [docs/TESTING.md](docs/TESTING.md)。

## 身分與正式部署

Portal handoff 只認明確預先開通的 issuer／Google subject／Auth ID／email／單機構角色綁定，不由 email 自動開通或擴大權限。請求等待資料時若角色、機構、本人員工連結、session 或 CSRF 改變，必須重新讀取，拒絕舊權限寫入及舊重送回應。

本倉庫只包含可公開程式、合成測試及去識別文件。正式環境、真實帳號綁定、資料庫、秘密、備份與私人 QA 不得提交。GitHub 上傳或 CI 通過不代表正式主機／HTTPS／Portal 已發布；SQLite／附件／nonce 需要持久儲存，不能依賴臨時檔案系統。

正式支付、薪資、資格、FA 介接、評分、定位與離線政策仍依核定依據實作，不能以本機人工作業或合成演練推定正式營運驗收。

本輪94項配置與2060項程式測試及修復紀錄見 [全系統回歸範圍](docs/FULL_REGRESSION_SCOPE.md)。GitHub CI以同一提交的Actions實際結果確認。

## 0.81 接續功能與正式資料

「員工薪資規則與月試算」可按員工與期間保存時薪或拆帳設定，明確核定後試算所選已核閱服務；介面輸入元及百分比。實收介接、正式扣項及發薪另驗，不把選取來源合計當成完整月薪。

「自訂表單」可完整核對並下載模板套件，嚴格驗證後匯入新的草稿，不搬移填答、附件、機構或權限，也不覆寫舊模板。

一次需提供或核定的八類資料見 [USER_REQUIRED_INPUTS.md](docs/USER_REQUIRED_INPUTS.md)；工程與正式驗收界限見 [COMPLETION_ACCEPTANCE_SCOPE.md](docs/COMPLETION_ACCEPTANCE_SCOPE.md)。新功能分別以 `pnpm test:e2e:employee-payroll`、`pnpm test:e2e:custom-form-package` 重跑，完整配置仍由 `pnpm test:regression` 驗證。合成原生程序重啟亦納入完整程式測試；這不證明正式主機或容器重建已通過。

本機0.81完整回歸已通過（兩Node版本各2,310項、99個runtime、49頁四角色及六寬度）；相同提交CI與正式部署各自驗收，八類正式工作包仍待核定。


## 0.81.1 視窗焦點與完整驗收

修正原生視窗關閉事件搶回已移至搜尋欄的焦點，仍保留父視窗、Escape、忙碌與撤權守衛。個人行事曆保留原14關並新增原生事件交錯G15；成功儲存測試等精確刷新回應及原視窗DOM移除後，才清理攔截。

Node22與24各2,310項測試、552份JavaScript語法檢查及99個runtime六組恰好一次全部原生退出0；49頁四角色196項、六寬度510項版面檢查及88個命名PNG已完成核對。696個公開輸入／565個可執行輸入整批前後相同。

原main失敗、本輪G10失敗及休眠中斷紀錄均保留；G10原失敗與攔截時序的精確因果仍未確證，不能宣稱由重跑證實。正式八類核定資料、公司Portal、持久主機及部署仍未完成；背景排程保持停止。相同提交的公開CI需另以實際GitHub紀錄驗證。

## 0.82 受控備份與移轉閱讀

新增 [十三表加密備份與隔離恢復](docs/PRODUCTION_BACKUP_SCOPE.md)、[私人來源封存](docs/LEGACY_MIGRATION_SCOPE.md)、[個案／員工操作匯入](docs/LEGACY_OPERATIONAL_IMPORT_SCOPE.md) 與管理者限定的 [移轉紀錄](docs/LEGACY_MIGRATIONS_UI_SCOPE.md)。封存不解析原檔，匯入先預覽、再整批原子保存來源與新主檔；公式只保留原文，來源員工不因此取得登入角色。隔離恢復不啟用舊登入，實際 runtime 拒絕待核定恢復標記及其 alias。

新增頁面合成驗收命令：`pnpm test:e2e:legacy-migrations`。`premium-ui.json` 已登錄為 required，六組回歸共 102 個配置、100 個 runtime。最終來源兩Node版本各2,445項程式測試及579份JavaScript檢查通過；100個runtime保留完整批次98個通過及兩個測試攔截清理修正後補測，不能視為同一最終來源的整批證據。同提交完整CI另驗。CLI 不加入自動回歸的正式操作命令，備份／封存／匯入原生測試只操作工廠合成私人暫存資料。私人匯出、對應 receipt 及原檔應留 `.migration-private/` 或 Git 外私人位置，不將私人備份、資料或 QA 推送。

[發布與監看手冊](docs/LAUNCH_RUNBOOK.md) 提供有限次 loopback 就緒檢查、故障停流與核定回退程序。正式主機、HTTPS、公司 Portal、金鑰保管／RPO／RTO、全量移轉對帳及四角色營運 UAT 仍待簽認，工具或本機分項完成不代表正式可用。原失敗与中斷紀錄保留；背景排程保持停止，本輪不执行掃毒或漏洞掃描。
