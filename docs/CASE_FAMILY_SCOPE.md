# v0.69 人工多代家庭成員與關係圖

本切片提供個案內人工維護的家庭成員、世代排列、連線與完整文字說明。它不是標準臨床家系圖，不推定親屬、年齡、性別、遺傳、疾病或照護分數，不把文字紀錄當作醫事判斷。世代完全由使用者明確指定，父母連線方向與圖上排列可以不同。

## 可操作範圍

個案詳情「人工家庭關係」捷徑進入兩份名冊。管理者、督導可新增、編輯、查看詳情、停用、恢復、搜尋與查看版本歷程。成員與連線各自固定25筆分頁；關係圖另讀完整同案資料，搜尋或切頁不會截斷圖。圖顯示使用中成員與連線，另提供完整文字名冊，手機使用既有局部橫向捲動容器。

- 家庭成員：所屬個案、姓名或稱呼、與個案的人工關係、人工指定世代、性別文字（選填）、狀態、完整備註。
- 家庭連線：所屬個案、起點成員、終點成員、人工種類（父母→子女／伴侶／其他）、狀態、完整備註。
- 世代必填，保存為數字整數 -5 至5；UI需明確選擇，不預設或計算世代。性別保存人工文字，不用圖示推論性別。
- 同案最多200位成員與400組連線，包含已停用資料。完整圖超限失敗，不截斷、不丟失已存資料。
- 原個案及已建立連線兩端固定。需更换兩端時，先明確停用原連線，再新增。
- 使用中的連線兩端必須是同機構、同案的使用中成員。拒絕自連、重複使用中連線、父母方向循環；伴侶反向視為同一組。允許多位人工父母，不發明臨床限制。
- 停用有使用中連線的成員會回409。先逐筆明確停用所有相連使用中連線，才能停用成員；沒有暗中連動、批次刪除或級聯改寫。恢復時先恢復成員，再恢復需要的連線。

## 安全與保存

兩個 entity 為 `case-family-members`、`case-family-links`。只有 admin／supervisor 可讀寫，finance／caregiver 在解析非法欄位、查詢及敏感資料前回403。每次寫入於既有交易中重讀機構、父個案及成員；保留CAS、同 payload 冪等重試、不可變版本與實際 actor 稽核。DELETE沒有新增支援。

完整關係守門比對本機構 `records` 原始筆數與安全讀取筆數。壞JSON、未知metadata、unsafe SQL版次等不能被略過後誤認沒有連線；圖與涉及完整圖的寫入回409，不自動修補。單筆／歷程不暴露壞資料或孤兒參照。歷史快照固定原個案／識別／兩端並驗SQL版本；過去有效的使用中邊在成員後來明確停用後仍保留歷史。

姓名、人工關係、性別最多100字，備註最多10000字，ID最多500字。保存原文的首尾空白、LF、CRLF。原生單行控制項不能無損呈現換行、textarea不能保持CR時，表單明示「保持原文／以本次輸入取代」，選填文字可明確清空。未變更不送覆寫、無改動不發PATCH。只有完整 closed ACK核對機構、原案、identity、CAS與所有原文後才顯示成功。失敗保留輸入、冪等key可重試；換案或身分改變會取消舊操作。

共用 `public/ui.js` 是唯一表單、dialog、confirm、dirty、toast、搜尋、分頁與錯誤入口。沿APM品牌tokens，不新增CSS、對話框或焦點管理。SVG由本模組建立視覺資料圖，沒有另一套互動owner。

## API契約

- `GET/POST /api/case-family-members`，`GET/PATCH /api/case-family-members/:id`，`GET /api/case-family-members/:id/history`。
- 連線API以 `case-family-links` 同樣路徑。
- list只接受各一次 `page/pageSize/caseId/status/q`；分頁預設1/25，API pageSize最大100，UI固定25。q最多200字，成員只搜尋人工姓名／關係／性別／備註，連線只搜尋人工備註，不能無意讀其他entity。
- single拒絕任何query。history只接受各一次page/pageSize/compare，compare只可previous。拒未知、重複、科學記號、前導0、尾CRLF及非正整數。
- `GET /api/cases/:id/family-graph`：不接受query，GET限定，先role guard，再原案sameorg guard；回 `{caseId,orgId,members,links,totalMembers,totalLinks}`，完整各item含id/orgId/version/createdAt/updatedAt；全部唯讀零寫。
- generation以spec `jsonFields:['generation']` 交專屬validator驗「數字整數-5..5」；不修改通用正整數規則，不接受任意JSON、字串或coercion。

## 驗證狀態

本輪自有 direct/pure/真HTTP 28項已通過（memory DB、隨機loopback）；含三代diamond／any-length cycle、明確停用順序、反向伴侶重複、跨機構／跨案／父案消失、未知及getter形狀、unsafe SQL版次、查詢精確語法、CAS競態、冪等、角色先拒絕、完整原文及不可變歷史。專屬native Chromium fresh完整流程18 gates／11張圖／14來源SHA前後一致／0 pageerror通過；全部11張最新圖皆實際 tools.view_image檢視像素，未發現重大視覺缺陷。

保留初始候選：`outputs/software/v069-candidates/family-tree/`。根節點負責所有共用model/index/history/operations與全來源、備份整合验收。只本機人工業務流程；不宣稱原平台全量對等、臨床圖標準、正式部署或線上可用。

最終自有驗證證據：

- `outputs/software/v069-case-family-qa/integration-unit-final.log`：28 tests（10 direct／7 pure／11真HTTP），native exit0。
- `outputs/software/v069-case-family-qa/browser-1791643596971-b2fefe81/verification.json`：18 gates、11screens、14source SHA stable、0pageerror，native exit0。
- 同目錄 `pixel-review.json`：逐圖實際像素觀察與SHA。
- 原失敗／來源改動紀錄保留：`browser-1791643132414-8222de6d`（錯ACK錯誤路徑Map迭代已修）、`browser-1791643238315-3d5b348e`（shared history SHA改動）、`browser-1791643472379-19d34888`（shared ui及signed literal守門SHA改動）。後兩次完整功能通過仍以SHA守門標示失敗，沒有當作驗收。
- 根節點全來源、全站回歸、共用合成備份／還原仍由根節點核定；自有正式8檔至此凍結。
