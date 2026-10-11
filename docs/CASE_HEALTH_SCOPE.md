# 個案健康人工紀錄（本機）

本切片新增個案詳情中的疫苗接種、感染觀察與處置、生理量測三組紀錄。每組可新增、編輯、停用／恢復使用、查看詳情、搜尋、按日期／狀態篩選及查看版本歷程。內容由管理者或督導人工維護；系統保存原文與追溯資料，不推定診斷、風險分數、健康建議或臨床效力。

## 欄位與規則

| 實體 | 業務欄位 | 必填 |
| --- | --- | --- |
| `case-vaccinations` | `caseId date vaccine dose provider lotNumber source status note` | 個案、接種日期、疫苗名稱 |
| `case-infection-records` | `caseId date category observation action followUpDate source status note` | 個案、紀錄日期、人工分類、觀察內容 |
| `case-vitals` | `caseId date time metric value unit source status note` | 個案、日期、時間、量測名稱、保存數值、保存單位 |

每筆固定隸屬建立時的個案；建立後不能更換 `caseId`。父個案必須在目前機構存在，寫入交易中重讀父個案；結案個案仍可保存歷史人工資料。父個案在目前機構不可讀時，清單排除紀錄，單筆、歷程及更新拒絕。

日期為有效 `YYYY-MM-DD`，年 0001 至 9999；人工追蹤日期可空白，填寫時不得早於紀錄日期。時間只能是 00:00 至 23:59 的 `HH:mm`。狀態為 `active`／`inactive`，新增預設使用中，停用與恢復使用需明確確認且保留原文／歷程。其他選填欄位預設空文字。

疫苗名稱、劑次／劑量紀錄、接種單位、批號、感染分類、量測項目與單位各最多 100 字；來源最多 500 字；觀察與處置各最多 2000 字；備註最多 10000 字。必要欄位不能只有空白。所有欄位都是文字，不接受物件、陣列或未知業務欄位。

生理量測 `value` 是最多 40 字的非負十進位原文，允許整數、小數及前後數字零，例如 `00036.500`，不轉成 JavaScript 浮點數。拒絕負號、正號、指數、空白、千分位、末尾換行及缺少整數／小數部分的寫法。不自動選擇量測項目或單位，不換算、不填參考範圍，也不對保存數值作臨床判讀。

## 權限與 API

只有 `admin`、`supervisor` 可讀寫三組紀錄。`finance`、`caregiver` 在處理業務 payload 前回應 403；業務驗證器亦再次守門。機構隔離沿用伺服器控制，不由前端隱藏按鈕代替授權。

- `GET /api/:entity`：只接受各一次 `page`、`pageSize`、`q`、`caseId`、`date`、`status`。日期／狀態／個案為精確篩選，文字搜尋最多 200 字；分頁必須是合法正整數，`pageSize` 上限 100。未知、重複或非法查詢回應 422。
- `GET /api/:entity/:id`：不接受 query；重新驗證目前機構及父個案可讀。
- `POST /api/:entity`：建立紀錄，支援同一 payload 與相同冪等鍵安全重試。
- `PATCH /api/:entity/:id`：必須帶目前 `version`，沿用 CAS；非法 payload、父個案、過期版次、來源／CSRF 等失敗不寫入紀錄、版本或稽核。
- `GET /api/:entity/:id/history`：沿用唯一歷程功能，只接受各一次 `page`、`pageSize`、`compare=previous`。版本必須符合目前機構、識別、版次及固定父個案；同機構更換父個案或跨機構偽造快照不可見。
- 沒有實體刪除；改為停用保存追溯。

伺服器匯出 `caseHealthEntities`、`isCaseHealthEntity`、`guardCaseHealthAccess`、`normalizeCaseHealthPayload`、`validateCaseHealth(entity, data, old, fail, dateValid, db, ctx, get)`、`caseHealthQuery(entity, params, fail, dateValid)`，由共用 model／router／history 整合。各實體 `maxLengths` 可直接提供泛用 payload 驗證的長度規則。

## 共用介面與資料保持

`createCaseHealthPanel({ entity, caseRecord, isCurrent })` 回傳 `{ element, load }`，與既有個案支持 panel 契約相同。前端 profile 匯出 `CASE_HEALTH_PROFILES`，每組包含 `fields: string[]`、`labels`、`title`、`singular`、`required`、`defaults`、`maxLengths` 與說明，供表單及歷程白名單整合。列表每頁 25 筆，卡片呈現日期、人工名稱與重點；詳情 fresh read 呈現全文與保存版次。

沿用 `ui.js` 的表單、詳情視窗、確認視窗、按鈕、搜尋、分頁及錯誤 owner，沒有第二套焦點／dialog／dirty controller 或新 CSS。日期、時間、狀態均為原生控制項，數值為十進位文字欄位。編輯未改欄位不提交；長文字及空白保持。CR／CRLF 或單行欄位中的換行無法無損放入原生控制項時，用明確「保持原文／本次取代／選填清空」意圖處理，原文保留在私有基線，不填入不相容控制項。多行觀察、處置及備註允許 LF，保存明確輸入的前後空白。

保存成功須確認機構、個案、識別、下一版次及所有業務欄位的 own-presence／精確文字吻合。型別不符、未知／巢狀資料或回應不完整時保留輸入，不顯示成功。409 提示重新讀取；建立重試沿同一 payload 冪等鍵。確認回應並關閉共用視窗後才重載清單，避免來源按鈕提前脫離目前 context。

使用者、機構、角色、員工綁定、路由、父個案或渲染內容失效時停止載入、清除內容並關閉過期視窗；晚到回應不復活。取消前端請求不代表已送出的伺服器交易回滾。

## 驗證與保留的失敗紀錄

HTTP 測試使用記憶體資料庫與隨機埠，資料全部合成。9 項 HTTP／server-helper 測試涵蓋三實體 CRUD、角色先行拒絕、機構與不可變父個案、父個案每次重讀、原文／十進位零精確保持、追蹤時序、非法 payload／query、冪等、CAS、失敗零寫入、版本 actor、非法歷程不可見及不可讀父個案 404。7 項純前端測試涵蓋三組 profile、沒有臨床預設、精確十進位、原文保持／取代意圖、完整 ACK、未知巢狀資料與分頁範圍。

首次測試 actual 1（工具 receipt `3cc093`，13 通過／3 失敗）：兩個合成最大數值 fixture 誤填 41 字；第三個刪除合成父個案因版本外鍵被攔下。未修改或放寬業務規則，將 fixture 校為 40 字，並保留版本外鍵、以合成跨機構父記錄構造目前機構父個案失聯。重跑 16 項全部通過（receipt `9d52fd`）。後續新增末尾換行數值與分頁查詢拒絕斷言後，最終 16 項與 3 個 runtime 語法檢查全部 actual 0（receipt `1ee3c4`）。原失敗 receipt 保留，不宣稱首次通過。

瀏覽器及全系統驗收由根整合完成後記入追溯清單。本文件不代表正式部署、Portal／HTTPS 發布、醫療建議能力或原平台完整等價。

待核定或本切片外功能包括疫苗時程建議、感染診斷、通報規則、異常數值參考範圍、臨床分數、裝置介接、外部提醒及正式醫療文件格式。這些規則未被推測或自動實作。
