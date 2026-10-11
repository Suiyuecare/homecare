# 完整日期跨日流程整合（0.74，本機驗收完成）

班表、服務與請假可明確保存開始及結束日期，沿既有缺欄舊資料模式；不縮寫或重算原ISO文字。已核閱服務保留原計價快照；跨日來源於人工帳單與薪資以固定完整來源捕捉，不推定夜間加給、月額度或跨月拆帳。日曆逐日呈現午夜區段，工作台包含前日開始而本日延續的班次；週期產班、整組改期與移日保留不可變原slot和追溯。

採明確 opt-in calendar-two-day-v1，原 legacy API、Source12及既有快照欄位分支保持。伺服器完整驗證個案及員工重疊、核准請假、已執行鎖定、整批最終候選及全歷程；格式不明或曾跨日而資料損壞時整體拒絕，沒有猜測修復。technical同日／翌日邊界不代表法定工時或薪資核定。

原八組目錄、180項對等清單、十二契約與所有舊狀態保持。必要unit、HTTP、合成十一表備份與還原、完整流程及桌機／375／390像素、APM／Portal與受影響回歸完成後才標示本機完成。共用設計來源不變；不使用私人資料、不操作4310、不發布、背景排程保持停止。

候選及原失敗證據：outputs/software/v074-shift-span-candidates、outputs/software/v074-shift-span-ui-candidates、outputs/software/shift-span-completion-qa。Root窄補已核閱explicit服務歷程缺billingSnapshot閉鎖，純legacy原分支保持；首頁時間文字只重用既有pre-wrap class。正式核定規則、原平台對等、部署及真實使用者UAT另驗。

本機完整驗收與原始失敗追溯見 outputs/software/full-system-completion-qa/verification-v077.json。正式核定與發布另驗。
