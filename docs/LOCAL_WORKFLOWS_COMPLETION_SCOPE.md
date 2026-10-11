# 家庭、出勤、面試與新增資料匯入（0.69）

本輪為使用者重新授權完整製作的可操作本機切片，已 accepted_local；最終證據位於 outputs/software/local-workflows-completion-qa/verification-v069.json。沿機構隔離、伺服器角色、CAS、安全正整數版次、POST冪等、稽核及十一表六trigger原備份。沒有正式部署或原180逐項對等宣稱。

人工家庭關係：個案頁新增多代成員與parent／spouse／other人工連線、文字清單及SVG方向圖；同案端點、active來源、唯一／自連／父代循環守門，停用及恢復留歷程。generation -5至5是人工相對層次，不推定血緣、醫學符號或診斷。詳見 CASE_FAMILY_SCOPE.md。

人工出勤例外：管理者／督導保存原員工及日期、人工類別／來源／原因，可人工處理、作廢及閱讀逐版歷程；居服員只讀本人。可關聯班次，保存精確七欄來源快照；後來合法改派不重写原來源或讓另一員工讀本人例外。沒有GPS、自動分鐘／打卡判定、請假額度或薪資計算。詳見 ATTENDANCE_EXCEPTIONS_SCOPE.md。

面試：原八欄保持，增加十個公司自行定義的可選欄及四群組，人工评估需本次原因，名單啟停不代表錄取／到職。面試員工使用精確同機構ID，目前姓名清楚呈現，原識別可展開。詳見 INTERVIEW_EXTENSION_SCOPE.md；不能宣稱原平台十八欄等價。

整合發現並修正舊八欄讀取相容性：完全沒有新擴充欄的legacy可按已知八欄及五metadata投影，只讀原保存日期文字，不解析或補值；未知保存key不檢視、不返回、不改DB。存在任一新欄即維持十八欄closed型別／ISO metadata守門。含未知key或非ISO日期原文的legacy禁止PATCH，避免讀取投影造成靜默刪欄；需另行核定修復。舊typed／missing／null／CRLF／任意保存文字的瀏覽器及真HTTP回歸保留；新root修正與原作者freeze明確分開記錄，不混稱相同來源bytes。

本機新增資料匯入：管理者選UTF-8 CSV、對應個案／員工／服務項目欄位、零寫預覽及原子整批新增。明確精確編號去重，資料更動409需重新預覽、相同key重送不重複，非法ACK／保存失敗保留輸入。詳見 LOCAL_IMPORTS_SCOPE.md。

所有新UI沿APM／ui.js／styles.css與原生控制，沒有新CSS／字型／tokens／第三方dialog。所有測試使用合成隔離資料；原失敗、既有catalog、私人資料及帳號開通保持。正式費率／薪資／資格／評分／FA格式、正式移轉及主機／HTTPS／Portal仍依核定契約，背景排程保持使用者停止狀態。

合成隔離驗收完成：1,611項程式測試、395份JavaScript、22套必要瀏覽器262項操作；37頁四角色148組合、390個版面檢查與六寬度通過。513來源SHA前後一致，166登錄runtime中165實存，原缺失路徑保持；8張最終新圖實看，另14張匯入圖及作者像素各自保留。十一表六trigger備份／還原／失敗切回通過，無新schema。原失敗及官方audit逾時actual124保留，不當官方通過；設計lint零error／10既有warning，私人parser零finding。78 configured／77 required未全fresh。證據：outputs/software/local-workflows-completion-qa/verification-v069.json。
