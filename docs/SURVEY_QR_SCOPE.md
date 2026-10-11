# v0.76 本機匿名自訂問卷 / QR 候選

本機整合驗收已完成：outputs/software/full-system-completion-qa/verification-v077.json。下列候選階段紀錄保留原時間與驗收界限，最新完成狀態以整合收據為準；沒有正式發布、真實營運UAT或原平台全量對等。

狀態：output-only 實作與合成驗證完成；正式整合 / 瀏覽器 / Portal regression / acceptance 尚待 root 與 UI owner 完成，不能當正式上線或原平台180項全面對等。

## 可操作流程

管理者/督導選自己已發布的自訂模板精確 SQL 保存版次，逐題明選可公開題目（條件欄的控制題也須明選），指定公開標題、到期時間、容量與核准依據，先唯讀預覽再人工開通。原模板私有名稱、代碼、說明、備註、unused groups/questions 不出現在匿名 DTO。此流程不代公司選正式題目，也不計算滿意度、評鑑分数或官方認定。

開通以既有 records / immutable versions / audit / shared idempotency 原子保存；server randomBytes(32) 發行 canonical43 base64url token，DB只存SHA256。fresh ACK 一次 header 回 token；合法cacheACK無header且明確「已保存、原始連結不可復原」，不得換新key自動重發。token留頁面memory、網址fragment；不在query、storage、DOM data屬性、audit/history/idem或一般QA JSON。

匿名 open 與 submit 為兩條 exact POST API，独立 fatal UTF8/body2MiB、Host/Origin、closed query/body/token。不讀寫 login cookie/session/Portalorg。公開只最小已核准問題 snapshot；七種型別、required、closed options、前序條件由既有自訂表單引擎驗證。填答整筆綁定當時批准的 schema/hash及原模板SQL版次，原始 decimal/string/multi-order 不回算或改寫。新nonce容量守門；同nonce同答案重播是11表及total_changes真0寫；不同答案409。停用、到期或原發布模板失效，連舊nonce也停止收件。

管理者讀原始答案及筆數；列表/歷程投影無tokenHash、nonceHash、payloadHash、私有reference/source文字。private detail 才核對核准依據與停用理由。active版1→disabled版2終態，response僅submitted版1；泛用POST/PATCH/DELETE封閉。

QR 採核准 pinned qrcode1.5.4，server RAM產生標準PNG，M error correction / margin4 / scale8。QR生成await前後重驗currentmembership、token、template、status、expiry；角色失效或停用 race不會回PNG。QA獨立jsqr1.4.0對完整原URLdecode roundtrip，同時逐像素验证32px全白quietzone（4modules）。圖片實際view；僅合成已销毁DB對應連結，沒有正式phone reachability或外部发布證據。

## 實際驗證與限制

- 21項新 candidate tests native0：typedSQL/current/head/full TEXT hex/unsafeversion/null/badJSON、preview/read/nonce replay0寫、7types/conditional/inactive/historical snapshot、fresh roles/CAS/mandatoryidem/cache原ACK、安全header/HTTPnamespace/Host-Origin/content type/fatalUTF8/bodycap、QRdecode/quietzone/await race、11表6trigger備份還原及強制失敗切回B世代再成功回A。
- 真随机loopback HTTP 測的是本候選 production handlers，在合成auth/CSRF adapter外殼中運作；不是已完成整個root createApp整合。`tests/surveys-app-http.test.mjs`另有真正 rootAPP 驗收稿，尚待接線才執行，不標skip為通過。
- backup只既有 owned synthetic workspace / 11tables / 6triggers；全source/raw head/answer/idem unchanged還原，old raw snapshots不補欄。
- r01/r02所有先前native失敗/QRPNG/proof保留。失敗原因包括合成fixture誤用引擎保留key、BigInt fingerprint讀法、URL constructor裁掉裸問號、URL pathname filesystem未decode，以及既有insert兩次now造成新record時間毫秒差；只修狹窄fixture或候選自有guard，未弱化正式授權/原tests。
- 正式 package/lock/src/public/tests/docs / v07427+7 freeze 均未promote。依賴sandbox僅qrcode runtime與jsqr QA；30套依賴完整license artifacts/provenance與pnpm-lock保留。MIT qrcode與Apache-2.0 jsqr按保存原授權文字。
- root負責formal namespace/metadata/model/private nav/Portal接線及最終sourceguard；UI owner負責manager ordinaryform/detail/history、公眾 `/survey/`、手機/桌機/失敗重試與實際可見驗證。所有formal integration、browser、production publication、公司正式評分仍pending。
