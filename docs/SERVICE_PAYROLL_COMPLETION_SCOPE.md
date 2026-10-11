# 核閱服務轉人工薪資結算

版本0.72，已完成本機程式整合與合成驗收（accepted_local）。來源及薪資人工金額、不可變生成依據與現有加扣項／覆核／關帳是本批完整工作流；正式自動工資、保險／稅／加班、付款及原平台對等另需核定。

管理者及財務指定目前同機構員工與月份，可從多個同機構個案選取1至100筆已核閱服務。每完整服務手動輸入一筆加項金額及人工核定依據，不能按當前或原試算時薪預填／換算。來源完整保存十二欄及原多服務／價格／數量／姓名／分鐘快照。建立薪資時現在員工姓名與員編另存建立時快照，不冒充核閱來源姓名。清單個案參考姓名如有顯示，明示其取自讀取範圍时的目前主檔。

來源清單、選取、原文依據、零寫預覽及二次確認後原子生成薪資草稿。每行明確非負整數分，明細名稱100字、共同依據500字、逐筆依據2000字、備註10000字；原文CRLF與首尾保存。新薪資、固定生成來源、版本、稽核及重送鍵全有全無。後續加減項、覆核、關帳、取消及型別化歷程沿原人工薪資頁。生成初版加項／淨額、目前加減項／淨額及原核閱試算分列。

來源從薪資草稿起即在薪資領域占用，取消不釋放。同一核閱服務可各產生一次帳單及一次薪資，兩領域識別與人工金額獨立，不取帳單生成金額推算薪資，也不因帳單占用而排除薪資來源。內部payroll-service-origins沿既有records／record_versions保存，不開generic CRUD，不增schema。

API是GET /api/service-payroll/sources、POST /preview、POST /create、GET /origins及GET /origins/:statementId。列表只接受employeeId/month/page/pageSize/q；single與mutation無query。create需previewHash及Idempotency-Key。兩POST專屬1MiB，所有完整來源／生成／cached ACK／追溯DTO2MiB，超限全拒、不截斷或部分寫入。每次讀寫均查目前角色／會員與同機構父案／員工／完成班次，SQL安全版次、不可改寫head及closed known nested shape；快取查找前重驗fresh身份、源版本與本次原預覽，回應再核對固定origin及初版statement。

合成memory或自有隔離DB／隨機loopback驗收：跨案相同員工、獨立帳單／薪資占用、真加扣項／覆核／關帳、零寫預覽、CAS／重送／競爭／污染／完整上限回滾、原文、角色撤權／跨機構、late ACK、桌機與375/390、受影響全路由及APM/HTTPS合成Portal回歸、十一表六trigger備份／還原／失敗切回。完成前不標accepted_local；最終證據outputs/software/service-payroll-completion-qa/verification-v072.json。

背景排程保持停止；不讀私人DB、秘密、真實binding或備份，不修改DNS、不推整批公開倉庫、不購買或正式部署、不發送外部訊息或付款／申報。原180項及12正式契約狀態保持，正式規則／原模板報表／完整移轉／真實營運UAT及主機HTTPS/Portal發布另驗。

## 實際驗收收據

合成隔離驗收完成：1,798項程式測試、439份JavaScript、8套必要瀏覽器84項操作；42頁四角色168組合、440個版面檢查與六寬度通過。569來源最終SHA前後一致，182登錄runtime中181實存，原缺失路徑保持。整合者實看6張新圖、作者33張另歸屬。十一表六trigger備份／還原／失敗切回通過，無新schema。原pure／selector失敗、真薪資明細visible-disabled缺陷與root初次freeze actual1皆保留；窄修原owner後原9流程及必要unit／source／財務／全路由重驗通過。沿相同設計來源零error／10既有warning，私人parser零finding，官方audit原逾時actual124不当通過。84 configured／83 required未全fresh。證據：outputs/software/service-payroll-completion-qa/verification-v072.json。

原ordinary薪資owner透過共用helpers.setHidden同步明細可見性，修正新增rowCount明細已顯示卻disabled的真操作缺陷；未使用forcefill、縮減原9流程或放寬timeout。生成初版260.03與後續人工扣1.01後259.02分開，原核閱試算200.01不當薪資。原首輪wrapper來源守門拒絕是e2e精確spinbutton selector amendment，仍保留actual1；修正owner後最終完整來源重新freeze及受影響檢查通過。
