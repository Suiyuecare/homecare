# 員工目前完整保存資料（0.61）

狀態：契約已凍結；本機必要整合、瀏覽器與實際畫面驗收完成；初始契約及source freeze另存保留。這是本機獨立功能，不代表原平台完整人事規格或正式上線。

## 工作目的與既有權限

員工名單目前只有七個摘要欄，沒有直接呈現聯絡電話、電子郵件與備註；服務區域的清單摘要也不能區分保存文字、清單、空項或重複項。使用者應能先查看目前完整資料，再決定是否進行原有編輯操作。

管理者、督導與財務沿既有 `/employees` 導覽及 `GET /api/employees/:id` 同機構讀權，在員工列選擇「查看資料」。財務只增加此唯讀按鈕；原編輯、證照、訓練、啟停、保存紀錄索引與版本歷程仍只供原管理者／督導使用。居服員不新增員工名單或詳情入口，原本人 API 讀權保持。停用或同名員工按精確識別碼查詢。

不新增後端、資料表、角色、帳號、寫入或人事流程。職務文字不是登入權限，资格與證照文字不等於正式資格認定；試算時薪不代表薪資核定或重新計算已核閱快照。

## 明確讀取與資料投影

每次明確開啟／人工重讀，只對捕捉的精確 ID 執行一次既有單筆 GET，使用共用 signal；不使用名單快照假冒目前完整資料、不批量取得其他員工、不自動重試或輪詢。取得的目前版次可以不同於名單版次；沒有同時點或跨請求原子快照宣稱。

封閉 `{item}` envelope 與 requested `{id,orgId}`。五個 SQL metadata `id/orgId/version/createdAt/updatedAt` 必须為 own enumerable data descriptor，精確 ID／機構、正安全整數版次及保存時間字串；時間字串原樣保存，包括空字串，不解析、裁切或轉時區。識別碼沿原路由 `[a-f0-9-]+`，不加 UUID 政策。

只投影十個既有欄位，順序與標籤沿員工歷程：姓名、員工編號、職務、聯絡電話、電子郵件、員工狀態、資格與證照、服務區域、備註、試算時薪（新臺幣元）。純輸出為五 metadata 加 frozen `fields[{key,label,kind,text}]`；不回傳原始 item、未知欄或隱藏巢狀內容。

普通欄位分辨 missing「未保存」、empty「空白」、null「未提供（null）」、text 完整原文與 non-text 型別標記。known business property accessor 拒絕整筆回應且不得執行；未知 property/getter 不讀取。文字使用 textContent，CR/LF、空白、未知狀態與 HTML 字面內容完整呈現，不建立 tel/mailto 連結。

服務區域保留上述 own-presence／空值差異；非空文字沿 `formatEmployeeRegions` 顯示保存文字。合法 dense own-data string[] 先以 descriptor 確認 length、每個 index、沒有額外 own key，再 detach 為普通字串清單後交既有 formatter；不排序、去重、合併或拆分文字，保留空清單、空字串、重複及原順序。已知 index accessor 拒絕整筆而不執行；holes、非字串項、額外 key 或巢狀異型只顯示 non-text array 型別標記，不取未知值或遍歷其內容。

試算時薪保留 missing／empty／null；普通 primitive number/string/boolean 沿原 `formatTrialPriceCents`，非負 safe integer 以 BigInt 商餘數精確顯示元及保存分，包含 0 與 1 分；文字金額不得 Number coercion。object/array 等只顯示型別，不序列化內容；不修復保存值、不新增金額上限或薪資规则。

## 共用所有者與視覺

沿 APM CIS、`public/styles.css` tokens、`public/ui.js` 的 el/table/button/openDetails。唯一對話框及 async owner 仍為 `openDetails` 的 wide/guardedRead；不得新增 controller、observer、timer、CSS 或另一套 modal。

將既有面試者的 descriptor／封閉 envelope／metadata／文字投影抽為 `public/data/saved-record-details.js`。公開介面為 `isSavedRecordDetailsId`、`savedRecordDetailsIdentity`、`confirmSavedRecordDetails(response,requested,{fields,projectField,unconfirmed})`；domain adapter 決定自己的固定欄及錯誤文字。面試者既有三 exports 成為等價 wrapper，原八欄、typed 語意、錯誤全文及全部純函式斷言保持。

薄共用 view adapter `public/modules/saved-record-details.js` 只組裝目前兩個已核定 domain profiles 的 metadata、欄位與 `openDetails` 呼叫；不另擁有 async/dialog 生命週期。面試者原 DOM、title、notice、data-interview-field、八欄與 fullWidth 規格保持。員工薄 adapter 使用 title「員工保存資料」、region「員工完整保存資料」、data-employee-field；資格、區域與備註跨全列，長文沿 detail-grid/pre-wrap。

新員工入口必須在開啟前確認精確 route ID、非空 user/org 與三個既有可讀角色；捕捉 user/org/role/employeeId、hash、outer context 與原父 render/目前 trigger 連接狀態。loaded／pending context 或父清單重建失效即由共用 owner 清空、取消並關閉，晚回應不可復活；nested 參考更換而四 primitive 相同保持，outer context 重建保守撤除。原面試者 preflight/guard 語意不變。

無 CSV、列印、存入 URL／client storage、外部訊息或閱讀提交。loading、失敗與人工重讀、Escape、背景 inert、回焦、手機 footer 可操作性沿共用 owner；新頁面不建立第二套搜尋或分頁。

## 必要驗收與完成限制

凍結來源後執行完整 Node 程式測試、最低 Node22.13 的新／抽取相關測試與 Portal 合成測試、JS check、沿已接受私人 parser strict、DESIGN lint。原官方 auditor timeout、舊 producer/pending 及全部失敗原件保留；私人 parser 通過不能改稱官方通過。

必要 browser subset：core、APM CIS、合成 HTTPS Portal、員工安全編輯、員工歷程、員工保存索引、面試者詳情、視覺回歸及新員工詳情。不用無關規則補造完成率，不宣稱全部 configured 本輪 fresh。重驗僅在新改動、失敗或未解關注需要時進行。

新瀏覽器驗證三可讀角色及居服員／跨機構原 API 邊界、同名及停用、舊名單後真更新的 fresh 版次、十欄與型別、區域保存結構、精確整數分、503 單次人工重讀、非法 2xx、loaded/pending primitive 撤除、真 GET 取消、nested/outer 負控制、Enter/Escape/回焦、1440px／390px 完整長文及末句 Range/hit-test 在 direct close footer 上方。以合成 memory DB、十一表／六 trigger／附件 BLOB／核閱快照及 total_changes 連續帳本逐段證明所有新讀取零寫。必要新圖片須逐張實際查看，raw producer flag 不改寫。

完成必要整合與瀏覽器、視覺驗證後才更新本機 implemented_verified、狀態與追溯；原180目錄、九階段、十二待核定契約、兩增強與舊里程碑／runtime 前綴保持。RM-01仍 partial。公開來源只逐明確安全路徑於隔離 checkout 提交與同步，實際 GitHub CI 另留證；根 Git、私人 binding／資料庫／env／備份及4310不操作。

正式持久主機、HTTPS、Portal發布、真實公司登入與業務 UAT、完整原人事功能及支付／薪資／評分／介接等規則仍待交接與核定。本輪不得購買主機、修改 DNS 或正式部署。
