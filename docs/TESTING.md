# 開發與合成測試

本專案的應用程式使用 Node.js 內建模組與 SQLite。Node.js 最低版本為 22.13.0；本機既有驗收使用 22.13.0 與 24。請使用套件管理器 pnpm 11.21.0，並依公開鎖檔安裝固定版本的開發依賴；Playwright 固定為 1.62.1。

## 新取得原始碼

在專案根目錄執行：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

`check` 檢查 JavaScript 語法；`test` 執行程式測試。這些命令使用測試自行建立的合成資料與暫存或記憶體資料庫，不需要正式帳號、私人 `.env.portal`、既有資料庫或原平台憑證。安裝開發依賴不代表發布服務。

## 瀏覽器測試

先安裝 Playwright 的 Chromium；Linux CI 可連同系統依賴安裝：

```sh
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
```

瀏覽器測試各自啟動合成資料、隔離資料庫與隨機本機連接埠，不應連到使用中的服務或正式網站。請依修改範圍選擇必要的 `test:e2e:*` 命令，保存每次實際退出碼與輸出。通過某一套不代表其他已配置的測試也在本次執行。PNG 與幾何斷言不等同人工視檢。

Portal 合成 HTTPS 測試另需要 PATH 中可執行的 `openssl`，以產生短效本機測試憑證。它不需要正式 Portal 密鑰或公司登入。請保留 HTTPS、Host、Origin、Secure cookie 與角色授權斷言。

## 七種 PDF 報表測試

以下命令需要 Chromium、Python 3、Python 模組 `pdfplumber` 與 Poppler 的 `pdftoppm`：

```sh
python3 -m pip install pdfplumber
pnpm test:e2e:case-report
pnpm test:e2e:certification-report
pnpm test:e2e:employee-report
pnpm test:e2e:leave-report
pnpm test:e2e:service-report
pnpm test:e2e:shift-report
pnpm test:e2e:training-report
```

Python 套件可安裝在自行管理的虛擬環境。Poppler 請透過作業系統套件管理器安裝，例如 Ubuntu 的 `poppler-utils` 或 macOS 的 `poppler`。Windows 需提供可執行的 Python 與 Poppler 路徑。這些工具不屬於應用程式執行期依賴。

預設使用 PATH 的 `python3` 與 `pdftoppm`。可用下列環境變數指定工具；值是單一可執行檔路徑，不是含參數的 shell 命令：

| 變數 | 用途 |
| --- | --- |
| `HOME_CARE_QA_PYTHON` | 執行 `pdfplumber` 文字與頁面邊界檢查的 Python |
| `HOME_CARE_QA_PDFTOPPM` | 將合成 PDF 轉成待視檢 PNG 的 Poppler |
| `HOME_CARE_QA_PDF_MARKER` | 可選的外部 PDF 作業標記 `.mjs` 檔，由目前 Node 執行 |

未提供 `HOME_CARE_QA_PDF_MARKER` 時不執行外部標記。它不是 PDF 或資料正確性的驗收條件；七套測試仍保留 PDF 實際產生、完整文字、欄位與分頁／邊界、授權與資料保持等原斷言。提供標記時，非零退出會讓測試失敗。既有 `PDF_OPERATION_ALREADY_MARKED` 只適用於同一產物已成功完成的標記紀錄；不要把它用來跳過 PDF 或資料檢查。

## 可選工具與公開範圍

私人 Codex 插件稽核、原平台即時瀏覽器盤點及私人 QA 收據不屬於新 clone 的必要執行依賴。公開來源應排除帳密、私人資料庫、備份、原始個資、使用者綁定與生成輸出。若外部設計稽核工具未配置，必須明示未執行，不能宣稱通過。

正式部署、正式公司 SSO、持久資料庫、付款或申報均有獨立的交接與驗收；本檔只說明本機合成測試。
