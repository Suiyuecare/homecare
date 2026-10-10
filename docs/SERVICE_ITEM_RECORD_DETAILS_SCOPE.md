# 服務項目目前完整保存資料（0.62，本機必要整合與瀏覽器驗收完成）

使用者已授權持續建置。原服務項目列表缺少備註，財務無編輯或歷程入口；本切片讓原有使用者直接閱讀目前保存內容。僅本機獨立功能，不代表原平台全量對等或正式支付契約完成。

## 範圍與唯一 owner

只在 `/service-items` 原列表增加「查看資料」。原可見角色 admin、supervisor、finance；caregiver 不增加導覽或入口。finance 只有查看，原管理者／督導編輯、啟停及歷程保持。共用 `public/data/saved-record-details.js`、`public/modules/saved-record-details.js` 與 `ui.openDetails({wide:true,guardedRead:true})` 維持原 bytes；新 domain adapter、新薄 UI profile、admin 列入口及有意義的 pure／browser 驗收。不得增加 controller、observer、timer、CSS、shared UI 行為、伺服器、schema、角色、查詢、下載、列印或寫入。

每次明確開啟／人工重讀才 fresh `GET /api/service-items/:id`，使用精確 ID 與 AbortSignal，不使用列表內容、舊版本或目前價格代替保存資料。不自動重試、輪詢或新增批次查詢。父清單重載會移除 trigger；loaded／pending 失效均沿同一 guardedRead owner 清空、abort、關閉，晚回應不可復活。捕捉 user/org/role/employeeId 四 primitive、outer context、hash、alive 及 trigger.isConnected；nested 同 primitive 參考替換可保持，outer context 重建撤除。角色及非空 user/org preflight 沿 employee profile。

## 八個保存欄位

順序與標籤沿 `getHistoryFields('service-items')`：code「服務代碼」、name「服務名稱」、minutes「預設服務分鐘」、unitPriceCents「測試單價（新臺幣元）」、validFrom「有效起日」、validTo「有效迄日」、status「服務項目狀態」、note「備註」。metadata 五欄 id/orgId/version/createdAt/updatedAt 確認；畫面沿原 shared owner 顯示版次、保存更新文字、保存建立文字及識別碼，不改 org 展示規則。

文字與日期保留任意保存原文、空白及 CR/LF，不解析日期或計算效期。missing、empty、null、text、non-text 五種保留；未知／巢狀欄位不讀不展開；已知 accessor 拒絕整份回應且 getter 零執行。封閉 `{item}` 回應與 `{id,orgId}` requested、own enumerable metadata、精確同 org/id、安全正整數 version、任意字串 timestamps 沿共用 pure。ID 沿 `[a-f0-9-]+` 既有 route grammar，不新訂 UUID。

minutes 為 finite number 時只以 String 呈現原 numeric primitive（含 0、負值、小數或超出正常寫入範圍的保存值），不 coercion、不改數字、不判有效分鐘、不換算工時；原保存字串原樣，其他型別沿型別標記。這是閱讀 legacy/import 保存值，不放寬 server 正常寫入驗證。unitPriceCents 的 number/string/boolean primitive 沿原 `formatTrialPriceCents`，missing/null/empty 沿五種標记；array/object 不展開。非負安全整數沿 BigInt 精確元與原分，無 Number coercion 或新價格規則，formatter原bytes保持。

status 已知 active／inactive 顯示啟用／停用及保存碼，未知非空文字顯示未辨識狀態及保存原文；其他kind沿標記。note 跨整列、`pre-wrap`、原文無 innerHTML。標題「服務項目保存資料」、region「服務項目完整保存資料」、`data-service-item-field` 白名單八欄；notice簡短說明保存值／日期不推定實際服務或效期結果，金額仍是試算、正式支付碼與核定價格待確認，不重算已核閱快照。

## 驗收邊界

先作者 source syntax／pure，再完整測試來源凍結。root跑必要相關整合與browser（不用把所有 configured commands 都重跑），數字來自 actual native receipt/log，full unit/check、最低Node22.13相關、原服務項目 edit/history、員工／面試共用詳情、core、visual、APM CIS與HTTPS合成Portal。新真browser至少驗三角色fresh單筆、同名及停用、八欄／型別／精確分值／保存日期、非法回應與descriptor、503手動重讀／無自動查詢、六loaded＋六pending守門及實際GET取消、父列重載、nested／outer context、Escape／inert／focus、1440與390px長文首尾Range與footer hit-test，逐張實際view_image。

使用 memory SQLite／隨機 loopback。三讀角色與原 caregiver 本人服務項目範圍、跨機構404、未授權寫入403、原真 edit/status/history／CAS及核閱價格快照不重算均保持。十一表、六不可變trigger、schema、全raw rows、兩BLOB與核閱snapshot、total_changes每個read segment exact；fixture寫入另列連續ledger，不UPDATE不可變版本。明確區分正常API fixture與INSERT-only memory異型／缺欄匯入。

原封存與所有失敗、原180目錄／9phase／12contracts／2enhancements及60本機milestones精確保留。預計只加獨立本機 milestone，相關RM仍partial，不變原completed0。公開使用隔離工作樹、明確安全路徑、合成test/publicdocs；不讀或發布原平台帳密、真DB/env/binding/backups、私人QA，不動4310/DNS、不購買主機或正式部署。APM CIS／Portal本機回歸不代表正式持久主機、HTTPS、Portal發布或真實公司UAT；未知資格、薪資、支付、評分及介接仍待核定。
