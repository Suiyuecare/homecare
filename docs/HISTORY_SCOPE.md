# 個案與照顧計畫歷程切片

> 公開版本文件：記錄此功能版本的設計與驗收條件，並非目前公開副本已執行的驗收證明。私人盤點與 QA 產物未匯出；現行行為以 API.md 與原始碼為準，正式規則及部署仍須核定。

此輪將現有版本快照呈現在個案列表、個案詳情及照顧計畫的唯讀歷程中。只驗證獨立系統的資料與介面契約，原仍是局部實作。

0.4新增case-contacts歷程，共用以下精確操作者與前版比較契約；其固定個案及歷史歸屬限制見docs/CONTACTS_SCOPE.md。原0.3兩類歷程語意不變。

## 範圍與相容性

原計畫歷程有生效日、結束日、備註及B+C碼給付額度等欄位；本輪不推定其等同本機的每筆計畫版本，也不補造給付額度。

本輪提供本機個案與計畫的完整業務欄位快照、每版操作者及相鄰版本差異。聯絡人群組、附件、家系／生態圖、正式給付規則、歷史資料移轉及原異動內容等價核對仍待後續建置。

## 歷程API契約

GET `/api/cases/:id/history?compare=previous&page=1&pageSize=25` 及 `/api/care-plans/:id/history?compare=previous&page=1&pageSize=25`；0.4亦支援`/api/case-contacts/:id/history?compare=previous`。未傳compare維持既有回應；其他compare值及上述三類以外實體要求compare會回422。

在既有row的version、snapshot、createdAt及source外，增加actor及comparison。actor為實際稽核使用者的識別與目前姓名，或null；只採同機構、實體、紀錄且detail.version精確符合的record.create/update，不以時間接近或source猜測。缺失或身份衝突顯示「未記錄」，合成種子及baseline資料不假造操作者。

comparison.status為initial、available或unavailable。version=1為initial。只有精確version-1同樣可讀，才能回available及previousVersion／previousSnapshot；缺失或被權限篩選的上一版回unavailable，兩個previous欄位均為null。先完成授權與歷史可見性篩選，再比較及分頁；跨分頁仍可比較，跨缺口不能推定相鄰版本。所有快照套用既有publicRecord遮罩。

## 介面契約

- 使用ui.js openDetails，不提供還原、刪除或修改按鈕。讀取、分頁、重試及關閉不增加業務異動。
- 每版以可展開卡片呈現版本、修改時間、實際操作者與保存內容；日期及手機欄位保持可讀。
- 只比較白名單中的個案／計畫業務欄位。空白、null與未提供視同未提供；CMS等級0仍是數值，不能視為空白。
- 服務項目依serviceItemId及quantity比較，忽略陣列排序；項目新增、移除與數量變動仍顯示。差異不修改快照物件。
- initial顯示初始版本；unavailable只顯示本版並說明上一版本不可取得；available但業務欄位相同顯示沒有業務欄位變更。
- 關聯人員、個案與服務名稱由有權讀取的目前主檔顯示並標示目前名稱；未取到名稱保留原識別。不冒充當時名稱或追加跨權限查詢。
- 居服員只讀其有權查看的個案與計畫歷程，從個案詳情進入計畫歷程；財務沿用原個案／詳情唯讀範圍，不新增計畫頁權限。
- 開啟即顯示載入，失敗可重試，關閉中止請求、Escape回復焦點；過時回應不能復活已關閉介面或寫入新機構頁面。

## 驗證門檻

測試包含操作者正確與缺失／衝突、版本與跨頁比較、授權後上一版缺口、跨機構與他人拒絕、純差異白名單／排序／空值／不修改輸入。瀏覽器以實際修改後的個案聯絡資料與計畫目標／數量核對版本快照及前後差異，檢查1440／390px、角色唯讀、失敗重試、延遲關閉、焦點與零寫入。

原功能仍須欄位、流程、輸出及業務驗收逐項核定。
