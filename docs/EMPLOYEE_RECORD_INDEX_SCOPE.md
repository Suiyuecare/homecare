# 員工保存紀錄索引（0.58，本機契約）

本機獨立唯讀功能。管理者與督導從既有員工清單逐列開啟「保存紀錄」，查閱目前機構精確員工的證照、教育訓練或請假紀錄 metadata，25筆分頁，交接既有單筆版本歷程。這是保存紀錄定位，不是資格、積分、差勤、薪資、完整異動時間軸或原平台全量等價。

## API／授權

GET /api/employees/:employeeId/record-index，先沿已登入本機session及org，僅admin/supervisor，其他角色403；不存在、不同機構、其他entity的父ID404。含停用員工，精確SQL employees主檔ID，不按姓名匹配、不信任業務body的shadow id/org。原員工主檔、證照、訓練、請假CRUD與server權限、單筆歷程、核閱快照、schema及六immutable trigger保持。

query只允許一次entity／page／pageSize；entity必填且限定employee-certifications、employee-training、leave-requests。page預設1正整數；pageSize預設25，1至100，不trim/coerce、不接受leading零、重複、未知參數。payload raw JSON須為非null非array object且own employeeId精確文字等於SQL父id，其他typed／shadow／missing不納入。所有保存狀態納入，只讀SQL row metadata，不回傳證照／訓練／請假內容、名稱、薪資、資格、到期、actor或history。

按原records的created_at DESC,id SQL順序，在分頁前驗所有匹配row的route可用id、org/entity、安全正整數版次及updated_at原文字；非法匹配metadata整批409 EMPLOYEE_RECORD_INDEX_INVALID。Envelope exactly {items,total,page,pageSize,entity,orgId,employeeId}；row exactly {entity,id,orgId,employeeId,version,updatedAt}。原更新時間及ID不猜日期、不格式化、不隱藏可讀末句；排序created_at未回傳，client不宣稱獨立驗證排序。safeVersionReader保護unsafe SQLite整數。

## 共用介面與互動

沿v0.57 APM CIS及唯一ui.js table/pagination/createForm/openDetails guardedRead/錯誤/manual reload，單筆history仍由history.js擁有。把既有case-record-index相同讀取/查詢/分頁行為抽成唯一record-index adapter owner，case薄caller預設行為、四類、原notice與caption保持；員工新增薄caller與封閉確認pure adapter，不複製第二控制器、不改CSS、tokens、router、其他CRUD或SSO。

只admin/supervisor員工列顯示「保存紀錄」；既有證照／訓練跳頁與主檔歷程保持。對話框選三類、明確查詢；草稿改即撤去舊結果、停用重讀，query僅記憶。未知2xx或503只顯示錯誤與人工retry，沒有error自動重試；成功out-of-range頁最多一次重新讀取最後頁，仍需確認完整DTO。未有查詢不讀取；無結果可操作。現在同員工不保證歷程過去每版仍屬此人，history沿原各版授權及保存關聯展示，不能用索引覆寫history或限制為只此員工過去版本。

父render與outer getContext object、user/org/role/employeeId primitives、hash、alive guard完整確認。loaded/pending失效清空Abort關閉，不復活晚回應；nested相同primitive reference保持，outer重建保守撤除。query與result exact descriptors/own keys/array/safe ints/分頁/唯一ID/parent/org/entity均需確認，getter不執行；click/Enter及history沿same current guard。共用pending/busy/native焦點/Escape/回trigger、桌機與390px表內捲/長原時間完整、print背景抑制保持。

## 必要驗收

新HTTP與pure：四角色／兩機構／同名與停用員工、三類所有狀態、SQL metadata shadow/body型別隔離、全匹配版次含off-page unsafe、嚴格query、25+5分頁及SQL排序、無history洩漏。十一表/schema/六trigger/BLOB及approved billing raw snapshot讀取零寫；原各種CRUD與單筆history fresh仍可用。

新browser：三類查詢與histories、30筆25+5、精確員工不按同名、不可讀finance/caregiver入口與API403、錯誤與manual retry、非法回應variants、draft retraction、loaded/pending六primitive及outer/nested owner守門、Escape/focus/實際GET取消、390px完整長時間/ID與table自身捲、readonly原表對帳。1440/390 PNG實際視檢後才接受。

必要回歸：source check／完整program tests、employee-history／personnel-history／leave-history／case-record-index／employee-edit-safety／core／APM CIS／合成HTTPS Portal／v0.57 visual refresh。只跑必要subset，原失敗與環境/helper窄修逐次保存。最低Node22.13相關測試、accepted-private strict parser、DESIGN lint沿原provenance。對原case shared owner的extract必須逆向對照及case browser完整通過；若新變更引出其他依賴再擴大。

未讀寫實際帳號／DB／env／binding／備份／4310，不新增正式申報／付款／外部訊息、DNS或部署。公開同步逐檔审查；原180 catalog、9phase、statusCounts／integrity、舊milestone／來源／user enhancements全部精確前綴保留，RM-01仍partial，正式契約needs_contract保持。
