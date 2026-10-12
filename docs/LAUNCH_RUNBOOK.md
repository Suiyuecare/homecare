# 居家系統發布、監看與停流操作

本文件提供待核定主機的操作程序。CLI 及合成測試完成只證明工程工具；正式主機、HTTPS、公司 Portal、真實帳號與營運 UAT 均須另驗。不要把過去版本的 CI、合成備份或健康 HTTP 200 當成正式上線證據。

## 正式發布前必填

| 項目 | 核定內容與負責人 |
| --- | --- |
| 版本與主機 | 待填：接受 commit、image digest、單一 Node instance 主機／持久 volume、UID、TLS 與 DNS target、主機管理人 |
| 登入 | 待填：正式 Portal producer 版本、獨立簽署秘密的私密管理位置、receiver origin、目前 grant／撤權管理人；秘密及真實 binding 不寫入本文件 |
| 備份 | 待填：完整十三表與附件的授權備份位置、保存／金鑰政策、備份人、還原批准人、RPO／RTO、目前 grant 與 consumed nonce 權威來源 |
| 試點 | 待填：首日必用的核定表單、四角色驗收人、公司／員工初始設定、試點機構與使用範圍；完整月結另簽認 |
| 當值 | 待填：監看／故障負責人、容量目標、停流與回退批准人、保留的 previous 來源及回退程序 |

原始 16 模板、52 報表、28 匯出未核定完整對等；先確認試點所需項目。BA／AA 額度與分攤、正式薪資及 FA 核銷需核定樣本；未完成前保留為試算／人工核對，不作正式結算／申報。GPS、簽名、離線及跨機構分享依實際試點規則決定是否必須先完成。

## 發布與現場驗收

1. 核對正式版本及部署設定，保存原工作區、私人資料與 previous 版本。容器依 `OPERATIONS_READINESS_SCOPE.md` 的受控 volume／非 root 契約；環境注入只經私密主機管理。
2. 在隔離 staging 以合成資料驗 HTTPS、正式 Host／Origin、匿名 API 拒絕及 Portal POST → cookie → 單一機構頁面。不能發布舊的 dirty Portal checkout；producer 必須以目前正式來源為基底，保留其他模組的新修正。
3. 驗停止／重啟與容器重建後個案、班表、服務、附件、版本與價格快照保持；持久政策旗標本身不能證明重建不丟資料。
4. 完成正式十三表備份及隔離還原、目前授權與 nonce 防重放、舊 session 撤銷、錯誤密鑰／不可用儲存失敗演練。現有 scratch-only 合成工具不能直接處理正式 DB。
5. 經核定人陪同，以四角色走完建案 → 排班／異動 → 服務紀錄 → 督導覆核 → 必用表單／輸出，並在手機實測；確認撤權及跨機構拒絕。實際帳號開通與業務內容由核定人提供，不按 email 自動給權限。
6. 保存部署、重建、復原、四角色與 UAT 證據，明確簽認限定使用範圍後才導入正式流量。

## 主機上的有限次就緒監看

```sh
node scripts/monitor-runtime-readiness.mjs --url http://127.0.0.1:8080 --public-origin https://homecare.example.test
node scripts/monitor-runtime-readiness.mjs --url http://127.0.0.1:8080 --public-origin https://homecare.example.test --count 10 --interval-ms 30000
```

以上 origin 是合成範例，須由操作者換成核定設定；本文件不設定實際目標。預設一次，count 範圍 1–60，interval-ms 範圍 1000–60000；兩次之間等待，不重疊請求、不背景執行、不建立排程、不寄外部通知。Host header 只提供原守門，TCP 永遠連明確 loopback port；拒絕 4310、外部 TCP 目標、localhost／DNS、憑證網址、query／fragment 及 redirect。

每次只 GET `/ready`，5 秒 timeout、4 KiB 回應上限；中止會取消正在等待的 HTTP 與間隔。stdout 為固定格式 NDJSON，只有固定 service、狀態／代碼、次序、計數、四項檢查及允許的問題代碼。未知回應、例外、URL／Host、磁碟路徑、帳號、簽署秘密與原始 body 都不輸出。主機日誌管理可在外層附時間、部署版本與留存政策；不把私人業務資料放進這些日誌。

| 結果 | exit code | 操作 |
| --- | --- | --- |
| 每次均 ready | 0 | 依已簽認範圍服務；不能代替登入、資料保存或完整 UAT |
| 有已確認 not_ready，即使後來恢復 | 1 | 停止新增正式流量並查固定 issues；處理後另啟新檢查，保留失敗紀錄 |
| 目標／引數錯誤、通訊／回應／輸出不能確認 | 2 | 未取得就緒證明；不得標示 ready 或自行放寬 Host／Origin／驗證 |
| SIGINT／SIGTERM 中止 | 130／143 | 已中止，當次不是完整監看；保留已輸出檢查及 summary |

這項監看不讀資料庫、試寫、改設定、操作備份、變更帳號或主機；也不測 TLS、容量、真實磁碟寫入或完整業務流程。

## 故障、停流與回退

收到 not_ready 或無法確認就緒時，由當值人停止導入新個案／新寫入，按固定 issue 查主機、storage、schema、Portal；保留原失敗紀錄。容量門檻及告警通道先由維運核定，本工具只 stdout，不自動向外通知。

回退由已核定人執行：先凍結 writer／關閉 connection，核對 previous 來源和一致性資料備份，按正式還原契約切換。回退同樣要套用目前撤權及 consumed nonce，不能讓舊 binding／session 回復權限。重新驗 `/ready`、四角色登入與必要業務流程，再簽認恢復流量；沒有完整可恢復來源時停止切換，不能清 DB 或重建示範資料。
