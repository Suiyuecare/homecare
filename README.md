# 歲悅居家照顧系統

目前原始碼版本 0.78.1。臺灣居家照顧機構的本機作業系統，沿 APM 品牌及 Portal 單一登入契約，具機構隔離、伺服器角色授權、版本歷程與不可變計價快照。

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

本輪完整90項配置與2060項程式測試及修復紀錄見 [全系統回歸範圍](docs/FULL_REGRESSION_SCOPE.md)。GitHub CI以同一提交的Actions實際結果確認。
