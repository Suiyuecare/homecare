# 請假衝突班次明細：0.15 本機獨立切片

2026-10-08 凍結。依 PRODUCT.md、現有 API/model 與 BUILD_BACKLOG RM-03 下一切片；只用合成資料。原完整差勤、假額、資格、跨夜、批次代班及正式規則維持待核定。

## 範圍與權限

- 新 GET /api/leave-requests/:id/shift-conflicts?page=1&pageSize=25，僅 admin/supervisor，其他角色早403；匿名401，membership/機構與 caregiver active-link 保持原 auth。原 leave GET/history 與寫入授權不改。
- 每次從目前 scopedRows 的 leave 讀取保存員工/日期/時段，必須同機構 scoped employees 存在；缺失、跨機構、錯 entity 父項404，停用員工管理讀權保留。這個新端點的父項 join 不加到原 leave current/history。
- 四種請假狀態都可查保存時段；不回 canApprove、不核准或變更任何紀錄。核准仍用原 PATCH/version/CSRF/全部驗證；先讀無衝突不保證隨後核准成功。

## 原規則共用與錯誤

- model.mjs 匯出共用逐筆 generator：同 employeeId、同 date、shift.status !== 'cancelled'；interval/timeMinute/overlaps 保持原行為，包含 completed。半開區間相接不重疊；同日 ISO 沿字面 HH:mm 忽略秒與 offset，不能轉 UTC、lexical compare 或增加跨夜。
- 原 approved 寫入用 generator 第一個 hit 即原409 SHIFT_CONFLICT，保留 rows 原順序與第一個錯誤短路，不先建立全結果。反向 LEAVE_CONFLICT、SHIFT_HAS_RECORD 與其他寫入/CAS/計價規則不改。
- 新 reader 消耗完整結果後才排序/分頁；目前 leave 日期或時段、匹配候選班次時段不合法時409 CONFLICT_DATA_INVALID，全份拒絕，不能少回資料或推成零衝突。新 reader 的錯誤轉換不能改到原 write guard。
- 任一同機構 service-record 的 shiftId 相符，即 hasServiceRecord=true，涵蓋 draft/submitted/returned/approved，不靠 completed 推測。false 不等於可直接修改；原寫入仍驗權與狀態。財務內容/核閱快照完全不改。

## 回應與分頁

- 固定白名單 {leave,generatedAt,items,total,page,pageSize,note}。
- leave={id,version,employee:{id,name,employeeNo,status},date,startTime,endTime,type,status}；只採目前已授權父員工，起訖與自由假別保留原值。
- items 每筆 {shiftId,version,date,startTime,endTime,status,employee:{id,name,employeeNo,status},case:{id,name,caseNo,status}|null,hasServiceRecord}。name/no 無值可 null；不猜名稱。case 只由 scoped cases map 取名；缺失/跨機構/錯 entity 則 null，仍保留實際阻擋核准的班次，不透露不可讀 caseId。缺 care-plan 不影響原衝突 predicate，不新增 join。
- 不回 reason/note、電話、地址、服務內容、服務紀錄識別、BLOB/fileId、費率/金額/billingSnapshot；不折算時數/重疊分鐘/假額。generatedAt UTC ISO，畫面標示目前資料。
- 只接受 page/pageSize，未知或重複參數422 INVALID_QUERY；分頁數值沿現有 index.mjs pageParams Number 語意，預設1/25、positive safe integer/size<=100，空值沿既有default。不是宣稱新嚴格十進位字串契約，不另抽 report query/parser 或改泛用 API。
- role guard 在 query/row 前；route 重用 pageParams，把已驗分頁傳給 reader。完整同 scope 衝突按起始分鐘、結束分鐘、shiftId 升冪穩定排序後分頁；total 全部符合數，不受頁面影響。28班25+3，頁外不存在回空 items/完整 total。
- 11 表所有 GET raw/count/total_changes 零寫；無新表/trigger、審計或冪等寫入。6個既有不可變trigger與所有父項/歷程/計價保持。

## 介面所有權與失效

- /leave 既有 admin/sup 操作欄對各狀態加「檢視衝突班次」，沿原其他操作；不增加 finance/caregiver 導覽或操作。不在衝突視窗建立核准/改派/取消寫入。
- 新薄 business adapter public/modules/leave-shift-conflicts.js 使用唯一 openDetails wide/表格或既有 semantic card/dl、pagination/errorState。ui.js 的 load callback 向後相容地增加第二參數 {reload,isCurrent}，現有一參數 callback 不變；重新檢查/分頁皆呼叫同一 openDetails reload，不新增 controller/overlay/async生命週期或 CSS。
- 每次開啟、重新檢查、分頁/失敗重試皆真 GET；依 response 顯示最新 leave 父員工、保存日期/時段/假別/狀態/版次與讀取時間，不用清單舊 row 推結論。回應缺 envelope/不符 id/非法分頁或資料時顯示錯誤，不能假裝空結果。若 race 使頁碼越最後頁，可在相同 loader/guard 下調整頁碼後 fresh 讀取。
- empty 明示「目前沒有重疊班次；核准時仍會重新檢查。」；非pending提示僅查看保存時段；有資料顯示全數及每班 ID/版次/原時段/狀態/目前個案/員工/鎖定原因。case null 明示「目前個案資料無法取得，請核對資料」，不能掩蓋該衝突。
- 已有服務紀錄明示不能改派/取消，completed 沿原狀態限制說明；scheduled 無紀錄導引至排班管理仍驗條件。單一語義 link「前往排班管理」到 #/shifts，不聲稱已過濾或定位，不把 PII/識別碼放 URL。
- admin caller alive（user/org/role/employeeId/hash/generation/container stamp/連線）加 adapter 完整 identity/hash guard，傳給共用 openDetails。loaded/pending 各 hash/org/role/employee/render 失效清空 abort 關閉；慢回應不復活。Escape/關閉回入口焦點，503保留清單可重試。無新 CSS/runtime token/DESIGN變更。

## 驗收與追溯

- 新 tests/leave-shift-conflicts.test.mjs 真四角色/跨機構/父項/停用、全部 predicate/ISO/接壤/取消/completed/四service狀態、缺case仍阻擋、28分頁/排序/fresh、未知/重複/非法query、完整DTO白名單與零寫、短路409/422原write相容、真核准競態、已核准billing/fees/payroll保持。記錄明示合成匯入/異常 fixture，不更新或刪不可變版本/BLOB。
- 新 tests/leave-shift-conflicts-e2e.mjs 真 admin/sup UI、fresh leave改派/改時間、真班次新增/取消/改派或新服務後重新讀取、無衝突→race→原核准409、503/無確認/非法DTO、分頁/empty/null case、loaded/pending10情境/晚回應/Escape與前往班表；每段必要11表零寫與正常寫入分別列帳。1440/390逐圖 view_image、四角色真session另驗，client role/employee fixture不冒稱server撤權。
- root完整Node/source/strict premium及既有14套browser196類回歸；需逐圖檢視新切片、最新請假歷程及適用報表回歸。原報表沿同artifact envskip/原PDFprovenance與marker限制，不產生本切片PDF/正式送印證明。
- 原84/52/28/16與9階段/status/parity/sourcehash/statusCounts/0 original completed/localReportKinds5不變，只為兩原請假頁 URL-b97f8cdb4e92/URL-89289081caa3 追加獨立本機證據。RM-03維持partial。完整驗證與瀏覽器/視覺完成後才標 implemented_verified，新增不可覆寫0.15.0快照。
