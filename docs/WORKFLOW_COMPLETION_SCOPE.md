# 0.67 永久週期、契約、待辦與自訂表單

本次直接開發，背景排程維持停止。沿APM品牌、原角色及機構隔離、CAS版本、POST冪等、records／record_versions、稽核及唯一 ui.js。只用合成隔離資料驗證；不改私人帳號、DB、備份、DNS或正式部署。接受結果以 outputs/software/workflow-completion-qa/verification.json 為準，檔案存在不代表驗收通過。

## 可操作入口

- 日常照顧「永久週期排班」，班表另有捷徑。
- 日常照顧「契約與期限」。
- 人員與機構「內部待辦」。
- 紀錄與報表「自訂表單」。

新增 shift-series、case-contracts、internal-tasks、form-templates、form-records，沿原 GET／POST／PATCH／history。管理型資料與自訂表單僅admin／supervisor；internal-tasks四角色讀取、僅兩管理角色寫入，finance／caregiver僅本人目前受指派項目與本人過去受指派的保存版本。

## 永久週期

無尾日或指定尾日設定，週一起算每1至4週、服務星期、同日時段與允許服務。逐期範圍含起迄最多93日；預覽不寫，產班單一交易重新核對全部原班次、計畫、員工、服務效期、重疊及核准請假。保存每班來源設定版次與閉合快照，重跑／重疊範圍不重建已產生日期，包括取消的班次。設定修改只影響尚未產生班。

整組明確選取查詢期間全部尚未執行且無服務紀錄的班次，最多50筆；改派、取消、同日改時段，必填本次原因與每班version。已有紀錄或已完成班排除並標明原因。產班追溯保存原records／record_versions，不增加表／trigger，無公開內部追溯CRUD；壞追溯無法完整核對則409、零寫。linked班個案與原日期固定；沒有跨夜或移日期。

API：POST /api/shift-series/:id/generation/preview|commit、adjustments/preview|commit；GET /api/shift-series/:id/occurrences。範圍含設定version，commit須Idempotency-Key及單一交易。詳 SHIFT_SERIES_SCOPE.md。

## 契約與待辦

契約草稿可編輯；人工記錄生效須簽署日期、文件參考及依據，生效後內容鎖定。人工终止／到期須本次日期與新原因；續約另建同案新紀錄，日期不重疊、原契約保留。期限查詢依明示asOf，不自動改狀態或推定法律效力。

待辦保存工作內容、受指派員工、期限與低／一般／優先程度。待處理→處理中→已完成，或已取消；完成需本次結果，取消需新原因，終態不可再改。本人角色只讀，不能藉頁面或API自行指派／完成。詳 CONTRACTS_TASKS_SCOPE.md。

## 自訂表單

修訂序號与SQL version分清；最多20群組、50題，七型短文字／多行／十進位文字／日期／單選／多選／是或否。條件只支援前序非多選題與一個型別正確的相等值，無eval／計分。發布後鎖定，停用不改舊填答，新版另建模板。

填答保存published SQL版本的完整模板快照、同案附件引用及精確十進位／多行原文。草稿可保存未完成答案，提交須全部可見必填完整，提交後鎖定。hidden題不能偷偷保存舊答案；介面先確認清除或回復條件。附件只引用原有同案有效資料，不複製BLOB。

模板／填答POST及PATCH採4MiB；schema最多1000000字元，answers最多600000，超限拒絕而非截斷。其他generic紀錄維持128KiB，核銷沿原4MiB。詳情與列印fresh讀取保存快照，歷程呈群組、型別、選項、条件、完整可見答案與引用附件識別碼，不序列化未知rawJSON。詳 CUSTOM_FORMS_SCOPE.md。

## 共用與驗收

createForm.setHidden隱藏整組控制、disable後代並保留原值；重新顯示恢復先前disabled，hidden選項重建也保持隱藏。业务adapter明確確認清除不適用答案或回復控制條件；不良ACK／保存失敗保留草稿，POST重試同一key，未動CRLF與空白不重寫。不新增CSS／字型／token／picker／dialog所有者。

新清單及單筆query封閉，重複／非法值拒絕；單筆無query，history僅page／pageSize／compare=previous。新閉合類型無效目前JSON、保留metadata注入及unsafe SQL版次不可見、不修補；每份歷程核對SQL版次、固定父項及閉合內容。原舊類型語意維持。

必要新瀏覽器：pnpm run test:e2e:shift-series、pnpm run test:e2e:contracts-tasks、pnpm run test:e2e:custom-forms。整合另驗33頁、四角色、375／390／760／1023／1024／1440px與APM／合成Portal。已知原盤點來源缺一舊檔不捏造；所有失敗與已接受證據保留。完整180對等、52報表／28匯出／16原模板、正式計算規則、資格／積分及正式主機／HTTPS／Portal仍按核定清單逐項驗證。
