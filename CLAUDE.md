# 知識卡冊 — 開發指南

寫給接手這個專案的人與 AI agent。目的只有一個：**讓你在不知道全部歷史的情況下，也不會踩到會靜靜壞掉的地方。**

這裡列出的每一條都對應真實發生過的錯誤，不是預防性的空話。看到「這條寫成這樣是因為…」時，那就是實際壞過一次的紀錄。

---

## 0. 三十秒版本

```
一份 Node runtime，資料在本機 SQLite，模型在本機 CPU。
desktop/local-api.cjs   ← 本機 API，資料與語意邏輯都在這
desktop/model-runtime.cjs ← 模型目錄、下載、embedding、摘要
desktop/store.cjs       ← SQLite 存取
app/                    ← 前端（vinext，Next.js 相容）
app/api/**/route.ts     ← 前端對本機 API 的代理層
```

動手前跑一次，動完再跑一次：

```bash
npm run lint && npm test && npm run release:check && npm run verify:runtime
```

---

## 1. 絕對不要動的不變式

這幾條被打破時**不會有錯誤訊息**，只會讓產品慢慢變成垃圾。這是它們危險的原因。

### 1.1 全庫向量寬度必須一致

一個 384 維向量和一個 1024 維向量之間沒有「相似度」可言。`cosine()` 在寬度不符時**直接丟例外**，這是刻意的：

```js
// desktop/local-api.cjs
if (first.length !== second.length) throw new Error(`embedding 維度不符…`);
```

- 權威來源是 `expectedEmbeddingDimensions()`（`model-runtime.cjs`）。
- 自訂 API 的寬度由**第一次成功的回應**決定，之後必須一致。
- 加入自訂 embedding 模型時，維度必須在下載前就確定。做不到就擋下來，不要先下載再說。

**不要**為了「讓它不要爆」而改成回傳 0 分或跳過。爆掉就是設計。

### 1.2 hash embedding 不是語意模型，永遠不可以當替代品

`embedding-hash-384` 是詞彙重疊的 deterministic fallback。把它混進由真模型建立的資料庫，會產生**看起來合理但毫無意義**的相似度分數——這比明顯的錯誤糟得多。

`fallbackOrThrow()`（`model-runtime.cjs`）只在 hash 本身就是啟用中的 embedding 時才允許回退。不要放寬這個條件。

### 1.3 語意分數是相對值，不是 cosine

強多語言模型會把所有配對壓在很窄的高分帶裡（實測 0.698–0.908）。**絕對 cosine 門檻無法分辨「相關」與「兩者都是中文」。**

所以 `semanticBaseline()` 會取樣這個收藏自己的分數分布，再把 cosine 映射成相對值。`RELATION_MIN_SCORE = 0.42` 是相對於這個分布的值，**不是 cosine**。

- 看到 `0.42` 不要想成「cosine 0.42」。
- 不要新增任何直接拿 `cosine()` 結果和常數比較的程式碼。
- 樣本太少（<6）時 `scoreRange` 回傳 `null`，此時不標記「語意相似」——這是正確行為，不是 bug。

### 1.4 封面圖案名稱必須存在於前端圖庫

`app/cover-art.tsx` 的 `glyphLibrary` 對未知名稱的處理是：

```tsx
{(shape && glyphLibrary[shape]) ?? glyphLibrary.quad}
```

**不會報錯，只會全部變成同一個四方格。** 這個 bug 上線過一次，整櫃卡片的封面失去所有資訊而沒有任何人發現，直到有人用肉眼看出來。

`tests/cover-art.test.mjs` 現在會擋下來。不要為了「加一個新圖案」只改後端。

### 1.5 卡片顏色由分類決定，且指派後不可重算

- 顏色記錄在 SQLite `meta` 的 `category_accents`。
- 指派只發生一次；之後**永遠不重算**。
- 原因：重算會讓「刪掉一個分類」把整櫃卡片重新上色。顏色是辨識的一部分。

`assignCategoryAccents()` 只填沒有顏色的分類，並清掉已不存在的分類。不要改成「每次依目前分類列表重新分配」——那個版本試過，很好看，但使用者的卡片會莫名其妙變色。

### 1.6 衍生資料改變時必須升版並補做遷移

封面是從 embedding 算出來的衍生資料。`reindexStore` 只看 embedding 有沒有變，**會直接走過所有舊封面**。

所以改動封面產生方式時：

1. 升 `COVER_VERSION`
2. 確認 `refreshStaleCovers()` 會抓到（它比對 version 與分類顏色）

漏掉第 1 步的結果是：新安裝正常、舊使用者永遠看到舊版本，而且沒有任何錯誤訊息。

### 1.7 `save()` 是唯一的寫入收斂點

```js
const save = (changedCards) => { … refreshStaleCovers(store) … db.save(store, { cards }) }
```

- 分類顏色在這裡定案，所以任何新增分類的操作都不會寫出錯的顏色。
- `changedCards` 只寫指定的列。**重新上色的卡片必須併進這個集合**，否則變更會遺失。
- API 回應要送 **store 裡的物件**，不是本地副本。`Object.assign(existing, card)` 之後 `card` 已經是另一個物件，回傳它會讓前端拿到 `save()` 重新上色前的舊值。這個 bug 真的發生過。

### 1.8 安全邊界

- 桌面 API **只監聽 loopback**，權杖由前端在伺服器端代理，不經過網路。
- **介面本身沒有登入機制。** `KCC_HOST=0.0.0.0` 等於讓所有能連到這個埠的人讀寫你的卡片。只能用在私人網路（Tailscale / WireGuard）。
- 不要新增任何把權杖送到瀏覽器的程式碼。
- 區網分享是**另一個** server（`startLanApi`，HTTPS、8443），不是把 loopback server 改成監聽 `0.0.0.0`。loopback 那個永遠維持原樣。
- **裝置權杖的權限比本機權杖小。** `deviceSafeRoute` 只放行 `cards`、`categories`、`search`、`trash`；模型、設定、資料庫、裝置管理都是 403。新增路由時要想清楚它屬於哪一邊——預設是**不**放行。
- 配對碼一次性且十分鐘失效，`pair()` 在發出 token 前先清掉它。不要為了「使用者重試比較方便」把這個拿掉：一個看得見的碼就只能換一把鑰匙。
- 裝置清單**永遠不回傳 token**，資料庫裡也只存 SHA-256。`tests/api-contract.test.mjs` 有斷言擋著。

### 1.9 平台差異寫在一個地方，而且要誠實回報

Windows 與 macOS 的差異只允許出現在 `desktop/` 的少數幾個檔案裡（`bonjour.cjs`、`lan-certificate.cjs`、`main.cjs` 的圖示、`mcp-server.cjs` 的 manifest 路徑）。其餘程式碼一律跨平台。

- **不要用 `execFile` 叫系統工具做跨平台的事。** 憑證產生曾經寫死 `/usr/bin/openssl`／`/opt/homebrew/bin/openssl`，Windows 沒有 OpenSSL，整個區網分享直接不能用。現在用 `node:crypto` 產金鑰、node-forge 做 X.509 編碼，兩邊同一條路徑。
- **不要用介面名稱猜哪張網卡是真的。** Windows 上 `192.168.56.1` 可能叫「乙太網路 3」（VirtualBox），名字完全看不出來。真正的答案來自路由表：`defaultLanAddress()` 用一個 connected UDP socket 問，不送封包也不開子行程，兩個平台通用。
- **能力不存在時要說實話。** mDNS 在 macOS 一定有，在 Windows 只有裝了 Apple Bonjour 才有。`status()` 回報 `discovery_active` / `discovery_detail`，介面照著顯示。**不要寫死「Bonjour 已啟用」**——之前就是這樣，在沒有 Bonjour 的機器上直接騙人。
- **子行程的 `error` 事件一定要接。** `spawn` 找不到執行檔是**非同步**的 `error` 事件，沒接就會 throw 掉整個 Electron main process。而且要 `await` 到它落定再回報狀態，否則 `active` 會先是 true 再偷偷變 false。

### 1.10 版號只有一份

`package.json` 是唯一來源。`scripts/release-check.mjs` 會掃 `desktop/*.cjs`，出現不一致的版號字面值就失敗。

會這樣是因為 MCP bridge 曾寫死 `0.1.0` 對所有 AI 工具回報錯版本，而 OpenAPI 文件寫死 `0.4.0`——一個既不是 app 版本也不是路由 `v1` 的數字。

### 1.11 備份校驗碼只能由產生它的實作驗證

JSON 浮點數序列化在不同 runtime 之間不同（Python 給 `4.92e-05`，JS 給 `0.0000492`）。跨工具的備份請**移除 `checksum_sha256` 欄位**再匯入；沒有校驗碼的 payload 會跳過該檢查。不要試圖「修好」跨 runtime 的校驗。

---

## 2. 連動地圖：改這裡，就一定要改那裡

| 你改了 | 就必須同時改 | 不改的後果 |
| --- | --- | --- |
| `MOTIF_SHAPES`（local-api.cjs） | `app/cover-art.tsx` 的 `CoverGlyph` union + `glyphLibrary` | 封面靜默退回單一圖案 |
| `PALETTES`（local-api.cjs） | `globals.css` 的 `--accent-*` 與 `.collection-card--*` 規則、`types.ts` 的 `visualAccents` | 卡片沒有顏色樣式 |
| 封面產生邏輯 | `COVER_VERSION` +1 | 舊資料永不更新 |
| 新增 API 路由 | `app/api/**/route.ts` 代理、`openapi.json` 的 paths、根路徑的 `capabilities` 陣列 | 前端 404；整合工具看不到新能力 |
| `store.cjs` 的 `SCHEMA` | `load()`、`writeMeta()`、`STORE_VERSION` 遷移 | 欄位讀不回來或舊資料庫開不起來 |
| `MODEL_CATALOG` 新增項目 | `size_tier`（summary）或 `language` + `dimensions`（embedding） | 簡易模式選不到它 |
| `DIMENSION_GUIDE` 涵蓋範圍 | 任何新的 embedding 維度都要有對應條目 | `tests/model-catalogue.test.mjs` 會失敗（刻意的） |
| `package.json` 版本 | 無（其他地方都用讀的） | — |
| `electron-builder.yml` 的 extraResources | `main.cjs` 的路徑解析、`model-runtime.cjs` 的 `bundledModelsDir()` | 打包版找不到資源 |
| README 提到的 npm script | `package.json` 必須真的有 | `tests/rendered-html.test.mjs` 會失敗（刻意的） |
| `networkController.status()` 的欄位 | `types.ts` 的 `LanSharingStatus`、`panels.tsx` 的顯示 | 介面顯示 `undefined`，或宣稱一個不存在的能力 |
| `deviceSafeRoute` 白名單 | 想清楚新路由該不該給手機；預設不給 | 配對過的裝置拿到主機管理權限 |
| `setting-cards.tsx` 的卡片結構 | `globals.css` 的 `.setting-card` 覆寫（`.collection-card__copy span` 與 `__tags` 在收藏頁是 `display:none`） | 設定卡的說明與標籤整片消失 |
| `glossary.ts` 的 `glyph` / `accent` | 必須是 `cover-art.tsx` 畫得出來的 glyph、`visualAccents` 裡有的顏色 | `tests/cover-art.test.mjs` 會失敗（刻意的）；否則會靜靜退回同一個圖案 |
| 新增設定分頁 | `glossary.ts` 要有對應 `scope` 的條目 | 測試會失敗；使用者少一整區白話說明 |
| 新增 `desktop/` 的執行期相依 | `desktop/package.json`（打包用，鎖定版號）**與**根 `package.json`（CI 測試用） | CI 綠、打包版 require 失敗，或反過來 |

---

## 3. 測試涵蓋什麼

| 檔案 | 守住什麼 |
| --- | --- |
| `api-contract.test.mjs` | 認證、卡片生命週期、搜尋、關聯上限與去重、備份完整性 |
| `embedding-safety.test.mjs` | 維度不符會丟例外、相對計分、排序不會反轉 |
| `embedding-dimensions.test.mjs` | 寬度鎖定、fallback 不會偷換、目錄一致性 |
| `store-migration.test.mjs` | JSON→SQLite 不掉資料、全新安裝是空的 |
| `model-catalogue.test.mjs` | 自訂模型驗證、供應商預設、簡易模式解析、內建權重 |
| `category-colour.test.mjs` | 同分類同色、分布平均、既有分類不變色、三方一致 |
| `cover-art.test.mjs` | 封面圖案名稱前端畫得出來、且夠多樣；術語卡的 glyph／顏色／編號一致 |
| `lan-certificate.test.mjs` | 選對網卡（含 Windows 虛擬網卡）、憑證指紋穩定、mDNS 缺席不會炸、LAN TLS 真的服務 v1 |
| `rendered-html.test.mjs` | 前端能 render、雙平台打包設定、README 指令存在、CLAUDE.md 引用的檔案存在 |

**加功能時請一起加測試。** 這個專案唯一沒有測試覆蓋的部分（文件）就曾經悄悄落後好幾個 commit。

---

## 4. 在這台機器上怎麼驗證前端

**預覽窗格（Browser pane）的截圖會逾時**，因為它沒有 compositing。CSS 動畫和 rAF 也不前進。

驗證前端請走 Electron + CDP：

```bash
# 1. 建置並用 CDP 開啟
npm run build
node_modules/electron/dist/electron.exe desktop/main.cjs --remote-debugging-port=9222
# 2. 用 WebSocket 連 http://127.0.0.1:9222/json 的 page target
#    Runtime.evaluate 讀 DOM、Page.captureScreenshot 抓畫面
```

另外兩個實際踩過的坑：

- **CDP target 出現 ≠ 頁面可以操作。** `/json` 一列出 page target 就去點按鈕，會什麼都找不到——收藏頁還沒 hydrate。實測要再等約 15 秒。找不到元素時先 dump `document.body.innerText` 確認畫面到哪了，不要直接以為選擇器寫錯。
- **React 狀態更新是非同步的。** 派送事件後立刻讀 DOM 會讀到舊值，看起來像功能壞掉。等一個 frame 再讀。我因此兩次誤判「拖曳功能壞了」。
- 用 `KCC_DATA_DIR` 與 `KCC_MODELS_DIR` 指到暫存目錄再測，否則會動到使用者真實資料，而且會繼承他們已選的模型（看起來像「全新安裝的預設值不對」）。

---

## 5. 雙平台：現況與還沒做的

macOS 支援已經進來了。`electron-builder.yml` 有 `mac:` 區塊（dmg + zip）、`build-icon.mjs` 同時產 `.ico` 與 `.icns`、release workflow 用 `macos-13`（Intel）與 `macos-14`（Apple Silicon）兩個 runner 各自建置後合併上傳、`mcp-server.cjs` 會查 `~/Library/Application Support/`。核心本來就不用改：`onnxruntime-node` 附有 `darwin/arm64` 與 `darwin/x64` 預編譯檔，`node:sqlite` 是 Node 內建。

**還沒做的：**

1. **簽章與公證。** 沒有 Apple Developer ID 的話使用者會被 Gatekeeper 隔離，比 Windows SmartScreen 更難繞過。這是要花錢的決定。
2. **Windows 防火牆。** 第一次啟用區網分享時，Windows 會跳出允許 `知識卡冊.exe` 監聽的提示。使用者按了「取消」就會靜靜地連不上。目前只在 README 說明，沒有程式處理（加防火牆規則要管理員權限）。
3. **Windows 沒有 mDNS。** 需要 Apple Bonjour 才有 `dns-sd.exe`。目前的做法是誠實回報並要使用者掃 QR code——這是可接受的，因為 QR 本來就帶了位址。若要補齊，就是用 `dgram` 寫一個純 Node 的 mDNS responder，**不要**改成叫系統工具。
4. **產品名是中文（`知識卡冊`）。** appId 沒問題，但兩邊的 bundle 路徑都要實機確認過才算數。

**在哪台機器上驗證什麼：** 平台相關的改動不能只靠 CI。`lan-certificate.test.mjs` 兩邊都會跑（以前是 `skip: process.platform !== "darwin"`，等於 Windows 完全沒有覆蓋——**不要再把測試依平台 skip 掉**，要嘛寫成跨平台，要嘛注入假的 `networkInterfaces`）。

---

## 6. iOS 版：先做對的事

使用者的方向是「連到主機獲取資料」，這是對的——Electron 不能跑在 iOS 上，所以架構必然是**主機端 runtime + 手機端瘦客戶端**。

### 已經打好的基礎

主機端該有的東西大致齊了：

- API 路由已有版本前綴 `/api/v1/`，根路徑回報 `capabilities` 陣列供協商
- **裝置配對**：`desktop/device-auth.cjs`。桌面端產生一次性配對碼（十分鐘、只能換一把鑰匙），手機端拿 `kcc_dv_…` 長期 token，可個別撤銷；資料庫只存 SHA-256
- **權限分級**：裝置 token 只能碰卡片相關路由，主機管理一律 403（見 1.8）
- **傳輸**：`startLanApi` 在 8443 開一個獨立的 HTTPS server，憑證自簽、**要求手機端 pin 指紋**（`pairing_requires_fingerprint`）。桌面 loopback server 完全不受影響
- **配對 QR code**：帶 `{host, certificate_fingerprint, pairing_code}`，所以手機不需要 mDNS 也能連
- 已有稽核記錄（`audit.jsonl`），裝置的動作記成 `device:<id>`

**這條紅線仍然有效：不要為了讓手機連上而放寬 `KCC_HOST` 或 CORS。** 手機該走的是上面這條配對過的 TLS 通道，不是把 loopback server 打開。

### 動工前還要解決的

**第一：憑證信任模型要在 iOS 端落實。** 主機端已經把指紋交出去了，但那只有在客戶端**真的去比對**時才有意義。iOS 端請用 `URLSessionDelegate` 做 pinning，比對 `certificate_fingerprint_sha256`。**不要**用 `NSAllowsArbitraryLoads` 了事——那會讓整套配對機制變成裝飾。

**第二：token 存 Keychain。** 桌面端不會顯示也不會保存裝置 token，發出去就只有手機有。存錯地方就沒有第二次機會。

**第三：API 契約穩定化。** 手機端一旦發布就不能隨時改 API：

- 保持**只增不改**（additive）
- 新能力一律加進 `capabilities`，讓舊客戶端能優雅降級
- `/api/v1/` 之下的既有欄位不刪不改語意

**第四：離線與換網路。** 憑證的 SAN 綁的是啟用當下的區網位址，換一個 Wi-Fi 就不再相符（指紋 pinning 仍然有效，但主機位址會變）。手機端要能處理「找不到主機」，而不是卡住。

### 不需要做的事

**不要在 iOS 上跑 embedding。** 主機端已經有模型，手機端只要送文字、拿結果。這樣可以完全避免第 1.1 條的維度問題——一旦手機端用了不同模型，向量就不相容了。

**不要為了手機端複製一份資料邏輯。** 所有語意計算留在 `local-api.cjs`。手機端只做顯示與輸入。

---

## 7. 不要做的事

- **不要加第二套推論引擎**（llama.cpp / GGUF）。使用者已明確要求本體輕量。需要 GGUF 的話，透過設定頁的 Ollama / LM Studio 供應商即可，那本來就是 llama.cpp。
- **不要把範例卡片自動塞進全新安裝。** 全新安裝是空的，這是刻意的決定。範例卡只在明確要求時載入。
- **不要在沒實測的情況下宣稱修好了。** 這個專案有過「改了設定檔就以為修好」的紀錄。前端改動請照第 4 節實際抓畫面。
- **不要相信自己對現況的記憶。** 寫文件或回報前，先去讀程式碼。README 曾經在多個 commit 中悄悄與現實脫節。
- **不要只在自己這台機器上驗平台相關的功能。** 在 macOS 上寫的區網分享曾經寫死 OpenSSL 路徑與 `/usr/bin/dns-sd`，在 Windows 上是「按下去就整個 main process 掛掉」。改到 `desktop/` 裡任何碰到檔案系統、網路介面或子行程的地方，先問「另一個平台上這個東西存在嗎」。

---

## 8. 提交前檢查表

```bash
npm run lint            # 0 問題
npm test                # 全綠（含 build）
npm run release:check   # 版號一致
npm run verify:runtime  # runtime 契約
```

- 改了前端 → 照第 4 節用 Electron + CDP 實際看過
- 改了衍生資料的產生方式 → 升版本常數並確認遷移路徑
- 改了 API → 代理層、openapi、capabilities 三處都補上
- 改了行為 → 對應的測試也要改，並在 commit 訊息說明**為什麼**改，而不只是改了什麼
