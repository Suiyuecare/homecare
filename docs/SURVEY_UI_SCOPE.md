# 本機匿名填答與 QR 介面候選

本機整合驗收已完成：outputs/software/full-system-completion-qa/verification-v077.json。下列候選階段紀錄保留原時間與驗收界限，最新完成狀態以整合收據為準；沒有正式發布、真實營運UAT或原平台全量對等。

此批是 output-only 接線候選，已在根節點權威來源的獨立合成副本完成介面驗收；正式來源整合與發布仍由根節點處理。沿原 APM CIS 共用 `ui.js`、原生表單／對話框／確認／清單／25 筆分頁與焦點、dirty、取消及 context 守門；沒有新增 controller、CSS、token 或其他樣式系統。後端及 QR 套件由另一工作包提供，無正式部署、外寄或真實個資。

管理者或督導在同機構選取目前已發布模板的精確 SQL 版次。公開標題、題目及前序控制題、UTC 截止時刻、容量、內部核准依據及核准勾選都需明確輸入；不按 email 或內部模板文字自動推導公開範圍。完整公開題目、群組、七型選項及條件先預覽，再確認開通。保存 ACK 封閉驗證完成後才讀取當次 token header；header 缺少時仍確認保存，明示原始連結不可復原，不自動改 key 再開一筆。

當次管理對話框用已驗證 `image/png` binary 轉換 memory data URL，符合原 CSP `img-src 'self' data:`。PNG 簽名、格式、完整 2MiB 上限與共享取消守門都保留。關閉或身份／機構／頁面變更即由共用 owner 清除內容；沒有 blob CSP 例外、storage、原始 token data-* 或 QR 外部服務。token 僅當次 URL fragment，不送 HTTP query/path/referrer。

管理清單、詳情、原始答案、停用理由／確認／CAS、邀請兩版歷程及原始答案一版歷程都是 ordinary UI。每份原始答案按自己已保存公開 snapshot 呈現七型完整文字、精確十進位字串及選項值。25 筆分頁顯示原始提交數；不視為不同自然人、完成義務、滿意度分數或排名。停用不改寫既有公開題目／原答案，歷程不出現 token、nonce、內部核准依據或停用理由。

`/survey/` 獨立靜態入口載入 `survey.js`，不載入私人 `app.js`，不要求登入或機構選擇。匿名 fetch 專用 wrapper 採 `credentials:'omit'`、`no-referrer`、`no-store`，從不呼叫私人 `ui.api`、讀取／清除私人 context、logout 或切換機構。無效連結统一不可用訊息。公開完整題目與 SHA 指紋確認後才開啟表單；保留七型原始值、不將 number 轉成浮點。

條件變更隱藏已有答案時，共用确认讓使用者取消（保留原條件與答案）或明確清除。首次提交前確認；同一次 Web Crypto256bit nonce 只用同一完整答案重試。曾送出但回應未確認時保留原值，後續修改回復原提交，避免無聲重發另一份答案。保存 ACK exact `{accepted:true}` 確認後才顯示已保存，不冒充公開義務完成。

目前原生 pure 26 項實際退出0：closed／own descriptor／zero getter、原文 CRLF／padding／10000 字／精確小數、條件取消／清除、明確公開控制題與順序、preview hash／create ACK、同 nonce 重試、缺 header 已保存、同 key private retry、public 401 不觸私人過期、late response／context、合法毫秒差及舊模板 timestamp、PNG data URL 原 CSP。首輪22/23保留一個合成 fixture 寫9999字卻期望10000的失敗；只修 fixture 字數後通過，未放寬業務檢查。

真實瀏覽器 `tests/surveys-e2e.mjs` 已在獨立 `/private/tmp` 合成副本 fresh 執行，9 閘門全部實際退出0；真正使用的19項程式來源SHA前後相同。涵蓋 actual manager 顯圖＋獨立 jsQR decode、匿名完整填寫／確認／bad ACK commit retry、typed 答案／兩種歷程、create bad ACK／cached 無header、25筆分頁、1440／375／390、四角色／真正撤權、late response取消及停用／私人登入保持。合成 memory DB、隨機 loopback、來源SHA前後一致；不碰私人DB／env／4310。一般QA圖遮罩當次token連結與QR，真正顯示的QR另保留私人暫存圖供實看後移除；只保存完整URL SHA 與 decode 是否一致，不把原碼寫一般證據。

實際以 `tools.view_image` 檢視21張最後視域PNG及1張真正顯示的合成QR；PNG原圖SHA、每圖觀察及限制存於 `qa-final-r03/pixel-review.json`。當次QR画面獨立解碼雜湊完全一致，檢視後連同4張先前嘗試的暫存QR已移除。一般證據仍遮蔽原始QR／連結；寬表沿共享視窗橫捲、長原文沿共享視窗縱捲，不假稱單張圖涵蓋全文。

全部失敗原樣保留：第一次Documents副本靜態載入15000ms逾時(native1)，全檔複製卡在無關冷文件而明確停止(native143)；後續改用權威逐byte/SHA的暫存來源。取消條件的立即值斷言及dialog detached診斷(native1)發生在原生close Promise continuation之前，後續真診斷證明會完整還原、原答案不遺失(native0)。最終只在兩處e2e以原15000ms等待實際還原／清空控制項值，保留完整值、全文、可見性與後續提交斷言，未改runtime或擴充timeout。

此候選只完成本機合成介面驗收，不等於正式發布、核定公開政策、官方量表、滿意度計分或正式評鑑。
