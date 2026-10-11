# 機構帳號生命週期與 Portal 居服員開通

本切片新增既有機構帳號的角色調整、員工重新連結、停用與復職，以及相同交易內的登入撤銷、原因、版本歷程和稽核紀錄。管理者不能透過這些 API 更改使用者 email、名稱、密碼、Google subject、Portal Auth UUID、公司身分綁定或其他機構授權。

## 權限與保存

所有入口僅接受目前機構有效的 `admin`；`supervisor`、`caregiver`、`finance` 皆拒絕。每次操作核目前 memberships 與帳號狀態，寫入仍核 Origin、CSRF，並在等待 request body 後重新核驗原本 session、機構、角色與員工連結。帳號一旦停用或變更角色／員工連結，撤銷該使用者的全部舊 session；復職不會使舊 cookie 恢復有效。

帳號狀態與員工狀態分開。停用帳號不會修改員工、排班、服務或薪資紀錄；本機已有多個明確 membership 時，停用只作用於所選機構，其他明確授權的機構仍可重新登入。Portal 維持原本的單一機構精確綁定，不會依 email 自動增加角色或跨機構 grant。

角色為 `admin`、`supervisor`、`caregiver`、`finance`。居服員必須指定員工；啟用或重新連結時必須是同機構且 status=`active` 的員工，其他角色可明確保留或移除員工連結。停用帳號時，可以只保留完全相同的既有停用員工連結，避免員工已離職後無法停用帳號；此狹窄例外不能重新連結他人，復職仍須有效員工。不能讓機構沒有有效管理者；不能自行降權、停用自己或變更自己的員工連結。請另一位管理者操作。

使用既有 `records` 的私有 `account-lifecycle` entity 和既有不可變 `record_versions`。沒有新增資料表、欄位或 trigger：local 維持十一表／六 trigger，Portal 維持十三表／六 trigger。此 entity 未加入通用表單 entity，沒有可繞過專用授權的通用新增或 PATCH 入口。

既有未管理帳號的版本是 `0`、狀態為 active。首次有效變更在同一交易保存基準版 `1`，再保存操作版 `2`；以後版本每次加一。歷程保存 userId、角色、員工 ID、帳號狀態、變更原因、實際操作 userId 與時間；沒有 provider subject、Auth UUID、密碼或 session token。保存 head、完整版本順序、live membership 角色與員工連結必須一致，漂移或不完整時拒絕操作，不自動補正權限。

## API

| 入口 | 回應／限制 |
| --- | --- |
| GET `/api/account-administration` | `{orgId,items,total,page,pageSize}`；可用 q、role、status、page、pageSize，未知或重複 query 拒絕。每頁最多100筆。 |
| GET `/api/account-administration/:userId` | `{item}`；只查目前機構明確 membership。 |
| GET `/api/account-administration/:userId/history` | `{orgId,id,items,total}`；完整版本由新到舊，未管理的帳號 items=[]。 |
| PATCH `/api/account-administration/:userId` | 必須有 `Idempotency-Key`、Origin、CSRF，body 必須精確包含 version、role、employeeId、status、reason。回應 `{item,sessionsRevoked}`。 |

帳號 item 欄位固定：id、orgId、name、email、role、employeeId、employeeName、employeeStatus、status、version、updatedAt、portalBound、bindingActive、isSelf、canManage。沒有員工連結時 employeeId/name/status 均為 null。`portalBound` 表示綁定存在；`bindingActive` 無綁定時為 null、有綁定時為 bool。帳號 active、員工 active 與 provider 綁定 active 各自獨立；復職 API 不重新啟用已撤銷的 provider 綁定。自己 isSelf=true、canManage=false。

PATCH 中 status 僅能 active 或 suspended；reason 是去除前後空白後1至1000字、沒有控制字元的文字。`employeeId` 明確為 UUID 或 null；version 是非負整數。保存版本不同回409 VERSION_CONFLICT；同 key 不同 body／route 回409 IDEMPOTENCY_CONFLICT；相同重送鍵只有在該回執仍是目前 head 時才能重送原成功結果，若已被其他變更超越回409 ACCOUNT_RECEIPT_STALE。拒絕的驗證、權限、CAS、重送及參照操作不寫入業務表、歷程、稽核或 idempotency。

歷程 item 是 `{version,source,createdAt,snapshot}`；source 為 account.baseline 或 account.change；snapshot 精確為 userId、role、employeeId、status、reason、changedBy、changedAt。基準 changedBy=null；操作版 changedBy 為實際管理者 userId。不可用 snapshot 的來源文字或時間鄰近替代實際操作身分。

## Portal 居服員開通

原本八個 CLI 旗標保持相容；新增居服員時另提供 `--employee-id`。`--role caregiver` 必須搭配同機構有效員工 UUID，其他角色不接受這個額外旗標。缺 employee、inactive、錯 entity、不存在或他機構員工均拒絕。全部 provider identity 必須已驗證並明確提供；CLI 不登入公司帳號、不寄信、不取得 Google 身分，也不發布公司 Portal producer 或 grant。

相同 issuer／subject／Auth UUID／email／name／role／employeeId 的重送只回 already-provisioned，不更改授權。既有帳號已停用、角色或連結改變、綁定撤銷或身分衝突時仍拒絕，不能藉開通 CLI 覆蓋生命週期或別人的綁定。既有八旗標若指定 caregiver 並省略員工，仍回原先的語意錯誤 PORTAL_PROVISION_INVALID；不開通無連結居服員。

## 必要驗收

`tests/account-administration-http.test.mjs` 使用合成 memory DB 與隨機 loopback port 的真實 HTTP：四角色、機構隔離、可讀 DTO、停用／復職、角色／連結、CAS、重送、實際在等待 body 時由管理 API 撤權、來源漂移、最後管理者、自行操作、原子失敗、版本不可變、保存漂移、Portal 精確綁定、Portal 撤權保留及多個明確 local membership。

`tests/portal-caregiver-provision.test.mjs` 使用合成 memory／temporary DB，驗明確 CLI、新增與零寫入重送、inactive／不存在／他機構拒絕、禁止偷偷重綁與非秘密回應。另保留原 `portal-handoff.test.mjs` 和 `runtime-authority-window-http.test.mjs` 的原斷言，全數一起驗證。原先失敗結果與修正後結果分別保存，不覆蓋。

本文件描述程式能力。前端操作、手機／鍵盤、完整回歸、正式公司 producer、持久主機、HTTPS 和真實公司帳號 UAT 需分別提供實測證據；本機合成測試不代表正式部署或開通真實帳號。
