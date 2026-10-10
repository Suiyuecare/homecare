# 評鑑填答版本歷程（0.20 獨立本機切片）

> 公開版本文件：記錄此功能版本的設計與驗收條件，並非目前公開副本已執行的驗收證明。私人盤點與 QA 產物未匯出；現行行為以 API.md 與原始碼為準，正式規則及部署仍須核定。

2026-10-08 凍結。assessment-history-v0.20，既有五欄保存填答唯讀歷程。16 模板的359個已觀察固定題項是目前展示目錄，不是歷史題目版本、權限規則、正式表單或臨床計分。必要整合、瀏覽器及逐張視覺驗證後才標本切片 implemented_verified。

## 讀取與歷史範圍

沿唯一 readHistory/current scopedRows(assessments)。admin/supervisor/finance 可讀目前同機構資料；caregiver 保持原403，不因可讀個案或公用模板取得評鑑權限。admin/supervisor 可維護、finance 唯讀且不新增評鑑導覽。不存在或其他機構／實體目前ID沿404；原 membership、active employee auth、publicRecord 遮罩保持。

目前紀錄授權後，raw與compare每個同org/entity/recordId保存版本的 snapshot.caseId 必須存在於目前 scopedRows(cases) 集合。歷史caseId不要求等於current，保留合法A→B→A；缺失／跨org／錯entity父項版本隱藏。當current父項不存在但原current仍可讀，較早合法父項版本可保留；不得偷偷改目前CRUD讀權或加入新current join。case狀態active/paused/closed不構成新歷程限制。templateId可合法更換，公用模板不是ACL，不按模板存在與否隱藏已授權版本。

GET /api/assessments/:id/history?compare=previous 加入既有 comparableEntities。精確version-1在授權後、分頁前比較，v1 initial、缺／隱藏前版 unavailable且previous兩欄null，不跳版。沿25/100分頁、28版25+3頁外前版及未知／重複compare拒422。actor僅既有精確org/entity/id/version的record.create/update實際user與目前姓名；缺失／歧義null，不採service.review/shift.complete/source/鄰版。

raw與comparison snapshots 維持原 publicRecord API 投影（原answers object值不改寫、不增分數／遮罩／序列化旁路）；新歷程畫面使用下述安全白名單。歷史授權適用raw與compare兩者。API/畫面不能被稱為原表或原欄位全部等價。

## 五欄及題項安全呈現

依序 caseId「個案」、templateId「模板」、date「填寫日期」、answers「保存填答」、status「儲存狀態」（draft草稿/submitted已提交）。關聯個案只用已授權cases Map；模板名稱與題名只用目前已載入的16模板Map，明示為目前目錄名稱，不推測當時名稱。保存ID可沿共用details展開；meta、fileId、billingSnapshot不在業務欄位展示。

每版以自身保存templateId選取題項，保留目前模板fields原順序及每個name（包含同名標籤的不同q序號）。只取answers自身已知題項name，不搜索／拼接／整包JSON呈現未知鍵。未知鍵只以一般提示說明未顯示，不顯示其鍵名或值。未知模板仍顯示合法版本及四個metadata欄，提示題項規格未核定、填答內容未顯示；不回退到第一模板。未知模板的答案值不出現在歷程DOM。

答案專屬純normalizer保留安全型別：題項未保存（own key缺失）、保存null、文字空字串、完整原文字（含空白／換行／字面提示標記）、有限數值（含0）與布林true/false各自區別。文字、數值及布林都有明示型別，不把"1"等同1、"false"等同false或空值等同0。沒有日期推算、選項解讀、分數／風險／資格換算。

answers容器缺失/null/空object/不支援顯示的scalar或array各有安全狀態；已知題項的array/object/非有限數字/其他不支援顯示型別以不同的無來源資料tag呈現，不展開、序列化或洩漏巢狀內容。array/object亦可能由正常API合法保存，安全展示不等同宣稱保存非法。合法文字「[欄位格式無法判讀]」和tag不可碰撞。缺失、null、空字串不可沿一般scalar合併；來源物件不得被修改。未知鍵或不支援值的隱藏內文變動不宣稱已比較。

同一已知templateId且精確前版可取得時，答案按同題項name與型別比較，只顯示有變動的已知題項及前後保存值；未知鍵變動不列業務差異。容器狀態變動可明示，無法判讀的內容不猜測。templateId更換時，只比較case/template/date/status等metadata，另外分開展示「原模板保存填答」與「新模板保存填答」，各用自己的模板題項；即使兩模板都有q001也不得把它們當同一題對照。未知模板或不可判讀容器提示比較限制。

## 共用介面與保留

只在既有admin/supervisor /assessments操作列加「版本歷程」，已知與未知模板都可開啟；原開啟紀錄或模板規格待補齊狀態保留。沿admin/listPage、history/openDetails的wide dialog、semantic table、25筆分頁、loading/empty/503 retry/Escape/focus及user/org/role/employee/hash/generation/render guard；不新增controller、CSS、runtime token、ui.js、lookup endpoint或導覽角色。

沿目前CRUD五欄、templateId/caseId合法更換、POST冪等、PATCH/CAS/CSRF、answers object≤50000與128KiB body等既有guard，不改提交狀態含義或偷偷限制原可保存unknown template/key/JSON值。原UI只編輯同模板；模板更換驗收用真API，不稱為新增UI功能。原編輯initial最後展開answers，未知保留鍵可能覆蓋caseId/date/status預設值的既有行為，本輪未修；新歷程不灌回表單、不編輯該類測資。只增加唯讀歷程，沒有還原、改題、評分、正式PDF／匯出或外部介接。

## 驗收條件

新Node整合驗證四真角色／跨org／current與逐版case授權／A→B→A／空與缺版／28版分頁／actor精確與歧義／publicRecord双snapshot／合法寫入與拒絕guard。純測覆蓋359題目目錄與五欄白名單、保存型別、未知模板/鍵/巢狀值不洩漏、同模板差異／換模板分開及來源不可變。既有測試與共用owner相容。

Chromium驗證真admin新增→supervisor修改→提交/返回草稿的原規則、case與模板合法更換、型別/長文/特殊文字安全顯示、精確actor/CAS、列表搜尋/狀態/分頁、四session且caregiver403、28版與缺版/缺名稱/未知模板、503 retry/Escape/焦點、1440與390px表格內捲。loaded/pending各hash/org/role/employee/render共十失效：清空、abort、關閉、晚回應不復活；client context fixture不得冒稱server membership撤權。

唯讀區間比對十一表raw/count/total_changes與六immutable trigger，真合成寫入批次另列；雙非空BLOB bytes/下載SHA、核閱計價/時薪快照及fees/payroll保持、現有25個報表出口相容。actual試用DB只唯讀前後核對，不seed/清除。此歷程不建立新PDF或新operation marker；必要既有報表驗證沿原artifact。

僅相關原評鑑頁追加獨立局部evidence，正式未核定契約保持pending。
