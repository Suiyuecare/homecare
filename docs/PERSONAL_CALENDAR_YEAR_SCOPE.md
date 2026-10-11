# 本人事件年度檢視（0.55，本機独立契約）

2026-10-10 凍結。延續0.51本人六欄事件與0.52月份完整閱讀，提供一次取得全年資料的唯讀年度索引。本切片屬RM-07本機能力；原180列、九階段、所有原版completed0及已驗收APM CIS／合成Portal權限維持。原機構年度曆、例休假、正式出勤與共享／代理规则仍待核定。

## 查詢與保存

新增GET /api/personal-calendar-events/year。仍先守門既有admin、supervisor、caregiver、finance四角色，再限定ctx.orgId與ctx.user.id；管理者不能代理。只接受year/q/status各一次。year必填精確四位西元0001..9999；q為不trim的字面文字、最多200字元；status空或active/cancelled。額外、重複或非法條件422；非GET在角色守門後、讀body前405。原month/list/single/write/history與所有權不變。

回應封閉{year,q,status,orgId,ownerUserId,items,total,undatedCount}。q/status沿既有搜尋；有效保存YYYY-MM-DD且屬所選年者完整放入items。其他有效年份排除。缺失、異型或不合法日期只計符合本人q/status的undatedCount，不暴露內文、不推定日期、不修資料、不計入total。所有本年或未定年候選先沿原identity與正安全version確認，再檢查界限；其他有效年與他人異常不阻塞本年。

items按date/startTime/endTime/id字面升冪，非文字時間排序鍵為空字串，不推算時間。保留完整既有DTO、六欄原值及own-presence。total必須等於全部items.length。全年最多1000事件與整個回應2MiB UTF-8 JSON，超過則422 CALENDAR_LIMIT，不能回部分結果；提示加q/status或改用月份／原清單。GET不新增entity/table/trigger/migration/seed/account、版本、稽核或任何寫入；兩附件BLOB與已核閱計價快照不變。

## 共用閱讀流程

/personal-calendar加「年度檢視」按鈕，沒有新route/nav。沿APM CIS、openDetails(wide/guardedRead)、createForm、table、button、errorState與既有shift-calendar索引／agenda樣式，不改styles.css、ui.js、原month控制器或日期演算。年度原生text四碼、status原生select、literal q保留前後空白；草稿只存modal記憶、不進URL或storage。

載入後確認封閉envelope、query echo、org/owner、完整筆數、唯一ID、安全version、日期歸年、q/status、字面排序及兩界限；拒絕未知或截斷結果。全年依12個月份列出完整六欄表格及月筆數，含空月與全年总數；長文字原文完整可讀、異型只顯示既有型別提示、不展開巢狀內文。桌機月份索引按鈕可鍵盤定位至對應heading；390px沿既有樣式隱藏索引但完整12月agenda可讀。事件維護回原清單，沒有新增平行編輯、取消、歷程、匯出、下載或巢狀月份操作。

上一年／下一年／今年及重新讀取；最小0001與最大9999停用越界年度並說明。草稿變更立即撤去舊結果、停用前後年／重讀，明確「查詢年度」才fresh讀取；失敗保留條件可重試，不自動retry。完整ctx user/org/role/employee primitives、outer reference、hash、render/alive与modal連線守門；nested同primitive參考替換保持，outer重建撤除。loaded/pending失效abort清空，晚回應不能復活。Escape／關閉沿shared焦點回復。

## 必要驗收與界限

HTTP確認四角色self、同機構他人／跨機構、未知role先拒、closed query／非GET與壞body、0001／9999／閏年、完整跨12月超25筆、literal排序／q/status、undatedCount、精確1000／2MiB界限及十一表／六trigger／schema／total_changes零寫；原歷程、idempotency、兩附件BLOB、核閱計價快照保護。pure確認年度條件、完整回應異常拒絕、12月分組与原值typed安全展示。

Browser確認空年、跨12月完整查詢、索引鍵盤／焦點、上下年／今年／邊界、變條件撤除、503／不可信200／retry、loaded/pending情境與晚回應、1440／390长文完整及表内捲動。必要新年度、既有本人CRUD／月份、core、APM CIS及HTTPS合成Portal回歸，完整unit、最低Node22.13相關、source check、strict私人parser與DESIGN lint；每張新圖外部實際視檢後才標本機完成。不宣稱所有配置fresh、原生OS popup或人工UAT。

保存所有既有失敗與封存證據；不讀真帳號DB/env/binding/private備份／4310、不動DNS、不部署／購買／正式申報／付款／外部訊息。正式持久主機／HTTPS／Portal發布與本人公司登入維持既有待辦。
