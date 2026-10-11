# 人工部分核付事實與差額

這個切片擴充既有 `/claim-batches`，保存使用者明確收到的部分核付事實。它不送出正式申報、不推定差額退件或退款、不建立收付款、應收核銷或銀行入帳。原帳單、計價快照及已核對來源均保持。

## 模型與相容性

回應仍精確限定五欄 `billingDocumentId reference status amountCents reason`，每筆來源最多一筆。新增 `status:partial`；`amountCents` 是該筆来源**累計人工已核金額**，必須為安全整數分，大於 0 且小於來源原額，依據及說明必填。再次保存 3001→4001 是以 4001 取代累計值，不把兩版相加。版本歷程保留原 3001、當時依據及實際操作者。0 使用待定；全額使用 `accepted`，不可用部分核付代替零額或全額。

`summary` 保留既有七欄，不加資料表或新账務欄。部分核付的累計值計入 `acceptedAmountCents`，原額减累計值計入 `pendingAmountCents`；接受、退件、待定、未回應合計仍精確等於原來源總額。待定合計的 UI 名稱為「尚待確認差額（含待定）」，並分列未回應；已記接受金額不代表現金實收。舊全額接受、全額退件、待定及未回應的摘要值／七欄形狀不變，舊已保存版本仍可讀。

`partial` 與 `pending` 或未回應均禁止 `closed`，伺服器與客戶端一致。來源已核對後不回算；父帳單後續作廢仍沿原凍結來源讀取／人工記錄規則，但父項及個案目前仍必須存在且同機構可讀。取消不刪除來源、回應或歷程。差額須由使用者明確改存收到的全額接受或退件／待定結果，不能自動判定。原 partial 改為 accepted／pending 的新操作須有非空回應依據及說明，不要求文字一定不同；不允在多來源 response 替換時省略 existing partial，使其靜默變成未回應。普通 legacy response 的省略規則不擴張；舊普通全額接受可空說明，讀取／歷程亦不追溯拒絕。

## API、重送與匯出

沿原 `PATCH /api/claim-batches/:id`，送 `version`、變更的 `responses`、共同依據及首次 `status:reconciling`。僅同機構管理者／財務有權限；原 CAS、body-read 後完整當前身份／權限重核、來源可見與稽核不變。此實體 PATCH 新增既有原子 `Idempotency-Key`：同內容同鍵回精確原 ACK，不再保存新版；改內容須新鍵。重送前仍核來源、角色及組織；若目前批次已再變更，回 `409 CLAIM_RECEIPT_STALE`，不回舊版本 ACK。

UI 使用共用表單／原生選單／確認／下載／歷程，不新增 CSS、widget 或 browser storage。保存原額及尚待確認差額唯讀；金額用原整數分 parser。錯誤、錯 ACK 或無法解析的 2xx 保留輸入，只有完整 id/org/version/業務欄位／來源／七欄摘要一致才顯成功。相同 payload 重試保持同鍵；更改輸入才換鍵。切頁／身份／機構失效清空舊 owner，晚回應不顯成功。

本模組草稿、核對／取消及人工回應的 mutation ACK 仍使用同一嚴格 DTO validator；在 mutation 邊界把驗證失敗轉為明確的「無法確認儲存結果」一般錯誤，不誤指表單不存在的編號欄。API 真正的 401／403 等錯誤仍按原處理。核對／取消 PATCH 同樣帶固定 payload 的重送鍵，更改輸入才換鍵；錯機構 ACK 保留依據／原因，重送取得原 ACK 而不增加 records、versions、audit 或 idempotency。

目前回應含 `partial` 時，JSON／CSV 標 `local-homecare-claim-v2`；每行有原額、累計回應金額、`unconfirmedAmountCents`，並明示非本次新增款項、差額不代表退件／退款／入帳。CSV 只在 v2 增加尾欄，原文字公式防護保持。當前資料不含 partial 時保留完整 v1 欄位／警語；解決後當前匯出可回 v1，舊 partial 歷程仍完整可讀。這兩版均為公司本機格式，不是政府介接格式。

## 驗收

Focused：`node --test tests/claim-partial-reconciliation.test.mjs tests/claim-batches.test.mjs tests/claim-batch-editor.test.mjs tests/claim-history.test.mjs tests/claim-history-http.test.mjs`。涵蓋一分／最大安全整數、閉合形狀、舊全額語義、累計取代、版本歷程、來源守護、四角色／跨機構、CAS、重送、v1/v2、分段真 HTTP 在讀 body 中撤權。測試以合成記憶體資料庫及隨機 loopback 埠執行，不讀本機私人資料。

`node tests/claim-batches-e2e.mjs` 先執行原有流程，成功結束後串行執行 `claim-partial-reconciliation-e2e.mjs`；新稿亦可獨立 focused 執行。涵蓋桌機／390px、只讀差額、必填與焦點、malformed/wrong ACK、同鍵重試／改輸入換鍵、CSV、歷程、CAS、結案／取消、晚導航及四角色撤權。serialized trace 只含 stage/path/method，不含密碼、請求 body、token 或重送鍵。

原生結果選單驗收分別核對 Tab／ShiftTab 的實際焦點順序、四個選項的精確名稱／值，以及透過原生選項變更的全額→部分金額預覽。另驗證在金額欄按 Escape 出現未保存確認，取消後全欄輸入保留且零寫入。Mac Playwright 的獨立原生選單診斷中，headed／headless 的選項鍵未提交選擇，Space→Escape 會觸發共用未保存確認；因此本機證據不宣稱原生 popup 的方向鍵提交已驗證。真實裝置的原生選項鍵提交仍須 UAT 核對，不以改造共用 dialog 或省略鍵盤焦點驗收代替。

本機、完整 CI、正式環境驗收各自另以實際原生退出碼及 evidence 記錄；測試通過不等於已正式申報、正式主機／HTTPS／Portal 上线或整套制度功能完成。政府格式、申報回應介接、支付／部分退件算法、金融結算仍需經核定樣本與政策驗收。
