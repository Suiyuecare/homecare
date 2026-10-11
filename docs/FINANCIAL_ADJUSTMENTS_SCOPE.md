# 財務更正調整單（CP-04）

本切片保存人工更正文件，不改寫原帳單／薪資，不執行收款、退款、薪資付款、稅額、帳務沖銷、正式核銷或外部訊息。正式調整金額、加減方向、跨月政策與覆核權責仍須由機構核定；系統不推測這些規則。

## 可操作範圍

既有帳單真正的狀態為 `draft / issued / voided`，薪資為 `draft / reviewed / closed / voided`。本功能僅以 **已開立帳單 issued** 或 **已關帳薪資 closed** 為來源，不虛構 finalized、paid 等狀態。來源必須是本機構可讀、目前有效且精確版次的完整不可改寫版本，包含個案／員工快照、明細、總額及人工依據。

`financial-adjustments` 保存於既有 records / record_versions，未開放泛用 CRUD，未增加任何資料表／欄位／trigger。資料維持本機 11 表／6 trigger；啟用 Portal 的既有 13 表／6 trigger 契約另沿原機制。本功能不接觸 Portal 綁定或秘密。

管理者與財務僅可操作自己目前授權的機構。每次 HTTP 寫入讀完 body 後，交易前及回執確認時重新檢查實際 membership、帳號生命周期與 CSRF。督導／居服員拒絕；帳號角色被變更或停用後，已在讀取 body 的舊請求也不能保留原授權。畫面隱藏操作不是伺服器授權替代品。

## 文件流程

草稿 draft → 編輯草稿 draft → 提交 submitted → 覆核 approved 或 rejected。

來源識別、來源版本、完整來源快照與建立者自建立後不能更換；提交後編號、月份、金額、方向、原因鎖定。覆核結果與原因為新版本，通過及退回後內容不能修改。退回是終態文件；需要改正時建立另一份具不同編號的人工調整單，不冒稱可重新送出原退回單。

金額是非負安全整數分，方向 `debit / credit` 明確顯示為加項／減項。0、1 分、最大安全整數均精確保存；不透過浮點乘 100。編號本機構唯一、月份 YYYY-MM、原因與覆核原因 1–2000 字元且不含控制字元；後端規則為單行保存文字，畫面會換行展示。有效月份由使用者明確選定，不推導跨月帳務政策。

如果原單據被取消／作廢或其目前版次與保存來源不同，調整單仍可查閱原快照與歷程，但不能再編輯、提交、覆核或接受舊回執。原對象改名／停用、目前單價變更不會重算或覆寫原快照。來源或目前 head 損壞／缺失時整體拒絕，不跳過錯列或猜金額。

每個動作均保存不可改寫版本與實際操作者稽核；CAS 指定精確前版，同 payload 重送沿同 Idempotency-Key。回執過時不能被當成目前成功狀態。交易中稽核寫入失敗會整批回滾。不能用更正單 API 寫收付款或其他實體。

## API

GET / POST `/api/financial-adjustments`；GET / PATCH `/:id`；GET `/:id/history`；POST `/:id/submit`、`/:id/review`。寫入必須帶 CSRF、目前機構與 Idempotency-Key。

新增精確 body：`sourceKind, sourceId, sourceVersion, number, effectiveMonth, direction, amountCents, reason`。

草稿 PATCH 精確 body：`version, number, effectiveMonth, direction, amountCents, reason`。

提交 body：`{version}`。覆核 body：`{version, decision: approved|rejected, reviewNote}`。

列表 query：page、pageSize（預設 25 最大 100）、q、status、sourceKind、effectiveMonth；未知或重複參數拒絕。列表回應 `orgId, items, total, page, pageSize, notice`；單筆／寫入回應 `item, notice`；歷程回應 `orgId, id, items, total, notice`。

單筆 24 欄：八個新增欄位、status、sourceSnapshot、createdBy、submittedBy／submittedAt、reviewedBy／reviewedAt／reviewNote、id／orgId／version／createdAt／updatedAt，加上目前來源 sourceCurrentVersion／sourceCurrentStatus／sourceEligible。歷程 snapshot 保存前 21 欄，不混入目前來源狀態。

sourceSnapshot 是既有嚴格 financial-output envelope：kind、title、organization、record、note。前端 descriptor-first 白名單驗證 DTO，拒絕跨機構／錯識別／錯版次／缺欄／多欄／getter／稀疏陣列／重複資料／不實總額。全部歷程列先驗型別，才比較精確相鄰版本；不執行後續列 getter。

## 共用介面

入口 `/financial-adjustments`、標題「財務更正調整單」。沿既有 APM CIS、ui.js 的 table／openForm／openDetails／confirmAction／pagination／searchBox／toast 與 styles.css tokens。沒有新增 CSS、色彩、元件控制器、原生 alert／confirm／prompt。原生 select popup 沿既有平台決策，不宣稱驗證 OS popup 幾何。

新增表單可選同機構全部已開立帳單／已關帳薪資（100 筆分頁、最多各 10,000 筆；超出明示拒絕），顯示來源編號、保存姓名、月份、精確版次及總額。儲存前重新讀嚴格保存明細，確認回執快照完整相同才成功。查看及每一歷程版本提供完整原明細、原因與建立／提交／覆核者識別；各次草稿編輯的實際操作者保存在不可改寫稽核，不冒稱其識別已顯示於歷程畫面。沒有 raw JSON 或秘密。

共享 dialog 保護髒資料取消、busy 重送、焦點回復、過時身份／機構／角色／路徑／render 失效。未知 2xx／錯誤 ACK 保留輸入和原 key；CAS 衝突保留表單以供核對，重新開啟時讀目前版次，不能強制覆寫。提交及覆核沿 app-owned 確認。取消請求不代表已提交交易回滾。

## 驗收

`tests/financial-adjustments.test.mjs`：目前 24 項後端及 pure DTO 檢驗，包括來源／全部角色、機構、帳號停用、CAS／狀態／來源撤回、0／1／最大整數分、immutable history、snapshot／head 損壞、母檔改名不重計、稽核失敗原子回滾、getter 零執行。

`tests/financial-adjustments-e2e.mjs`：記錄每次原始 process、結果、來源 SHA、HTTP trace、1440／390 圖。驗收包括實際 HTTP 四角色／跨機構／CSRF／冪等／鎖定／CAS、所有表 zero-write 否決；新增／編輯／提交／覆核／歷程；未知 ACK 同 key 重試；原單據完整保持；撤回來源禁止繼續；列表錯誤重試；late response／身份撤銷請求拒絕。

原始失敗與重跑分開保存。只有完整原生退出碼 0、所有關卡通過且最終圖人工檢視後可稱本機驗收；不代表人工 UAT、正式主機、CI、部署或原平台完整功能等價。

2026-10-11 最終本機驗收：bundled Node v24.19.0，後端與 DTO 第 4 次直接執行取得原生退出碼 0，24／24 測試通過，無 skipped／cancelled／failed。瀏覽器第 8 次取得原生退出碼 0，8／8 關卡通過，22 張桌機／390px 圖逐張檢視，來源前後 10 個程式／測試 SHA 完全相同。包含真正多人 CAS 衝突保留輸入、提交及覆核兩層確認、來源頭尾明細、四角色頁面、來源撤回及身份撤銷後讀取 body 的舊請求全表 zero-write。

瀏覽器第 1–6 次原生退出碼均為 1，完整保留錯誤、HTTP trace、截圖與結果，不當作通過；第 7 次原生退出碼 0、7／7 關卡及 17 張圖為較早參考，第 8 次才是最終稿。嚴格 frontend premium 靜態 auditor 超過三分鐘沒有輸出，依整合安排停止，原生退出碼 143；沒有取得結果，不能標示其通過，也沒有替換或放寬規則。

私人原始證據與 manifest 保存於工作區 `outputs/software/completion-20261011-qa/financial-adjustments/`，不收錄於公開倉庫。最終瀏覽器 attempt 名稱 `attempt-UIzdYf`；manifest 明列各次原生退出碼及 SHA。程式／測試於整體回歸前凍結；本文件只補精確實際結果。正式金額及跨月核定、機構覆核分工、人工 UAT、OS 原生 popup、CI／正式部署均不屬於這次本機合成驗收。
