# 員工證照紀錄總表：0.23 獨立本機切片

2026-10-08 凍結。依保存證照與既有效期提醒，不推定正式資格、排班資格或原報表匹配；整合、瀏覽器及逐圖完成後才標本機完成。

## 授權與日期

三GET `/api/certification-report`、`/api/certification-report/export`、`/api/certification-report.csv` 共用builder。guardPersonnelAccess('employee-certifications',ctx,true,fail)早於query/ref：admin/sup同org（含停用員工）、caregiver本人且原active link每次驗權，finance三出口403。沿原scopedRows，不parent join漏掉缺失/foreign/wrong-entity父項可讀證照；姓名/員編只取scoped employees map，缺失空字串／UI「—」。指定不可讀employeeId先404。原auth/model/schema/personnel/certificationView/附件/history不改，caregiver超safe employee version先auth500的匯入限制保持。

精確filters `{startDate,endDate,q,employeeId,status,asOf,expiry}`。start/end是**保存核發日期issuedOn**，不是原平台生效日、建立日或到期日，含端≤366日，初載/清除臺北當月。asOf是**效期截至日期**，三出口必填有效YYYY-MM-DD，初載/清除臺北今日；改asOf需重新查詢/輸出，不依generatedAt改分類。沿既有dateValid含0000年行為。status active「有效紀錄」、revoked「已撤銷」，空全部。

expiry空「全部效期」；expired「已到期」、due_soon「即將到期」、valid「有效期內」、no_expiry「未填到期日」、revoked「已撤銷」。只在驗證有效日期後呼叫原certificationView(item,asOf)：早於asOf過期，當日到30日即將到期，31日以後有效，空/未保存expiresOn無到期日，撤銷優先。這是現有提醒，**不判定issuedOn是否已生效或合法資格**，未來核發日列仍沿保存日期可讀。沒有daysToExpiry數值欄或資格合計。

q原文≤200 UTF-16、不trim/截斷/語法，不分大小寫在任一白名單文字欄literal includes，與其餘filters AND；只員編/目前name、證照name/certificateNo/issuer/note及合法statusLabel。**不搜尋衍生expiryLabel**（用效期下拉）、日期/ID/version/隱藏PII/fallback，不拼欄。未知/重複/非法422，嚴格page/pageSize沿原25/100；full拒分頁。共用query有限opt-in `asOf=false,expiryLabels=null`，其他報表預設/語義保持。

順序：scope→employee/status/q候選→全部候選issuedOn dateValid→核發範圍→全部範圍內id非空字串/positive safe version/合法status/expiresOn有效且不早於issuedOn→原helper→expiry篩選→排序/分頁。expiresOn只允許有效string、''或未保存undefined（投影''）；null/object/非字串異常409，撤銷也先驗日期。範圍內異常不能用expiry排除或頁外隐藏；q/status/employee/scope排除的紀錄不驗。任何候選必要異常整份409，不跳列。沿safeVersionReader，不改SQL/auth或其他builder。

## 投影

15 row keys依序 `certificationId,version,employeeId,employeeNo,employee,name,certificateNo,issuer,issuedOn,expiresOn,status,statusLabel,expiryState,expiryLabel,note`。目前名稱及原保存string不trim/coerce；其他非string描述安全''、不展開nested，姓名缺失不借用別entity。外鍵string只用confirmation，不列CSV/紙本。selection精確employee/status/expiry；指定無名可讀員工「名稱未取得」，未指定「全部可讀員工」，空status「全部狀態」、空expiry「全部效期」。

十visible/CSV欄依序：employeeNo「員工編號」、employee「員工（目前名稱）」、name「證照名稱」、certificateNo「證號」、issuer「發證單位」、issuedOn「核發日期」、expiresOn「到期日期」、statusLabel「紀錄狀態」、expiryLabel「效期狀態」、note「證照備註」。日期表格畫面formatDate，空到期日畫面「—」、CSV空。title「員工證照紀錄總表」。totals只有 `{count}`，排序issuedOn→employeeNo→name→certificationId code units。note明示目前可讀名字、保存核發日與截至日提醒、沒有生效/資格認定或正式表單核定。

full≤1000及JSON envelope UTF-8≤2097152 bytes（等於允許/+1整份413），非CSV實體bytes上限。CSV沿BOM/full quoting/公式防護，固定certification-report.csv/no-store/nosniff；每次fresh重讀驗權，不截短。

## 唯一共用介面

薄certification-report adapter。唯一report-view加有限 `asOf:{label:'效期截至日期'}`、`expiry:{label:'效期狀態',selectionKey:'expiry',emptyLabel:'全部效期',labels}`，keys/echo/selection/default/validate/內容／control沿同owner；未opt-in報表語義不變；date.displayRowKeys有限顯示鍵只格式化額外expiresOn，預設仍只rowKey。asOf必填/clear今日、expiry按合法labels；所有條件都進signature。無新async/download/print/controller。adapter只純DTO核對日期／expiryLabel與截至日、status/employee/q/count-only，不作新業務写入。

admin/sup原報表中心加「證照總表」，finance隱藏並server403；caregiver原/certifications及本人API保持，不新增報表導覽。localKinds8→9，admin9/sup7/finance7；原五legacy API仍五。螢幕最小1400px自身横捲、核發及到期日不折行；A4橫向12mm/9pt十欄寬7/10/13/10/11/9/9/7/8/16%，重複header/長備註及證號換行。只新certification CSS，tokens/其他報表geometry維持。

## 驗收

真新增/sup修改核發/到期/證號/issuer/備註/撤銷/恢復與不可改employee、CAS409；40 CERT標記25+15、日期AND/expiry與asOf變更、過期/當日/30/31/空/撤銷及未來核發含義、q200與literal、empty/clear/lookup-only；15keys/10columns/countonly、wrongDTO date/expiryLabel/asOf/extra keys拒絕。四真role sessions、caregiver本人/他人/inactive恢復、finance早403、缺父scope；imported非法頁外與expiry排除仍全409、strict query、exact1000/JSON2MiB/+1、CSV原文保護、fresh預覽後真修改再fresh單次列印。

沿loaded/pending10context、取消/晚回應/503/MIME/空body/AbortError/native-beforeprint抑制；31報表出口（原28+新3）。11表raw/count/total_changes唯讀與刻意寫分開對帳，六trigger SQL/雙非空BLOB原bytesSHA/核閱費薪snapshot保持。完整既有293 Node及22browser原script SHA回歸。全部合成memory/random port；actual DB不複製/seed，實際4310正常重啟前後11表/trigger/health/setup/session只讀核對。

一新QA PDF／首次成功marker一次，actual fresh授權print DOM/CSS→JS-disabled capture，40 CERT各一次、十headers/A4邊界/全部可見文字/末頁；全部新UI/PDF逐張view_image。新產品上人員11、人員歷程18與訓練28UI的fresh回歸副本也逐圖；原六個報表PDF只原script程式驗證或同artifact修訂，不冒稱新人工舊頁驗收。保留QA shell session並取得OS exitCode；fixture失败及產品/脚本變更時序如實保存。

同步state/product/API/UX/design/backlog及不可覆寫0.23.0，基準141source/16舊proof SHA/4409歷史copy不寫，新copy逐份核SHA。原84/52/28/16/359題/四来源SHA/status/parity/9phases/0原completed保持；原「證書」只是相關CRUD，沒有精確report映射，不改任何原row，只RM04局部證據與獨立milestone。未知正式支付/薪資/評分/外部介接仍待核定。
