# 已保存人工帳單／薪資輸出介面（v073 本機完成）

本切片在原「人工帳單詳情與收款」及「人工薪資結算明細」增加兩個一般操作按鈕：「匯出保存明細 CSV」、「列印保存明細」。輸出目前版次的保存單據及建立時快照，沿原 admin／finance 與同機構父案／員工權限。原核閱服務試算、付款、來源 origin、帳單開立／收款、薪資加減／覆核／關帳都不由輸出重算或改寫。不是正式發票、申報、扣繳憑單、薪資演算法或付款功能。

業務依據為 docs/API.md 的人工收費／薪資章節、既有 owner，及 outputs/software/v073-saved-financial-output-candidates/CONTRACT.md。APM 外框、字體、暖白／橘色、44px操作與手機表內捲動沿 DESIGN.md／UX-CONTRACT.md；沒有新 CSS／token／字型或第二套 dialog／焦點／控制器。

## 唯一介面所有者

| 能力 | 所有者 | 本切片用途 |
|---|---|---|
| 現有帳單與薪資詳情 | billing-documents.js／payroll-statements.js | fresh 一般詳情 load 成功後注入薄 action group |
| API、下載、對話框、列印、回焦、取消 | public/ui.js | api／downloadCsv／openDetails guardedRead+printable |
| 封閉回應確認及精確顯示 | public/data/financial-output-editor.js | descriptor 先驗證全部可達值，再複製／原 owner 合計驗證 |
| 保存輸出薄 adapter | public/modules/financial-outputs.js | 精確 id/org/version、完整 context、signal／trigger 連接守門 |

每次 CSV 先 fresh JSON 確認 exact closed envelope，再 shared CSV GET；CSV server 再驗相同精確版次，沒有自動接受更新版次。CSV只有完整成功回應才能建 blob。CSV公式轉義會在輸出加安全文字前綴；按鈕旁明示原文與列印不變，沒有修改原保存紀錄。

列印按鈕開 shared guardedRead printable details；預覽 fresh GET，shared「列印／另存 PDF」再 fresh GET 一次，完整 closed ACK／同版本／目前授權成功才呼叫原生 print。使用者直接瀏覽器 beforeprint 沿原共享 suppression，不能輸出未重新授權內容。取消／Escape／原詳情失效／hash／user/org/role/employee或outer context失效即 abort，晚回應不能復活。失敗只沿 shared errorState 手動重讀；錯誤或不可信2xx不保留前次已讀明細，也不新增自動 retry／私有 HTML。

## 原文及完整性

JSON envelope exact5，record exact14，snapshot exact3，summary帳單1欄／薪資3欄。全部 own enumerable data descriptors；陌生key、symbol、非enumerable、accessor、稀疏或附加 array key 先拒絕，零 getter。ISO24保存時間、時序、canonical月份、ID與機構／父項／版本、合法金額及合計逐項確認。organization及snapshot文字沿 server上限500，原空白／CRLF／HTML-looking文字無損保存；labels與number保留各原owner合法差異，不將薪資合法多行套帳單限制。

一般輸出顯示標題、目前授權機構、保存機構與父識別、編號／月份／狀態／版次、建立時姓名與案號／員編、識別／建立與更新時間、完整1至100明細、保存合計、人工依據／備註及限制文字。明細金額以整數分 BigInt精確格式化為元兩位，不使用浮點或現在價目。帳單僅顯保存數量／單價及文件保存總額，不發明未保存的每行總額。長依據與備註使用既有 field-wide／pre-wrap，最後文字與關閉／列印按鈕可實際捲動到。

完整 JSON／CSV 2MiB 守門。合法100行各重複10000字備註可能CSV413，此時可完整列印；不能刪行、刪備註、改保存值或下載部分内容來假稱成功。

## 無損路徑

JSON `/api/financial-outputs/:kind/id-${encodeURIComponent(id)}?version=N`；CSV再接 `/export.csv`。固定prefix避免 `.／..` dot-segment正規化；單独encodedsegment解析支持 x.csv／slash／問號／hash／literalpercent／中文／backslash／NUL及500字原ID。Root以 canonical raw namespace的 url.pathname 擷取再單獨decode，其他原路由guard不變；不限制generated UUID，不把來源entity混入路由。

## 候選驗收與實際界線

14項 pure 实际 native exit0，pure-r08.log：closed原文／身份与metadata、所有可達 getter0、100行、合計不一致拒絕、精確1分／大額、500字全原文、原薪資合法多行、reference边界、路徑 x.csv／slash／點段／backslash／NUL無損。旧 pure-r01至r07及r02原五檔、改路由前四檔均保留。

真瀏覽器 tests/financial-outputs-e2e.mjs 接線後r02原生exit0，11組 gate通過：原一般owner兩種CSV與freshprint；直接beforeprint suppression；完整100行10000字、多頁PDF首末文字及全部明細；1440／375／390局部捲動與最後文字Range／footer；exactversion409（含已載列印後更新）；不可信2xx不出blob／內容及手動重讀；目前finance操作；真memory membership撤回後fresh403；supervisor／caregiver入口与API守門；晚JSON／CSV／print真abort；主檔改名／時薪不改保存快照。全程 memory SQLite／randomloopback，各零寫段比較所有表及 total_changes。

PDF只以實際 shared print的fresh-authorized beforeprint事件內DOM捕捉再另靜態page套同CSS產生 QA PDF。pypdf核全部行與首末文字／頁數，Poppler渲染首末頁PNG供真像素查看；不使用page.pdf去繞過產品beforeprint守門，不宣稱OS原生列印對話框自動化。每次 unique attempt保存 trace／SHA／CSV／DOM／PDF／PNG／失敗，執行前後 runtime精確SHA需一致。圖片和PDF未實看不能標視覺通過；尚未正式發布或真帳號UAT。

## 實際本機接受

本機合成驗收完成：1,833項程式測試、446份JavaScript、9套必要瀏覽器95項操作；42頁四角色168組合、440個版面與六寬度。579來源最終SHA一致，185登錄runtime中184實存，原缺失保持。作者11組輸出流程與38張圖、整合者8張圖分別實看，100明細／10000字完整列印PDF各11頁，首末及全行文字核對。十一表零寫及原備份還原通過，無新schema。原SQL NUL讀取失敗、browser捲動owner selector失敗與root初次freeze actual1保留；兩精確e2e-only selector修正後原斷言及完整source／visual重驗通過。共用設計來源未變，沿零error／10既有warning、私人parser零finding；官方audit逾時124不當通過。85 configured／84 required未全部fresh。證據outputs/software/financial-output-completion-qa/verification-v073.json。 作者38張逐張實看，整合者8張另歸屬；原r01錯把非scroll wrapper當scroll owner actual1保留。僅測試兩精確selector改為實際共享dialog，沒有修改runtime／刪減Range與footer斷言／放寬timeout。最終17來源凍結、零pageErrors／nativeDialogs，十一表／total_changes輸出零寫。普通兩PDF各2頁，長文兩PDF各11頁，全部100明細與首末marker文字核對。上述後續收據取代候選階段未驗收說明，非正式發布或真帳號UAT。
