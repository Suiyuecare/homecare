# 證照與訓練唯讀版本差異與操作者（0.12）

> 公開版本文件：記錄此功能版本的設計與驗收條件，並非目前公開副本已執行的驗收證明。私人盤點與 QA 產物未匯出；現行行為以 API.md 與原始碼為準，正式規則及部署仍須核定。

原生效日、進修年度、積分、附件、法定資格與排班連動仍partial/unverified或待核定。沿既有record_versions、稽核、證照及訓練寫入規則，不新增還原／更換員工／積分計算。

## 授權與比較

GET /api/employee-certifications/:id/history及/api/employee-training/:id/history，沿既有page/pageSize及新增compare=previous。auth與guardPersonnelAccess保持：管理者／督導可讀同機構紀錄，財務403，居服員只讀自己的紀錄。居服員未連結同機構active員工沿既有auth 403；他人／跨機構或目前紀錄不可讀404。管理者／督導可讀停用員工的保存紀錄；不把效期或紀錄狀態當作權限。

先scopedRows(entity)核對目前紀錄可讀，不擅加目前employee join或修改目前資料讀取規則；再對所有角色raw與compare逐版要求snapshot.employeeId === current.employeeId，且歷史employeeId存在於目前scopedRows('employees')可讀集合。這是建立後不可改的員工歸屬，不能沿用班次A→B→A的可改派歷史規則。缺失／同機構其他員工／跨機構員工污染的版本隱藏；若目前紀錄可讀但父員工已不存在，歷程集合為空，不猜父項或擅加404。居服員另沿自身employeeId限制。所有過濾先於精確version-1比較，最後沿既有25預設／100最大分頁。

raw維持{version,snapshot,createdAt,source}；compare=previous追加actor:{id,name}|null及comparison:{status:initial|available|unavailable,previousVersion:number|null,previousSnapshot:object|null}。v1為initial；缺版／無權前版為unavailable且previous兩欄null，不用其他可見版本代替。28版25+3頁界仍能比較頁外精確前版。非法／重複compare維持422，其他不支持entity仍拒絕。每版及前版沿publicRecord遮罩，其他entity契約不變。

## 精確操作者與原保存值

兩種personnel entity只採同org/entity/recordId與精確整數detail.version的record.create/update。service.review與shift.complete不採用；姓名來自實際users目前名稱，不能以員工、督導、source、相近時間或鄰版猜測。缺user／合法候選身份衝突為null；同user重複可辨識，非法version/scope/action忽略。baseline／缺前版不推測操作者。

證照八欄依序employeeId「員工」、name「證照名稱」、certificateNo「證照編號」、issuer「發證單位」、issuedOn「發證日期」、expiresOn「到期日期」、status「紀錄狀態」、note「備註」。訓練八欄依序employeeId「員工」、name「課程名稱」、category「訓練類別」、provider「辦訓單位」、date「訓練日期」、trainingMinutes「實際訓練時間（分鐘）」、status「紀錄狀態」、note「備註」。category職前／在職／其他沿既有文案；證照active有效紀錄／revoked已撤銷，訓練completed已完成／cancelled已取消。

日期只呈現保存日期，空expiresOn明示「未填到期日」，不依目前asOf重算expiryState／daysToExpiry。trainingMinutes純數值差異，以保存整數及分鐘單位呈現，不四捨五入／轉積分。白名單排除id/org/version/updatedAt、expiryState/daysToExpiry/asOf、trainingHours/statutoryCredits以及billingSnapshot等內部值；不修改來源。移轉格式不合法時沿共用scalar顯示原可判讀值，不把未知猜成零。

## 共用介面

personnel.js刪除自訂snapshotDetails/showHistory與重複分頁／請求controller，以兩頁既有「版本歷程」按鈕呼叫唯一history.js openRecordHistory／ui.js openDetails，wide／可展開版本卡／單欄保存內容／620px差異表局部橫捲。lookups只用renderList已授權fetchAll('employees')形成的Map；不為缺失名稱額外查取資料。員工名稱清楚標為目前名稱，保存ID可展開。

保留既有列表／搜尋／員工及狀態分類／效期／截至日／分頁、新增／編輯／撤銷取消恢復／失敗輸入／寫入重送與原員工管理入口。共用history的user/org/role/employee/hash與呼叫者generation/container guard，已載入與慢讀失效都清空、abort、關閉；晚回應不復活、Escape回復焦點。personnel的alive可補role/employee與container renderVersion，避免同container其他render替換後仍活著；不修改寫入流程、ui.js或CSS。其他未通知client的授權變化仍在下次請求驗權，不宣稱即時推播撤權。

## 驗收條件

Node含兩entity真API建立／編輯／撤銷取消／恢復與精確actor、四角色raw/compare／跨機構／inactive與未連結、不可改父項／歷史污染／父項缺失／精確缺版／28版頁界、actor缺失／歧義／錯事件／baseline、完整10表rawState/count/total_changes零寫、CAS／EMPLOYEE_IMMUTABLE／append-only trigger與既有費用薪資／核閱billingSnapshot不變。純差異測試驗八欄、日期／空期限／實際分鐘、元資料排除與來源不修改。

真Chromium含兩頁真UI新增編輯撤銷取消恢復、目前員工改名後歷史日期／分鐘不變、兩入口與居服員自身歷程／財務拒絕、28版分頁／缺版／未知actor或名稱／空歷程、503重試／取消／Escape焦點／已載入及慢讀的hash/org/role/employee/render失效。client role/employee fixture明示只是UI context，真正API權限由登入session另驗；不能把fixture稱伺服器撤權。read區間只GET並逐段完整10表不變，approved快照不重算。1440/390截圖全部逐張view_image後才完成；舊personnel E2E selector只可調整為共用介面語意，不刪除原功能驗收。
