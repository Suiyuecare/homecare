# 多組個案聯絡人切片（0.4）

此為獨立系統的本機資料契約。沿用已授權的持續建置範圍，不使用原平台或真實個資。RM-02及原個案基本資料仍partial。

## 來源與相容性

notes/case-evidence.json的原/case/:caseId觀察到聯絡人姓名、電子信箱、電話(H/O)、主要／次要照顧者與關係、A單位／個管姓名與聯絡資訊。這是介面線索，不是完整資料結構或App註冊規則。本輪提供可重複新增的分類聯絡紀錄；不推定原全部欄位等價。

現有cases.primaryCarer/contactName/contactPhone維持原值，不自動搬移、同步或建立新紀錄。新增分類不代表法定代理人、App帳號或唯一主聯絡人；沒有外部訊息、撥號或帳號連動。

## 資料與權限

新增case-contacts實體，使用既有records與record_versions，無另建資料表或批次修改既有個案。

欄位：caseId、name、category、relationship、phone、alternatePhone、email、organization、status、note。caseId及name必填，category預設general、status預設active。分類值general（一般聯絡人）、primary_caregiver（主要照顧者）、secondary_caregiver（次要照顧者）、case_manager（個管窗口）、other（其他）；同分類可有多筆，沒有唯一主聯絡人或優先順序演算法。

建立後caseId不可更換，違反回409 CASE_IMMUTABLE。caseId必須為同機構存在個案；暫停／結案個案仍可維護聯絡紀錄。文字在伺服器trim；name/relationship/phone/alternatePhone最多100字、email254字、organization200字、note10000字。email可空白，非空白須為一般電子信箱格式；電話允許文字、分機與國際格式，不宣稱驗證可接通。聯絡方式不強制必填。

status為active（使用中）或inactive（已停用）。透過PATCH停用／恢復，保留版本與稽核；不提供硬刪除。寫入沿用CSRF及未知欄位拒絕；POST使用Idempotency-Key防重送，PATCH使用version防衝突。

admin/supervisor可讀寫；finance沿用個案唯讀；caregiver僅讀目前可讀個案所屬聯絡人，包含停用紀錄與可讀歷程。不新增頁面或寫入權限。跨機構及他人個案的GET detail/history回404，列表於搜尋及分頁前限制範圍；寫入403。敏感資料正式營運遮罩仍待核定。

## API與歷程

GET /api/case-contacts支援caseId、category、status、q、page/pageSize，所有篩選在分頁前完成；不合法或重複category回422。POST、GET/PATCH /api/case-contacts/:id沿用共用格式。

GET /api/case-contacts/:id/history可用compare=previous，沿用docs/HISTORY_SCOPE.md的actor與comparison格式。未傳compare保持既有history格式。只有目前有權查看的紀錄才能讀歷程，歷史快照caseId須與目前紀錄相同且同樣可讀；原始歷史中其他個案快照不可藉前版比較帶出。先篩選後精確比較及分頁。不跳過缺失或不可讀前版，不猜操作者。

history-fields.js新增此實體白名單；caseId顯示目前已授權個案名稱與保存識別，其餘值依快照。停用／恢復及聯絡欄位變動可比較。讀取、分頁、重試、關閉不增加資料或稽核。

## 介面

於個案詳情基本資料後新增「多組聯絡人」獨立區塊，自己載入、搜尋、分類／狀態篩選、25筆分頁與錯誤重試，不阻斷其他個案區塊。搜尋及個案篩選留於記憶體，不寫URL/localStorage。

管理者／督導有新增、編輯、停用／恢復；其他角色只讀。固定目前個案，不提供更換個案選單；表單及確認使用ui.js，歷程沿用history.js/openDetails。失敗保留輸入；真409提醒重新讀取，不能靜默覆寫。停用／恢復先確認，取消不寫入。新增POST每份表單持有Idempotency-Key。

聯絡紀錄以卡片及definition list呈現，手機單欄，長信箱／備註可換行；差異表沿用局部橫向捲動。輸入都有標籤，Escape／關閉恢復焦點；切換個案／機構或搜尋新請求後，過時回應不能串入新頁。聯絡列表首次失敗保留其他個案內容，可重試。

## 驗收

後端整合：CRUD／trim／格式／同機構外鍵／不可改個案／Idempotency及409；分類／狀態搜尋分頁；角色、同個案歷史與精確前版缺口；原個案資料與版本不變；版本不可UPDATE/DELETE，歷程讀取零寫入。

瀏覽器使用memory SQLite、隨機埠及合成資料，實際新增／修改多筆聯絡人，核對保存值與歷程；驗證28筆分頁、分類／狀態／搜尋、真併發409保留、原聯絡欄位不變、角色唯讀、重試／過時回應／取消／焦點及1440/390px。截圖逐張檢查後才標示此獨立切片implemented_verified。
