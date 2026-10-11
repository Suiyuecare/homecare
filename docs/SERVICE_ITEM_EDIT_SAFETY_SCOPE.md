# 服務項目安全編輯（0.26 獨立本機切片）

2026-10-09 凍結，service-item-edit-safety-v0.26 / RM-03。沿既有服務項目 CRUD、角色、CAS、POST 冪等、分鐘／日期／同機構代碼唯一及服務關聯限制；僅合成資料。原正式支付、薪資、額度與機構完整功能仍待核定，不新增政策或部署。

八個業務欄：code、name、minutes、unitPriceCents、validFrom、validTo、status、note。純 createServiceItemEditor 捕捉八欄原 JSON own-presence 及 id/orgId/version，表單不得展開 row 或內部欄。正常未變／改回原值省略；無變更沿 version-only PATCH，未發明無版本寫入。無法原樣預填的缺失／null／異型／CRLF／非法 enum 等原值在 DOM 外保存，只提供原生保持／取代控制。日期及備註可明確清空成空字串；其他欄不提供清空。保持仍可能被原合併驗證拒絕，保留輸入並提示修復，不猜或正規化原值。

新增預設分鐘30、測試單價0.00、啟用；送完整八欄。code/name 字串且無 CR/LF，note 字串且無 CR，保留空格與 LF，不 trim；新寫必要文字非空、最多500，note最多10000。原過長但可預填的未改字串省略。分鐘只有安全整數1..1440能正常預填；替換亦此範圍，沿 number 控制項。日期只有空字串或有效四位非零年 YYYY-MM-DD 可進 native date；0000年原API可接受而native不能原樣展示，因此保持／取代。日期不依今天推斷；同日允許，雙日期倒置由原 merged API422處理。

價格表單別名 unitPrice 使用 text、inputMode decimal 的有限共用 descriptor，避免共用 number 收集時的浮點／指数轉換。原安全整數0..1e9分用 BigInt 商餘數產生精確兩位元字串；替換採 ^\d+(?:\.\d{1,2})?$，不 trim，BigInt 計算並比較0..1e9後才 Number；拒空白、正負號、指数、逗號、三位小數。等值分數省略，即使元文字樣式改變。unitPriceCents 的後端欄錯誤只在本入口映射至 unitPrice。列表測試價格沿已有 formatTrialPriceCents 精確顯示一分與異常值，不改全域或其他金額欄。

原 API PATCH只驗證送出的欄位：新增／替換 number safeinteger0..1e9，分鐘另1..1440，其他欄字符串與上限。合併後四必填 missing/null/''/[]拒；status必active/inactive；truthy日期必有效且起迄不可倒置；minutes做原JS <1/>1440；unitPriceCents省略除必填外不重驗型別／範圍。歷史數字字串／物件／false等能否 keep 不由 adapter重新定義，對精確例子以真 API 驗證。沒有原 in-use 主檔鎖；改價／啟停不改核閱快照與舊班次，後續建立排班／紀錄按原 active/date 判斷。

新增、編輯沿 openForm isCurrent:alive；啟停沿既有 confirmAction isCurrent 有限 opt-in。完整 user/org/role/employee/hash/generation/render stamp/連線 guard、AbortSignal、busy鎖、dirty確認、原生鍵盤與焦點。取消請求不代表伺服器已提交資料回滾。捕捉原 id/version，不重讀覆蓋CAS，不自動重試PATCH。保存成功須確認plain item、同org/id、safe version(新增1／編輯old+1)，全部八欄 own-presence及JSON精確投影吻合後才toast/refresh，啟停只送 status+version 亦確認全部八欄。失敗、422、409、未知2xx與POST回應中斷保留輸入／intent／同冪等key；過時晚回應不能復活。

admin/sup 原寫入；finance維持唯讀，caregiver沿原目前自己的shifts引用主檔讀权、不加導覽。沿唯一共用視窗，不新增控制器／CSS／路由／資料表；19後端、版本歷程與其他入口保持。唯一共用表單變更允許 inputMode numeric/decimal 的 descriptor，預設 caller無變化。

必要驗收：純8欄JSON保留、price0/1/12345/1e9／相等／非法字串、optional clear、日年0000／nullable／异型、複合原值與回應 own-presence、identity/CAS邊界；真 HTTP lifecycle角色／跨機構／CSRF／同POST key／duplicate409／原merged必填日期分鐘邊界及approvedbilling保持。真瀏覽器完整八欄往返、保持取代清空、真409/422／不實2xx／POST中斷重試、取消零寫與busy/nativekeys、edit/status loaded/pending各六context（24情境）及真已提交晚回應，四session原scope與31報表出口；十一表raw/count/total_changes、雙BLOB與六trigger對帳。全部Node、原25套browser350聚合gates、逐張新UI與直接相關服務項目歷程／公告安全編輯回歸；舊報表沿同artifact修訂檢查，不新增PDFmarker或宣稱新人工PDF驗收。

完成必要整合與逐張瀏覽器視覺验证後才局部 implemented_verified。原84/52/28/16條與順序／status／parity、16/359表單目錄、四來源hash、九階段／12待核契約／0原completed與localReportKinds9保持；更新RM-03獨立局部證據及RM-07已排程cross-module指標，不把正式價格／完整差勤標完成。0.7–0.25封存proof SHA保持，新0.26來源與證據另封存並逐份核SHA。
