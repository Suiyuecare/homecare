# v0.68 人工年度訓練積分

本切片新增 `employee-training-credits`，供管理者與督導按年度逐筆保存人工積分原文、來源、人工核對及作廢紀錄。既有 `employee-training` 時數紀錄維持原流程。此切片不換算分鐘、不合計不同單位、不推算資格或法定認定；正式積分規範、認定機構及官方樣本仍待使用者核定。

## 資料契約

十四個封閉純文字業務欄位：`employeeId,date,activityName,provider,creditValue,creditUnit,sourceReference,reference,note,status,verifiedOn,verificationBasis,voidedOn,voidReason`。員工、活动日期、活動名稱、活動單位、積分原文、積分單位與來源依據必填。識別 metadata 只有 `id,orgId,version,createdAt,updatedAt`，保存版次必須正安全整數。

`creditValue` 保存非負十進位原文，整數最多十五位、小數最多六位；允許 `0`、`001.230000`，拒絕數字 primitive、負值、指數、前後空白、末尾換行與超出技術上限。這些限制僅為可保存格式，不代表官方積分規則。長文原文及未變更的 CRLF 保留；短文字名稱可修整空白，換行不能藉修整而被接受。年度為 `0001` 至 `9999` 四位文字；日期遵守 Gregorian 閏年，不接受 `0000` 或末尾換行。

同機構員工建立後固定。`draft` 可編輯；本次 PATCH 明確帶 `status=verified,verifiedOn,verificationBasis` 才能核對。`verified` 完整內容鎖定，只可本次帶 `status=voided,voidedOn,voidReason` 作廢；原核對內容完整保留。`voided` 終態不得改寫，沒有刪除 API。每次保存沿共用 SQL CAS、版本快照與稽核；新增沿共用冪等鍵。

## 授權、查詢與歷程

管理者、督導可維護。居服員只能讀取本人同機構紀錄及歷程；財務讀寫皆 403。權限先於查詢／本文解析；他人及其他機構 parent 不可藉查詢或識別碼讀取。Current 与 history 的未知欄位、壞 JSON、null、SQL unsafe version、snapshot/SQL 版次不符皆隱藏且不修資料。歷程只比較可取得的精確前版；員工名稱讀取目前有權 DTO，歷史仍保存識別碼。

`GET /api/employee-training-credits` 只接受單次 `page,pageSize,year,employeeId,status,q`。單筆 GET 不接受任何 query。`/:id/history` 只接受 `page,pageSize,compare=previous`。重複 query、未知 key、尾端 LF、無效範圍、過大的整數拒絕。列表按年度、員工、狀態及文字篩選，只有逐筆明細與分頁，無積分加總。

## 操作與整合

`#/training-credits` 主標題「人工年度訓練積分」，沿共用普通表單、確認框、詳情與版本歷程 owner。年度為文字輸入；修改查詢草稿立即撤除既有结果，必須按「查詢年度」才重新讀取。內容身份以伺服器 DTO 確認；輸入保留、cancel、目前機構／角色／hash／connection 失效沿共用 guard。原始積分使用文字輸入，不要求使用者編輯 JSON。

新 server callback 注入 `get/fail`，不匯入 model 避免循環；model/index/history/guarded-records/app/history-fields/history 為根節點整合 owner。歷程十四欄為人類可讀日期、文字、員工參照及人工狀態，不輸出 raw JSON。

## 驗證與界線

`tests/training-credits.test.mjs` 六項 pure／memory 整合與 `tests/training-credits-http.test.mjs` 四項真 HTTP 測試：十進位與日期邊界、closed schema/accessor、狀態鎖／本次操作依據、同機構固定員工、本人／財務授權、嚴格查詢、CAS／冪等、unsafe current/history、零部分寫入及唯讀零修復。僅合成 `:memory:`，隨機 loopback，不能以此推定正式部署。

`tests/training-credits-e2e.mjs` 沿真 server 与共用 UI 驗證普通新增編輯、保留 CRLF／小數位、人工核對必填及 nested cancel、確認鎖定／作廢原因與日期、typed details/history、年度草稿撤除、`0001/9999`、管理者／督導／居服員／財務與桌面／375／390 像素。每次建立唯一 attempt 目錄，來源與產物 SHA 可追溯，舊失敗日志保留；實際圖像檢視完成才可認列視覺結果。本機列印、CSV、外部消息、正式積分介接與正式部署均不在此切片。

驗收為本機可操作人工紀錄切片，不代表原平台全部功能對等；原 180 功能狀態與正式待核定項目不因本 CRUD／工作流而變更。

本機專屬驗證收據：`outputs/software/v068-candidates/training-credits/unit-http-run-02.log` 全10項通過；`outputs/software/training-credits-qa/attempt-FiOGzt/` 全13個瀏覽器里程碑通過，來源SHA未變、page/request errors皆空、native dialog零。桌面1440、375/390表單／詳情與typed歷程圖片已實際檢視；新增表單內容在固定footer上方可捲動，沒有全頁横向溢出。先前三次失敗測試（第四次亦通過，最終版本補足 caller 授權的 fresh 員工名稱）與唯一attempt完整保留，不當作通過證據。
