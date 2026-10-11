# 面試紀錄：本機18欄人工擴充

本批沿用原本8個已實作欄位，加上10個歲悅本機人工欄位。這是可操作的公司工作模型；未取得原平台18欄的逐欄證據，因此不宣稱與原平台18欄相同或已完整複製。

## 欄位與表單分組

| 群組 | 欄位 | 保存規則 |
| --- | --- | --- |
| 基本資料 | `name` 姓名、`phone` 電話、`city` 縣市、`district` 鄉鎮區 | 原8欄規則保持；姓名、電話必填，單行。 |
| 工作意願與經歷 | `appliedPosition` 應徵職務 | 選填單行，最多200字；本次輸入的前後空白保留。 |
| 工作意願與經歷 | `education` 學歷說明 | 選填單行，最多500字；不是正式學歷驗證。 |
| 工作意願與經歷 | `workExperience` 工作經歷 | 選填多行，最多10000字。 |
| 工作意願與經歷 | `availableFrom` 可到職日期 | 選填，空字串或0001至9999年真實YYYY-MM-DD日期。 |
| 工作意願與經歷 | `availableHours` 可配合時段 | 選填人工文字，最多2000字；不是可自動排班的可用時段規則。 |
| 工作意願與經歷 | `certificateNotes` 證照說明 | 選填多行，最多10000字；不是資格或證照正式核定。 |
| 面試紀錄 | `interviewDate` 面試日期、`interviewContent` 面試內容、`note` 備註 | 保留原8欄驗證；面試日期、內容必填，內容與備註各最多10000字。 |
| 面試紀錄 | `interviewQuestions` 面試提問與回應 | 選填多行，最多10000字。 |
| 面試紀錄 | `interviewerEmployeeId` 面試員工 | 選填，同機構員工參照；新建及改派須為使用中員工。 |
| 人工評估 | `decision` 人工評估 | `pending` 待人工評估、`considering` 人工考慮中、`selected` 人工選用意向、`not_selected` 人工未選用意向。 |
| 人工評估 | `decisionReason` 本次人工判斷原因 | 多行，最多10000字；明確人工評估操作須提供本次非空白原因。 |
| 人工評估 | `status` 名單狀態 | 原本`active`啟用、`inactive`停用，與人工評估意向互相獨立。 |

四個群組使用共用`createForm`實際欄位描述的`groupLabel`；每組只在第一個實際控制項標註群組，不增加假欄位或替代對話框。舊欄位的安全保持／取代／清空處理控制項仍可出現，但18個業務欄位保持完整。

## 人工操作與舊資料

新建紀錄保存全部18欄：新`decision`預設`pending`，其他新欄預設空字串。既有原8欄紀錄不批次回填；讀取、無變更、只改原欄及啟用／停用皆保留10個新欄位的缺席。缺席的人工評估在編輯表單顯示待人工評估選項，但未實際修改時不會PATCH寫入。

人工意向允許人工改判；每個明確PATCH `decision`操作，包括再次送出相同意向，都必須在本次payload提供非空白`decisionReason`，不能自動繼承先前原因。POST非`pending`也須本次原因。普通表單只有意向實際改變時才送出該欄，且不得把未改的先前原因當成本次原因。所有過往原因保留在版本歷程。

新派或改派面試員工只能選同機構使用中員工。原指派員工後來停用時，原紀錄與歷程仍可查閱，也可改其他欄位或明確清空；不能把停用員工重新作為新指派。選項未完整取得時使用原共用安全編輯處理方式保持原指派，不因select沒有對應選項而默默清空。員工參照跨機構、找不到或原資料的新欄位型別不符時，現行／歷程均採不展開、不保存的保守守門。

原8欄在**本次明確送出**時維持既有trim規則。新多行／人工說明文字明確送出時逐字保存；只對新日期、員工識別、人工意向碼trim。textarea顯示將CRLF或CR轉為LF，未改欄位按初始顯示值比對後不PATCH，因此原CRLF、前後空白及缺席均保持。舊8欄已有異型別保存值沿用現有安全詳細資料型別標記，不能展開任意巢狀JSON；其伺服器合併驗證仍可能要求明確修復後才能改其他欄位。

## 權限、安全與API

沿既有`/interviews`頁、`/api/interview-applicants` entity。管理者與督導可讀／寫；財務、居服員為403，須在解析body或query前拒絕。沒有新增員工、聘任、帳號、角色、到職、通知、排班、證照資格、薪資或外部通訊副作用。所有欄位與歷程以目前機構隔離；閉合現行及歷程DTO為18欄加既有5個metadata，允許新欄位缺席但拒絕未知欄、新欄未知巢狀值、非安全版次及錯誤來源。歷程須核對SQL版次、原record ID／機構／建立時間及當前可讀性。

POST沿既有交易內冪等鍵，原始內容不同不能復用同鍵。PATCH沿既有版本CAS；不要把共用PATCH描述為伺服器冪等重播。紀錄、版本與audit採既有交易保存。ACK逐欄確認18欄的保存值／存在性、機構、原ID及下一版次；未確認時保留表單輸入。重新導覽／切換機構／身分的過期結果不得更新當前頁面。

本entity POST/PATCH body允許最多1 MiB，因合法的原面試內容／備註與4個新增10000字多行欄位可以超過128 KiB。其他entity維持原128 KiB。超過上限為413且零寫入；單欄限制仍先後完整生效，這不是放寬單欄字數。

## 對接接口

候選server `interview-extension.mjs`輸出：

- `interviewExtensionSpec`：完整18欄、原必填欄、原名單狀態、新defaults及maxLengths；root整合既有entity spec。
- `normalizeExtendedInterviewPayload(entity,payload)`：**取代**原本此entity所有字串trim hook，不可先用舊hook trim掉新欄原文。
- `assertInterviewExtensionPayload(entity,payload,fail,patch)`：normalize後、合併舊資料前驗證本次人工評估原因。
- `validateInterviewExtension(db,ctx,entity,data,old,fail,get)`：沿既有原8欄validator後追加，在共用交易內檢核新欄與同機構參照。
- `interviewExtensionVisible`、`interviewExtensionHistoryVisible`、`interviewExtensionRecordValid`：閉合來源守門；SQL版本相符由共用安全reader/history owner驗證。

候選純編輯器`createExtendedInterviewEditor`重用現有原8欄owner，提供`fields/initial/needsIntent/enabled/buildPayload/buildStatusChange/confirm`及已定義18欄／4群組／人工意向／字數常數。共用admin/detail/history/UI由root整合，沒有第二個表單、下載或對話框owner。

## 驗收與證據狀態

本機接線後實跑36項全部通過：9個新增真HTTP、15個新增pure（9 editor、6 server validator）及12個原有HTTP。正式POST驗收改為18欄defaults；原8欄trim、型別驗證、舊紀錄缺席及異型別安全讀取仍保留。

專屬瀏覽器最後一輪實跑9個工作流全部通過，page errors為0，輸出27張桌面／375px／390px截圖，已逐一用原尺寸實際檢視。涵蓋普通18欄群組輸入、真commit不良ACK及同鍵重試、完整詳細內容／歷程、無改動零PATCH、未動CRLF保持、新原因改判、停用原面試員工保留、原8欄未回填、真正CAS409、四角色／機構隔離及已commit晚回應不更新過期畫面。最後證據為`outputs/software/interview-extension-qa/browser-1791643515560/verification.json`，逐張像素紀錄為同QA目錄`pixel-review.json`。

手機寬表採共用表格橫向捲動，姓名與最右操作未在同一個viewport同時顯示；長表單及18欄詳細內容須垂直捲讀，固定保存／關閉footer維持可操作。原生日期控制項依驗收瀏覽器locale顯示，保存值仍為ISO日期。較長的停用員工select標籤尾段會受原生control寬度裁切，姓名與「目前已停用」可讀；完整姓名亦可於詳細內容／歷程查核。本批未另造CSS或對話框。

這是本機切片驗收；全系統版本封存由root另行執行。全部測試僅用合成資料、記憶體SQLite與隨機loopback埠，不使用私人資料庫、帳密或真實綁定。原候選、先前失敗與loading截圖證據保留，未部署、未推送或聲稱原平台等價。
