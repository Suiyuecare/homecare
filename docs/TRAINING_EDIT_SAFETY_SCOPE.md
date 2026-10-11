# 訓練紀錄安全編輯（0.30 獨立本機切片）

2026-10-09 凍結；training-edit-safety-v0.30 / RM-01。沿既有 employee-training、機構隔離、角色、CAS、POST 冪等、版本歷程及訓練報表；只使用合成資料，不新增法定積分、資格、排班資格、費薪或外部介接。

八保存欄：employeeId、name、category、provider、date、trainingMinutes、status、note。七個原控制項：employeeId、name、category、provider、date、trainingHours、note。trainingHours 仍為原生 number，min=1/60、max=1000、step=0.25；沿共用 noValidate 與應用驗證，不增加15分鐘倍數限制。status 不進表單，新增固定 completed，取消／恢復完成沿原獨立確認動作。

createTrainingEditor({existing,employees,defaultDate,defaultEmployeeId}) 純 adapter 私下捕捉八欄 own-presence／JSON 與 id/orgId/version，不展開 row 到 initial。員工只取目前可讀、安全字串 ID 的選項並包含停用者；新增預設只可用目前合法已選員工篩選，否則待選，不猜首項。編輯歸屬永久固定、永不 PATCH employeeId；缺失、異型或目前選項缺父項維持 readonly 空值及原歸屬，不能在表單修復。原 merged 必填、同機構外鍵及 EMPLOYEE_IMMUTABLE 仍可能拒絕保存。

六個可編輯控制項未改／改回省略。missing/null/異型、CR 單行文字、含 CR 的備註、未知分類、非法或0000年日期，以及非 safe integer 1..60000 的分鐘值留 DOM 外；六項提供保持／明確取代，只有 provider、note 可明確清空為空字串。trainingHoursIntent 對應保存欄 trainingMinutes；unsafe number initial 為 null、disabled／非 required，不把 null 當零。category 取代只可 pre_service/in_service/other，新增預設 in_service；date 明確取代及原生預填只用有效 YYYY-MM-DD／0001..9999，API 合法0000年原值保持不轉年。保持不繞過原 merged 422。

合法整數分鐘預填原 trainingMinutes/60 的完整 number，不用 toFixed、不縮成兩位。1..60000 全範圍按原乘回規則可還原；未改 numeric baseline 直接省略，修改後換算回原整數分鐘亦省略。新寫只接受共用 number 控制項的有限 number，維持小時1/60..1000與原 raw=hours*60、Math.round、abs(raw-rounded)<=1e-7、rounded1..60000 規則；不擅改容差、不發明積分。空值、0、超界、不能換成整數分鐘的1.001小時拒絕；1.25→75、2.5→150及容差內結果保持。省略的是 trainingMinutes，payload 不送 trainingHours／intent。

name 明確新寫沿原 normalizePersonnelPayload.trim()，正規化後非空且最多500 UTF-16字元；未改名稱不 trim。provider 不 trim、最多500，note 不 trim、最多10000；LF textarea 可無損預填、CR 原文在 DOM 外保持。只驗新送欄位，不把未改 optional 型別清成空字串；所有 typed/null／未知 category／非法分鐘等非正常 API 資料，測試須明示記憶體匯入，不能聲稱由正常 API 寫入。

新增／編輯沿唯一 openForm 的完整 identity/user/org/role/employee/hash/render isCurrent、AbortSignal、busy、dirty、native 焦點；取消／恢復沿 confirmAction 相同 guard、原按鈕名稱與後果。成功須 plain item、同 id/org、安全版本（新增1／編輯old+1）及八欄 own-presence／精確 JSON 投影吻合後才 toast／refresh；status-only 另七欄必保持。API trainingMinutes 錯誤沿原 alias 映射到 trainingHours。未知2xx／本文中斷／409／422／403／503保留輸入與 intent，POST 同 payload 同鍵、PATCH 原 CAS；真已提交後 Abort 不宣稱回滾。

只有 admin/supervisor 維護；caregiver 沿原 active auth link 只讀本人目前資料／逐版歷程／訓練報表，finance 原403，不新增導覽或寫權。停用員工由可維護角色保持可讀。完整版本歷程、目前員工名稱及精確前版缺口、搜尋／分類／狀態／25筆分頁保持。

僅窄修訓練列表兩處既有投影：分鐘只對 safe integer1..60000 顯示小時／分鐘，異常值顯示固定未取得符號，不 Number() coercion；分類標籤只查 own 已知碼，未知字串字面顯示，missing/null/非文字用固定未提供提示，不讀 __proto__/constructor 原型。證照安全 editor/status、附件 owner、其他列表與共用 ui/styles/token、19後端均保持；不清理未修改的舊 fallback 路徑或新增 controller。

驗收含純 helper／原算術全範圍、真 HTTP 省略／取代／可空／原 merged422／0000／固定歸屬409／CAS／POST鍵／四角色及完整回應矩陣；真 UI 新增→督導修改→取消→恢復、1/7/61/75/150/60000分鐘與容差／清空／缺父項／typed private keep、28版25+3、目前名稱與原分鐘、原訓練報表及證照 sibling。loaded/pending edit/status六context共24與兩真先提交晚回應分列；dirty/native鍵盤／busy／1440及390px長備註真正末段逐圖檢視。

十一表唯讀／必要寫入分段完整對帳，既有雙非空合成 BLOB 精確下載、六不可變 trigger、核閱費薪快照及31報表出口保持；訓練沒有附件面板，不新建附件。0新PDF／marker，七既有 artifact72指定參照檔可沿舊script程式檢查／同artifact修訂，不宣稱新增人工舊PDF頁驗收。29既有browser414個聚合gates沿0.29封存版本，collector須正確辨識兩舊安全切片的new-browser-work，禁止自動重跑或偽造run；證照附件已知偶發失敗原因仍未確認，若再發生保留真失敗、分別診斷及必要正式重跑。

本輪基準為0.29的176來源、23 prior proof及9244已存copy計數，不覆寫舊封存、不重掃全部舊內容；新來源與證據逐份封存核 SHA。實際4310／PID83631／DB保持不重啟、seed或寫入；原180目錄列／16模板359題／四來源／九階段／12待核契約／0原completed／localReportKinds9保持，只完成獨立 localMilestone。原生 OS popup 幾何與headless鍵盤選值、人工UAT及正式規則不因本輪驗證而宣稱完成。
