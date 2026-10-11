# 本機新增資料 CSV 匯入（0.69）

管理者在「本機資料匯入」選取 UTF-8 CSV、資料種類及欄位對應，人工檢查全部資料後確認整批新增。只有個案、員工及服務項目；員工職務文字不建立登入帳號或授權。不覆蓋／刪除既有資料，不載入附件、舊識別、原平台歷程或正式支付規則。

最多100筆／40欄／200,000文字字元，檔案800,000 bytes，API body4MiB；非法UTF-8、NUL、缺欄、重複欄名、非法引號、空白資料列、錯列長、欄名換行、單格超過10,000字與數值非安全整數全部拒絕。quoted CRLF、逗號、双引號及前導零精確編號保留，不執行公式。只能將已知欄名對應一次至白名單，不能提交metadata、狀態、帳號、角色權限、價格計算參數或未知欄位。

POST /api/local-imports/preview 僅管理者、無query，返回封閉預覽及來源／目前資料SHA，零寫入。相同機構同類精確案號／員工編號／服務代碼已存在或批內重複均拒絕整批。POST /api/local-imports/commit 必須同一內容、mapping、previewHash及Idempotency-Key，於原BEGIN IMMEDIATE冪等交易重新驗全部資料；來源已有變更409，任何一筆無效422或保存失敗全部回滾。不以略過錯誤、部分新增或暗自更新代替整批確認。相同key重送只返回原保存結果，不再次新增。

保存每筆初版／record.import操作者及批次稽核，來源hash與本次追溯識別可核對。UI回應需精確組織、編號、完整已核對資料、安全版次1、合法metadata、完整筆數及已確認sourceHash；未知、sparse、getter或不完整回應不當成保存成功。輸入與key保留以人工重讀／同key重送，不因壞ACK重複建立。沒有client持久storage。取消保持mapping；context／hash／角色失效撤除對話框及晚回應。

沿唯一APM ui.js native file/select、表單、確認、表格及錯誤呈現。CSV filePolicy是明確opt-in；原附件PDF/PNG/JPEG限制及伺服器簽章檢查保持。375／390px表格可在容器內水平捲動，完整欄名不被頁面截断；長mapping在對話框內捲動。這是本機新增匯入，不是正式移轉、原平台轉換或原資料庫修復。

必要整合、備份與九項匯入瀏覽器流程已本機驗收；作者真HTTP原子／冪等／跨機構／角色／large Unicode／SQL失敗全回滾、純CSV/ACK以及九項實際瀏覽器流程保留於 outputs/software/v069-candidates 與 outputs/software/local-imports-qa。最終root收據：outputs/software/local-workflows-completion-qa/verification-v069.json。僅合成memory／owned temporary DB及隨機loopback，不讀私人DB／env／實際binding／備份，背景排程仍停止。
