# 本人事件月份檢視（0.52，本機獨立契約）

> 公開版本文件：記錄此功能版本的設計與驗收條件，並非目前公開副本已執行的驗收證明。私人盤點與 QA 產物未匯出；現行行為以 API.md 與原始碼為準，正式規則及部署仍須核定。

2026-10-10 凍結。原年度曆、機構曆、我的行事曆、例休假與正式出勤仍未核定。沿 frontend-design 與 frontend-design-premium 的既有 APM CIS／共用元件，不另建立樣式或控制器。

## 查詢

新增 GET /api/personal-calendar-events/calendar，仍先驗證原四角色、ctx.orgId 與 ctx.user.id，本人及同機構之外事件完全不可見；管理者不能代理。只接受 month/q/status 各一次；month 必填精確YYYY-MM，年0001..9999、月01..12，q字面文字不trim最多200字，status空或active/cancelled。任何額外／重複／非法條件422；非GET405，在角色守門之後、讀body之前拒絕。原list/single/write/history契約不變。

回應封閉 {month,q,status,orgId,ownerUserId,items,total,undatedCount}。先本人機構與q/status篩選，只將有效保存YYYY-MM-DD且屬所選月份的事件放入items。其他合法日期月份不計；日期缺失、異型或不合法則以undatedCount表示符合q/status的本人事件筆數，不暴露內文，也不猜日期、修資料或計入本月total。items依date/startTime/endTime/id的字面升冪；非文字time排序鍵為空字串，不推算時間。total等於完整items.length；不使用分頁截斷。

所有當月items及無法歸月計數的候選先沿原身份／安全版本檢查，於筆數界限前驗證；有效他月與其他owner異常不阻塞本月。保留完整DTO、六欄原值及own-presence，非文字由既有格式化函式顯示型別，巢狀內文不展開。整份回應最多1000事件與2MiB UTF-8 JSON，超過則422 CALENDAR_LIMIT，不回部分結果，提示加q/status縮小條件或回清單。非法版本保持原409；其他月份及他人異常不洩露。GET不新增entity/table/trigger/migration/seed/account、歷程、稽核或任何寫入。

## 共用閱讀流程

/personal-calendar 增加「月份檢視」按鈕，沒有新route/nav。沿openDetails(wide/guardedRead)、createForm、table、button、errorState、既有shift-calendar索引／agenda樣式；styles.css/ui.js及原日期計算不改。calendarPeriod('month',month+'-01')重用Gregorian日期與六週索引，收緊最小年0001；顯示週一至週日、上一月／下一月／本月邊界。原生text月份YYYY-MM、native status與literal q（顯示清除搜尋按鈕）；條件只保存在modal記憶，不進URL/client storage。

讀取後確認精確envelope、query echo、org/owner、完整筆數、唯一ID、安全version、date歸月、q/status吻合與排序／兩個界限；不能顯示未知或截斷回應為完整。完整每天表格包含標題、日期、起訖、備註及狀態，保留空日，桌機日期索引可鍵盤定位至當日heading；390px沿既有樣式隱藏索引，完整每日agenda保留。長備註完整可讀，沒有新增編輯、取消、歷程或下載的平行入口；回原清單維護。

草稿条件變動立即撤去舊結果並停用前後月／重讀；明確「查詢月份」後fresh讀取，失敗保留条件且可重試，不自動retry。完整ctx user/org/role/employee primitives、outer reference、hash、render/alive與modal連線守門；nested同primitive參考替換保持，outer重建撤除；loaded/pending失效abort清空，晚回應不能復活。Escape／關閉沿shared焦點回復，abort不宣稱交易回滾。

## 必要驗收與限制

HTTP確認四角色self、同機構他人／跨機構、未知role早拒、closed query、年邊界／閏年、完整超25筆／literal排序、q/status、undatedCount、1000／2MiB拒絕及十一表／六trigger／schema／total_changes零寫。pure確認月份／Gregorian日格、回應完整和異常拒絕、原值／typed安全展示。Browser確認空月、完整查詢與索引、上一下一／邊界、本月、變條件撤除、503／不可信200／retry、loaded/pending情境與晚回應、鍵盤／焦點、1440及390長文／表內捲動、sibling以及既有事件CRUD/班表月份/APM CIS/HTTPS合成Portal回歸。

原失敗與封存不改。正式持久主機／HTTPS／Portal發布與實際公司登入沿交接待辦。
