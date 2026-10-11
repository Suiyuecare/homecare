# 服務紀錄唯讀版本差異與核閱操作者（0.11）

本輪獨立本機合成資料切片，接續RM-03及URL-6f3a815ad462。原服務紀錄完整欄位、差勤/App、原跨事件歷程及正式支付/薪資/申報仍partial/unverified或待核定。沿既有record_versions、稽核及單班服務紀錄流程，不新增寫入、還原、外部訊息或計價規則。0.7至0.10不可覆寫封存保留。

## 授權與比較

GET /api/service-records/:id/history?page=&pageSize=&compare=previous。先membership及scopedRows('service-records')要求目前紀錄可讀，否則404；caregiver未連結員工沿403。沿原四角色：admin/supervisor/finance同機構只讀，caregiver目前紀錄employeeId必須為自己。此切片不新增目前紀錄的shift join授權，不改服務寫入規則。

所有角色raw及compare在分頁之前只保留snapshot.caseId存在於目前scopedRows('cases')集合的版本；caregiver另要求snapshot.employeeId=ctx.employeeId。歷史個案可不同目前個案，不能把目前caseId當固定歷史關聯；缺失或跨機構case均隱藏。case可讀集合沿自己目前全部班次（包含完成/取消），不新增日期或狀態限制。A→B→A或換案後舊案不可讀時形成缺口，不跳版；若另有自己的取消班使舊案可讀，舊版仍可見。

沿readHistory同一owner：先授權全部版本，再比較精確version-1，最後index既有25預設/100最大分頁。compare省略raw維持{version,snapshot,createdAt,source}，只有可見範圍補強；compare=previous追加actor:{id,name}|null及comparison:{status:initial|available|unavailable,previousVersion:number|null,previousSnapshot:object|null}。v1 initial；缺失/不可見前版unavailable、previous兩欄null；跨25筆頁界可比較。重複/非法compare及不支持其他entity仍422。前後snapshot都沿publicRecord：supervisor/caregiver遮billingSnapshot，admin/finance保留既有API權限；前端白名單全角色不顯示金額/計價。既有其他entity比較與shifts授權不變。

## 精確操作者

只有service-records額外接受同org/entity/recordId及精確整數detail.version的service.review（退回及核准），並沿record.create/update；shift.complete仍專屬shifts。只從該users實際identity及目前name讀取，不取目前員工/督導、source、時間相近事件或鄰版。缺user/同版不同user身份衝突為null；同user重複仍可辨識；無效版本/錯scope/不允許action忽略，無合法事件則null。baseline與缺前版不猜actor。核准後billingSnapshot、價格/時薪及舊費用/薪資讀取保持原結果，不重新計價。

## 共用介面與欄位

唯一owner public/modules/history.js openRecordHistory及ui.js openDetails/wide，不另造controller/CSS/保存queue。新增service-records十欄依序：shiftId「關聯班次」、caseId「個案」、employeeId「服務人員」、date「服務日期」、actualStart「實際開始時間」、actualEnd「實際結束時間」、services「服務項目與實際數量」（quantityLabel=實際數量）、status「服務紀錄狀態」、note「服務紀錄與觀察」、reviewNote「核閱說明」。status沿既有作業文案draft草稿/submitted待核閱/approved已核閱/returned已退回；actual時間保持保存字串，不轉時區或推算工時。services沿serviceItemId/quantity純排序比較，忽略非白名單內部值/metadata/billingSnapshot，不修改來源。

三入口：/records每列「版本歷程」與核閱/草稿編輯並存；/my-services有record卡片新增「服務紀錄版本歷程」，原班次「版本歷程」保持；個案詳情「服務紀錄」表每列「版本歷程」並保留原核閱，finance沿個案詳情唯讀，不增加/records管理導覽。無record班次沒有服務紀錄歷程。只有已授權呼叫者lookup，/records沿已載shifts/cases/employees/service-items，/my-services用當頁班次，case detail用已載本案與前5班次；不為關聯補查跨scope資料。班次特殊描述「目前班次：日期 開始 至 結束（狀態）」；無lookup「目前班次無法取得」並可展開保存ID；其他關聯沿目前名稱標示。actor標明目前名稱，缺失明示未記錄，不假稱原當時姓名。

沿可展開版本卡、單欄保存欄位、620px差異表內捲動、25筆分頁及loading/empty/error/retry/Escape/關閉/焦點。history current identity包含user/org/role/employeeId、hash及呼叫者renderVersion/container連線，傳給openDetails.isCurrent。共用openDetails讓非列印dialog也監看hash/session-updated/body子樹失效：只要isCurrent=false即清空body/abort/關閉；其他default isCurrent=true行為不變，既有printable單次fresh列印保護維持。已載入及載入中的歷程切機構/角色/員工範圍/頁面均撤除；晚回應不重開、錯誤不顯示舊資料。每次翻頁/重讀仍伺服器驗權，其他client未通知的變更沿下次請求驗權，不宣稱即時推播。

## 驗收與追溯

Node：真caregiver草稿→提交→督導退回→改送→管理者核准，精確actor/核閱意見/保存服務數量；真draft合法換另班次的A→B→A與換case、原shift改派撤舊案scope、自己的cancelledshift恢復可見；四角色及跨機構/目前record404/逐版缺失或foreigncase/raw一致；service.review錯scope/version/action/缺user/重複同user/不同user歧義，其他entity不收service.review；baseline/前版缺口/28版25+3頁界；財務兩層遮罩；approved快照/改價/時薪/fees/payroll與CAS/RECORD_LOCKED/SHIFT_HAS_RECORD/不可變trigger維持。所有read以完整10表rawState/counts/total_changes證零寫。純差異驗十白名單、文字時間/狀態/備註/核閱/services與不修改來源。

真Chromium：三入口及原編輯/核閱功能、真UI生命周期、四角色與A→B→A/歷史case可讀及不可讀缺口、25+分頁和精確前版、缺失actor/關聯名稱/空歷程、503重試/慢請求取消/Escape焦點/機構角色employee/hash/render失效（含已載入）、1440/390所有截圖逐張view_image。fixture無法由UI產生的歷史缺口/移轉baseline明列合成fixture，不降低產品validator。唯讀區段完整10表不變、核閱計價快照不變。root獨立全Node及既有10browser回歸，三類報表沿同一artifact修訂PDF_OPERATION_ALREADY_MARKED=1並保留最新證據，若重生PDF須逐頁view。必要整合及browser/視覺全過才本切片implemented_verified。原84/52/28/16來源/status/parity/sourcehash/9階段/0原completed保留，僅原服務入口附獨立本機證據及localMilestone；0.11另封存。
