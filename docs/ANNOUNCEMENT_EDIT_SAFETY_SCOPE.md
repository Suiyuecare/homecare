# 公告安全編輯切片 0.25.0

本機 RM-07 獨立功能；沿 0.24 公告歷程與原 CRUD/CAS/冪等、角色及機構範圍。原平台頁面、發送／閱讀追蹤及正式部署仍未驗收。

## 保存政策

- 四個業務欄位只有 title、body、audience、status；編輯只送明確變更欄位，加既有版本。新增四欄皆送出，預設 all/draft。禁止 row spread 帶出其他 metadata。
- 全無差異沿原 version-only PATCH，建立內容相同的新版；不新增「無變更禁止保存」規則。
- 可以原樣預填的 title（無 CR/LF）、body（無 CR）、已知 audience 五選項及合法 status 採共用原生控制項。空白及 Unicode 不 trim。變更後改回原值視為未變更，PATCH 省略。
- 無法原樣預填、未知、缺失或非文字保存值不放進控制項、placeholder、help 或隱藏欄位。顯示一般保存型別提示，原生「保持原值／取代」決策預設保持；取代才啟用空白輸入。audience 另可明確「清空」成空字串；取代可選五個既有值。title/body/status 不提供清空選項。不新增 audience enum 後端限制。
- title/body 必填及 status enum 沿原合併資料驗證：缺失/null/空字串/空陣列的必要文字，或不合法 status，保持原值後保存仍可能 422，须明確取代。非文字非空匯入 title/body 與任意 audience 若省略可沿既有 API 保留；不承諾修復匯入資料。顯示原值由唯讀歷程負責。
- 取代的 title/body 要非空字串，body 最多 10000 字，其餘最多 500 字，沿原 API 限制。required 只用於正常或取代模式，不阻擋保留無法預填值。

## 操作與確認

- 新增／編輯用共用 openForm 的 isCurrent opt-in 與 AbortSignal；撤回草稿用共用 confirmAction 的 isCurrent opt-in。其他 caller 預設行為維持。以 admin 現有 alive 捕捉 user/org/role/employee/hash/render；載入或保存中失效都移除操作內容、取消請求，不顯示成功或重讀舊頁。Abort 不是伺服器回滾；需重讀確認。
- 保存期間鎖住輸入與重複提交；取消/Escape 不得在 guarded pending 撤回中假裝撤銷成功。錯誤保留輸入、intent、同一新增冪等 key；dirty/Escape/焦點沿共用表單。
- 2xx 必須有 plain item、非空 id、正確 orgId、版本新增 1／編輯 row.version+1、原 id、四欄正確 own-property presence 與 JSON 值；未送欄位與保存前投影一致。invalid confirmation／不可讀 response 一律保留操作並顯示未確認訊息，不 toast、不 refresh。409 不抓新版覆蓋或自動重送；新增同 payload 的未知結果重試用同一 key。
- 撤回只 PATCH status:draft，加 row.version；同樣驗四欄、id/org/version。成功後保留舊版本與稽核。標題等缺失引發原 422 的邊界不略過。

## 驗收

合成資料驗證 normal/create/edit/revert、未知／空 audience、CRLF／特殊文字、非文字／缺失保留边界、明確取代／清空、四欄型別／長度、2xx 欄位及 presence 不符、403/422/409/回應失敗、POST 穩定冪等、撤回草稿及歷程讀權。loaded/pending 的六種 context 都取消 edit 與 withdrawal；dirty/鍵盤/桌機與 390px 版面、finance/caregiver 不可寫、共用表單回歸、readonly DB/BLOB/計價/31 報表、現有實際資料與舊封存完整性皆需證據。

只在整合、瀏覽器與畫面人工檢視完成後標示本切片 implemented_verified；原 84/52/28/16/359 追溯及待核定規則不改。
