# v0.70 候選：內部通知與本人回執

狀態：本機整合驗收完成（accepted_local）。原候選仍保留在 outputs/software/v070-internal-receipts-candidates/；正式router/model/history/app已接入，實際HTTP、瀏覽器、像素及整體備份均已驗證。正式部署及原平台對等另驗。

此切片保存機構管理者／督導明確指定人員的通知，以及認證本人自行記錄的閱讀、回覆與更正原文。沒有 Email、簡訊、推播、帳號開通、Email 自動綁定、送達期限、法律簽收、評分或義務推論。沒有回執不代表未讀，閱讀或回覆不代表理解或正式義務完成。

## 資料與權限

- 公開通用實體 `internal-notifications`：title、body、recipientUserIds、status、note、cancellationReason、publication。title最多200字；本文、管理備註與取消原因各10000字；保持完整 CRLF、LF 和空白。發布快照為 server-only，client 即使提交 null 也拒絕。
- 收件人明確1至100位、不重複，僅目前同機構會員；姓名／角色來自 users + memberships，不按 email 推定。居服員沿既有認證要求目前綁定同機構 active employee。管理者／督導可维护；四角色僅按目前會員與通知範圍讀取。
- 通知草稿只有管理者／督導可見。發布的 `publicationVersion = old.version + 1`，至少2；快照 `{publicationVersion,title,body,recipientSnapshots,publisher,publishedAt}`，每个人快照只有 `{userId,userName,role}`，沒有 email。發布後固定原文、收件人、管理備註及發布快照；只有本次明確原因可取消。取消終態不可再編輯。
- 一般收件人 DTO 僅本文、狀態、取消原因、發布版次／時間／發布者，以及自己的發布收件人快照與五個 metadata；不暴露其他收件人或管理備註。管理者／督導 DTO 保持完整閉鎖 record。
- 內部 `internal-notification-receipts` 不加入 public entities，沒有通用 CRUD。只沿現有 records／record_versions 儲存，不增加 SQL 表或 trigger。固定 SHA tuple（org／通知／發布版次／本人）派生 UUID。
- 回執欄位 notificationId、publicationVersion、recipientUserId、recipientSnapshot、status、reply、readAt、repliedAt。本人／角色／時間皆伺服器派生；client 只傳精確 publicationVersion、receiptVersion、action、reply。
- 回執 read／replied，首次閱讀時間固定；可直接明確提交首則回覆。更正回覆使用CAS建立新版、保留舊原文。不刪除，不重設閱讀；取消通知封鎖新保存但保留既有本人歷程與管理者實際已保存清單。
- 所有本人 GET、提交、歷程、idem cached preflight 都重新讀取目前會員；居服員重新確認同機構 active employee。管理者不能代他人回執，自己也需明確列入收件人。
- current 通知與回執必須對應 immutable head； malformed JSON、unsafe SQL version、錯配、head 不一致不當作不存在後重建。不能自動修補、遺失舊版或抹除證據。

## 入口與 UI

候選 export `mountInternalNotifications(container,{isCurrent})`。APM 共用 pageHeader、table、pagination、searchBox、openForm、confirmAction、openDetails、errorState、toast、openRecordHistory；沒有新 CSS、dialog、focus 或控制項 owner。

一般操作包括：新增／編輯普通草稿欄位、checkbox 明確指定收件人、發布確認、取消本次原因確認、通知全文詳情、本人閱讀確認、本人回覆／更正、本人逐版原文歷程、管理者已保存回執25筆分頁、搜尋／狀態／本人收件匣。

完整草稿／回覆原文若原生 input／textarea 无法無損呈現，顯示保持／明確取代／選填備註明確清空的意圖欄位。未改動欄位不 PATCH；同一批勾選只是順序不同不改寫原始順序。既有收件人已不符合目前選項則封鎖編輯並要求核對，不能暗中移除。

失敗保持表單原文，重送同一明確 payload 使用同 key，改 payload 換 key；ACK 核對閉鎖完整 DTO、機構／本人／識別／新版本／所有提交與未改原文。context object、org、user、role、employee、hash、isConnected、isCurrent 全部固定；失效取消請求，不顯示成功。

## Endpoint 契約

| Endpoint | 方法 | 角色／用途 |
|---|---|---|
| `/api/internal-notification-recipients` | GET | admin/supervisor；目前有效同機構 ID／姓名／角色選項，page/pageSize/q/role |
| `/api/internal-notifications` | GET/POST | 可讀清單／管理者草稿；list page/pageSize/q/status/view（managed僅管理者，mine為本人明確收件匣） |
| `/api/internal-notifications/:id` | GET/PATCH | 已授權通知／管理者CAS草稿編輯、發布或取消；GET無query |
| `/api/internal-notifications/:id/history` | GET | raw scope 先確認，再投影各版；page/pageSize/compare=previous |
| `/api/internal-notifications/:id/my-receipt` | GET/POST | 明確本人收件人；GET零寫，POST mandatory idem + 原子交易，無query |
| `/api/internal-notifications/:id/my-receipt/history` | GET | 只有本人逐版完整回執原文；page/pageSize，无compare |
| `/api/internal-notifications/:id/receipts` | GET | admin/supervisor，實際已保存清單；page/pageSize/status(read或replied) |

回執 body 精確 `{publicationVersion,receiptVersion,action,reply}`，action為read／reply；新增 receiptVersion=0，更新為當前CAS。read必須reply空文字；reply必填且10000字內。body不收recipient／actor／createdAt／status。未知或重複query、CRLF／指數／前導零分頁、任意代理參數一律422。預設1／25，pageSize最多100。

## 驗收與限制

候選 direct memory SQLite + pure 第一輪22項 native exit 0，`candidate-unit-r01.log`；增加 current head、明確管理範圍守門後第二輪22項 native exit 0，`candidate-unit-r02.log`。最後閉鎖發布角色、read回執版次、不可缺漏audit、receipt/notification兩種ID的ACK及最小本人投影filter回歸，見 `candidate-unit-final.log`（23項 native exit 0）。七檔 syntax native結果 `candidate-syntax-final.json`。final source與檔案SHA清單請見同目錄 HANDOFF.json。

13 injected tests 覆蓋精確發布版本／raw text、收件人角色與父員工重驗、發布鎖定／取消原因、本人zero-write GET、拒代理body、CAS及單一locator、先閱讀後回覆／首則直接回覆、認證撤銷、取消保留歷程、strict query、corrupt JSON／unsafe version／head mismatch、audit失敗完整rollback、實際26回執25分頁。另1個server pure filter與9個editor pure tests覆蓋普通欄位、完整名單不暗刪、最小本人投影filter不讀其他收件人／管理備註、明確transition、lossless ACK、回覆保留原文、精確識別與CAS、完整dense分頁，以及0 getter execution。

正式接線後6項真HTTP與原23項pure／injected共29項actual exit0，另1項完整十一表六trigger備份／還原／失敗切回通過。實際Chromium12項、11圖、13份monitored source SHA穩定，pageErrors0，全部11圖由作者實際view_image。候選預期13流程已以實際12流程收據訂正；根本搜尋API呼叫失敗r01保留，修options-object後r02通過。source／unit／browser／pixel精確證據見outputs/software/v070-internal-notifications-qa/HANDOFF.json。整體接受見outputs/software/internal-workflows-completion-qa/verification-v070.json。

回執不是正式送達或義務完成證明；僅明確指定的站內操作，不外寄。不能將本機完成當作正式網域、真實營運UAT或原平台全量對等。
