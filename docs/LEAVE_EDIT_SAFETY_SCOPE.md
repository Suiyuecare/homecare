# 請假安全編輯（0.28 獨立本機切片）

2026-10-09 凍結；leave-edit-safety-v0.28 / RM-03。沿既有 leave-requests CRUD、機構隔離、角色、CAS、POST 冪等、歷程與雙向半開區間衝突，只用合成資料；不新增假額、扣薪、跨夜或正式差勤規則。

七個保存欄：employeeId、date、startTime、endTime、type、reason、status。原表單只有前六欄可編輯；新增固定 pending，編輯保持原 status，不增加自由狀態選單。核准、駁回、取消沿原獨立確認動作。pending 才顯示編輯／核准／駁回，pending/approved 才顯示取消是原 UI 規則；後端沒有 pending-only 狀態鎖，本輪不新增或宣稱已有。

createLeaveEditor 純 adapter 私下捕捉七欄 own-presence/JSON 及 id/orgId/version，不展開 row 到 controls。前六欄正常未改／改回原值省略；全部未改沿 version-only PATCH。missing/null/異型／不能無損預填值提供保持／取代，只有 reason 可明確清空為 ''；保持不猜今天、09:00、第一位員工、不 trim、不 coercion。status 不來自表單輸入。新增完整七欄，員工待選、日期沿 today()、09:00–10:00、空假別／原因、pending。

員工選項沿本機可讀 employees，包含停用員工；不新增 active 限制。原 employeeId 只有能在目前 native 選項精確表示時預填，缺失／不可取得不自動選其他員工；保持保存原 ID、明確取代才選目前選項。日期用 native date：有效 YYYY-MM-DD 且年 0001..9999 才預填；原 API 合法 year 0000 在 DOM 外保持，不轉年份。起訖只將有效完整 HH:mm 原樣預填；同日 ISO 含秒／offset 及其他無損不相容資料在 DOM 外保持，不截短、不做時區換算。明確取代起訖用有效 HH:mm；改日期但保持原 ISO 仍由原 API 同日 interval 驗證，可能 TIME_RANGE 422，不默默改寫原時段。

type 使用單行文字，不含 CR/LF 的原文可無損預填；reason 使用 textarea 保留 LF，含 CR 原文在 DOM 外保持。新送 type 非空、普通字串最多500 UTF-16字元，reason 最多10000；空白不 trim。未改的可無損過長文字省略。原 validatePayload 只驗送出的欄，merged validate 不重新驗未送 type/reason 型別或長度；保持不保證原必填、日期、時段、status、同機構員工與 fresh 核准衝突可通過。日期／時段整體次序由原 API 決定，不新增跨夜規則。

只有 admin/supervisor 沿原入口維護；finance 保留原 GET/history/三請假報表 API 讀取，caregiver 保留本人讀取與 active auth link。兩者仍沒有 /leave 入口或請假寫權；conflicts 仍僅 admin/supervisor。employeeId 可沿原 API 合法改派，歷程逐版 scope 與精確前版缺口不變。預覽無衝突不能當核准授權；核准 PATCH 再讀最新班次，completed 阻擋、cancelled 排除、相接不重疊，已有服务紀錄鎖不放寬。

新增／編輯沿共用 openForm 完整 isCurrent/AbortSignal/busy/dirty/native 焦點；三狀態動作沿共用 confirmAction 相同 guard，保留原確認按鈕語彙。確認內容只使用可安全呈現的目前員工名稱／保存日期與時段，異型用固定名稱，不展開隱藏匯入物件。成功須 plain item、同 id/org、安全版本（新增1／編輯old+1）與七欄 own-presence/精確 JSON 投影一致後才 toast/refresh；狀態動作亦檢查其餘六欄未漂移。未知2xx／409／422／503保留輸入、intent 與 POST 同鍵，晚回應不得復活表單；Abort 不宣稱撤回已提交交易。19後端、ui.js、CSS/token、其他模組與所有既有測試原則保持。

驗收包含純 helper、真 HTTP 省略／明確取代／原因清空／同日 ISO與0000年份／缺員工及停用員工／原 merged422、真 CAS409、POST同鍵、七欄保存確認、真 fresh 核准衝突與四角色；loaded/pending 編輯／審核六context與兩真先提交晚回應、dirty/native焦點鍵盤與390px長文；原歷程、衝突、分頁與相關既有流程回歸。十一表唯讀段與必要寫入分開對帳，雙BLOB、六不可變trigger、核閱費薪快照及31報表出口保持。最終截圖逐張 view_image；0新PDF／marker，不宣稱 headless OS popup 幾何或人工UAT。原RM-03與正式差勤仍 partial/unverified，完成只記獨立 localMilestone。
