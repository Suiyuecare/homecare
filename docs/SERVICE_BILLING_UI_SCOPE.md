# 服務轉帳單：v0.71 本機完成

本切片只建立本機公司人工帳單草稿，來源是已核閱服務。候選位於 `outputs/software/v071-service-billing-ui-candidates/`，已整合本機正式程式來源並通過合成驗收；沒有正式部署、原平台等價、官方費率、自付／補助、月額度、核銷、付款、發票或薪資效力聲明。伺服器唯一封閉契約另見 `outputs/software/v071-service-billing-candidates/CONTRACT.md`，root 負責 model/index/app/nav/package／正式接線。

## 操作流程與共同元件

路由 `/service-billing`，頁名「服務轉帳單」，export `mountServiceBilling(container,{isCurrent})`。同機構 admin／finance 可使用；supervisor／caregiver UI 不提供入口且 API 前置403，不藉客戶端隱藏代替伺服器授權。

使用者先以共用普通表單明確指定個案及月份，再查詢同案同月尚未導入的已核閱服務。清單使用共用 semantic table、搜尋及25筆伺服器分頁。逐笔「加入待核對」／「移除待核對」只改本頁選擇，不寫入資料，最多100筆；更換範圍時共用確認視窗說明清除尚未生成的選擇。

「人工核對並預覽」沿共用 openForm／createForm 的普通文字、textarea、月份與分組欄位。每個 service-record 一筆人工整體總額，不拆項、不反除原服務數量；生成帳單明細 quantity 固定1，unitPriceCents 是明確輸入的人工總額。金額欄初始留白，即使保存試算非零，也不默認原trial價。每笔依據及共同人工依據必填；數字文字以既有精確元／整數分 parser 轉換，不浮點乘除。明確輸入0可保存0，空白、負數、科學記號、第三位小數、超限全拒。

共用 onPreview 先 POST 零寫預覽，確認輸入、完整保存來源版次、每笔核定金額、精確總額、個案快照及previewHash。改欄即由共用 owner 失效預覽並停用生成按鈕；未預覽不能生成。再以共用確認視窗提示來源會永久占用（包含草稿及作廢），原子生成帳單草稿及不可改來源保存記錄。沒有隱性开立、收款或其他 entity 寫入。成功回本頁「已產生帳單及來源」清單，保留個案月份，清除本次選擇，並使用共用toast。

## 已產生帳單及來源

第二個列表模式查詢 GET origins，25筆分頁，搜尋只用契約已定生成編號／共同依據／備註／各行依據；不搜尋任意個資或未知欄。詳情 fresh GET origins/:billId，沿共用 guarded openDetails。

三組數值分開：生成當時人工總額、目前帳單明細總額，以及原核閱保存試算。普通帳單草稿之後可以正常人工修改／開立／登錄已收款／取消收款／作廢；生成origin不改、來源不釋放，沒有把原trial或初版帳單回算成現行帳單。

來源完整12欄與 billingSnapshot 只投影已知 scalar／封閉表格：保存時間、日期、原實際時段、原分鐘、人員姓名／編號、捕捉時點、幣別／approval／trial標記、全部原保存服務項目（code/name/quantity/unitPriceCents/amountCents），另可展開来源／機構／個案／員工／班次／項目識別碼及保存 metadata。保留原 HH:mm 或同日 ISO 秒數／offset 文字，不改源紀錄；分鐘只依原既定 HH:mm 規則核對，不引入新工時計算。

詳情提供 `#/billing-documents` 的既有「前往帳單與收款」導覽，提示以原編號搜尋；原帳單 module 是開立／收款唯一 owner。本切片不向每張一般人工帳單試查不存在的origin，不改一般billing fields／flag或另造收款UI。

## 安全契約

source／preview／Bill／Origin／collection envelope 全部 descriptor-safe exact keys；未知 nested、symbol、accessor、sparse／extra-key arrays 拒絕且不觸發 getter。12-keysource、14-keyBill、14-keyOrigin與行映射、原版本、明細乘積、總額全部核對。Bill 金額BigInt精確加總；per-source manual amount範圍0..1e9整數分。

來源來源ID／版次只由私有複製選擇產生，不讓表單修改來源關係；個案月份固定。共同依據、每筆依據、備註保存精確原文，不 trim 換行及前後空白；帳單編號／普通單行名稱依新輸入契約trim。private baseline 不被呼叫者或公開adapter資料變動改寫。

提交成功須確認 `{mode,item,origin}` 完整ACK與本次輸入／預覽／來源／生成初版吻合。不良ACK保留表單及預覽，同一完整payload+previewHash重試同一Idempotency-Key；改payload才更換key。實際409使預覽失效但保留輸入，不能自動換來源版次或覆寫其他人結果。這是POST原子生成，沒有PATCH冪等或自動回復來源的承諾。

讀取與保存沿目前user／org／role／employee／hash／parent mount／trigger／render序號守門。頁面失效取消讀取、關閉過期表單／詳情、丟棄晚回應；已提交交易不能被client abort宣稱回滾。沒有native alert／confirm／prompt、沒有新CSS／token／dialog／toast／下載owner。

合法100筆×每行2000字依據可超128KiB；root已確認只有 service-billing 的 preview/create 採1MiB body上限，其他API保持。伺服器對完整來源2MiB上限全拒，不截斷或省略保存來源。

## 候選驗證與接線

pure候選12項首輪實際exit0，後續補同日ISO分鐘／原ISO保留及100行長文完整保存，共14項於 `pure-r02.log` 實際exit0。唯讀審查發現保存ACK比較呼叫者來源時會讀取未知getter；新增回歸先保存 `getter-regression-r01.log`，實際exit1／14通過2失敗，包含getterCount=1及可選preview accessor未拒絕的重現。窄修先封閉來源與可選preview，再比較私有複本；新增兩項必要守門後共16項於 `pure-r04.log` 實際exit0，來源／nested／array／preview getter呼叫數都為0。舊 `READY-r01.json` 保留，不覆寫失敗證據。

候選browser有9個memory SQLite／隨機loopback完整流程稿：來源與選擇零寫、預覽零寫、真提交不良ACK同key重試、生成／目前／trial分列、從保存來源導覽原帳單介面真正開立及登錄已收款（取消收款及作廢保留API末端驗證，來源不釋放），真來源個案改名使previewHash失效、1440／375／390表單／預覽／來源footer、finance合法預覽後在合成記憶體資料庫真正撤銷會員再提交403且全表零寫／所有表單欄位完整保留、兩受限角色與真已提交晚回應context。作廢後來源不存在斷言先等待另一筆合法来源已正確顯示，避免讀取中誤判為0。撤權是明示合成fixture寫入，失敗零寫比較從撤權完成後開始，不假冒應用程式會員管理功能。

本機正式接線後browser-r03九項／九項actual exit0，12份來源SHA前後一致、pageErrors0／nativeDialogs0。25張1440／375／390pxPNG由作者逐張實看；整合者新圖另歸屬。r01起始load timeout在同條件診斷未重現，不推定歷史唯一原因；r02原owner正確顯示$239.01但fixture預期元的失敗及source guard變更均保存，r03精確dd斷言修正而timeout不放寬。正式scope以整體verification-v071.json為準。

自有promote五檔：`public/data/service-billing-editor.js`、`public/modules/service-billing.js`、`tests/service-billing-editor.test.mjs`、`tests/service-billing-e2e.mjs`、本scope。候選另有唯讀support copy `public/data/billing-document-editor.js`供pure resolve，與正式既有helper同SHA，不可promote覆蓋。Root 接nav／app/admin wrapper與server五條route；新UI不修改共享owner。測試與來源只用合成資料，不碰私人DB、env、binding、4310、DNS、外部訊息或部署。
