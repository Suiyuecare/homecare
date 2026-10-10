# 人工追蹤查詢（0.50）

> 公開版本文件：記錄此功能版本的設計與驗收條件，並非目前公開副本已執行的驗收證明。私人盤點與 QA 產物未匯出；現行行為以 API.md 與原始碼為準，正式規則及部署仍須核定。

凍結日期：2026-10-10。依已接受的0.46九欄人工暫停／結案追蹤，提供同機構跨個案唯讀清單；不是原平台表單提醒、喘息提醒、臨床訪視或法定期限規則。

## 權限與保存來源

獨立頁面 /case-followup-worklist、GET /api/case-followup-worklist 及 /:id 僅admin／supervisor可讀。server先驗機構membership與角色，再處理路徑、方法及query；finance／caregiver在新入口403。原case-status-followups四角色generic讀取、兩角色寫入、固定caseId、CAS、版本、稽核與冪等保持。

新功能不寫入、沒有新entity／表／trigger／migration／輸出／列印／CSV／通知。每筆必須在目前同機構可讀cases與case-status-followups交集。缺父個案或跨機構父項隱藏；原個案active／paused／closed不影響既有可讀範圍。沿safeVersionReader保留unsafe SQLite整數，符合查詢的非法id／org／case／version回409 FOLLOWUP_DATA_INVALID，整份拒絕；不修資料。

## 封閉查詢與投影

只接受一次page、pageSize、q、kind、status、followUpDate、caseId。page正安全整數，pageSize1..100，預設1／25。q最多200字、不trim，大小寫不敏感，只搜尋reason／outcome／note的own string；不搜尋未知鍵、JSON或目前姓名。kind空或pause／closure；status空或pending／completed／cancelled；followUpDate空或有效YYYY-MM-DD，僅精確匹配人工保存追蹤日期；caseId空或非空白最多500字且目前有權ID，越界404。未知／重複／非法422。沿原保存紀錄created_at DESC,id順序，不推算到期、逾期、未完成比例或法定期限。

list回{items,total,page,pageSize,filters}，filters精確回顯q／kind／status／followUpDate／caseId。先篩選、確認全部符合資料，再分頁。每列**只有**id／orgId／version／caseId／caseNo／caseName／fields。caseNo／caseName為目前可讀主檔原文字，非文字為空，不按同名猜ID。fields只有kind／startDate／endDate／reason／followUpDate／outcome／note／status八欄；每欄為{kind:'string',value:原文字}或{kind:missing|null|array|object|number|boolean}，非文字內容不展示，不展開未知鍵。未修改保存內容、不trim／轉型／補日期。unknown kind／status原文字可讀，不猜狀態。

single回{item}，拒絕任何query；每次重驗目前機構與父項。前端確認精確DTO／全部tag shape／org／id／case／安全version／唯一ID／query echo／精確分頁筆數。details須同清單捕捉id／org／case；fresh版次可較新，不靠舊列推成功。

## 共用介面與情境

沿APM CIS、styles.css token及唯一admin.listPage、searchBox、table、pagination、errorState、openDetails guardedRead、history。listPage僅增加可選kindFilter業務變體，其他caller預設保持；dateFilter key為followUpDate，caseFilter沿完整確認名單／失效ID／明確清除，不默默轉全部。條件僅記憶體，不進URL或client storage。

列表顯示目前案號／姓名、人工追蹤日期、類型、開始日期、追蹤狀態、原因摘要、版次與動作。完整保存內容fresh讀取八欄，長文字原樣pre-wrap；版本歷程沿既有case-status-followups九欄精確前版與實際actor。明確「前往個案維護」a導向捕捉caseId的既有詳情，不提供新寫入按鈕，不暗示自動定位某筆追蹤。使用者依原個案區塊維護。

完整JSON primitive tuple user.id／org／role／employeeId（null／undefined一致正規化），加hash／generation／render stamp／element連線。loaded／pending列表及details／history失效清空、中止，晚回應不復活；保持外層context的同值user／organizations等巢狀reference替換不失效；外層context重建沿既有canonical guardedRead規則保守失效，business current亦捕捉外層reference以保持列表與視窗一致。Escape、取消、回焦、錯誤重試沿唯一owner。原生date／select接受OS外觀，不宣稱popup幾何或人工UAT。

## 驗收與限制

必要純確認、HTTP與真Chromium含empty／25筆翻頁／全部filters／同名不同ID／停用或結案父項、missing/null/JSON/CR/LF及超長文字、非法回應／503／重試／fresh版本／精確history、角色及機構拒絕。loaded／pending各六種primitive失效、同值reference負控制、真requestfailed與晚回應、Escape焦點、1440／390px與長文字末句實際可讀。唯讀每段完整十一表／六trigger／schema／total_changes、非空BLOB與核閱計價快照一致；fixture及合成登入寫入分開對帳。

沿必要相關browser包含舊followups／supervisory-visits／interviews／contacts／history／core／APM CIS／HTTPS合成Portal。只跑必要子集，不宣稱所有配置命令fresh；原失敗保存。完成整合、瀏覽器與逐張圖實看才標示本機implemented_verified。
