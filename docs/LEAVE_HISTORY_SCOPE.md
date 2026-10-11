# 請假紀錄版本歷程（0.13 獨立本機切片）

2026-10-08 凍結。依既有本機 API 與程式，沿 RM-03 的 leave-history-v0.13；合成資料，不使用原平台、真實個資或正式差勤結算。完成必要整合、瀏覽器與逐張視覺驗證後才 implemented_verified。原完整差勤、假別額度與結算仍 partial/unverified。

## 目前紀錄與逐版授權

目前 leave-requests 保持既有 scopedRows：管理者、督導、財務可讀同機構全部，居服員只讀 employeeId 自己。只有 admin/supervisor 可寫；finance/caregiver 403。員工存在且同機構即可作請假父項，不新增 active 限制；admin/sup/finance 仍可讀停用員工。caregiver auth 原要求有效同機構員工連結，未連結／跨機構／缺失／停用 403。

先沿 scopedRows 核對目前紀錄可讀，不加目前 employee join；再對所有角色的 raw 與 compare 逐版要求 snapshot.employeeId 存在於目前 scopedRows(employees) 可讀集合，caregiver 再限自身。employeeId 原可合法 PATCH 更換，不能要求每版 employeeId 等於 current.employeeId，也不能套用證照不可改父項契約。真 A→B→A 後 caregiver A 只見 v3、v1，v3 精確前版 v2 不可取得；B 已失去目前紀錄授權則 404。缺失／跨機構父項版本隱藏；若 current 父項缺失但原 scopedRows 可讀，歷史較早合法父項版仍可保留，不擅加 404 或強制空集合。

raw 保持 {version,snapshot,createdAt,source}。compare=previous 增加同一 actor 與 comparison 格式；先授權全部版本，再精確 version-1 比較，最後既有預設25／最大100分頁。v1 initial；缺版／無權前版 unavailable，previous 兩欄 null，不跳版。28版的25+3頁界需能比較頁外精確前版。非法／重複 compare 422；不支援 entity 契約不變；前後 snapshot 均沿 publicRecord 角色遮罩。

## 原寫入規則與操作者

不改 model/index/schema/資料庫、不新增 pending-only backend 狀態鎖。原合法 enum 的 POST/PATCH 狀態與 employeeId 改派保持；核准請假任一 POST/PATCH 皆重新檢查同員工／同日期所有非 cancelled shifts（包括 completed）的半開時段重疊，衝突 SHIFT_CONFLICT 409。反向 shift 與 approved leave 重疊 LEAVE_CONFLICT 409，相接端點允許；沒有 leave 對 leave 互斥規則，不自行新增。日期與 end>start、同日 HH:mm 或 ISO 原驗證保持。不新增假額、法定時數、跨夜、補班、支付或薪資算法。

操作者只依同 org/entity/recordId 及精確整數 detail.version 的 record.create/update 實際 users 身份。核准、駁回、取消目前皆 generic PATCH record.update；不存在 leave.review，不採 service.review／shift.complete 或猜 source／員工／督導／相近時間／鄰版。缺 user 或合法候選身份衝突 null；同 user 重複可辨識，非法版本／scope／action 忽略。待審核版亦顯示真正建立或修改人，不稱已審核人。姓名明示目前姓名。

## 七個保存欄位與共用介面

依序 employeeId「員工」（reference employees）、date「請假日期」（date）、startTime「開始時間」（text）、endTime「結束時間」（text）、type「假別」（text）、reason「請假原因」（text）、status「請假狀態」（leave-status）。pending 待審核、approved 已核准、rejected 已駁回、cancelled 已取消，沿原文案。假別為機構自由文字；時段保留原 HH:mm／同日 ISO，不能轉成推算請假時數。白名單排除內部 meta、billingSnapshot、年度／餘額／積分，不修改來源。

在既有 /leave 管理者／督導入口每筆追加「版本歷程」，全狀態可讀，不修改原 pending 編輯、核准、駁回與 pending/approved 取消按鈕規則。finance/caregiver API 可讀不等於新增導覽。只用 leave 已授權 fetchAll employees Map，目前名稱明示、保存 ID 可展開；缺失名稱不額外跨 scope 查取。

沿唯一 history.js openRecordHistory／ui.js openDetails，寬版、可展開版本卡、七欄保存內容及差異表自身橫捲；不另寫 async/controller、CSS 或 ui.js。傳入 user/org/role/employee/hash、generation、container 連線與 namespaced render stamp guard。已載入與慢讀的路徑、機構、角色、員工連結、同 container 重繪失效均清空、abort、關閉，晚回應不復活；重試／取消／Escape 焦點沿共享 owner。原列表搜尋／狀態／25筆分頁／寫入失敗保留／確認取消不升版保持。必要 guard 修改限 /leave 或共用 owner 的最小一致改動，不擴充其他產品範圍。

## 驗收與追溯

Node：真 API 建立／修改／核准／駁回／取消與精確 actor；四角色 raw/compare／跨機構／active auth link；真改派 A→B→A、停用／歷史缺父項與 current 缺父項保留早版；baseline／缺版／28版頁界、actor 缺失／歧義／錯事件；完整10表 rawState/counts/total_changes 零寫，CAS／CSRF／冪等／append-only triggers，以及原雙向衝突與相接時段／核准 PATCH 重新驗證、approved 計價及 fees/payroll 舊5類報表不變。純差異測試覆蓋7欄、自由假別／原時段與 metadata 排除、來源不修改。

真 Chromium：管理者建立→督導修改（含真員工更換）→管理者核准→督導取消等原合法 UI 流程；另真 UI 駁回、取消確認不寫及衝突失敗保留。核對四角色 API、A→B→A、精確 actor／相鄰版／原時間與名稱、28版分頁、baseline／缺版／未知名字或 actor／空歷程、503 重試／Escape 焦點、loaded/pending hash/org/role/employee/render 10情境。client role/employee fixture 明示僅 UI context；真 server auth 另以登入 session 驗證。逐段全部10表與 approved snapshots 不變，唯讀區間只 GET。1440/390 screenshot 逐張 view_image。

root 獨立全 Node 及舊12套 browser 回歸。新歷程無 PDF；既有三報表若重生 PDF 沿同 artifact envskip 和原 provenance/marker 限制，不假造送印或 operation marker。原84/52/28/16目錄、順序、來源hash、status/parity、9階段、0原completed與 localReportKinds5保留，僅 URL-b97f8cdb4e92／URL-89289081caa3 追加本機證據。0.7至0.12封存不覆寫，0.13 另保存本輪程式與證據。
