# 保存帳單／人工薪資明細輸出（本機完成）

本切片輸出已保存 billing-documents／payroll-statements 的目前人工單據與版次，不使用核阅服務trial報表、現在價目／時薪或來源origin重新計價；不宣稱正式發票、扣繳／薪資憑單、申報或付款。

角色沿原owner，仅目前同機構admin／finance。每次輸出重新驗證membership、同機構父案／員工及其目前immutable head，當前單據SQL身份、安全版次、原JSON与不可改寫版本完全一致。version必填canonical正整數；版本變更409要求重新讀取，異機構／缺父不可見404，保存污染409，沒有略過或修補。

JSON有closed原14欄單據、目前機構名稱與限制文字。snapshot姓名／案號／員編及明細／依據／備註原文、CRLF／前後空白保持。BigInt只驗證保存summary一致性，失敗拒絕，不修補總額。草稿／覆核／關帳／取消與帳單開立／作廢按原保存狀態輸出，不暗示義務完成或付款。

CSV逐筆完整明細順序、整數分字串，BOM／CRLF／全欄引號及quote escaping。公式／TAB／CR／LF／前置空白危險文字輸出加單引號，明示只是表示法安全轉義，不改保存JSON或print原文。filename使用kind、ID的固定SHA前20hex與version，不用原文編號注入header。Billing CSV每行重複保存的文件總額，欄名明確，不發明未保存per-line金融金額。Payroll包含原加項／減項與保存加减／淨額。

全部JSON／CSV完整回應2MiB，超限413不截斷。合法長備註重複100行可能令CSV超限，仍可完整JSON列印；不刪備註、減行或改原資料以繞過。所有讀取／輸出為零寫入，不新增schema、版本、audit／idem或外送。

候選server／parser／CSV已完成，12項memory SQL／pure測試實際通過、native exit0（unit-r05.log）。測保存1分與大額精確分、master改名／改价不回算、四角色／撤權／跨機構、canonicalquery、SQL/JSON/head污染与缺父、版本競態、0 getter／closed nested、formula原文與完整CSV cap，所有保存表零變。

正式接線後9項真HTTP actual exit0，35項focused（12 SQL／pure、9HTTP、14editor）通過；普通兩owner、fresh guarded print及完整PDF／像素驗收已通過。第一批只輸出目前版次，不提供歷史版／正式格式／bulk全月ledger。

本批路由使用固定 id- transport prefix及獨立 /export.csv，raw pathname擷取後單獨decode，保留合法500字ref／x.csv／slash／.／..／backslash／NUL的語意。僅此canonical raw namespace進入新財務角色／method守門；其他所有路由的NUL／backslash400保持。第9HTTP包含完整legacy識別與兩domain SQLhead、unsafe method roles、舊namespace及GET全表／total_changes零寫，實際HTTP通過。r01四檔READY／契約／接線／規劃原件在 preserved-r01 封存。

Node SQLite TEXT讀取含NUL識別會截斷，原unit-r04原生1保留。新唯讀head用CAST(id AS BLOB)與CAST(record_id AS BLOB)，fatal UTF8且ignoreBOM:true，再與本次SQL bind逐字核對及原immutable snapshot核對；無損讀取不足409，不修資料。新增12th回歸覆蓋current/head畸形UTF8與不同bytes零寫。這只保留既有識別的唯讀相容性，不宣稱可新增／修改NUL單據，仍沿本機generated UUID。

本機合成驗收完成：1,833項程式測試、446份JavaScript、9套必要瀏覽器95項操作；42頁四角色168組合、440個版面與六寬度。579來源最終SHA一致，185登錄runtime中184實存，原缺失保持。作者11組輸出流程與38張圖、整合者8張圖分別實看，100明細／10000字完整列印PDF各11頁，首末及全行文字核對。十一表零寫及原備份還原通過，無新schema。原SQL NUL讀取失敗、browser捲動owner selector失敗與root初次freeze actual1保留；兩精確e2e-only selector修正後原斷言及完整source／visual重驗通過。共用設計來源未變，沿零error／10既有warning、私人parser零finding；官方audit逾時124不當通過。85 configured／84 required未全部fresh。證據outputs/software/financial-output-completion-qa/verification-v073.json。
