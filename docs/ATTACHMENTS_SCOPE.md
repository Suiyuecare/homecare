# 個案附件切片（0.5）

本輪提供獨立本機附件流程；沿用已授權持續建置及合成資料限制。RM-02與原個案基本頁仍partial；原醫事意見表仍not_started。原盤點notes/case-evidence.json只觀察到醫事意見頁的上傳入口，不推定原完整附件、保存期限、病毒掃描或儲存介接規則。

## 資料與保存

case-attachments metadata放既有records；欄位caseId,title,category,note,status，以及伺服器產生fileName,mimeType,sizeBytes,sha256,fileId。caseId/title必填，category預設general（一般文件）；其餘care（照顧文件）、administrative（行政文件）、other（其他）。status active（使用中）或inactive（已停用），預設active。文字trim；title最多200字、note10000字。分類不是正式敏感等級或法定文件分類。

建立後caseId不可更換（409 CASE_IMMUTABLE），須同機構存在個案；暫停／結案個案仍可維護。一般PATCH接受title/category/note/status及version，也可重送相同caseId；UI不提供更換個案欄位。fileName/mimeType/sizeBytes/sha256/fileId等衍生欄位不能直接寫入。一般POST /api/case-attachments拒絕（405 UPLOAD_REQUIRED），只能經專用upload建立。

SQLite新增attachment_files immutable BLOB表：id,org_id,attachment_id,case_id,file_name,mime_type,size_bytes,sha256,content,created_at。檔案與metadata版本、稽核、Idempotency回應須同一交易提交；失敗不留下孤兒檔案或部分版本。禁止BLOB UPDATE/DELETE，不採用使用者檔名作為磁碟路徑。既有資料庫與個案資料保留；不將合成附件注入實際試用資料。

fileId僅內部使用，一般read/write/history回應及diff均不提供；沒有直接blobId、公開靜態路徑、inline預覽或外部分享網址。metadata版本保存指向當版檔案；只改描述沿用同一BLOB，更換檔案建立新的BLOB與metadata版本，舊版保留。

## 檔案驗證

一次選一檔；decoded bytes須1至5*1024*1024（5 MiB）。JSON contentBase64須canonical base64（不含data URL、空白或非法padding，decode後重新encode相同）。只有兩個專用上傳端點將body上限提高為8*1024*1024，其他API仍128KiB。

副檔名與mimeType須一致：.pdf/application/pdf、.png/image/png、.jpg或.jpeg/image/jpeg，副檔名大小寫不敏感。伺服器另檢查PDF起始%PDF-、PNG八位元組簽章、JPEG起始FFD8FF。這只是基本檔型識別，不宣稱完整文件有效、無病毒或醫事內容驗證。

fileName trim後1至180字，須有上述副檔名，拒絕ASCII控制字元、DEL及/、反斜線。sizeBytes及sha256由伺服器計算。超出byte/body上限413，檔名／MIME／簽章／base64等不合法422，檔案錯誤使用fields.file，metadata錯誤使用對應欄位。

## 端點與角色

- POST /api/case-attachments/upload：{caseId,title,category?,note?,status?,fileName,mimeType,contentBase64}，回201 {item}。先角色／CSRF，再bounded body；使用Idempotency-Key。
- POST /api/case-attachments/:id/replace-file：{version,fileName,mimeType,contentBase64}，回200 {item}。當前同機構紀錄／個案及version再次驗證；使用Idempotency-Key，相同成功請求重送不增加檔案或版本。
- GET /api/case-attachments、/:id、PATCH /:id、/:id/history?compare=previous：沿用共用格式、分頁、category/status/q/caseId篩選及CAS。category非法或重複422。
- GET /api/case-attachments/:id/download[?recordVersion=N]：省略N下載目前版；N為單一正整數metadata版本。非法或重複422，版本缺失／不可讀或檔案關聯不符404，不回退目前檔案。

admin/supervisor維護；finance沿個案唯讀；caregiver只讀目前可讀個案所屬附件，包含停用紀錄與可讀舊版。正式附件敏感分級及欄位遮罩待核定。跨機構或他案GET detail/history/download回404，列表先限制範圍再篩選／分頁；寫入403。上傳及檔案替換audit沿record.create/update並保存精確detail.version供actor辨認。

每次下載重新授權目前附件與個案，再選精確history快照。所有角色歷史快照須caseId===目前caseId且個案可讀。BLOB查詢須同時匹配org_id、attachment_id、case_id與snapshot.fileId；檔名／MIME／大小／hash metadata亦須與實際BLOB匹配。回應attachment Content-Disposition（安全ASCII fallback與UTF-8 filename*）、正確Content-Type/Length、nosniff、no-store。不接受任何使用者磁碟路徑或任意URL。

本機切片GET列表／歷程／下載均不寫入；版本與上傳稽核可追溯，但正式檔案存取稽核、保留期限、加密、掃毒、備份／還原、外部儲存與原檔案移轉仍待另行核定及建置。

## 共用歷程與介面

history-fields.js新增白名單caseId/title/category/status/note/fileName/mimeType/sizeBytes/sha256；不做檔案內文diff。沿用精確actual actor／previous comparison。history.js增加optional versionActions({version,signal,isCurrent})→DOMNode；僅附件使用『下載此版本』，下載依版號由伺服器決定檔案，不用snapshot.fileId。

個案詳情contacts之後新增「個案附件」獨立區塊，獨立載入／重讀／搜尋／category/status篩選與25筆分頁。卡片顯示標題、類別、狀態、檔名／格式／大小及備註；校驗碼可在歷程查看，不擠入主流程。上傳、更換與metadata編輯分開表單；停用／恢復先確認，取消不寫入。原個案資料／版本不變。

root擴充ui.js canonical file field：回File|null、不預填File、明示檔名／大小、移除選檔、空檔／大小／副檔名驗證及ARIA；native picker單檔，不提供drag-only操作。提供MAX_ATTACHMENT_FILE_BYTES、ATTACHMENT_FILE_ACCEPT、formatFileSize(bytes)、attachmentFilePayload(file,{signal})→{fileName,mimeType,contentBase64}，及downloadAttachment(id,{recordVersion,signal,isCurrent})。單檔上傳沿共用表單indeterminate busy、逾時保留選檔與metadata，可用同Idempotency-Key重試；busy時沿既有表單阻止關閉，不宣稱取消已提交交易。成功status但JSON body讀取逾時/格式錯誤或缺少有效item確認時仍拋錯並保留表單、選檔及重送鍵，不僅以HTTP狀態判定完成。

新增／更換每份表單保持Idempotency-Key；開始讀檔前及讀檔後、送API前均驗目前機構／頁面。失敗或真409保留File與輸入，不靜默覆寫。下載helper有15秒逾時、401處理、signal／目前context及isCurrent保護；切案／切機構／關閉歷程後，慢回應不得自動下載。object URL用後revoke；內容不進URL、localStorage、分析或console。

## 驗收

整合測試核對格式／decoded byte邊界／base64／header注入、原128KiB維持、原子保存／Idempotency／CAS、同機構／固定個案／角色、metadata與舊檔下載、精確版缺口與篡改fileId/metadata拒絕、BLOB不可變、列表／歷程／下載零寫入、原case完整資料與版本不變及持久化重開。

瀏覽器用真File、合成bytes、memory SQLite及隨機埠，驗證上傳／更換／metadata／停用恢復、下載bytes一致、真409選檔保留、28筆分頁／搜尋、角色／舊版、503重試、成功提交後JSON body讀取中斷/缺確認同鍵恢復及慢回應、鍵盤／焦點、1440/390px與逐圖檢查。完成後才將獨立附件切片標implemented_verified，原RM-02保持partial。
