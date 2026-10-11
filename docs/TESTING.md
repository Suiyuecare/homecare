# 開發與合成測試

本專案的應用程式使用 Node.js 內建模組與 SQLite。應用程式支援 Node.js 22.16+（22.x）與24.x；原子22.13的更早子集測試不代表目前完整系統相容。請使用套件管理器 pnpm 11.21.0，並依公開鎖檔安裝固定版本的開發依賴；Playwright 固定為 1.62.1。

## 新取得原始碼

在專案根目錄執行：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

`check` 檢查 JavaScript 語法；`test` 執行程式測試。這些命令使用測試自行建立的合成資料與暫存或記憶體資料庫，不需要正式帳號、私人 `.env.portal`、既有資料庫或原平台憑證。安裝開發依賴不代表發布服務。

0.79 的完整程式測試在本機與 CI 明確使用 `--test-concurrency=2`，仍執行全部 `tests/*.test.mjs`，所有斷言、子程序與瀏覽器逾時限制保持原樣。此設定限制同時執行的測試檔數，避免大量 SQLite／密碼運算及子程序爭用主機；原資源壓力下的逾時紀錄保留，不改寫為通過。

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

## 視覺與四角色操作驗收

```sh
pnpm test:e2e:visual-refresh
```

此套使用API建立合成資料與隨機記憶體服務，涵蓋48個登錄頁面、四角色及六種管理者寬度、44px主要動作、16px手機輸入、導覽／Escape／焦點、空資料、失敗重試與輸入保留；完整業務表／附件及核閱快照唯讀比對。預設只驗目前原始碼，不需要私人fixture或正式帳號。產生的16張主要畫面必須另做真實像素檢視，不能稱48頁逐張截圖。共用樣式大幅改動時需重驗premium-ui.json全部配置及七種PDF報表。

員工三類保存紀錄索引合成瀏覽器驗證：`pnpm test:e2e:employee-record-index`。來源契約見 `docs/EMPLOYEE_RECORD_INDEX_SCOPE.md`；僅記憶體資料庫與隨機loopback。

面試者完整保存紀錄切片以 `pnpm test:e2e:interview-record-details` 驗證 fresh 單筆八欄原文、型別安全、機構／角色、桌機／390px、鍵盤與長文末端、人工重讀及情境撤除；沿合成記憶資料庫和隨機 loopback。它不接觸正式綁定或員工帳號，不建立錄取／到職規則。只宣稱實際執行的必要子集，完整配置不等於每輪全部 fresh。

本頁本人公告回執以 `pnpm test:e2e:announcement-page-receipts` 驗證人工且最多25個目前本頁ID的串行GET、本人精確版次回執、混合未確認與手動重讀、搜尋／頁次／身份失效、鍵盤與390px表內捲動；使用合成記憶資料庫和隨機loopback。原全文的明確閱讀POST與名冊沿原owner，此新入口不提交閱讀、不推論未讀率。只宣稱實際執行的必要subset，來源上傳與CI不代表正式部署。

員工目前完整保存資料以 `pnpm test:e2e:employee-record-details` 驗證人工單筆 fresh GET、十欄原文、服務區域保存型別與試算分值、三種既有讀取角色、情境撤除、鍵盤與390px長文末端；沿共用 `openDetails` 與純保存資料確認 helper。財務僅查看，居服員沒有新入口；機構與本人讀取範圍由原伺服器授權。合成fixture與記憶體資料庫不含正式帳號綁定，視覺PNG另行視檢；只宣稱本輪實際執行的必要子集。

Service item current saved details (0.62): `pnpm test:e2e:service-item-record-details` exercises the existing three-role service list, fresh exact-ID reads, eight complete saved fields, trial cents and raw default minutes, read-only database checks, malformed responses, cancellation and desktop/mobile reading. Synthetic fixtures only; local checks and CI do not establish formal hosting, HTTPS, Portal publishing or real-company UAT.


## 全系統回歸（0.79）

`pnpm test:regression` 執行 premium-ui.json 除 check／unit 外全部配置，包含合成加密還原；一次性口令由程序生成後經 stdin 送給工廠自有演練，無 argv／環境秘密。check／unit 仍分别用 pnpm check／pnpm test。

CI 使用 Node22.16與24各跑完整程式測試，以六組覆蓋全部瀏覽器／還原配置，包含 PDF 所需 Python／Poppler 與中文字型。單一 shard 失敗不略過同組其餘測試。Artifacts只收錄白名單合成結果與圖片；新功能的結果只在成功時上傳，trace限stage／url／method，不含請求body、密碼或回執鍵。原始log、fixture、資料庫、秘密與私人證據不公開。

新回歸 `test:e2e:feedback` 包含三種按鈕、桌機與390px、一般／減少動態、通知下方真點擊及鍵盤、紙本白底及螢幕色保持。權限窗口以真 HTTP 在 body await 撤權／退籍／登出，驗證拒絕與十一表、六trigger、total_changes零後續寫入。

The manual **Report diagnostics** workflow runs the four compact report suites directly with the same Linux PDF dependencies, so a failing assertion appears in its native job log. The normal push workflow still runs all configured commands. Synthetic encrypted rehearsal logs are excluded from failure-tail diagnostics.

常態配置共99命令、98必要命令：來源與程式測試由兩個Node作業驗證，六組互斥執行其餘97命令，包含選用的請假歷程。舊報表月份安全、帳號生命週期、兩套唯讀試算、財務更正與設定頁安全、十一表及十三表合成還原、就緒探測均納入；不啟動正式服務、讀取操作員資料庫或執行帳號開通命令。


## 重跑前保留舊證據

部分舊測試使用固定QA目錄，為保護既有產物會在重跑時拒絕覆寫。完整重跑前，先停止本輪擁有的測試程序，逐檔記錄並核對舊 outputs 的 SHA256，再將它完整移到專案以外自己控制的私人封存目錄；重新使用乾淨 outputs 執行原命令。保存原結果、原生退出碼與新批次來源雜湊，不刪除舊證據、不關閉守衛，也不把啟動前的保護拒絕說成產品斷言通過。公開CI每個作業從新clone取得乾淨目錄。
