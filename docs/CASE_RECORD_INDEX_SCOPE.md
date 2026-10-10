# 個案保存紀錄索引：v0.56 本機切片契約

目的：管理者／督導在個案頁以四種紀錄種類查找目前同案紀錄，從完整分頁索引開啟既有單筆版本歷程。既有生效計畫、班次及服務紀錄前五筆摘要、業務清單與維護流程保留；新增該案評估紀錄的歷程入口。這不是個案完整異動事件或跨紀錄時間軸。

依據：PRODUCT.md 的個案／計畫／版本追溯、docs/API.md 現有四角色及同機構授權、RM-02 的個案歷史、public/modules/operations.js 個案頁、src/server/model.mjs/scopedRows、src/server/history.mjs/readHistory。APM CIS、Portal receiver 與單一登入契約保持。未知正式業務、原欄位映射、支付／薪資／評分／保存期限不在本切片。

## 伺服器

GET /api/cases/:caseId/record-index。admin/supervisor 才能使用；其他角色先403。非GET在角色守門後405，不解析或保存 body。同機構且 entity=cases 的精確現存父ID才存在，包含 paused/closed；錯entity／跨機構／缺失404。不以姓名或email關聯、不按歷史caseId推定目前歸屬。

query 僅 entity/page/pageSize 各一次。entity 必填 care-plans/shifts/service-records/assessments 其中一碼；page正安全十進位整數預設1；pageSize 1..100預設25。未知、重複、缺失或非法422。父案與候選紀錄ID沿既有歷程路由 ^[a-f0-9-]+$，不新增UUID形狀或長度限制；候選非相容ID整份409，不能展示無法開啟的歷程。索引只取現在 records 中 ctx.orgId、指定entity、原資料own caseId精確等於父caseId的資料，包含所有保存狀態。非object／非文字caseId／無法解析而不能確認歸屬的原資料不納入，也不修復。候選SQL版次以BigInt安全讀取，正safe integer轉數字；候選 metadata id/org/entity/updated_at 無法確認或版次不安全，整份409 CASE_RECORD_INDEX_INVALID，先驗全部候選再分頁，不能只驗當頁或回部分成功。updatedAt必須原string，不猜日期。

排序沿 records.created_at DESC、id ASC；createdAt僅排序不回傳。exact envelope {items,total,page,pageSize,entity,orgId,caseId}。每列 exact {entity,id,orgId,caseId,version,updatedAt}。全部字段來自SQL metadata與已確認父ID；body中同名metadata不得覆蓋SQL。無業務欄、狀態、答案、備註、模板、檔案、actor、audit、record_versions、計價或BLOB。GET不寫11表／6trigger、版本、冪等、快照；沒有新table/trigger/migration或restore。

## 介面

個案頁 admin/supervisor 新增『保存紀錄索引』按鈕；finance/caregiver不顯示新按鈕，原個案／單筆歷程與讀取權保持。唯一openDetails guardedRead管理讀取、重試、取消、Escape、focus與full primitive context；重用createForm、table、pagination及history，不造第二dialog/controller/CSS/token。

四碼原生select接受OS popup，預設照顧計畫。明確查詢才用草稿條件fresh讀取；草稿變更立即撤去舊結果並停用分頁／歷程。每次分頁fresh讀取且保留已確認entity，25筆；外來／非法2xx不得呈現舊或新索引。空結果、503、離線可手動retry，保留entity；錯誤不自動重試或寫入。合法2xx若請求頁已超過最新最後頁，可沿既有共用分頁方式校正到最後頁並fresh讀取一次，這是頁面收斂，不是錯誤重試。只在完整echo/scope/安全版次/唯一ID/精確頁筆數與metadata白名單確認後呈現。

桌機及390px完整展示紀錄種類、目前版次、原更新時間、可展開的原識別碼與『此紀錄歷程』動作，表內可橫捲。更新時間保留原文字，非法時間不猜。histories沿原openRecordHistory與既有已授權lookup；新索引不重新實作比較或actor。此紀錄歷程可能包含該紀錄過去其他目前可讀個案／模板的版本，不能宣稱每版都屬本案。開啟歷程不新增單筆endpoint；既有history本身每次fresh server授權。

完整user/org/role/employee/hash/父render/outer context失效清空abort，晚回應不復活；nested同primitive參考保持。原record CRUD/CAS/CSRF與所有歷程規則保持，不展開未知巢狀欄位。焦點、主dialog关闭與nested history以canonical owner協作。

## 必要驗收與完成界線

合成HTTP：四類所有保存狀態、相同姓名不同ID、paused/closed、跨org/錯entity/缺失父、role-first method/query/body、封閉query/echo、25+後頁、metadata-only投影、不相容原JSON不外洩、超安全版次在頁外整份409、SQL metadata權威及排序；GET記錄全11表/6trigger/schema/total_changes零寫、BLOB及approved快照保持。

純函式：exact DTO與own-descriptor守門、wrong id/org/case/entity/page/count/duplicate/version/extra字段、無getter執行、改寫為safe copied返回而非opaque payload。必要browser：四種真合成紀錄歷程、後頁、空與503retry、malformed2xx、慢讀close/情境失效/真正Abort、Escape及focus、1440/390及長ID/時間、原個案摘要／評估／CIS及合成HTTPS Portal回歸。只必要subset；不稱全部配置fresh/正式UAT/原功能等價。

先完成整合與browser，再版本0.56與local milestone追加；原180列/全部欄、9phase、原statusCounts/completed0保持，RM-02仍partial。原v0.55与GitHub初次發布證據不覆寫；本機實際帳號/DB/.env/備份/4310/DNS不得讀取或重置，不正式部署。
