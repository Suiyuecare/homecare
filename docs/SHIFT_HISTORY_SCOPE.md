# 排班異動與改派歷程切片（0.7）

> 公開版本文件：記錄此功能版本的設計與驗收條件，並非目前公開副本已執行的驗收證明。私人盤點與 QA 產物未匯出；現行行為以 API.md 與原始碼為準，正式規則及部署仍須核定。

本輪為獨立本機、合成資料的唯讀契約。沿用既有單班調整/代班、PATCH版本衝突、不可變record_versions及稽核；不另建改派流程或版本表，不改有服務紀錄不能改派的規則。原總班表及個案班表仍partial/unverified。結構化代班原因/申請核准/通知、批次改派、永久週期、跨夜、資格/額度與正式差勤規則仍未完成。

## 授權與版本可見範圍

依docs/API.md及model.scopedRows：必須先有權讀取目前shift，否則404；機構由membership選取，跨機構不通過。admin/supervisor/finance沿既有唯讀API範圍，僅admin/supervisor的班表與caregiver的我的服務新增入口，不新增finance排班頁。

所有角色的shifts歷程，包含不帶compare的raw history，僅保留snapshot.caseId存在於當前同機構可讀cases集合的版本。歷史個案可以不同於目前個案，因既有排班可改個案；不能因關聯不存在或越機構而揭露歷史內容。caregiver再要求snapshot.employeeId為ctx.employeeId，不擴張目前自己的班次/個案授權。改派出去後該shift目前不可讀；新承接者只見自己的版本。A→B→A時A可以見v1/v3，但v3不能拿v1冒充精確前版；同一人改個案後舊個案目前不可讀，舊版亦隱藏。若另有目前自己的班次仍使舊個案可讀，該舊版可見，沿現有cases授權，不擅自排除取消班次。

## 比較及操作者

GET /api/shifts/:id/history?page=&pageSize=&compare=previous沿既有分頁。每列追加actor:{id,name}|null及comparison:{status:initial|available|unavailable,previousVersion,previousSnapshot}，compare省略維持原欄位。重複或非法compare回422。先做完整版本授權，再比較精確version-1，之後分頁；跨25筆頁界可比較，缺失/被過濾前版unavailable且兩個previous欄位null，不跳版。v1為initial。

actorsByVersion僅對shifts接受同org/entity/recordId及精確detail.version的record.create、record.update、shift.complete，實際users identity及目前姓名；其他entity仍只接受record.create/update。同一版有缺失身份、不同身份或不合法稽核不能推測操作者；沿既有衝突身份為null規則，不使用source、時間附近事件、目前員工/督導或鄰版替代。核閱自動完成的真shift.complete應顯示實際核閱者。前後snapshot均publicRecord，不能新暴露計價快照。讀取不寫DB、版本、audit或idempotency，不更新主檔或核閱快照。

## 共用介面

沿public/modules/history.js openRecordHistory及ui.js openDetails/wide，新增shifts白名單：caseId、employeeId、carePlanId、date、startTime、endTime、services、status、note，顯示個案、服務人員、照顧計畫、服務日期、開始/結束時間、服務項目與排班數量、班次狀態及交班備註。不顯示orgId、內部metadata或價格。services仍按serviceItemId及數量比較，忽略排序及非白名單內部值，不修改來源。

班表各列及我的服務各班次增加「版本歷程」唯讀入口，沿既有native button、loading/empty/error/retry、分頁、Escape/關閉及焦點恢復，user/org/role/hash/renderVersion guard。關聯使用呼叫者已授權lookup；姓名/code明示目前名稱，照顧計畫沒有name時以目前可讀的起訖日期/狀態辨識，保存ID可展開。取得不到目前主檔明示，不以舊版中的未授權主檔取名。班次services標示「排班數量」，計畫仍「計畫數量」。沒有還原/覆寫/發送訊息動作。桌機與手機沿既有可展開版本卡、620px差異表格內捲動，無整頁溢出；不另造歷程dialog或CSS樣式。

## 驗收

Node：真PATCH改派/日期/時段/服務/取消、同機構與四角色、A→B→A與歷史case可讀/不可讀、raw/compare一致過濾、精確前版缺口/頁界、真核閱shift.complete actor及計價快照不變、缺失/歧義/錯scope與錯version操作者、唯讀全counts不增加、既有有服務紀錄改派409、跨機構404、非法compare422。純差異驗白名單與services、不修改來源。

真Chromium：班表與我的服務入口、真實改派差異及授權版本缺口、取消/完成/核閱操作者、保存欄位與目前關聯名稱、26+版本頁界、keyboard/Escape/focus、503重試/慢回應關閉/切機構/換頁、空歷程/名稱不可取得、1440/390畫面逐張檢視，唯讀區段DB total_changes/audit/records/versions/idempotency不變。執行既有全部回歸。必要整合與browser驗證後才標此切片implemented_verified，原不能標完成。
