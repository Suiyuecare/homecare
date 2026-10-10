# 證照紀錄安全編輯（0.29 獨立本機切片）

> 公開版本文件：記錄此功能版本的設計與驗收條件，並非目前公開副本已執行的驗收證明。私人盤點與 QA 產物未匯出；現行行為以 API.md 與原始碼為準，正式規則及部署仍須核定。

2026-10-09 凍結；certification-edit-safety-v0.29 / 。沿既有 employee-certifications、機構隔離、角色、CAS、POST 冪等、唯讀歷程及證照附件父項規則；只用合成資料，不新增資格、積分、排班資格、正式效期或外部介接。

八個保存欄：employeeId、name、certificateNo、issuer、issuedOn、expiresOn、status、note。表單七個可見控制項，編輯時員工 disabled／不可改，其他六項可編輯。status 不進表單，新增固定 active；撤銷／恢復沿原獨立確認動作，不建立新的後端狀態機。訓練表單與動作保持原 bytes／語意，留待後續獨立切片。

createCertificationEditor({existing, employees, defaultDate, defaultEmployeeId}) 純 adapter 私下捕捉八欄 own-presence／JSON 及 id/orgId/version，原 row 不展開到控制項。正常未改／改回原值省略，全未改沿 version-only PATCH。既有 employeeId 永不送 PATCH；若缺失／異型或不在目前可讀選項，readonly 空控制項與固定說明，不猜其他員工，也不能用表單修復歸屬。原 merged 必填／同機構外鍵／EMPLOYEE_IMMUTABLE 保持，可能拒絕保存。建立員工選項只取目前可讀、可安全表示的 string id/name/employeeNo，包含停用員工；預設只可用目前合法已選員工篩選，否則待選，不自選首項。

missing/null/異型／不能無損預填值在 DOM 外保持，六個可編輯欄提供保持／明確取代，certificateNo、issuer、expiresOn、note 另可明確清空為 ''。name、issuedOn 不能清空。name/certificateNo/issuer 單行文字只有不含 CR/LF 才可無損預填；note textarea 可保留 LF、含 CR 原文保持。正常未改 name 不 trim；明確新寫 name 按原 normalizePersonnelPayload.trim()，以正規化後非空且最多500 UTF-16字元驗證並確認保存結果。certificateNo/issuer 不 trim，最多500；note 不 trim，最多10000。未改的相容過長文字省略；新寫型別／長度只驗送出欄位，原 merged 對 name 仍要求非空普通文字。

issuedOn 用有效 YYYY-MM-DD、年0001..9999 原樣預填；expiresOn 同格式或空字串。原 API 合法0000年保持在 DOM 外，不轉年份；missing到期日可保持未保存，null／異型／非法日期保持仍可能原 INVALID_DATE422，不能推成空日期。明確取代用有效 native 日期、到期日清空為空文字；日期次序仍由原 API DATE_RANGE 判定，不新增格式、轉換或提前改寫。新增完整八欄：員工待選或合法已選篩選、名稱／編號／發證單位／備註空文字、發證日 today()、到期空文字、active。

只有 admin/supervisor 維護；caregiver 只讀本人並沿 active auth link，finance 原 GET/history/report/attachment 拒絕保持。可讀停用員工記錄保持；不可改員工、版本歷程逐版父項一致與精確前版缺口、derived expiryState/daysToExpiry/asOf 不保存且不參與八欄確認。提醒仍原 certificationView，撤銷優先、空期限／到期／30與31天界線；不是法定資格或自動排班限制。

新增／編輯沿共用 openForm 完整 isCurrent/AbortSignal/busy/dirty/native 焦點，撤銷／恢復沿共用 confirmAction 相同 guard；保留原按鈕名稱與後果，確認名稱只呈現安全單行文字、異型用固定名稱，不 coercion 或展開匯入物件。成功須 plain item、同 id/org、安全版本（新增1／編輯old+1）與八欄 own-presence／精確 JSON 投影吻合後才 toast／refresh；狀態動作亦確認另外七欄未漂移。未知2xx、409／422／503保留輸入／intent／POST同鍵；晚回應不得復活過時表單，Abort 不宣稱回滾已提交交易。

19後端、ui.js、CSS/token、歷程、attachments owner、其他模組與28套既有browser scripts 原則保持。personnel.js 只新增 certificate business variants 及兩個早期分支，原共用訓練路徑保持。驗收含純 helper、真HTTP名稱正規化／省略／取代／可空四欄／缺父項／停用員工／0000／原422／immutable409／CAS／POST鍵、八欄確認與四角色；loaded/pending edit/status六context及兩真先提交晚回應、dirty/native焦點／鍵盤、390px長文與末段、原歷程／效期／篩選／分頁／證照附件回歸。

十一表唯讀與必要寫入分段對帳，雙BLOB與精確版本下載、六不可變trigger、核閱費薪快照與31報表出口保持；0新PDF／marker，原七artifact可依舊script程式檢查／同artifact修訂，不宣稱新增人工舊PDF驗收。最終截圖逐張 view_image；不宣稱 headless OS popup 幾何／鍵盤選值或人工UAT。
