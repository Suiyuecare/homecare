# v0.70 人工代班申請／審核（候選，尚未正式整合）

本切片提供尚未執行班次的申請原因、人工核准／拒絕、保存歷程及核准後的一次原子改派。不處理跨夜、移日期、服務後改派、薪資、定位、簽到、請假額度或正式部署，也不代表原180項完整對等。v0.69與更早正式來源保持凍結；本輪所有自有修改只在 outputs/software/v070-substitution-candidates。

## 封閉模型及狀態

新 entity `shift-substitution-requests`，十四業務欄：shiftId、shiftVersion、shiftSnapshot、employeeId、requesterUserId、reason、note、status、reviewedOn、reviewReason、reviewerUserId、replacementEmployeeId、replacementShiftVersion、replacementShiftSnapshot。metadata恰 id/orgId/version/createdAt/updatedAt，版次為正安全整數；四衍生數字／快照在spec.jsonFields內，其餘為文字，reason/note/reviewReason各10000字。建立只能送shiftId／目前shiftVersion／reason／optional note，不接受客戶端身分、原員工、狀態或任何snapshot注入。

原班snapshot與核准後snapshot均為 exact七個已知scalar：id/orgId/version/employeeId/date/startTime/endTime，不保存caseId、個案姓名、照顧計畫、服務內容、任何BLOB或未知巢狀欄。Gregorian日期0001至9999與同日HH:mm精確驗證；跨夜或datetime文字不在此切片。

建立即submitted，原申請內容不再編輯。核准→approved，拒絕→rejected，兩者均終態；不提供PATCH／DELETE／再次審核，若要改申請內容須另提新record。相同班次只能有一件submitted，已核准／拒絕的舊件留存。核准凍結原版與唯一下一版改派快照，原申請原因、附註、固定原員工與申請者保持。

## 角色及來源

admin／supervisor可提出並人工審核；caregiver只能提出目前由自己負責、scheduled且無任何服務紀錄的班次，並只能讀「原固定employeeId＋自己requesterUserId」雙綁定申請／每個歷程。不同帳號即便連同員工也不能讀另一人的申請；核准後舊申請人仍可讀保存結果，新代班員工不能因此取得原原因／附註。finance讀寫皆403，review-preview／review只限admin／supervisor，先授權再解析body／query；居服員不能自核，也不擴大同事名單查詢權。代班員工由主管審核表單選取。

原員工同機構parent有效；本人讀取另須原員工使用中。歷史資料不依live shift歸屬，合法後續改派不讓原申請消失。名稱僅來自當次有權serverDTO；保存userId只呈識別碼，原共用audit/history解析操作者目前名稱，不捏造歷史姓名。本人不讀替代員工DTO；其保存識別碼可見並不表示有同事名單權。

## 核准交易與拒絕

核准raw payload必須exact `{version,decision:'approve',shiftVersion,replacementEmployeeId,reviewedOn,reviewReason}`，原request目前版與原班次版需一致，shift仍scheduled、original七scalar完全相符且沒有任何服務紀錄。代班人須同機構使用中且不同原人。沿原 shifts validatePayload/writeGuard/validate 完整驗證保留的business內容，包括有效個案／計畫／服務、既有員工或個案重疊、核准請假及永久週期的原case/date不可變守門。未知／壞JSON／null／unsafe SQLversion衝突來源拒絕，不略過或修復。

review-preview以同樣完整prepare驗證，只返回原申請及before/after七scalar，沒有record、audit、idem、token、暫存或其他SQL寫入。review不能相信已預覽結果，必須在現有idem／BEGIN IMMEDIATE交易重新prepare，再保存shift、request、兩方不可變record_versions及兩個有實際操作者和版次／原因的audit。第二次保存或最末audit故障必須回滾全部committed rows；同一冪等鍵可在故障回滾後合法重試，成功重播不能再次改派。

拒絕raw payloadexact `{version,decision:'reject',reviewedOn,reviewReason}`，不接受shiftVersion、替代員工或snapshot欄。只鎖定目前待審request版次／固定原員工與本次日期原因，不讀寫當前班次；因此可人工終結已被其他合法操作改變的過期申請，避免永遠pending。不改原理由、任何班次、服務或計價快照。此安排沿本切片確認方向，沒有新增雙人審核或法定時限假設。

## UI與驗收界限

`#/shift-substitution` h1「人工代班申請」，使用APM與既有ui.js普通下拉／日期／長文表單、明確預覽、nested確認框、清單／詳情／typed歷程。查詢年度／日期以精確文字，不透過native date轉換filter邊界。查詢草稿變動立即撤除結果與操作入口；完整user/org/role/employee/context-reference/hash/connection失效會撤除並中止read／preview／save。取消保留輸入；未成功ACK不關閉；POST及review重送鍵依相同操作／payload／dialog-owner保持。沒有新CSS、外部popup、列印或CSV。

候選dependency-injected真model memory測試14項全通過，最新單獨命令actual exit0見 unit-run-03.log。包含已服務來源any status、合法核准後本人／替代者讀取界限、停止計畫、unsafe SQLversion／壞JSON／null、最末audit故障回滾與同key重試、普通editor／ACK。第一份10項通過保留；第二份13/14舊失敗保留（fixture state reader原未開BigInt，追加unsafeSQL負例時fixture自身拋RangeError）；只修測試reader，未放寬runtime／權限／來源守門。UI module語法檢查actual exit0。

已由root接線並完成14項pure／injected及6項真HTTP共20項actual exit0。普通表單真Chromium主套12項通過，另外12項同流程補充截圖驗證獨立歸屬，不重複灌入主套功能數；桌機及375／390px共25張由作者實際像素檢視。original／replacement各七欄typed快照、本人原申請界限、preview零寫／原子競爭、CAS與冪等、身分失效均受檢。精確SHA与author receipt見outputs/software/shift-substitution-qa/owned-source-freeze.json；整體本機接受以outputs/software/internal-workflows-completion-qa/verification-v070.json為準。

原候選、缺key fixture、過期計畫fixture與所有失敗保持，不放寬runtime守門。來源只用合成memory／隨機loopback，不讀.env、私人DB、4310、原平台或真實個資。這是人工同日代班，不宣稱跨夜、正式規則／上線或原180對等。
