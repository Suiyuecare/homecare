# 需求評估保存紀錄查詢（0.53）

> 公開版本文件：記錄此功能版本的設計與驗收條件，並非目前公開副本已執行的驗收證明。私人盤點與 QA 產物未匯出；現行行為以 API.md 與原始碼為準，正式規則及部署仍須核定。

2026-10-10 凍結。正式主機、HTTPS、Portal 發布及本人 UAT 依原交接待完成。

## 範圍與授權

新增 /needs-assessments「需求評估查詢」及 GET /api/needs-assessments、GET /api/needs-assessments/:id。只讀目前機構、目前可讀父個案的既有 assessments，templateId 必須精確為 assessment-03。僅 admin／supervisor；沿 session／membership／org，query／body 前拒 finance、caregiver 及未知角色。其他方法先驗角色再405，不讀body。單筆其他模板、entity、外機構、缺失／不可讀父個案一律404。原 assessments CRUD／history、十六模板、其他訪視端點與財務既有讀權不變；不新增 entity／表／trigger／migration／寫入、輸出、評分或通知。

## 查詢與投影

list 僅接受 page/pageSize/q/status/date/caseId，key 單值。page 為正十進位 safe integer，pageSize1..100 預設25；不接受空值、空白、小數或指數。q 原文最多200 UTF-16字元，不 trim；小寫字面搜尋九個 own string 答案各自，不跨題拼接，不搜目前姓名、metadata、unknown keys、型別標記或巢狀值。status 空或 draft/submitted；date 空或沿原 dateValid 的有效YYYY-MM-DD（包含保存年0000），精確匹配主欄 assessments.date「紀錄填寫日期」，不使用 q003/q008/q009。caseId 空或最多500字元的非空白精確 ID，不 trim；不可讀所選父個案404，包含可讀 paused／closed，同名不猜 ID。

沿 scopedRows created_at DESC／id 穩定順序、safeVersionReader 及父個案重新授權。只對符合模板、可讀父個案及明確條件的全部候選，於分頁前驗證非空識別、org／case、正 safe version、有效 date 及保存狀態；不合法409 NEEDS_ASSESSMENT_DATA_INVALID，全拒，不猜值或修資料。其他模板／機構異常不阻塞。single 不接受 query。

list exact {items,total,page,pageSize,filters}，filters exact {q,status,date,caseId} 原文回顯；single exact {item}。row exact {id,orgId,version,templateId,caseId,caseNo,caseName,date,status,answerContainerKind,hasUnknownAnswerKeys,answers}。caseNo／caseName 僅目前可讀父個案 string，非文字為空；與保存 q001 個案姓名分開。

answers exact own q001..q009：個案姓名、照服員姓名、訪視日期、處遇情形、備註說明、督導、主管、審閱日期、填表日期。own string 包括空文字、CR/LF、長文及不相容日期原字串為 {kind:'string',value:完整原文}；missing/null/array/object/number/boolean 僅 {kind}，不帶非文字原值或巢狀內容。容器種類同上述加 string，只有 own 非array object 讀九題；unknown keys 只回 hasUnknownAnswerKeys 布林，非 object 容器九題都 missing。日期題只展示原文，不解析、推算風險、督導／主管簽核、資格、期限、分數、支付或薪資。

## 共用介面與情境

沿 frontend-design／frontend-design-premium 已有 APM CIS、唯一 styles.css／ui.js 控制項及 admin.listPage。只增加 caller 設定與獨立 pure projection：endpoint／caseFilter／dateFilter／confirmList／preserveSearchText；原其他 caller 不改。條件只記憶體，25筆分頁；case lookup 全頁核對，缺失所選 ID 保留條件／提示明確清除，不默默轉全部。

列表保存文字摘要最多160字，完整九題每次由唯一 openDetails({wide:true,guardedRead:true}) fresh single GET；沿 shared loading/error/retry、signal、Escape／焦點、完整 user/org/role/employee primitive／hash／render／alive 與 outer context 守門。nested 相同 primitive 換參考保持，outer 重建保守撤除；loaded／pending 失效清空 abort、晚回應不復活。非法2xx DTO／echo／row／org／template／typed tag／分頁不顯示資料，條件及手動重試保持。

目前姓名和九項保存姓名各自標示，不回填主檔。版本歷程仍 openRecordHistory('assessments')，精確前版、實際操作者與合法跨模板／跨父個案舊版沿原逐版授權；不另建歷程或縮減其內容。填寫連結回原 /assessments，沒有另一套編輯／提交／取消入口。390px表內橫捲、長答案完整可讀，真Range／hit-test驗末句在真正 close footer 上方，不以 textContent 或單張上半頁圖代替完整可讀性。

## 驗收條件

必要子集限定，不宣稱全部 configured fresh。每個原生程序記實際 exit、輸入 source／log SHA；錯誤及修稿原樣保留，不自動重試。每張新1440／390圖實際 view_image，原 raw pending flags 保留並另存外部視檢證據。

只使用 factory 合成 memory fixture／隨機loopback；setup／login／刻意fixture寫入另列。讀取、條件、分頁、403／404／409／422／503、不可信2xx、重試、關閉及context測試均以十一表、六trigger、schema／total_changes／完整raw rows零寫入確認，核閱快照、雙非空BLOB及原非assessment資料保持。

本機整合與瀏覽器完成後才標0.53 implemented_verified。保留306原來源及原失敗／封存證據；凍結QA後metadata另外驗收，再guarded同步。原需求評估分組、選項、必填、評分、正式報表／文件及完整等價仍待核定。
