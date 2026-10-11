# 證照附件（0.14 獨立本機切片）

2026-10-08 凍結。依 RM-01 certification-attachments-v0.14，補既有證照紀錄的本機附件功能；合成資料，不使用原平台、個資、付款、正式部署或外部儲存。必要整合、持久化、瀏覽器及逐圖驗證後才 implemented_verified。原證照完整欄位、資格、年度積分、正式列印與全系統仍 partial/unverified。

## 資料與固定父項

新增 certification-attachments entity，metadata 欄位 certificationId/title/note/status(active|inactive)，預設active使用中，inactive已停用；certificationId/title必填。文字trim、title1至200字、note最多10000字。無category／訓練附件／法定分類。employeeId由目前同機構employee-certifications.employeeId推得，僅伺服器保存，不允許client POST/PATCH；fileId/fileName/mimeType/sizeBytes/sha256同樣伺服器產生。一般POST405 UPLOAD_REQUIRED，專用upload建立；PATCH接受metadata與version，可重送相同certificationId，改父項409 CERTIFICATION_IMMUTABLE，其他衍生欄位422 UNKNOWN_FIELD。新附件／版本／BLOB不升certification或employee版本。

保留case-attachments/attachment_files原表、欄位、API與角色，不將certificateId放入case_id。新增 immutable certification_attachment_files：id,org_id,attachment_id,certification_id,employee_id,file_name,mime_type,size_bytes,sha256,content,created_at；references organizations及records，再由應用核對entity/org；1..5MiB與length(content)=size_bytes CHECK，scope索引與UPDATE/DELETE拒絕trigger。共11張業務表／6個不可變trigger；既有10表及4trigger名稱/SQL保持，CREATE IF NOT EXISTS，不替換資料庫。metadata→version→BLOB→audit→idem回應同交易提交，任何失敗無孤兒檔；metadata編輯沿用同BLOB，replace新增BLOB保存舊版。

fileId在所有read/write/raw/compare回應刪除；無直接BLOB端點、inline預覽、公開網址或磁碟路徑。歷史版本指向當版BLOB，只以metadata版號請求下載，不信任client fileId。保存ID不是可用的下載URL。

## 角色、目前父項與歷史

admin/supervisor維護；caregiver有效同機構員工連結，只讀自己的證照附件（寫入403）；finance全部list/detail/history/download/upload/PATCH/replace403，早於body讀取。新entity每次目前讀寫需目前cert可讀、cert.employeeId存在於目前scoped employees、attachment.employeeId===cert.employeeId；父證照／員工不存在、跨org、不同entity／歸屬污染404。列表先授權再篩選分頁；不改原cert本身current無employeejoin的孤立資料語意。

證照revoked／附件inactive／員工inactive不額外剝奪admin/sup既有維護，caregiver停用auth仍403；到期/asOf不作附件授權，不能因上傳附件宣稱資格通過。固定父項，每一raw/compare版本要求snapshot.certificationId===current.certificationId及snapshot.employeeId===current.employeeId===目前cert.employeeId，父項仍可讀。精確version-1過濾後比較，缺口unavailable、v1initial、25預設100最大與28版頁界保持；actor僅同org/entity/id/version record.create/update實際users，不猜source/相鄰版，publicRecord雙snapshot維持。

新upload與replace在idem之前重驗目前父項/附件可讀，callback內再次核對；已成功同key回應不得繞過後續父項失效，合法父項的相同成功重送不增加版本／BLOB，不以舊version擋成功快取。不同內容同key409。新增與一般metadata PATCH、replace沿Origin/CSRF、CAS；角色先拒絕，沒有擴大原case附件權限。

## 端點與檔案驗證

- POST /api/certification-attachments/upload：{certificationId,title,note?,status?,fileName,mimeType,contentBase64}，201{item}。
- POST /api/certification-attachments/:id/replace-file：{version,fileName,mimeType,contentBase64}，200{item}。
- GET /api/certification-attachments[?certificationId=&employeeId=&status=&q=&page=&pageSize=]、/:id、PATCH /:id、/:id/history[?compare=previous]，共用格式。certificationId只此entity有限filter，重複/格式非法422；越界不可讀父項404，employeeId/status/q沿既有全域語意。caregiver只自身。
- GET /api/certification-attachments/:id/download[?recordVersion=N]：省略下載目前metadata版；單一正整數精確版本，非法/重複422，缺版/不授權/篡改404，不回退其他檔。

沿唯一validateAttachmentFile與metadata helper：canonical base64、decoded1..5MiB，PDF/PNG/JPEG副檔名/MIME及基本簽章、trim檔名1..180、ASCII控制/DEL/斜線拒絕、server SHA256/size。只有新兩upload/replace加原兩端body8MiB，其他128KiB不變。不宣稱完整檔案有效或掃毒。

下載先重驗current，再選精確snapshot，完整tuple=(org,attachment,certification,employee,fileId)固定SQL；snapshot id/org/version、固定父項、檔名/MIME/size/hash與BLOB相符，實際bytes長度/hash及檔型再核對。只抽純版號解析、bytes/metadata檢查與安全headers供原case及新cert adapter重用，不接受client動態table/parent/URL。Content-Disposition attachment、安全ASCII fallback與UTF-8filename*、Content-Type/Length、nosniff/no-store保持。

所有GET/list/history/download零寫入；版本及上傳異動audit可追溯，正式下載存取audit、保留/刪除、加密、掃毒、備份/還原、外部storage與原檔移轉待核定，不在本輪宣稱完成。

## 共用介面

證照列表每筆新增「附件」，在同頁選定證照附件panel（單一選定父項，標題/證照/員工身份清楚，關閉回復原觸發焦點）；不用外層modal包列表，避免內層表單/歷程多重dialog。/training不新增附件，finance不新增導覽。panel共用既有attachments列表／上傳／metadata／replace／status／history controller，有限allowlist case/cert entity與parent設定，原case default保留；cert adapter薄，不複製第二套async流程。category只原case顯示；cert title/note/status沿相同card/form/file元件、搜尋/status/25筆分頁。

檔案一次一檔，共用native file field、accept/5MiB、移除選檔、實際檔名/大小與ARIA。新增、replace各form保持同Idempotency-Key；開始讀檔及讀完/送API前驗context。成功HTTP但body讀取錯誤/缺有效item時保留File/metadata/key；重試不多建。真409/503/逾時保留輸入，不靜默覆寫。busy沿原表單規則，取消未送交不寫。

共用downloadAttachment只加有限entity allowlist且default case API/檔名原相容，不接受任意URL；15秒timeout、401、signal/isCurrent、完整user/org/role/employee/hash、panel父項/generation/render stamp guard。關閉panel、改選證照、切頁/機構/身分/重繪，pending及已載入歷程清空abort關閉，晚download不落地，object URL釋放。未通知client的server撤權在下次request驗證，不稱即時撤權。

history-fields白名單依序certificationId「證照」、employeeId「員工」、title「附件標題」、status「附件狀態」、note「備註」、fileName「檔案名稱」、mimeType「檔案格式」、sizeBytes「檔案大小」、sha256「SHA-256校驗碼」。reference僅目前已授權cert/employee Map，缺名稱不跨scope查取。history「證照附件版本歷程」沿共用owner及版本動作「下載此版本」，不做檔案內文diff。無新CSS，原case卡片與dialogs保持。

## 驗收與追溯

Node：真API生命周期/actor、四角色與跨org、父cert/employee缺失/污染與inactive/revoked、固定父項、fileId全面遮罩、精確版/tuple/metadata/bytes篡改404、25/28版與gap、metadata沿BLOB/replace保留舊bytes、基礎檔型/檔名/base64/精確5MiB及8MiB/一般128KiB邊界。CSRF/CAS/成功idem重送與父項失效重驗、原子rollback無孤兒、6trigger／11表GET零寫、cert/employee/case原附件與版本及核閱billing/fees/payroll不變。臨時合成DB重開與既有schema增量保存實測。

Chromium：真File上傳/metadata/replace/停用恢復/版本下載bytes/hash、四真登入角色/父項scope、不明成功body保File/key重試不增BLOB、真409/503保留及焦點、列表28筆/搜尋/status/分頁、精確舊版與actor/原parent版本不變、history loaded/pending失效及晚download、手機1440/390逐張view_image。fixture只記憶體/臨時DB，全部11表read區間不寫、approved snapshots保持；角色/員工client fixture明記，不冒稱server會員變更。新測試PDF是合成上傳/下載檔，無新生成報表或marker；已有報表回歸沿原provenance/envskip限制。

root全Node與舊13套browser必要回歸，原hardcoded10表assert只能明示加第11表覆核，保留全部原驗收、不降低原條件。原84/52/28/16目錄/順序/來源/status/parity/9階段與0原completed保持；僅原證書頁追加本機證據/localMilestone。0.7至0.13封存不覆寫，0.14新不可覆寫程式/證據快照，完整驗證前維持in_progress。
