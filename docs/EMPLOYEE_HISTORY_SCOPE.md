# 員工主檔版本歷程（0.17 獨立本機切片）

2026-10-08 凍結。employee-history-v0.17，RM-01 的本機十欄唯讀差異。只使用合成資料；原員工列表、基本資料及跨事件異動紀錄仍 partial/unverified，不宣稱完整原平台等價。正式薪資、資格、積分、保存及原欄位契約待核定。必要整合與瀏覽器逐張視覺驗證後才標本切片 implemented_verified。

## 目前主檔、歷史與角色

沿 scopedRows(employees) 先核對目前 ID：同機構 admin/supervisor/finance 可讀所有員工，包含 inactive；caregiver 只自己的 ctx.employeeId，auth 原要求目前有效、同機構且 active 的員工連結。沒有連結、跨機構、錯實體、inactive 連結仍403；可讀 ID 以外404。employees 不屬 personnelEntities，不新增 finance403、父項 join 或歷史 employeeId/role/status 篩選。

目前員工可讀後，同 org/entity/recordId 的全部 raw 保存版本仍可讀；目前 active caregiver 可以讀自己過去 inactive 保存版。原 hourlyRateCents 四角色可见性保持，role 是職務文字，不是登入角色或權限。publicRecord 四角色去 fileId、非admin/finance去 billingSnapshot 保持；不新增薪資遮罩。

GET /api/employees/:id/history?compare=previous 沿唯一 readHistory，只加入 comparableEntities。raw 契約不改。精確 version-1 在授權後、分頁前比較；v1 initial、缺前版 unavailable 且 previousVersion/previousSnapshot null，不跳版。28版25+3含頁外前版。非法或重複 compare422；其他實體支持／拒絕保持。6套舊 Node 用 employees 做 unsupported compare 負向fixture，改為另一原可讀且仍未支持的實體，保留負向驗收、scope及原測試數量。

actor 只取同 org/entity/recordId/detail.version 的 record.create/update、實際 users 身份及目前姓名。缺失／歧義 null，不採其他 action、相近時間、source、鄰版或目前員工擁有者。不寫新audit、idem、trigger、歷史或新表。

## 十欄與保存型別

依序 name「姓名」、employeeNo「員工編號」、role「職務」、phone「聯絡電話」、email「電子郵件」、status「員工狀態」（active啟用/inactive停用）、qualification「資格與證照」、regions「服務區域」、note「備註」、hourlyRateCents「試算時薪（新臺幣元）」。業務白名單排除meta、credential、登入角色、billingSnapshot等內部欄。

regions 原合法 string 長度≤1000 或 string[]≤50、每項長度<100，空項合法。專屬純 normalization 保留字串／陣列型別、完整文字、空項、順序及重複，不拆頓號／逗號、不排序、去重、trim、推算行政區。missing/null/空字串沿未提供；[] 顯示保存的空清單，[''] 顯示一個保存空項；單字串「臺北」和清單['臺北']以保存型別標示可區別。清單每項依保存順序呈現且空項明示；非空項以角引號包住完整保存文字，空項顯示「空字串」，所以真正文字「空字串」與空項可辨。保存文字標記以冒號分開內容；不以純 join 隱藏邊界。異常物件／混合型別陣列 normalization 採無來源資料的異常型別tag，避免與合法文字「[欄位格式無法判讀]」碰撞；renderer用既有欄位格式無法判讀標示，不序列化巢狀敏感資料、不猜正確值。只 regions 專屬 helper，不改其他實體 scalar/services normalization。來源 frozen 可比較且不被修改。

時薪沿 v0.16 formatTrialPriceCents 非負安全整數的 BigInt 整數商／餘數，0/1/12345/safe上緣精確；缺失/null/空字串未提供、異常 scalar 金額無法判讀、物件不洩漏。沿 type trial-price-cents 重用，不改 formatMoney 或現有CRUD。提示保存的試算時薪不是核定薪資，資格文字不推定合格，不重算已核閱快照。

## 共用介面與寫入保持

只 admin/sup /employees 原操作列全狀態加「版本歷程」，title「員工版本歷程」，沿 openRecordHistory/openDetails、10欄保存內容與差異、精確 actor、25筆頁。finance 原列表／讀API保持但不加入口，caregiver不增導覽。只擴 admin.js/history.js/history-fields.js、server history.mjs；無新controller/CSS/ui.js/lookup/query，完整 user/org/role/employee/hash、generation/namespaced stamp/容器連線 guard沿用。

原新增／編輯／證照／訓練／停用啟用／搜尋／篩選／分頁及失敗保留不改；原編輯表單將 regions array.join('、') 為字串的語義保持，歷程不偷偷更改CRUD。admin/sup POST/PATCH、finance/caregiver403；CAS/CSRF/POST冪等/同org編號唯一、整數金額邊界保持。列出真正API/UI寫入段，唯讀與失敗寫入段11表完全零寫。

loaded/pending 各 hash/org/role/employee/render 十情境清空、abort、關閉，晚回應不復活。client role/employee fixture不冒稱server撤權；四個真session另驗證。503重試/Escape/焦點沿共享owner，1440/390渲染及手機差異表自身橫捲、不整頁溢出。

## 驗收與證據

Node 真API lifecycle/四角色current/raw/compare/active link/歷史inactive/不加父項/精確actor、publicRecord、baseline/empty/gap/28版頁外比較、非法query與原寫入guard。11表raw/count/total_changes零寫、六不可變trigger、雙非空BLOB byte/download保持。核閱後改目前員工時薪與名稱／狀態，billingSnapshot/fees/payroll不重算；報表可使用目前名稱，不假定改名後DTO全部舊名稱。19報表端點相容。純helper驗证10欄白名單、regions型別與順序/重複/空值/異常不洩漏、來源不可變及精確時薪。

新 Chromium 流程 admin新增v1→sup編輯v2→停用→恢復及合法 API string/array保存切換；CAS409保留、確認取消零寫、列表搜尋/篩選/分頁、四session、28版、空/缺版/未知actor/異常regions與時薪、503/10失效。最終PNG每張view_image，root獨立抽查至少六張。

root全Node及原16套browser回歸；最新證訓歷程18張、服務項目歷程22張、三報表42UI及14PDF逐張回歸，複本來源SHA不變。新歷程無PDF；三報表沿同artifact envskip/provenance/marker限制，不新增marker、不宣稱實體送印。DESIGN/CSS/runtime tokens保持、strict premium無finding、原design lint零error十已知warning保留並標非本轮重跑。

原84/52/28/16項目來源、順序、status/parity、四sourcehash、statusCounts、九階段及0原completed/localReportKinds5保持；只 URL-6d93f16d410f、URL-b6f805085183、URL-feab69ea11c9 追加本機局部證據，不改原欄位映射／缺口文字或薪資頁。0.7–0.16舊封存驗SHA，新0.17另保存程式／契約／證據；實際試用SQLite十一表/六trigger/匿名setup保持。完成前不標此切片已驗證，未核定契約仍pending。
