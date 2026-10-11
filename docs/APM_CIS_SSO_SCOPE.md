# APM CIS、Portal 接收端與部署交接

此 repository 沿 APM CIS 的歲悅標誌、暖白底、橘色與深棕、共同桌機／手機版型。唯一樣式與共用控制項為 public/styles.css 與 public/ui.js。本機合成 CIS／Portal 整合已接受；公開副本的實際測試、正式發布及真實公司帳號 UAT 需分別驗收。這份公開契約不包含任何私人身分綁定、帳號開通、簽署秘密或 Portal producer 發布產物。

## 登入與授權

local 模式保留首次建立與本機密碼登入。已設定 portal 模式而尚未登入時，顯示品牌載入及回入口連結，前往設定的公司 Portal；成功取得本模組 session 後不再顯示第二次密碼表單。僅有 receiver 與開通 CLI 隨源碼提供；Portal 簽署端與明確 grant 必須另外整合、核定及發布。

POST /api/auth/handoff 只接受 form-urlencoded 的 payload、signature。payload 為 canonical base64url UTF-8 JSON，HMAC-SHA256 簽署 encoded payload，signature 亦為 canonical base64url。獨立 HOME_CARE_PORTAL_SIGNING_SECRET 至少 32 UTF-8 bytes，兩端私下設置，不與其他模組共用、不進版本控制或公開產物。

signed claims 只有九欄：aud、moduleId、iss、googleSubject、authUserId、email、iat、exp、jti。aud/moduleId 固定 home-care，iss 精確符合設定的 Portal origin；Google subject、Portal Auth UUID、小寫 email 必須精確符合本模組明確啟用的 binding。iat/exp 為整數、有效期最長600秒，未來 clock skew 最多30秒；jti 為 UUID，持久 nonce 防止重放。未知 role、scope、company、returnTo 或其他欄拒絕。成功固定303至 /#/，憑證與 token 不進 URL。

Portal producer 必須在 server 端先驗證目前公司登入與唯一已驗證 Google identity，以及與該身分一致的 email，再核對明確居家模組 grant 才簽署。不可按 email 自動建帳、套用其他模組角色或廣開機構。receiver 每次 handoff 核啟用 binding 與目前 memberships；一般 API 仍核機構、角色與逐筆範圍，居服員仍需同機構有效員工。nonce 消費與 session 同交易；失敗不建立半套 session，成功切換撤銷原 cookie session。

只有 handoff 允許設定 Portal origin 的跨來源 POST；其他寫入仍核本模組 Origin／CSRF。正式 Host 取自明確 HOME_CARE_PUBLIC_ORIGIN，不信任任意 forwarded header。HTTPS Portal cookie 為 Secure、HttpOnly、SameSite=Lax，8小時；local 模式 SameSite=Strict。Portal 關閉 local password login/setup，缺設定不能以密碼模式開啟 SSO schema；不提供密碼 fallback 或自動重設。

## 設定與持久儲存

預設 local schema 為十一表／六個不可變 trigger；Portal 或明確 provisioning 增加 identity binding 與持久 nonce，成為十三表。主機必須持久保存 SQLite、附件與 nonce，不可使用暫存檔案系統存放資料庫。先核備份工具的實際 schema：十一表演練工具拒絕 Portal schema；十三表合成演練也不是正式資料 backup／restore 或完整災難復原方案。

在自己控制的私密環境檔設定下列值；範例是佔位說明，沒有可使用的秘密或帳號：

| 設定 | 含義 |
| --- | --- |
| HOME_CARE_AUTH_MODE | portal |
| HOME_CARE_PORTAL_ORIGIN | 核定公司 Portal 的 HTTPS origin |
| HOME_CARE_PUBLIC_ORIGIN | 核定居家主機的 HTTPS origin |
| HOME_CARE_PORTAL_SIGNING_SECRET | 私下產生、至少32 UTF-8 bytes的獨立共同秘密 |
| DATA_DIR | 主機持久且受控的資料目錄 |
| PORT | 主機明確指定的服務埠 |

伺服器預設 loopback，正式對外須配置核定的 HTTPS reverse proxy、可信 origin 與持久 volume。DATA_DIR 及環境檔必須排除版本控制，不直接公開到靜態根目錄。

## 明確開通

scripts/provision-portal-account.mjs 僅使用全部明確旗標：--db-path、--organization-name、--name、--email、--issuer、--google-subject、--portal-auth-user-id、--role。資料庫路徑須指向自己控制、已存在的普通檔案且為絕對路徑；不接受 symlink、hardlink 或預設 DB。不要以文件中的假身分替正式帳號開通。

居服員角色另必填 `--employee-id`，必須對應同機構有效員工；其他角色不接受此旗標。重送時完整綁定、目前會員與員工連結均須一致，不以 email 自動取得或擴大角色。帳號管理變更角色／員工／停用狀態會撤銷既有 session，Portal 換票及已送出請求仍重新確認目前生命週期。詳見 ACCOUNT_ADMINISTRATION_SCOPE.md；receiver 與本機開通工具完成不代表正式 Portal producer／grant 已發布。

issuer／verified subject／Auth UUID／小寫 email／本模組機構與角色需先核定。重送同值可確認既有 binding，衝突拒絕，不覆寫另一人或擴大既有角色。binding 為單一機構明確授權，不借用其他模組 company UUID；CLI 不寄信、不登入公司帳號、不取得 Google 身分、不發布 Portal grant。真實身分不得放入測試 fixture、公開 log 或 Git。

## 部署驗收清單

1. 核定持久主機、資料目錄權限、備份／還原、DNS 目標、HTTPS、reverse proxy 與正式 origin。
2. 核定並發布 Portal server producer 與 grant，再以明確身分開通本模組 binding。
3. 先以合成 HTTPS 流程驗 POST → receiver → 303 → cookie → session，核拒絕錯簽章、issuer／audience／身分、未知欄、逾時、重放、錯 Origin、越權機構及撤權。
4. 桌機／390px核 CIS、選單鍵盤／Escape／焦點、機構與角色，以及本人與跨機構拒絕；測試失敗保留，不用真實個資當 fixture。
5. 在明確授權下另外執行真實公司登入與業務 UAT，保存實際部署來源、命令、結果與可取得產物。

正式持久主機、HTTPS、Portal 發布與真實公司登入／UAT 仍 pending。DNS 有紀錄、receiver 本機通過或 CLI 有能力皆不能證明正式可用；此文件不提供目前 DNS、正式網址或真實帳號驗證證明。
