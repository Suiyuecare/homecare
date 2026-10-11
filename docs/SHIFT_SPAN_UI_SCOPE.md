# v0.74 完整日期時段 A/B 介面閉包候選

狀態：候選 mirror 完整 A/B 真正瀏覽器九組通過，28 張原尺寸 PNG 逐圖實看完成，自有來源可交 root 機械接線。正式工作區接線與最終全來源驗收仍待 root；候選證據不代表正式發布。

## 操作範圍

單筆排班、實際服務、請假沿共用 APM 表單增加明確日期模式，結束日由人選擇。未選模式保留舊欄位真正省略；已有明確結束日不可清成 null、空白或舊格式。合法同日／翌日、正分鐘、最多 2879 技術分鐘，只描述保存時段，不推定夜班、加給、假額或法定班別。實際服務開始日仍綁班次保存開始日；不能表示完全在翌日才開始的服務，表單明示。

普通編輯保留未修改日期、ISO 時間、CRLF／前後空白備註與原保存 JSON。新增冪等鍵、修改版本 CAS、不良保存 ACK、機構／頁面切換與取消沿既有 owner；沒有另造 dialog、下載或事件 owner。

代班與人工出勤例外的班次保存來源支援原七欄與新八欄條件式閉包，完整時段出現在表單、確認與詳情；原角色矩陣與核閱規則不變。版本歷程增列條件式結束日與 endDay，舊缺欄仍顯示未另存，不回填資料。

永久週期與有限週期的每班 endDay 與模板生成範圍 endDate 是不同欄位。舊省略、明確同日、明確翌日可人工選擇；預覽、產班、保存 ACK 與完整追溯核對 ending-date presence。整組調時可選保留原每班 ending-day presence／明確同日／明確翌日；移日同步移開始與保存結束日，原 slotDate 與 movedDate 不改。其他動作不送 endDay。

班表明細、服務、請假明細固定完整日期 query；班表行事曆以 intersects 讀取，前日開始且本日延續的班次按實際占用日分段，唯一班次只計一次，翌日 00:00 結束不產生空區段。完整 CSV 與列印使用同一條件與原 guarded owner，不截斷或把全報表當前頁。原報表中心費用／薪資試算亦使用完整日期模式；原保存價格、工時及金額不回算，舊原生確認 API 保持原 literal 月前綴行為。

服務轉帳單與服務轉薪資支援精確 Source12/13、保存快照及來源歷程 read-mode。人工金額仍空白，不從原試算預填；preview/create mode、hidden origin 與完整保存來源都必須吻合。原保存 origin 不補欄，初版人工金額與目前帳單／薪資金額分開展示。

## 對接與來源

root 持有 app.js/ui.js/styles.css/model/index 及所有正式共享接線。APP_GLUE.md 說明唯一 dashboard 手動 glue。peer v043 持有 shift-span kernel、兩來源核心以及 server A/B／ADDON；這些僅 support、promote:false，UI 不覆蓋。

## 已觀察驗證

full-owned-pure-r05：144 tests，native exit 0，包括新日期表單 11、完整日期消費者 20、新完整試算 6，以及原服務轉帳薪、週期／移日、普通三表單 41 與原財務試算確認 10。普通三表單測試只修新增可見控制項與 reference 字串的 fixture，原本文、CAS、冪等／保存 ACK 斷言保留。之前失敗日誌與修正稿保存。

tests/shift-span-e2e.mjs 使用合成 memory／隨機 loopback，r08 實際九組通過、native exit 0。涵蓋普通跨日保存／不良 ACK 同鍵重試、未改 CRLF／原 ISO 秒數時差、完整班次歷程、本人實際服務與核閱、翌日請假衝突零寫、carry 行事曆與完整 CSV、八欄保存來源、永久／有限週期及明確調時／整組移日、Source13 獨立帳薪與來源追溯、375/390 表單真正末段與 footer、晚到 GET 防回寫、居服員財務讀取 403，以及 Taipei 當日動態 carry 工作台。

r08 證據為 integration-mirror-r01/outputs/software/shift-span-qa/browser-attempt-DYtVIX/verification.json，39 個指定來源前後 SHA 相同，pageErrors 與 nativeDialogs 為空；owned-source-check-r08.json 的 36 個自有 JavaScript 語法實際 exit 0。pixel-review-r08.json 記錄作者實看全部 28 圖，accepted:true，包含工作台 desktop／375／390 原文 Range 範圍與不交疊回歸。r07 已通過功能但像素 accepted:false 的碰撞證據完整保留，root app 改為僅明確日期使用既有 pre-wrap class 解決，styles.css 未改。此 root app 與 peer server/core 一律 support promote:false。

像素限制：手機工作台既有短暫成功 toast 遮第二列下段；完整日期文字仍可讀且不碰個案。長歷程與來源詳情只視檢本輪可見區段；手機寬表沿既有內部橫捲，沒有宣稱未截到的全部欄位完成像素驗收。r01–r07 原失敗／通過與每次修正稿均保留，未提高逾時或放寬保存與零寫斷言。正式重接後仍需 root fresh full-source 回歸；候選 mirror 不包含 root 後續 approved explicit 缺快照的新安全增補。


所有資料為合成，不讀私人資料庫或秘密，不開原平台、正式付款／申報／外部通訊、部署、DNS 或背景工作。
