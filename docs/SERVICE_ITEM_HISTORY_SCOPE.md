# 服務項目主檔版本歷程（0.16 獨立本機切片）

2026-10-08 凍結。接續 service-item-history-v0.16，補既有本機服務項目的唯讀版本差異；合成資料，不使用原平台或正式支付價。RM-05、原自費服務頁 URL-d2e425aaa0ac 維持 needs_contract/unverified/related_only，不以本機歷程宣稱原正式價格、核銷或政策版本相等。必要整合、瀏覽器及逐張視覺驗證後才標局部 implemented_verified。

## 目前資料及全部歷史的授權

沿既有 scopedRows(service-items) 先核對目前主檔可讀。同機構 admin/supervisor/finance 可讀全部項目，包含 inactive 及有效期已過的項目。caregiver 僅可讀目前自己所有 shifts.services 引用的 serviceItemId，包括 completed/cancelled 班次，不加日期／狀態／有效期／個案／計畫 join；單有計畫或服務紀錄引用不擴權。caregiver auth 的目前員工有效連結條件保持。

service-item 沒有不可變父項；目前 ID 有權讀取後，該 org/entity/recordId 的原 raw 全部版本仍可讀，不依歷史 code/name/價格/日期/狀態重新篩選。caregiver 真改派或移除全部自己班次的引用失去 current 主檔權限時，current/raw/compare 均404；重获讀權可看原全部版本。仍被取消班引用者保留讀權。跨機構或不存在404，不新增 finance403 或薪資／價格遮罩。

raw 不變：{version,snapshot,createdAt,source}。同端 GET /api/service-items/:id/history?compare=previous 加入既有 comparableEntities；精確 version-1 在授權後、分頁前比較，v1 initial、缺前版 unavailable，previousVersion/previousSnapshot 均 null，不跳版。28版25+3須比較頁外精確前版。非法／重複 compare422，其他 entity 原支持與拒絕保持；page/pageSize 沿目前 history/pageParams，不引入另一解析器或新 query 契約。

前後 snapshots 沿 publicRecord：所有角色去 fileId；非admin/finance去 billingSnapshot；原 unitPriceCents 價格欄四角色仍可讀，不能把它混同核閱 billingSnapshot 或薪資。沒有新表/trigger/audit/idem 或歷史寫入。

## 操作者及既有寫入保持

只採同 org/entity/recordId、精確 detail.version 的 record.create/update 實際 users 身份；使用目前姓名，缺失／身份歧義 null，同使用者重複可辨識。不採 service.review／shift.complete、不猜 source、相近時間、項目擁有者或鄰版。

admin/sup 原可 POST/PATCH，finance/caregiver 寫入403。沿原 CAS/CSRF/POST 冪等、同 org code 唯一、分鐘1..1440整數、價錢0..1e9整數、日期可空及双日期倒置拒絕。code/name 原可改，不擅加 in-use 鎖／不可改代碼／trim 或有效期算法。model/index/schema、核閱及價格／時薪快照算法不改；核閱後改主檔不重算歷史費薪。

## 八個保存欄及精確價格

依序：code「服務代碼」（text）、name「服務名稱」（text）、minutes「預設服務分鐘」（minutes）、unitPriceCents「測試單價（新臺幣元）」（trial-price-cents）、validFrom「有效起日」（date，空值未設起日）、validTo「有效迄日」（date，空值未設迄日）、status「服務項目狀態」（service-item-status：active啟用/inactive停用）、note「備註」（text）。只用業務白名單，不顯示 meta、actor、credential、billingSnapshot、正式補助／自付／額度／薪資／文件儲存內部欄。

新 trial-price-cents formatter 只處理非負安全整數，不 coercion。整數精確分拆（可用 BigInt 的整數商/餘數，不新增依賴）顯示「新臺幣 123.45 元（保存 12345 分）」；0顯示0.00/0分、1顯示0.01/1分，安全整數上緣亦精確，不能用原 formatMoney 的四捨五入、||0、浮點重新計價或推算法定給付。缺失/null/空字串沿 normalization 為未提供，不能假造0；非法字串/負值/非整數/非safe integer 原 scalar 文字附「金額無法判讀」，未知物件沿已有「欄位格式無法判讀」，不序列化內嵌資料或猜正確金額。formatter 純函式可放 history-fields.js 供 meaningful 邊界驗證；不改其他 type、normalization 或目前列表 formatMoney。

分鐘是保存的預設值，不是實際工時；日期保存值不依今天重新判斷是否可用，空迄日不推永久有效。視窗提示「合成測試價格，不代表政府支付標準；預設分鐘及有效日期保留保存值，不重算已核閱快照」。

## 既有入口與共用介面

只在 /service-items 原 admin/sup 操作欄加「版本歷程」，全狀態。finance 原頁面／唯讀列表／raw API 保持，但本輪不加歷程按鈕；caregiver 不新增導覽或入口。原新增/編輯/停用啟用/搜尋/篩選/25筆分頁/CAS失敗保留與確認取消不寫保持。

沿唯一 history.js openRecordHistory、ui.js openDetails，title「服務項目版本歷程」、8欄完整保存內容、精確差異與 actor、25筆歷程分頁，不新 adapter/controller/CSS/ui.js 或跨 scope lookup。只擴 history-fields 定義、專屬 price/status formatter、notice/title，admin operation 傳 isCurrent:alive；沿已有完整 user/org/role/employee/hash、generation/namespaced render stamp/容器連線 guard。

loaded/pending 各 hash/org/role/employee/render 10情境清空、abort、關閉，晚回應不復活；重試/Escape/焦點沿共享 owner。手機差異表自身橫捲，正文與價錢完整可讀，不整頁溢出。

## 驗收與證據

Node 真 API lifecycle/精確 actor、四角色 current/raw/compare、own shifts 引用與真改派/移除/恢復讀權、inactive/expired/缺case-plan不加join、active employee auth、baseline/empty/gap/28版頁外比較、actor缺失/歧義/錯action/目前名、雙snapshot publicRecord、原CAS/CSRF/idem/唯一/日期數字邊界、11表raw/count/total_changes零寫及6不可變trigger。真核閱後改價/時薪，billingSnapshot與fees/payroll不變，原五報表及三新報表相容；報表原本可顯示最新名稱，不假定主檔改名後整份DTO仍舊名稱。

純差異測試：8欄白名單/內部欄排除；一分差與0/1/12345/safe integer精確顯示／异常不猜；frozen來源不改、空值等價與有效期/停用差異。

Chromium 真 admin新增v1→sup編輯v2→admin停用v3→sup啟用v4、精確actor/8欄/價格、取消確認零寫、CAS409保留輸入、列表搜尋/狀態/分頁、四session API/無額外role入口、28版、空/缺版/未知actor/非法保存值、503 retry/Escape/10失效；逐段完整11表及快照不變，必要真API/UI寫入另列。client role/employee fixture明示不等於server撤權；1440/390最終PNG每張 view_image。

root 全 Node 及原15套 browser 回歸；共用 history 格式擴充後，最新證訓／請假歷程及三報表UI/PDF逐張回歸。新歷程不產PDF；三報表沿既有同artifact envskip及 provenance/marker 限制，不假造新marker/實體送印。原84/52/28/16來源／順序／status/parity／sourcehash／statusCounts／9階段／0原completed及localReportKinds5保持，只在原相關自費服務頁追加獨立局部證據，原 needs_contract 不改。0.7–0.15不可覆寫舊封存核 hash，新0.16另保存程式/契約/證據。
