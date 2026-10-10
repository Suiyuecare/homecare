# 評鑑編輯安全切片 0.21（凍結範圍）

> 公開版本文件：記錄此功能版本的設計與驗收條件，並非目前公開副本已執行的驗收證明。私人盤點與 QA 產物未匯出；現行行為以 API.md 與原始碼為準，正式規則及部署仍須核定。

2026-10-08，assessment-edit-safety-v0.21。只修既有同模板評鑑建立／編輯的預填與答案保存；原16模板359題、授權、API、資料表、版本歷程、提交含義、計價快照及正式評分規則保持。新系統的本機測試契約，不推定原平台等價。

## 主欄與保存基準

個案／填寫日期／狀態從保存row主欄取得；templateId固定開啟的目前模板。禁止將answers展開到metadata initial、字段描述或DOM。已填寫列使用當時列表row的id／version／答案快照；不新增讀取controller或fresh GET預填。若列載入後或表單開啟後其他人先更新，原PATCH version CAS拒409，保留此次輸入，使用者取消後重讀清單；不能偷偷重新讀取並覆寫競爭者的值。

未知模板仍只有0.20唯讀歷程，不新增編輯入口。admin/supervisor原可維護；finance原API唯讀無新導覽，caregiver原403。個案可合法更換，提交仍只是紀錄狀態，未新增審核／評分。

## 安全預填與明確意圖

新增pure createAssessmentEditor(template,row,defaultDate)，提供initial、questions、answersEditable、editing、hasPreservedAnswers與buildPayload(values)。question含name/type/label/initialValue/requiresIntent；需要意圖時intentName固定answerIntent_加題名，savedKind只安全型別tag，沒有未知鍵或巢狀來源。已知題項必須為own key。

現catalog只有text304/date49/textarea5/time1。可無損預填：text為不含CR/LF的string，textarea為不含CR的string，date為空string或有效四位西元YYYY-MM-DD（0001至9999），time為空string或HH:mm（00:00至23:59）。其他保存型別、非法date/time、text換行／textarea CRLF不轉型，不把原值放進input/help/placeholder/hidden DOM，只提示安全型別。缺題initial空白但不憑空新增保存鍵。

無法無損預填的已保存已知題項，原輸入框空白disabled，旁邊沿canonical native select選「保留保存答案」（預設）、「以本次輸入取代」、「清除保存答案」。只有取代啟用輸入。保留完全原值；取代以明確選擇後的控制項值（含空文字）替換；清除明定保存空文字''，不是刪鍵或改null。切回保留／清除停用輸入，內部此次輸入可保留供再選取代；沒有隱藏原值灌回。一般可安全預填題以最終控制項值和安全initial比較；改後回原值表示保留，清空原非空值表示改為''。全部文字照原文，不trim。

編輯時以原JSON答案快照為基底，僅改目前模板已知、明確更動的own題項；未知鍵、特殊own __proto__/constructor/prototype、未修改number/boolean/null/array/object及嵌套內容、順序不靜默刪除或轉型。helper不修改來源，不用JSON整包作DOM內容，也不把任何意圖欄送API。metadata-only或全部保留時PATCH省略answers；修改答案時產生完整合併物件，沿原answers≤50000字元／request≤131072 bytes守門，超限拒絕且保留表單，不裁切隱藏內容。

僅不正常匯入可有缺失／null／array／scalar答案root；這種編輯只可修改metadata，所有題項disabled、明示此次保留原填答，PATCH省略answers，不自動轉{}或新增整包替換入口。正常建立沿既有空白已知題項及answers物件，不接受注入未知表單值。非法意圖、未知題项替換及不符合控制項的替換值拒絕，不默默回退。pure helper不能取代伺服器驗證。

## 共用表單與異步保護

沿public/ui.js openForm/createForm的noValidate、label/error、dirty取消確認、Escape與焦點回復、忙碌防重送、輸入與意圖保留。共用helpers新增setDisabled(name,boolean)，不另造controller／CSS。createForm可選lockDuringSubmit，opt-in guarded form提交期間鎖input/select/textarea，失敗恢復各控制項原disabled狀態，避免晚回應成功關閉時丟失提交後新增輸入；原其他表單預設行為不改。

openForm可選isCurrent，評鑑傳完整user/org/role/employee/hash/generation/render/alive；opt-in表單於身分／路徑／render失效時清空關閉並abort client request，阻擋晚回應、stale onSubmit、toast與refresh。失效不等待dirty確認，已開啟的本表單放棄確認亦一起關閉；共用confirmAction可選signal，其他使用者無參數時原行為保持。不宣稱abort已撤回可能提交到伺服器的交易，失效後須重讀確認。

新增／更新沿原CSRF／POST每表單冪等鍵／PATCH CAS。評鑑專屬提交須取得與此次id/機構/安全version/五欄metadata相符的item確認才close/success；錯誤、斷線、成功status但無有效item保留输入與意圖。沒有自動CAS重送或不明成功後假稱保存；重讀後核對。

## 驗收條件

必要pure與真HTTP整合：metadata同名鍵、own特殊鍵、型別／native清洗、missing/null/空值、clear/replace/keep、原資料不變、完整合併與大小界限、原四角色／org/reference／CSRF／POST replay／CAS、精確history/actor；無關BLOB／核閱快照／報表保持。新真Chromium：建立/編輯/提交/返回草稿、metadata-only、只改單題、native不相容值、422/409/503或回應失敗保留、dirty／取消／焦點、native選項與鍵盤、1440/390及長表單、client context載入/提交或開啟失效，分開標示真角色session與client fixture。

沒有新PDF或marker。actual試用資料重啟前後只讀核對。

完成上述驗證後才標implemented_verified並唯一封存0.21.0。
