# 週期排班切片（0.6）

本輪為獨立本機、合成資料契約。RM-03與原排班等價仍partial；未知月額度、支付、資格連動、假日規則、代班/差勤/列印與原週期欄位映射不在本輪推定。使用既有shifts，不新增自動常駐排程或永久週期規則；一次預覽並建立指定區間內班次，之後維持逐班既有調整/取消。

## 定義與日期

request definition只有caseId,employeeId,carePlanId,startDate,endDate,intervalWeeks,weekdays,startTime,endTime,services,note。前三個識別必填且為字串；日期嚴格有效YYYY-MM-DD、區間含兩端，最多93個日曆日。intervalWeeks預設1，整數1至4；weekdays必填、不重複非空整數陣列1..7（週一..週日）。同一日期最多一班；無符合日期回422。HH:mm為同日有效時間，endTime晚於startTime，不接受跨夜或時間戳。services沿既有1..100個同機構項目/整數數量1..10000與計畫規則；note選填trim、最多10000字。拒絕status、client dates/items/ready判定、batchId等未知欄位。

以startDate所在週的週一為第1週，週一至日為同一週；只選week offset % intervalWeeks===0的週內指定星期，並限制於起訖日期。UTC純日曆運算，顯示zh-TW/Asia-Taipei日期；不依主機DST或自動跳過假日。intervalWeeks=2不等同從任意起日每14天。輸出日期遞增；weekdays正規化排序，不改變輸入服務數量。

## API與原子性

POST /api/recurring-shifts/preview與POST /api/recurring-shifts/commit：同一definition。只有admin/supervisor，Origin/CSRF及角色驗證在body前；128 KiB上限不改。finance/caregiver兩端403，跨機構FK不通過，機構僅來自membership。preview忽略Idempotency-Key、不寫records/versions/audit/idempotency，不以insert+rollback模擬預覽。

preview回200 {definition,items,total,readyCount,conflictCount,canCommit}。items逐日期為{date,startTime,endTime,status:ready|conflict,conflicts:[{code,message,fields?}]}；每日期只列首先遇到的既有驗證問題，不暴露衝突班次他人識別或資料。固定產生scheduled shift；沿validate(db,ctx,'shifts',candidate)核對同機構FK、active個案/員工/服務、有效計畫日期與服務、員工/個案重疊及approved請假。canCommit只在total>0且0conflict。

commit要求Idempotency-Key，缺少422 IDEMPOTENCY_REQUIRED。沿既有idem→BEGIN IMMEDIATE，在交易內重新展開/validate所有日期，不能信任先前預覽；任何問題409 BATCH_CONFLICT，error.details.preview為新的上述preview，整批零寫入。全通過後逐班再次validate/insert+version1+record.create audit，任一儲存失敗整批rollback；idempotency回應與所有班次/歷程/audit同交易。成功201 {batchId,items,total}；每個item為既有publicRecord(shift)，audit detail含精確version=1、operation=recurring-shifts及同batchId供追溯。batchId僅批次回應/audit，不新增可任意寫入的shift欄位，不改原個案/計畫/員工或核閱價格快照。

成功同鍵/同body重送先回原結果，不因自己已建立班次而重新衝突；同鍵不同body409 IDEMPOTENCY_CONFLICT，失敗不留key。預覽後新增重疊班次、核准請假、停用個案/員工/服務、變更計畫均在commit重新驗證。GET/list/history仍沿原shifts角色範圍。共用api新增error.details以保留批次衝突內容，不把內部exception細節顯示到產品。

## 共用表單與UI

班表/shifts中新增「週期排班」入口，admin/supervisor可見，不新增頁面或擴張其他角色。UI沿既有「個案與照顧計畫」合併select，由已授權plan取得caseId；員工只列active，計畫只列active且case active，服務選項只列plan允許且active項目。換計畫清空services；任何欄位修改立即使預覽失效。

root擴充ui.js canonical checkbox-group：options(value可為number)回checked原值陣列、setValue、至少一項驗證、整組ARIA及每個native checkbox的label/44px鍵盤可操作範圍；不由模組另造表單。

createForm/openForm增加onPreview(values,{signal})→{content:DOMNode,canSubmit:boolean}與previewLabel（本模組「預覽排班」）。onPreview與submit共用欄位驗證；有onPreview時commit初始disabled，只有當前輸入已確認且canSubmit=true才開放。預覽內容在form內、預覽中明示讀取；輸入改變中止並忽略舊預覽，保持dirty，不關閉。preview可取消（純讀）；mutation busy停用所有輸入與預覽/建立按鈕，Escape/取消不關閉，失敗先恢復控制項再聚焦錯誤欄位；dirty取消先確認且原焦點返回。e.invalidatePreview=true令提交衝突取消可提交狀態；一般網路/確認失敗保留相同預覽及POST key，允許同body重試。

週期欄位label：開始日期、結束日期、每隔幾週、服務星期（週一..週日）、開始時間、結束時間、本次服務與數量、交班備註；明示週一起算及93日界限。預覽摘要日期總數/可建立/有衝突，逐日卡片含日期、星期、時段、可建立/衝突原因，桌機兩欄、手機單欄；不把輸入存URL/localStorage。零衝突提交label「建立全部班次」；有衝突不提供跳過建立。BATCH_CONFLICT保留輸入與更新的日期衝突預覽，重新預覽才可提交。

模組capture user/org/role/hash及renderVersion/連線DOM isCurrent；預覽前後/提交前後guard，切機構或頁面晚回應不覆蓋或toast。POST commit每表單固定key；成功必須確認batchId、items與total，items日期/關聯與預覽相同且version有效，body中斷/缺確認保留輸入+key，不能只以201關表單。成功重讀班表並toast實際建立筆數。讀取錯誤、重試、取消與真409均沿canonical。

## 驗收

Node整合：週一anchor、1/2/4週及跨月/年/閏日、含兩端、無日期/重複星期/非法日期/93日邊界/時間/未知fields、所有現有衝突與角色/CSRF、preview total_changes全零、全部成功history/audit、commit真race重驗無部分寫入、強制第二筆INSERT失敗完整rollback、重送/不同body、持久化臨時DB重開及核閱價格快照不改。

真瀏覽器：日期/服務真保存、修改任何語義欄位預覽失效、checkbox鍵盤/label/錯誤focus、全批提交與成功丟回應/JSONbody錯誤同key恢復、預覽後真班次衝突及計畫失效重驗、503/慢preview/切案機構/取消無過時回應、權限與取消零寫入、1440/390逐圖檢視。完成整合與所有必要browser/既有回歸後才標此獨立切片implemented_verified；原RM-03維持partial。
