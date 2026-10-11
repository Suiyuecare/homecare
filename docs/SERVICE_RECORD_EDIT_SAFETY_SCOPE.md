# 服務紀錄安全編輯切片 0.35

狀態：契約凍結；實作與驗收狀態以 BUILD_STATE.md 及本輪 verification 為準。僅合成本機測試；原功能全量對照仍未核定。

## 原規則與邊界

原十個保存欄：shiftId、caseId、employeeId、date、actualStart、actualEnd、services、status、note、reviewNote。原有 `/records`、`/my-services` 的填寫入口，以及 `/records`、個案詳情的核閱入口保持。財務唯讀、居服員限本人、admin/supervisor 維護與核閱，伺服器機構隔離、Origin/CSRF、CAS、不可變版本與逐版授權保持。

draft/returned 可編輯；submitted/approved 直接 PATCH 鎖定。returned 保持 returned、改 draft 或再 submitted 皆是既有合法行為，UI 不預先改成 draft。reviewNote 只經 review 寫入；核准由同一後端交易產生價格快照並完成班次。原 API 允許 draft/returned 合法整組改派；本切片不新增改派控制項，保持目前捕捉的四個關聯／日期欄，不能稱 API 關聯不可變。

原時段只要求同日且結束晚於開始，接受 HH:mm／符合當日的 ISO；不要求落在排定時段內，不推工時或定位。原服務數量 1..10000、1..100 項、不重複、同機構有效服務，且 ID 包含於班次及目前有效計畫；不要求 quantity 小於排班或計畫數量。原日期包括 0000 的相容性不變。legacy reports 的非字串日期 month 500 不在本切片。

## 編輯與保存契約

新增維持五個業務控制項：實際開始、實際結束、實際服務與數量、服務紀錄與觀察、儲存方式；由目前班次補上四個必要關聯／日期，不送 reviewNote。編輯只送改變欄位，未改十欄及原 own-presence／JSON 值保持；note 可明確清空。ISO 時間、非字串／缺失／CR 文字等無法無損預填值，以原生「保持原值／以本次輸入取代」處理；原值不塞入控制項。services 編輯一律整欄保持／明確取代，取代才從目前可讀班次服務與主檔選取；保持不重建、不排序、不清掉缺失 lookup。保存仍經原 merged 全筆驗證，污染必要欄／服務可能 422，不能自動修復。

保持 returned 不自動重送；只有明確改 submitted 才送核閱。原審核兩控制項 decision/reviewNote 保持，退回需非空白說明的既有 UI 規則保持，保存文字不 trim。create/review 同一 dialog、同 payload 重試沿同一 Idempotency-Key；PATCH 仍 CAS，不自動更換 version 或重試。

所有寫入入口沿 canonical openForm 完整 user/org/role/employee/hash/render guard、signal、忙碌鎖定、dirty／Escape、錯誤保留輸入。2xx、空 JSON、錯誤 id/org/version 或十欄 own-presence／JSON 投影不吻合不能顯示成功或關閉。review 確認明確 status/reviewNote 與其餘八欄保持；billingSnapshot 是後端專屬衍生欄，不在 UI 推價或重算，整合驗證快照保持／遮罩及核准完成班次。失效清空／關閉、中止且忽略晚回應；Abort 不代表已提交交易回滾。

## 共用介面與安全投影

沿 public/ui.js、styles.css、DESIGN.md 的原生 controls、雙欄桌機／390px 單欄。新增 pure service-record editor adapter，不增加 DOM 元件、控制器、token、CSS、通知或依賴。服務紀錄自身時間／服務／文字使用 typed 安全投影；合法完整 ISO 原文可見，未知 JSON 不 coerce 成文字或執行 HTML。班次／其他報表投影保持。

## 驗收門檻

1. pure 與真實 HTTP：五控制項／十保存欄、sparse own-presence、缺失/null/typed/CR、ISO/0000 保持、services 保持／取代、returned 保持／重送、create/review 冪等、身份版本／每欄偽回應拒絕。
2. 原角色／機構／CSRF／CAS、submitted/approved 鎖、合法改派、原時間與服務數量邊界、完整交易／精確 actor、價格快照遮罩／不重算、核閱完成班次；失敗與唯讀所有 11 表及非空附件 BLOB／6 trigger 保持。
3. 真 Chromium：兩填寫入口／兩核阅入口、桌機與390px、鍵盤／focus／dirty／busy、原生三態保存、空／loading／error／retry／長文字、未知保存結果保留輸入、create/review 同鍵重試、版本衝突、完整context失效與已提交晚回應、四角色；逐張圖檢視至少一個 sibling 流程。
4. 全 Node、source check/build、premium-ui.json 所有命令與必要既有瀏覽器迴歸通過。所有失敗原始輸出保留、不宣稱 first-pass；原生 OS popup 未驗項目明示。
5. 最終來源 hash、實際 process exit、QA 證據及 BUILD_STATE／PRODUCT／API／UX／追溯清單同步；完成前不標已驗證。actual4310 不重新載入、不登入、不寫入；不部署、不使用真實個資或原平台帳密。
