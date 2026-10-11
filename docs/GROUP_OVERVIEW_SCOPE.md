# 已有授權的跨機構營運概覽

本機整合驗收已完成：outputs/software/full-system-completion-qa/verification-v077.json。下列候選階段紀錄保留原時間與驗收界限，最新完成狀態以整合收據為準；沒有正式發布、真實營運UAT或原平台全量對等。

候選尚未接線；不代表已完成或正式集團權限。只使用目前登入帳號在每個選取機構既有的管理者 membership，不創新角色、不按 email 開通、不跨機構共享員工或個案。

管理者明確選取1至10個自己具有管理者權限的機構及一個基準日。每次在讀取資料前，重新查目前機構與所有選取機構的會員；任一撤權或角色不同時整份拒絕。輸出目前保存的個案／員工紀錄數、使用中個案／員工數、基準日開始的非取消班次及其中已完成班次、目前待核閱服務紀錄、基準月份已核閱紀錄，另列七個開始日的班次／核閱紀錄趨勢。不算工時、價格、收入、薪資、滿意度或資格；跨夜只按保存開始日计筆數。合計是各機構紀錄筆數相加，同一人若在不同機構有紀錄會各計一次，不冒充集團去重人數。

可以從每個機構數字查詢所計入的目前紀錄識別、版次、姓名／編號（僅個案和員工）、開始日與保存狀態；同機構來源且 current／immutable head 一致，壞 JSON／unsafe SQLversion／身份注入／不完整日期或狀態會整份拒絕，不略過、不修資料。概覽給出完整來源fingerprint；查明細及翻頁每次重讀並確認同 fingerprint，來源變更需重新取得概覽，不能把新版明細冒充旧數字。

GET `/api/group-overview?organizationId=…&organizationId=…&date=YYYY-MM-DD`。固定 closed query，1至10個不同機構；GET `/api/group-overview/records?organizationId=…&date=…&metric=…&fingerprint=…&page=…`，單個已授權機構及25筆頁；GET `/api/group-overview.csv`同概覽query，完整CSV安全文字處理。角色守門先於query和資料讀取。全部JSON／CSV2MiB、每個實體完整讀取上限50000，超限整份拒絕；無寫入／稽核／重送鍵或schema物件。

UI沿APM CIS、現有stats/table/form/details/download/print owner；機構選取不更改使用者原目前機構。清單名稱是現在授權機構名稱，統計不等於政府／財務報表。對话框、下載、fresh列印及晚回應由captured context／user／org／role／原父控制項生命週期取消。完成必要原子拒絕／逐筆核對／member撤權／版本變更、CSV／列印、桌機與375/390後才接受。本契約不取代跨機構調派、正式指標或集團身分去重政策。

日期選擇0001至9999合法日，舊保存year0000不改寫；0001起日的七天趨勢可以跨到0000。使用中是目前保存狀態，當日班次排除取消，待核閱是目前全部submitted，核閱月份按開始日。CSV包含notice、total、每機構summary及完整七日trend；統計模式與fresh取得時間同行。匯出／列印重新讀取目前總覽，明示數字可能更新；追查必以原fingerprint與原total閉鎖。只個案／員工指標可返回保存name／number，班次／服務固定空字，不因未知保存欄披露其他文字。

## 已執行候選驗證

12項SQL／pure（sql-r02.log）與6項真HTTP（http-r04.log）原生exit0；合成memory／randomloopback，admin兩既有授權機構、每筆計數與25筆追查、完整19欄CSV七日趨勢、撤權／跨機構／坏資料整份拒絕、unsafeSQL、descriptor-first accessor零次、legacy year0000與ISO原秒offset無損。50001界線用實際SQL包裝器模擬返回完整超限，不宣稱50000真資料壓力測試。Portal綁定即使另有既有membership仍只原綁定機構，真HTTP證明。組織目前名稱納入完整fingerprint，改名也拒舊追查。最初mirror glue anchor失敗與HTTP text去BOM fixture native1保留；改為arrayBuffer保留原字節後不刪減斷言通過。尚待正式整合、UI、全回歸／瀏覽器／真像素，不能標功能完成或上線。
