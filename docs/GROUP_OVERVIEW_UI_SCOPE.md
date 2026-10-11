# 群組營運總覽介面

本機整合驗收已完成：outputs/software/full-system-completion-qa/verification-v077.json。下列候選階段紀錄保留原時間與驗收界限，最新完成狀態以整合收據為準；沒有正式發布、真實營運UAT或原平台全量對等。

這個切片使用登入帳號目前已具有的管理者機構授權。使用者從原生勾選表單明確選取一至十個機構及基準日，查看八項紀錄合計、每機構筆數及每機構完整七日開始日趨勢。沒有預先勾選、email 推導開通、機構切換、跨機構人員去重或新角色。

數字是目前保存狀態的紀錄筆數，不是歷史截至日報表。當日開始班次排除取消；目前待核閱是所有目前 submitted 紀錄；基準月已核閱依服務開始日歸屬，不拆跨夜工時、不推正式財務金額。

每機構八個數字可追查。每頁固定25筆，返回已知紀錄識別、版次、保存狀態和日期；姓名／案號／員編只在個案和員工指標出現。明細與翻頁固定原完整來源 fingerprint 和原總筆數。來源或機構名稱變更的409會清除舊明細並提供明確「來源已變更，重新載入總覽」，不混用舊合計與新紀錄。

下載及列印的按鈕明示重新讀取目前總覽。同一機構選取及日期，每次都重新確認全部機構的當下授權與目前來源，数值可能較舊畫面更新。CSV完整包含19欄、notice、total、每機構summary及每機構七日trend，不捨棄後段。危險字首用安全文字表示，保存資料不改。列印沿 shared fresh guarded owner；只有重新讀取成功的完整已授權內容可以送到本機列印。原生直接 beforeprint 仍被抑制。不是正式報表、歷史快照、付款、申報或平台全量對等宣稱。

介面沿既有 APM CIS。原生表單、checkbox-group、日期、stat、table-scroll、分頁、details、下載和列印均重用 ui.js；没有新 CSS、色彩、字型、dialog、focus 或 AbortController。頂層 /group-overview 是管理者入口；共享 app/admin 接線由 root 負責。完整 context 物件及 user/org/role/employee 身分、原hash、頁面／控制項生命週期與查詢 generation 都會阻擋過期輸出。使用者改條件即移除先前結果及輸出動作；關閉／導航／撤權／壞ACK不可帶出晚回應、舊表格、blob或列印。

候選驗收使用完整 output-only server/public 支持副本、真正 HTTP、memory DB、隨機 loopback；support 副本不發布。純測試涵蓋 closed data descriptors、getter零執行、dense arrays、完整指標及趨勢、來源身分、數值總和、25分頁與0001跨至0000七日趨勢。真瀏覽器驗收涵蓋普通操作、完整CSV與80行列印、375/390、25分頁、來源更新409、真membership撤除、四角色及晚回應Abort。證據和原失敗保存在 outputs/software/group-overview-qa 與候選驗收logs；實際頁面像素和列印PDF首末頁需逐圖檢視才可接受。

静態 PDF 僅由真 shared beforeprint 當下 fresh 已授權 DOM 使用既有CSS輸出，確認完整文字及多頁首末頁；不冒稱自動操控原生作業系統列印視窗。候選通過不代表正式部署、正式企業權限或使用者驗收。
