# 保存帳單與薪資的完整列印／CSV

版本0.73，已完成本機正式程式接線後合成驗收（accepted_local）。沿既有人工帳單／薪資明細入口提供「匯出保存明細CSV」與「列印保存明細」，不另造財務状态或平行print owner。每次輸出重新取得同機構、同一識別及所點保存版次的完整單據；版本改變、目前會員撤回或父紀錄不可讀時整份拒絕。建立時姓名／編號、全部100筆明細、保存合計、原文依據／備註及明確本機紀錄說明完整保留，不以目前價格／姓名／來源回算。

JSON與print保存文字完全相同；CSV安全文字處理可能被試算表當公式的原文，UTF8 BOM／CRLF／quoted欄、原分值及完整保存總額。所有輸出完整2MiB上限，全有或全拒絕；合法100筆與長備註若CSV重複欄超限，仍可完整列印，不省略欄。列印沿共享 guardedRead 再次讀取；任意beforeprint不能繞過授權，輸出與晚回應隨captured context／原父觸發生命週期失效取消。

新GET入口/api/financial-outputs/:kind/id-${encodeURIComponent(id)}?version=N，CSV後接/export.csv。canonical raw namespace才用單一encodedsegment，decode一次；不把點段、slash、.csv、backslash/NUL保存識別誤拆成路徑。其他API及static全維持原NUL/backslash與path guard。target/currenthead識別以SQL BLOB＋fatal UTF8無損核對本次bind，normalTEXT ID與NUL讀取都核對完整不可變snapshot；沒有改寫SQL、補歷史或降低角色守門。異常UTF8／unsafeSQLversion／污染metadata與缺head閉鎖零寫。CSV filename只用hash與安全版次，不把原text放headers。

合成memory／随机loopback驗收包括普通兩頁入口／下載／freshprint、100行10000字首尾及多頁PDF文字、拒409／壞ACK no blob／真會員撤回403、晚JSON及CSV撤銷、四角色、桌機與375/390、全部原金融／服務生成／APM／合成HTTPS Portal、sourcefreeze与read-side十一表零寫。PDF是實際fresh授權rendered DOM的靜態PDF重現，不宣稱native OS列印對話框或正式憑證。最後收據outputs/software/financial-output-completion-qa/verification-v073.json已accepted_local。

背景排程仍停止，原完整catalog／失敗／已接受來源保留。正式稅務發票、正式工資／核銷規則、主機／HTTPS／Portal發布及真實UAT仍另驗；不讀私人DB／秘密／真帳號、不送訊息／申報／付款、不改DNS／購買主機／正式部署或推送Git。

## 實際驗收收據

本機合成驗收完成：1,833項程式測試、446份JavaScript、9套必要瀏覽器95項操作；42頁四角色168組合、440個版面與六寬度。579來源最終SHA一致，185登錄runtime中184實存，原缺失保持。作者11組輸出流程與38張圖、整合者8張圖分別實看，100明細／10000字完整列印PDF各11頁，首末及全行文字核對。十一表零寫及原備份還原通過，無新schema。原SQL NUL讀取失敗、browser捲動owner selector失敗與root初次freeze actual1保留；兩精確e2e-only selector修正後原斷言及完整source／visual重驗通過。共用設計來源未變，沿零error／10既有warning、私人parser零finding；官方audit逾時124不當通過。85 configured／84 required未全部fresh。證據outputs/software/financial-output-completion-qa/verification-v073.json。

CSV完整超限413沒有blob，JSON／列印完整獨立驗證；PDF來自實際fresh-authorized beforeprint DOM再靜態重現，不宣稱OS原生popup自動化。原雙標題／普通末頁留白及窄欄長文密度保留為非阻擋版面限制。
