# 員工主檔安全編輯（0.27 獨立本機切片）

> 公開版本文件：記錄此功能版本的設計與驗收條件，並非目前公開副本已執行的驗收證明。私人盤點與 QA 產物未匯出；現行行為以 API.md 與原始碼為準，正式規則及部署仍須核定。

2026-10-09 凍結；employee-edit-safety-v0.27 / 。沿既有 employees CRUD、機構隔離、角色、CAS、POST 冪等、版本歷程及核閱薪資快照，只用合成資料，不新增正式薪資、資格或支付規則。

十個業務欄：name、employeeNo、role、phone、email、status、qualification、regions、note、hourlyRateCents。純 createEmployeeEditor 私下捕捉十欄 JSON own-presence 及 id/orgId/version；不展開 row 到 controls。正常未改／改回原值省略；全部未改沿 version-only PATCH。缺失、null、異型及無法無損預填的值提供保持／取代，選填文字可明確清空為 ''。保持不補預設、不 trim、不猜零；不能保證原 merged 必填／狀態／唯一檢查通過。

name、employeeNo、role、phone 用單行原生文字，CR/LF 值留在 DOM 外。email 使用文字欄，沿原 API 字串／500 字上限；API 沒有 email 格式規則，不讓共享 type=email 驗證阻擋既有保存原文。qualification、regions、note 用 textarea 保留 LF，含 CR 原文留在 DOM 外。新寫普通文字最多500、regions 最多1000、note 最多10000；name/employeeNo 非空，空白不 trim。過長而可原樣預填的未改字串仍省略。

regions 原 API 接受文字或最多50項、各項少於100字的字串清單；空項、重複、順序及項內 LF/CR 均有保存語意。本輪原清單、缺失或不相容值預設整欄保持，在 DOM 外保存，不 join、拆行、排序或去重；明確「改存文字」才以本次 textarea 字串取代，「清空為空文字」才存 ''。help 明示清單會改成文字。此切片不增加清單逐項新增／刪除／編輯；合法清單仍可由原 API 保存並在歷程及總表讀取。背景既有列表展示不作本輪安全表單證明範圍。

hourlyRateCents 表單別名 hourlyRate，text/inputMode decimal；原 safeinteger 0..1e9 分以 BigInt 商餘數預填精確兩位元字串。新取代值僅接受非負十進位、最多兩位小數，不含空白、符號、指數或逗號；以 BigInt 轉分及範圍判定後才 Number，等值分數省略。缺失/null/異型不猜零。列表沿既有 formatTrialPriceCents 完整顯示一分。後端欄錯誤僅本表映射至 hourlyRate。新增送完整十欄，其他選填 ''、狀態 active、試算時薪0.00；既有修改不補缺欄。

原 validatePayload 只驗送出欄，merged validate 對員工要求 name/employeeNo 非 missing/null/''/[]、status 僅 active/inactive、employeeNo 同機構嚴格相等唯一；省略 email/regions/hourlyRate 不重驗型別。職務 role 是文字，不能修改登入 memberships.role。admin/supervisor 維護，finance 原唯讀，caregiver 原自己讀取與有效同機構員工連結。停用無新增 in-use 鎖，不刪帳號／取消既有班次；連結該員工的 caregiver 下一個受保護請求沿原 auth 回403 EMPLOYEE_LINK_REQUIRED，恢復後原 session 可再讀。已核閱費薪快照不重算。

新增／編輯沿 openForm 完整 isCurrent/AbortSignal/busy/dirty/native 焦點；啟停沿既有 confirmAction opt-in 同 guard，不新增控制器／CSS／路由／表／後端規則。停用提示說明有效員工限制及舊紀錄保留，異型姓名用固定安全名稱。捕捉原 id/version，409 不覆蓋，不自動重試 PATCH；成功須 plain item、同 id/org、安全版本（新增1／編輯old+1）及全部十欄 own-presence／精確 JSON 投影吻合後才 toast/refresh。錯誤或未知2xx保留輸入、intent、POST 同鍵；晚回應不可復活。Abort 不宣稱已提交伺服器資料回滾。

驗收須包含純 helper／真 HTTP、十欄往返、省略／regions清單與特殊型別保持／明確轉文字或清空、非法金額、原 merged422/CAS409/POST同key、十欄保存確認、四角色及停用本人403／恢復、loaded/pending完整context與真先提交晚回應、桌機及390px原生dirty/鍵盤/焦點、版本歷程／證照訓練入口、11表唯讀段及必要寫入對帳、雙BLOB／六不可變trigger／核閱快照、相關既有流程回歸。最終圖逐張 view_image 才完成；不宣稱 headless OS native popup 幾何或人工UAT。

必要舊測試契約修訂：employee-history-e2e 第231行原要求清單合併字串預填，改驗 regionsIntent=keep 與空白 disabled 控制項；取消後原清單 exact 保留及原12 gates不變。其他25套既有script byte保持。此修訂不削弱區域歷程比較或授權驗證。
