# 自訂模板套件搬移

管理者與督導可下載自己機構的自訂模板定義，並匯入為新的待檢查草稿。財務及居服員沿既有模板API拒絕。不是16份正式模板、52份報表或28種匯出全部對等；核定原檔與公式仍列在 `USER_REQUIRED_INPUTS.md`。

## 範圍與完整性

套件固定`format:suiyue-custom-form-template-package,version:1,definition,sha256`，定義只含code/name/description/groups/fields/note。不搬移機構ID、修訂鏈、權限、填答、個案識別、附件或檔案內容。SHA256檢查內容損毀，不代表可信作者或官方核定。

文字仍可能含人工輸入的個資。下載前fresh GET目前同機構版本，完整呈現說明、群組、七型題項、選項、顯示條件及備註，再明確勾選核對。真正下載前再讀相同版本及權限；撤權、改版或情境失效均不下載。

JSON檔案最多4MiB，原生file控制項沿共用filePolicy新opt-in，不改PDF／PNG／JPEG附件或CSV限制。嚴格UTF-8、非空、閉合封包與定義、SHA核對、七種型別／條件／群組及既有schema界限；重複及escaped同名JSON鍵、NUL、非法Unicode、getter、sparse陣列、未知欄位、過深及過量項目均拒絕。任何文字以安全DOM呈現，不執行HTML或公式。

## 匯入

先本機讀檔驗證、完整預覽，再明確填寫不同於來源的新代碼及新名稱並勾選確認。透過既有`POST /api/form-templates`建立revision1／previousTemplateId空／draft；不覆寫、停用或自動發布既有模板。新模板仍需人工檢查與既有發布流程。

沿共用表單、對話框、busy、dirty／Escape、情境Abort及原冪等POST。相同payload重試保留鍵；不完整回執不得顯示成功，保留輸入並明示結果不能確認；真正重複代碼提示換新代碼，實際403不冒稱資料錯誤。原模板、已填答的固定版本快照及附件保持。

共用`beforeFields`只接收DOM節點，供完整核對內容置於同一表單控制項前；`openDetails`增加守門的owner.close供確認保存後關閉父讀取視窗。既有API、元件預設、下載及附件行為不變。

## 驗收

純與HTTP驗證合法七型往返／文字原文、型態／SHA／duplicate-key／邊界拒絕、同機構／角色、原子新增與版本／冪等、原模板不改。真瀏覽器驗完整下載預覽與明確核對、匯入草稿、錯檔／占用代碼／未知回執、同鍵重送、改版／撤權、手機／鍵盤與切頁晚回應。完整結果由本輪驗收紀錄另記載。
