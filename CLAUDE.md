# 知識卡冊 — 開發指南

寫給接手這個專案的人與 AI agent。

這份文件有兩半，兩半都要看：

- **第 1–2 節是產品方向。** 它回答「為什麼要有這個東西，以及下一步該做什麼」。不知道這個，你會把力氣花在很好但沒人需要的功能上。
- **第 3 節之後是工程約束。** 它回答「哪些地方會靜靜壞掉」。這部分每一條都對應真實發生過的錯誤，不是預防性的空話——看到「這條寫成這樣是因為…」時，那就是實際壞過一次的紀錄。

---

## 0. 三十秒版本

**慢慢理解，快速想起。**

知識卡冊不是第二大腦，也不是 Notion 的替代品。Notion、論文、網頁負責**保存**知識；這個 app 負責在你只剩模糊印象時，把以前理解過的東西**送回工作記憶**。決定要不要做一件事，先問它有沒有縮短「想到問題 → 找到知識」的時間（完整判準在第 2 節）。

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

## 1. 這個產品在賣什麼

功能數量從來不是這個專案的問題。卡片、分類、標籤、語意搜尋、關聯圖、重複偵測、AI 草稿、MCP、桌面版、區網配對、Raspberry Pi、本機模型管理——都有了。真正的問題是**核心功能沒有全部圍繞「最快找回以前理解過的知識」設計**。

### 定位：Notion 是 Storage，這裡是 Cache

```
Notion / 文件 / 論文 / 網頁 / 筆記
              │
              │ 理解、整理
              ▼
         Knowledge Card
              │
              │ 壓縮
              ▼
       Knowledge Card Cabinet
              │
              │ 快速搜尋
              ▼
         Working Memory
```

| 系統 | 角色 |
| --- | --- |
| Notion | 完整的知識文件、筆記、研究資料、長篇內容 |
| 論文／網站／文件 | 原始來源 |
| **知識卡冊** | **已理解知識的快速存取版本** |
| AI | 協助整理、搜尋、建立關聯 |
| 使用者 | 最終理解與判斷的來源 |

**這條區隔就是判斷新功能值不值得做的主要依據。** 產品最重要的工作不是幫使用者保存更多資訊，是在他只剩模糊印象時把舊的理解送回來。所以它分成兩個階段：**Capture**（讀完之後整理成一個問題、一句話理解、白話解釋、比喻、必要細節、來源）與 **Retrieval**（日後不必重讀原文，模糊印象 → 搜尋 → 一句話重建 context → 需要時才展開細節）。

### 五條產品原則

這五條有編號是因為程式註解會引用它們（例如 `local-api.cjs` 裡的 `§P-02`）。

**P-01 — Retrieve First**
任何會縮短「想到問題 → 找到知識」時間的功能，原則上優先於純整理功能。

**P-02 — AI 是搜尋的增強層，不是搜尋存在的前提**
模型損壞、還沒下載、建立失敗、API 連不上時，使用者**仍然必須**能用基本文字搜尋找到自己的知識。實作與守門的測試見 §3.14、§3.15。

**P-03 — 分層揭露**
搜尋結果不該要求使用者先讀完整篇。資訊按 `標題 → 問題 → 一句話 → 白話說明 → 完整細節 → 原始來源` 逐層展開——`KnowledgeCard` 的欄位本來就是這個順序，不要打亂它。搜尋結果**至少**要能不開卡片就重新取回核心理解。

**P-04 — 建一張卡必須比寫一篇筆記便宜**
判斷標準是「我現在願不願意花 20 秒把這個理解留下來」，不是「我願不願意填一份表單」。一旦變成後者，使用者會開始說「之後有時間再整理」，然後卡冊就死了。

**P-05 — Local-first 不因為重新定位而改變**
本機 SQLite、本機模型、自有資料、私人網路分享（Tailscale / WireGuard）全部維持。「所有裝置都能匿名登入」不是目標。

對外描述也照這條走：**不要寫「在任何裝置上存取」**，要寫「在自己的裝置上，隨時找回以前理解過的知識」。前者是 Cloud SaaS 的承諾，這個產品的架構與安全模型都不是那個東西；後者把 local-first 從限制變成特色。

### 唯一的產品指標：Time to Knowledge

從「我以前好像學過這件事」的念頭，到重新取得足夠 context 的時間。桌面快速搜尋的目標是 **≤ 5 秒**：

```
快捷鍵 → 輸入模糊描述 → 前三筆看到正確的卡 → 讀到一句話 → Esc → 繼續手上的事
```

延伸的效能要求：快速搜尋介面開啟 ≤ 150ms 體感、第一批結果 ≤ 300ms（本機小型資料庫）、輸入維持現有的 250ms debounce。次要指標有 Top-3 命中率、搜尋回應時間、搜尋→開卡率、放棄率、改寫查詢率、建卡時間、被重新翻出來的卡片數。

**第一階段不需要 analytics 基礎建設**，本機測試與人工量測就夠。

### 命中理由要說話，分數不要

介面上要說**為什麼這張卡出現在這裡**（`標題命中`、`關鍵字命中`、`語意相似`、`同分類`、`共享標籤`），不要秀 `0.78243`。`/search` 有回 `score` / `lexical_score` / `semantic_score`，那是給除錯與調權重用的，不是給讀者看的。

---

## 2. 產品路線

### 判斷一個新功能該不該做

開工前先回答這五題，全部都是「否」就不要進近期 roadmap：

1. 它能不能**更快找到**知識？
2. 它能不能**更快建立**一張有用的卡？
3. 它能不能**提高搜尋結果品質**？
4. 它能不能幫忙**重新發現已經忘記**的知識？
5. 它有沒有**維持 local-first 與資料自主**？

### 五個階段，順序有意義

| 階段 | 目標 | 內容 | 狀態 |
| --- | --- | --- | --- |
| 1 | 讓檢索**正確** | 前端不再用字面比對否決主機答案；字面搜尋與 embedding 解耦；混合排名；語意檢索測試；模型失敗的退路 | **已完成**（§3.14、§3.15、`tests/retrieval.test.mjs`） |
| 2 | 讓檢索**快** | 有查詢時換成結果列（標題／問題／一句話／分類／命中理由）；桌面全域快速搜尋疊層；鍵盤優先操作 | **已完成**（§3.16、`app/quick/page.tsx`） |
| 3 | 讓建立**便宜** | Card ID 與編號自動產生；Quick Capture：貼上 → AI 草稿 → 只確認標題／問題／摘要／分類，其餘收在進階編輯 | **已完成**（§3.17、`tests/capture.test.mjs`） |
| 4 | 把 **Storage 和 Cache 接起來** | 結構化來源（`source_type` / `source_url` / `source_external_id` / `source_updated_at` / `source_content_hash` / `source_checked_at`，全部 nullable，原本的 `source` 字串保留給顯示用）；首頁定位改寫 | **已完成**（§3.18、`tests/source.test.mjs`） |
| 5 | 重新發現**忘掉的** | 偶爾把久未查看、或與最近閱讀相關的卡浮出來；來源過期提示；手機端搜尋優先 | **已完成**（§3.19、§3.20、§3.21，`tests/resurface.test.mjs`） |

**第 1 階段先做完才做後面的。** 搜尋不可信的話，後面每一個功能都只是把人更快地送到一個錯的答案。

### 幾個階段裡容易做歪的地方

- **Card ID 是實作細節。** 一般使用者沒有理由思考該叫 `attention-v2` 還是 `attention-mechanism`。ID 由 runtime 自動產生，只在進階／除錯介面看得到；編號也自動產生。**編號不該擋住 capture。** 實作與守門的測試見 §3.17。
- **快速搜尋不要另開一條 API。** 沿用 `GET /search` 就好，Global Quick Search 只是另一個 client。開新的 `/quick-search` 會讓主視窗與快速搜尋長出兩套搜尋邏輯，然後其中一套會先壞掉。
- **來源過期只給草稿，永遠不自動覆寫。** 卡片記的是使用者**當時的理解**，不一定等同來源的最新文字。可以說「原始資料已更新，這張卡可能需要重新整理」，不可以自己改掉。
- **手機端預設畫面是搜尋，不是整面收藏牆。** 手機的情境是「我現在突然要查一件事」，不是欣賞收藏。
- **關聯圖不刪，但它是檢索的增強而不是產品本身。** `/related` 目前能給 semantic／manual／category／tag／topic 的理由，這已經足夠支撐第一階段；短期不要加更複雜的 layout、更多 edge 類型、更多動畫、更複雜的節點編輯。

---

## 3. 絕對不要動的不變式

這幾條被打破時**不會有錯誤訊息**，只會讓產品慢慢變成垃圾。這是它們危險的原因。

### 3.1 全庫向量寬度必須一致

一個 384 維向量和一個 1024 維向量之間沒有「相似度」可言。`cosine()` 在寬度不符時**直接丟例外**，這是刻意的：

```js
// desktop/local-api.cjs
if (first.length !== second.length) throw new Error(`embedding 維度不符…`);
```

- 權威來源是 `expectedEmbeddingDimensions()`（`model-runtime.cjs`）。
- 自訂 API 的寬度由**第一次成功的回應**決定，之後必須一致。
- 加入自訂 embedding 模型時，維度必須在下載前就確定。做不到就擋下來，不要先下載再說。

**不要**為了「讓它不要爆」而改成回傳 0 分或跳過。爆掉就是設計。

### 3.2 hash embedding 不是語意模型，永遠不可以當替代品

`embedding-hash-384` 是詞彙重疊的 deterministic fallback。把它混進由真模型建立的資料庫，會產生**看起來合理但毫無意義**的相似度分數——這比明顯的錯誤糟得多。

`fallbackOrThrow()`（`model-runtime.cjs`）只在 hash 本身就是啟用中的 embedding 時才允許回退。不要放寬這個條件。

### 3.3 語意分數是相對值，不是 cosine

強多語言模型會把所有配對壓在很窄的高分帶裡（實測 0.698–0.908）。**絕對 cosine 門檻無法分辨「相關」與「兩者都是中文」。**

所以 `semanticBaseline()` 會取樣這個收藏自己的分數分布，再把 cosine 映射成相對值。`RELATION_MIN_SCORE = 0.42` 是相對於這個分布的值，**不是 cosine**。

- 看到 `0.42` 不要想成「cosine 0.42」。
- 不要新增任何直接拿 `cosine()` 結果和常數比較的程式碼。
- 樣本太少（<6）時 `scoreRange` 回傳 `null`，此時不標記「語意相似」——這是正確行為，不是 bug。

**但相對分數答不出「這個卡冊裡有沒有這件事」。** 每個查詢都有一張最高分的卡，而顯示的分數是它在這次查詢自己的分佈裡的位置，所以不管你打「為什麼需要多數決」還是 `asdfghjkl`，最高分永遠是 1.0。實際發生過：97 張卡的卡冊搜「橘子」回了 50 張資料庫與分散式系統的卡，每一張看起來都像命中。

`standoutFloor()` 回答的是另一個問題：**最高分比這次查詢的中位數高出多少，以卡冊自己的尺度計**。尺度就是 `semantic_baseline` 的 `hi - lo`（卡對卡的 p99 減中位數），所以它跟著模型走，沒有任何常數在跟 cosine 比。

**這個尺度必須被存下來，而且必須跟著卡冊重新量。** 那是 v1.2.1 修掉的 bug：`rebuildSemanticRelationsFor()` 算了 baseline、用完就丟，所以**一張一張建起來的卡冊從來沒有 baseline**，`standoutFloor()` 每次都走 `!baseline` 那條 return null，什麼都沒被過濾。實測 58 張卡的 benchmark：no-result accuracy 是 **0%**——十二個問卡冊裡根本沒有的東西的查詢，每一個都回了一整頁看起來很有把握的卡。現在走 `refreshSemanticBaseline()`：寫回 store，並在卡片數量變動超過五分之一時重量一次（凍住第一次的話，五百張卡的卡冊會被釘在最初六張的尺度上）。

**門檻 `SEMANTIC_STANDOUT = 0.6` 是量出來的，而且量過兩次。**

原本是 0.9，那個數字是對著另一個 embedding 模型量的（30 個查詢，答得出的 0.98–3.08、答不出的 0.31–0.85）。換成內建的 EmbeddingGemma 之後那條空隙的位置變了——**門檻跟著模型走，不是跟著直覺走**，所以換模型就要重量。

用 `npm run benchmark:retrieval` 掃了六個值（126 個查詢、58 張卡、真模型）：

```
STANDOUT     R@1     R@3     R@5     MRR   no-result
0.30       92.1%   98.2%   99.1%   0.951      0.0%
0.60       92.1%   98.2%   99.1%   0.951     58.3%   ← 選這個
0.70       92.1%   96.5%   97.4%   0.945     75.0%
0.90       92.1%   93.9%   93.9%   0.930     91.7%
```

**0.60 是免費的：沒有任何一題變差。** 0.70 多買到 16.7 個百分點的 no-result，代價是兩題從第 3 名變成完全消失——而那兩題正好是「之前那個 logging 不用寫進每個 function 的做法叫什麼」與「之前看到一個方法可以讓模型不要亂編，會附出處的」，也就是這個產品存在的理由本身。0.90 會弄丟六題，其中三題什麼都回不出來。

判準沒有變：**搜不到自己寫過的卡，比多看到一張卡糟糕得多**，所以疑慮花在留下結果。0.60 之下還有五個查詢會回一兩張不相干的卡，那是還沒解決的部分，不是可以接受的部分——但它已經不是回一整頁了。

要動這個數字，先跑 benchmark（§3.22），前後數字寫進 commit 訊息。

`null` 代表「沒有意見」（卡片太少、或卡冊裡的卡彼此都差不多），此時不過濾。

### 3.4 封面圖案名稱必須存在於前端圖庫

`app/cover-art.tsx` 的 `glyphLibrary` 對未知名稱的處理是：

```tsx
{(shape && glyphLibrary[shape]) ?? glyphLibrary.quad}
```

**不會報錯，只會全部變成同一個四方格。** 這個 bug 上線過一次，整櫃卡片的封面失去所有資訊而沒有任何人發現，直到有人用肉眼看出來。

`tests/cover-art.test.mjs` 現在會擋下來。不要為了「加一個新圖案」只改後端。

### 3.5 卡片顏色由分類決定，且指派後不可重算

- 顏色記錄在 SQLite `meta` 的 `category_accents`。
- 指派只發生一次；之後**永遠不重算**。
- 原因：重算會讓「刪掉一個分類」把整櫃卡片重新上色。顏色是辨識的一部分。

`assignCategoryAccents()` 只填沒有顏色的分類，並清掉已不存在的分類。不要改成「每次依目前分類列表重新分配」——那個版本試過，很好看，但使用者的卡片會莫名其妙變色。

### 3.6 封面綁定卡片 id，不綁內容、不綁向量

封面曾經是從 embedding 算出來的，理由寫在註解裡：「讓圖案跟著語意走」。**它從來沒有跟著語意走。** 每個決定都經過向量的 SHA-256，所以實測兩張說同一件事、餘弦 0.99 的卡，圖案吻合度 7%，而隨機期望值是 6%。它一直都是雜湊，只是雜湊了一個會動的東西。

而且動得很貴：來源雜湊涵蓋九個欄位，所以**刪掉一個句號，卡片就被重畫成主人沒看過的樣子**——跟原本沒有一個圖案相同。用眼睛認卡正是封面的用途。

現在是 `buildCover(card.id, category, accents)`，只吃 id 與分類顏色。

- **不要**把內容、向量、或任何會隨編輯改變的東西加回種子。
- 「換模型會不會重畫封面」不再需要規則擋——結構上就辦不到了。
- 顏色仍然來自分類，那是刻意的例外（見 §3.5）。
- `density` 與 `orbit` 決定 `app/card-face.tsx` 的漸層焦點。從向量算的時候它們是死的（正規化向量的分塊平均恆等於零，200 張卡只有 4 個相異值），現在才真的會變。

封面仍然是衍生資料，而 `reindexStore` 只看 embedding，**會直接走過所有舊封面**。所以改動封面產生方式時：

1. 升 `COVER_VERSION`
2. 確認 `refreshStaleCovers()` 會抓到（它比對 version 與分類顏色）

漏掉第 1 步的結果是：新安裝正常、舊使用者永遠看到舊版本，而且沒有任何錯誤訊息。

### 3.7 換 embedding 模型：先重算，最後才切換

`/search` 用**啟用中**的模型把查詢轉成向量，再丟掉所有寬度不同的卡（`hasUsableEmbedding(card, queryVector.length)`）。所以只要「先切換、後重算」，每一張還沒轉換的卡就是不存在的。

實測 91 張卡從 BGE-M3 換到 EmbeddingGemma：**切換後第一次搜尋只回 1 筆**，花 15 秒才長回 50 筆。兩千張卡就是將近十分鐘、卡冊看起來被清空。

正確順序在 `applyEmbeddingPlan()`：

1. `planSelect()` / `planSettings()` 只驗證，**不套用**
2. `stageEmbeddings()` 用新模型算完全部，寫進 `card.embedding_pending`
3. `plan.apply()` → `commitStagedEmbeddings()` 一次換掉
4. `reindexStore()` 收尾，處理重建期間新增或編輯的卡

要點：

- **`embedding_pending` 不在 `store.cjs` 的 SCHEMA 裡，這是刻意的。** 暫存向量永遠不落盤，所以中途崩潰＝什麼都沒發生。舊做法會留下一半新一半舊，而且沒有東西會自己修好。
- **不要新增「立刻切換模型」的函式。** `select()` 與 `restoreSettingsState()` 已經移除——一個先套用，一個收拾先套用的後果。要立即套用就寫 `planSelect(...).apply()`，讓它讀起來是個決定。
- 重建期間會同時載入兩個模型（`loadPipeline` 按模型快取）。這是這個做法唯一的成本。
- 取消現在真的會取消：`taskManager` 的 context 多了 `cancelled()`，worker 必須自己問。以前取消只是把任務標成 cancelled，工作照跑照套用。

`tests/model-migration.test.mjs` 用一個會慢慢回應的假 embedding 服務守著這三件事，不需要權重也不需要網路。三個測試都驗證過：把順序改回去會紅在「search shrank during the rebuild: 0, 0, 0, …」。

### 3.8 `save()` 是唯一的寫入收斂點

```js
const save = (changedCards) => { … refreshStaleCovers(store) … db.save(store, { cards }) }
```

- 分類顏色在這裡定案，所以任何新增分類的操作都不會寫出錯的顏色。
- `changedCards` 只寫指定的列。**重新上色的卡片必須併進這個集合**，否則變更會遺失。
- API 回應要送 **store 裡的物件**，不是本地副本。`Object.assign(existing, card)` 之後 `card` 已經是另一個物件，回傳它會讓前端拿到 `save()` 重新上色前的舊值。這個 bug 真的發生過。

### 3.9 安全邊界

- 桌面 API **只監聽 loopback**，權杖由前端在伺服器端代理，不經過網路。
- **介面本身沒有登入機制。** `KCC_HOST=0.0.0.0` 等於讓所有能連到這個埠的人讀寫你的卡片。只能用在私人網路（Tailscale / WireGuard）。
- 不要新增任何把權杖送到瀏覽器的程式碼。
- 區網分享是**另一個** server（`startLanApi`，HTTPS、8443），不是把 loopback server 改成監聽 `0.0.0.0`。loopback 那個永遠維持原樣。
- **裝置權杖的權限比本機權杖小。** `deviceMayReach()` 是唯一的判斷點：`cards`、`categories`、`search`、`trash` 全開；`GET /settings`、`GET /tasks`、`GET /app/version` **只能讀**；其餘（模型、資料庫、裝置管理、區網）一律 403。唯讀那三條是刻意加的——沒有它們，手機的設定頁只能是一個「關於這支手機」的頁面；有了寫入權，一支被撿走的手機就能重設主機或把整櫃資料匯出去。**新增路由時要想清楚它屬於哪一邊——預設是不放行**，而且唯讀清單是一條一條列的，不是用前綴：`/app/version` 可讀不代表未來的 `/app/*` 可讀。`tests/api-contract.test.mjs` 有一張政策表擋著。
- 配對碼一次性且十分鐘失效，`pair()` 在發出 token 前先清掉它。不要為了「使用者重試比較方便」把這個拿掉：一個看得見的碼就只能換一把鑰匙。
- 裝置清單**永遠不回傳 token**，資料庫裡也只存 SHA-256。`tests/api-contract.test.mjs` 有斷言擋著。

### 3.10 平台差異寫在一個地方，而且要誠實回報

Windows 與 macOS 的差異只允許出現在 `desktop/` 的少數幾個檔案裡（`bonjour.cjs`、`lan-certificate.cjs`、`main.cjs` 的圖示、`mcp-server.cjs` 的 manifest 路徑）。其餘程式碼一律跨平台。

- **不要用 `execFile` 叫系統工具做跨平台的事。** 憑證產生曾經寫死 `/usr/bin/openssl`／`/opt/homebrew/bin/openssl`，Windows 沒有 OpenSSL，整個區網分享直接不能用。現在用 `node:crypto` 產金鑰、node-forge 做 X.509 編碼，兩邊同一條路徑。
- **不要用介面名稱猜哪張網卡是真的。** Windows 上 `192.168.56.1` 可能叫「乙太網路 3」（VirtualBox），名字完全看不出來。真正的答案來自路由表：`defaultLanAddress()` 用一個 connected UDP socket 問，不送封包也不開子行程，兩個平台通用。
- **能力不存在時要說實話。** mDNS 在 macOS 一定有，在 Windows 只有裝了 Apple Bonjour 才有。`status()` 回報 `discovery_active` / `discovery_detail`，介面照著顯示。**不要寫死「Bonjour 已啟用」**——之前就是這樣，在沒有 Bonjour 的機器上直接騙人。
- **子行程的 `error` 事件一定要接。** `spawn` 找不到執行檔是**非同步**的 `error` 事件，沒接就會 throw 掉整個 Electron main process。而且要 `await` 到它落定再回報狀態，否則 `active` 會先是 true 再偷偷變 false。

### 3.11 向量大小是「輕量／高精度」，不是「384／1024」

實測過：**Hugging Face 上沒有 384 維、專為中文訓練又有 ONNX 權重的句向量模型。** 384 那一檔全是 MiniLM 家族，不是英文就是多語言蒸餾版。最小的中文專用模型是 `bge-small-zh-v1.5`，512 維。

所以介面上的按鈕是**大小分級**，實際寬度寫在被選中的卡片上。不要為了「比較整齊」把它改回 384/1024 兩個按鈕——那個承諾只能靠偷偷回傳別種語言的模型來兌現，而那正是使用者要求修掉的行為。

### 3.12 版號只有一份

`package.json` 是唯一來源。`scripts/release-check.mjs` 會掃 `desktop/*.cjs`，出現不一致的版號字面值就失敗。

會這樣是因為 MCP bridge 曾寫死 `0.1.0` 對所有 AI 工具回報錯版本，而 OpenAPI 文件寫死 `0.4.0`——一個既不是 app 版本也不是路由 `v1` 的數字。

### 3.13 備份校驗碼只能由產生它的實作驗證

JSON 浮點數序列化在不同 runtime 之間不同（Python 給 `4.92e-05`，JS 給 `0.0000492`）。跨工具的備份請**移除 `checksum_sha256` 欄位**再匯入；沒有校驗碼的 payload 會跳過該檢查。不要試圖「修好」跨 runtime 的校驗。

### 3.14 搜尋是兩條管線，其中一條永遠不准被另一條擋住

`/search` 的候選集是**全部未刪除的卡**（再套分類／標籤過濾），然後同時跑兩件事：

```
Query
 ├─► lexicalMatch()      每一張卡，不需要向量
 └─► cosine(queryVector) 只有向量寬度對得上的卡
        ↓ 合併 ↓
   score = 0.6·語意 + 0.4·字面 (+ 標題完全相同的 0.5)
```

**任何一邊都不准把卡片從另一邊手上拿走。** 這條寫成這樣是因為原本的順序是「先 embed 查詢，再 `hasUsableEmbedding` 濾掉寬度不符的卡，最後才算字面分數」——結果一張 embedding 失敗的「Spring AOP 是什麼？」，就算你一字不差把標題打進去也搜不到，因為它根本沒進到打分階段。

所以：

- `modelRuntime.embed()` 的呼叫**包在 try 裡**。模型沒下載、壞掉、正在重建，就是沒有語意那一半，不是沒有搜尋。
- 模型壞掉時 `semantic_score` 回 `null`（不是 0），`語意相似` 這個理由也不會出現。**「這張卡沒有可比較的向量」和「模型看過它但不覺得像」是兩個不同的答案**，回 0 就分不出來了。
- 保留 `standoutFloor()`（§3.3），但它只管語意那一半。字面命中的卡永遠不會因為「語意上很普通」被丟掉。

**中文查詢用字元 bigram 比對，不要用空白切詞。** `lexicalTerms()` 把中日韓字串切成 bigram（跟重複偵測同一個單位），拉丁字母維持整個詞。原本用 `split(/\s+/)`，於是整句中文變成一個巨大的 term，只有完全子字串能命中——「為什麼需要多數決」和「為什麼共識需要過半數？」是同一個問題卻一個字都不重疊，字面分數是 0。

`LEXICAL_MIN_COVERAGE = 0.5` 是「你打的東西有一半以上出現在這張卡上」。**放寬它就是讓「每個查詢都回整個卡冊」用另一種形式回來**——bigram 很容易零星命中，十一個 bigram 中了一個是雜訊不是命中。`tests/retrieval.test.mjs` 有一題專門搜「橘子的種植與採收季節」，期望回 0 筆。

排名權重（`LEXICAL_FIELDS`）是「標題 > 問題 > 摘要 > 分類/標籤 > 內文」。這是產品決定，不是量出來的閾值，也沒有跟任何常數比大小。

沒有向量的卡，字面分數同時當兩半用而不是被砍半——否則模型失敗的那張卡會排在只對了一半的卡下面，那是同一個 bug 換件衣服。

### 3.15 P-02 適用於之後每一個功能，不只搜尋

上一條是 P-02（§1）在搜尋上的實作。這條是它的驗收方式，寫在這裡是因為它適用於所有會用到模型的東西：

**把模型整個弄壞，這個功能還剩下什麼？** 如果答案是「什麼都沒有」，那它就設計錯了，不管它平常表現多好。

`tests/retrieval.test.mjs` 用一個會對所有請求回 503 的假 embedding 服務守著搜尋這一塊。之後新增任何依賴模型的功能，請照同樣的方式加一題——不需要權重、不需要網路。

### 3.16 快速搜尋疊層：預先建好、藏起來，而且只能有一套搜尋

這個疊層是整個產品定位的兌現點——有人在 VS Code 裡忘了某個概念，取回它的成本必須是一個按鍵。所以有三件事不能動：

**視窗是「藏起來」不是「關掉」。** `quickWindow` 在 `app.whenReady()` 就建好，前端一起來就把 `/quick` 載進去，之後永遠只 `show()` / `hide()`。改成用完就關、要用再開，按下快捷鍵到畫面出現會慢到讓人以為沒反應，而目標是 150ms。同理 `backgroundThrottling: false`：Chromium 會節流沒顯示的視窗，那正好會讓「叫出來之後的第一個按鍵」變鈍。

**快捷鍵搶不到就要說出來。** `globalShortcut.register()` 搶不到時**回傳 false，不會 throw**。忽略它的下場是出一個招牌功能靜靜地什麼都不做。`registerQuickShortcut()` 會依序試 `QUICK_ACCELERATORS`，把真正拿到的那個記在 `quickAccelerator`，介面透過 `quick:shortcut` 問出來再顯示。**不要在前端寫死 `⌘⇧K`**——那是猜的，`tests/rendered-html.test.mjs` 會擋。

**不要為快速搜尋開第二條 API。** 疊層是 `GET /search` 的另一個 client，不是另一種搜尋。開 `/quick-search` 會長出第二套排名，然後兩套裡總有一套會爛掉而沒人發現。

另外兩個容易踩的：

- 焦點永遠留在輸入框，結果列是「用游標選」不是「用 Tab 走」（所以 row 是 `tabIndex={-1}`）。這樣才能邊打字邊選。
- **疊層的 debounce 是 150ms，收藏頁維持 250ms。** 兩個介面在做不同的事：瀏覽卡冊容得下一個停頓，疊層要在你還沒意識到自己問完之前就回答。實測（IME 每 220ms 送出一段，各跑五次，從最後一個按鍵量到答案出現在畫面上）：250ms 是 835ms（635–1039），150ms 是 293ms（286–299）——五次裡 150 的最差一次還贏 250 的最好一次。其中一部分是那 100ms，另一部分是打字途中一直發請求會讓模型保持熱的，所以真正那一發不是閒置後的第一發。代價量過了：每次查詢多花大約十一次 embedding（abort 一個 fetch 不會讓伺服器停下手邊的工作）。**不要再往下調**：那個節奏下已經是每個按鍵一個請求、十二分之十一被 abort，沒有東西可以再買了。
- 疊層不自己開卡片。`Cmd/Ctrl + Enter` 走 `quick:open-card`，把 id 交給主視窗。在這裡複製一份 viewer 等於兩份都要維護，而讀者本來就到得了那個畫面。
- **但交出去的方式不可以是重新載入主視窗。** 原本是 `mainWindow.loadURL(.../collection?card=…)`，那會重建整個 renderer——於是「查一個概念」會把正在寫、還沒存的卡片丟掉。**檢索功能弄壞 capture，比沒有檢索功能還糟。** 現在 renderer 掛好時自己 invoke `collection:ready`，主行程據此送 `collection:open-card` 事件；`loadURL` 只留給「卡冊還沒起來」那條路。
- **ready 不能用網址判斷。** `webContents.getURL()` 在導航一 commit 就回 `/collection`，那時 React 什麼都還沒掛上。旗標由 renderer 自己說，並在 `did-start-navigation`（非 same-document）與視窗關閉時清掉。

### 3.17 卡片的 id 與編號由 runtime 決定，而且只決定一次

`POST /cards` 以前要求 `id`、`number`、`topic`、`title` 四個欄位。前三個是記帳，最後一個才是卡片。要人先想好該叫 `attention-v2` 還是 `attention-mechanism`，是把「留下這個理解」換成「之後有時間再整理」的標準做法（P-04）。

現在**只要求 `title`**——沒有標題的卡在任何清單裡都認不出來，那是唯一真的必要的欄位。其餘照這幾條走：

- **`generateCardId()` 產生 ULID 形狀的 id**（10 碼時間 + 16 碼亂數，Crockford base32 沒有 I/L/O/U）。可以照建立時間排序，dump 出來讀得下去。它是封面的種子（§3.6），所以必須唯一、穩定，而且**永遠不能從內容算出來**——否則改一個錯字就重畫卡片。
- **`nextCardNumber()` 給 `KC-000123`**，整櫃一套編號，不做分類前綴。分類已經用文字和顏色在卡片上出現兩次了，前綴是同一件事講第三遍；而且大部分分類是中文，沒有誠實的方法把「人工智慧」變成三個拉丁字母。計數**含垃圾桶裡的卡**，否則復原一張卡會撞到後來發出去的號碼。不符合這個格式的編號不列入計數，也不改寫。
- **caller 帶來的 id 與編號一律照用。** 匯入、備份、MCP、iOS 都可能自己管識別碼。
- **編號指派一次就不再重算**，理由跟顏色一樣（§3.5）：它是辨識的一部分。換分類、改標題都不會換號。
- `topic` 空的時候沿用 `category`。Quick capture 只問一次「這張卡放哪」，沒有這條的話垃圾桶列表會顯示「KC-000004 ·」，點後面什麼都沒有。

介面那半在 `CreateCardForm`：上面固定四個欄位（標題／問題／一句話／分類），其餘收在「展開進階欄位」裡——**是收起來不是拿掉**，比喻、細節、來源、標籤、主題、編號全部還在，編輯既有卡片時預設展開。卡片 ID 只在編輯既有卡片時以唯讀顯示；新卡還沒有 id，開一個框請人取名字等於把 friction 原封不動放回去。

### 3.18 來源是 cache origin，而它會變成一個可以點的連結

卡片是 cache entry，來源就是 cache origin。一個字串「Spring AOP 的 Notion 筆記」回答不了它值得被問的問題：東西在哪、有沒有改過、這張卡過期了沒有。所以除了原本的 `source`（顯示用文字，**不動、不取代**），旁邊多了七個 nullable 欄位：`source_type` / `source_title` / `source_url` / `source_external_id` / `source_updated_at` / `source_content_hash` / `source_checked_at`。

**這幾條是安全與正確性，不是便利：**

- **`source_url` 只收 http/https。** 它會被 render 成 `<a href>`，而來源正是使用者貼上東西時不會看內容的欄位。`javascript:` 與 `data:` 一律**丟掉**（不是跳脫），而且**卡片照樣存下來**——一個壞連結不是弄丟別人理解的理由。
- **外連在瀏覽器開，不在 app 裡開。** `mainWindow.webContents.setWindowOpenHandler` 一律 `deny`，只把 http(s) 交給 `shell.openExternal`。在 app 視窗裡開等於把一個任意網頁載進一個掛著 preload bridge、又沒有網址列的視窗。這是同一件事要成立的第二個地方。
- **`source_type` 從連結讀，不做下拉選單。** 六個沒人能據此行動的字，只會變成擋在卡片前面的第五個決定，而答案本來就在網址裡。使用者自己指定的 type 仍然優先。
- **連結一改，描述舊文件的欄位全部清掉**（title / external_id / updated_at / content_hash / checked_at）。把 hash 或 page id 帶過去，就是讓將來的過期偵測拿一張卡去比對一份它從來不是從那裡做出來的文件——安靜地、而且會給出看起來合理的答案。
  注意 PATCH 是 `normalizeCard({ ...existing, ...changes })`，所以 `input` 裡本來就有舊值。判斷「caller 這次到底說了什麼」的方式是**跟卡片原本的值比**：不一樣就是這次講的（所以新連結配新 hash 會留下），一樣就是 merge 帶進來的（連結換了就丟）。
- **這幾個欄位不進 `embeddingText()`。** 加一個連結沒有多說任何關於這張卡在講什麼的事；放進 embedding source hash 的話，第一個人填來源的那天整櫃卡片會重算向量。

`source_content_hash` 與 `source_checked_at` **目前沒有任何東西會寫**，它們屬於過期偵測（第 5 階段）。現在就加是為了不要再做一次 schema migration，不是因為有人在填。接上任何東西之前先回來讀這一節。

**schema 遷移**：`STORE_VERSION` 是 4。`CREATE TABLE IF NOT EXISTS` 對已存在的表什麼都不做，所以 `openStore()` 另外用 `PRAGMA table_info(cards)` 補 `ALTER TABLE ... ADD COLUMN`。漏掉這步的結果是全新安裝正常、所有既有使用者的資料庫一直回 "no such column"。加 nullable 欄位就是整個遷移：SQLite 不改寫任何 row，比它早的卡片讀回來就是 null。

### 3.19 去看來源有沒有變：只在有人按下去的時候

第 4 階段留了 `source_content_hash` 與 `source_checked_at` 兩個沒人寫的欄位。現在有人寫了，而寫的方式就是這條的全部重點。

**這是整個 app 第二個對外請求。** 第一個是更新檢查，而它可以被信任的理由是它有邊界、而且關得掉（見第 4 節那條）。第二個必須賺到同一句描述：

- **只在有人按下那張卡上的按鈕時發生。** 沒有排程、沒有開啟時檢查、沒有批次。使用者自己貼上的那一個網址，一次一張卡。
- **`KCC_SOURCE_CHECK=off` 整個關掉**，跟更新檢查一樣。
- **不帶任何識別資訊**：`credentials: "omit"`、固定的 User-Agent、8 秒逾時。
- **2MB 上限是「最多下載」，不是「最多雜湊」。** 讀的是 `response.body` 的 reader，滿了就 `cancel()`。原本寫成 `await response.arrayBuffer()` 再 `subarray(0, 2MB)`——那只限制了雜湊多少，來源回 500MB 就有 500MB 進到這個行程裡，然後用掉兩個。**不要為了「簡單一點」改回去**，`tests/source.test.mjs` 的 `source stream stops at configured cap` 用一台想送 20MB 的伺服器擋著（改回舊寫法：它會送完整整 20,971,520 bytes）。
- **不看 `Content-Length`。** chunked 沒有、壓縮過的是錯的，而一條只有乖伺服器會走到的分支會爛掉。真正的限制在 reader 裡。
- **裝置權杖一律 403。** `/sources` 在 `deviceMayReach()` 裡是第一條就擋掉的——一支被撿走的手機不可以叫主機去連只有主機連得到的位址。所以這兩條路由**不放在 `/cards` 底下**：`cards` 對裝置是全開的，掛在那裡就等於開了。
- **連不到就是「不知道」，不是「變了」。** 回 `unreachable`，不寫 `source_stale_at`。跟更新檢查同一條紀律。
- **比對的是正文，不是回應的 bytes。** `canonicalSource()` 按 Content-Type 處理：HTML 先拿掉 script／style／noscript／template／svg／iframe 與註解，再去標籤、解 entity、壓空白；text 與 JSON 只壓空白；其餘（PDF、圖片）維持 bytes。**不這樣做的話這個功能在真實網頁上是廢的**——文章一個字沒改，但 CSP nonce、analytics id、script hash、hydration state 每次都不一樣，於是每次都說「來源變了」。**一個大多數時候都在誤報的提示，人就不看了。**
  它是變更偵測用的指紋，不是 renderer；標籤是用樣式拿掉的，不是 parser。弄錯的後果是指紋稍微不同，而它永遠只跟自己比。
- **介面說的是「來源內容可能已經更新」，不是「你的知識已過期」。** 來源變了不等於理解變了——卡片記的是使用者當時讀懂的東西。

**卡片本身永遠不會被覆寫。** 卡片記的是使用者當時的理解，那跟來源現在的文字是兩件事。`check` 只寫 hash 與時間戳；`accept` 也只寫 hash，意思是「我看過了，之後以現在這版為準」，不動標題、摘要或任何一個字。第一次檢查是記錄基準線（`recorded`），不是宣告有變。

### 3.20 重新浮現：一張卡、偶爾、而且關得掉

搜尋回答的是「我知道我寫過這個」。它結構上答不了「我根本忘了我學過這個」，而後者才是比較貴的那種遺忘。這是整個產品裡唯一針對它的功能，也是唯一有風險悄悄變成 Anki 的地方（第 9 節）。

界線畫在**資料模型**上，因為那是 Anki 真的會長出來的地方。`store.cjs` 的 `RECALL_COLUMNS` 只有兩欄：

- `last_opened_at` — 上次打開這張卡的時間。**沒有任何東西從它算出間隔**、排出複習、或數連續天數。
- `resurface_muted_at` — 使用者說「不要再推薦這張」。

要加 ease factor、due date、review count，得先加到這裡；`tests/rendered-html.test.mjs` 盯著這份清單。

其餘的規則：

- **一次一張，`RESURFACE_QUIET_DAYS = 90` 天沒打開才算候選**（從沒打開過的，用建立時間算——一年前整理、之後沒再看，正是這功能存在的理由）。
- **`RESURFACE_OFFER_GAP_HOURS = 20`，而且記在 `meta` 不是記在前端。** 一個卡冊有好幾個視窗看它，「偶爾」必須是跨視窗的偶爾。每次載入都出現的建議不是建議，是嘮叨。
- **`?force=1` 是「我自己再問一次」**，跟「頁面重新載入」是兩件事。換一張走這條。
- **讀一張卡不會動 `updated_at`。** 讀不是改；混在一起「最近更新」就沒有意義了。
- **沒有東西可以說的時候就不說。** 空卡冊、新卡冊、或每張都最近讀過的卡冊，回 `card: null`。不要拿最新的卡去填那個位置。

### 3.21 手機的第一個畫面是搜尋

手機上打開這個 app 的理由是「我現在要查一件事」，不是「給我看我擁有的全部東西」。所以 `max-width: 640px` 時：

- 搜尋框吃掉整個第一列，其餘篩選排到下面。輸入框 `font-size: 16px`——比這小 iOS 會在 focus 時自己放大整頁。
- 快捷鍵提示 `display: none`。手機沒有那個東西。
- **沒有查詢時不給整面收藏牆**，改成 `SearchResults` 列出最近整理的 12 張。這條在 `page.tsx` 用 `matchMedia` 判斷（在 effect 裡讀，桌面版 hydrate 前不可能知道）。
- 那份列表**不帶命中理由**（`reasons={new Map()}`）。它沒有跟任何東西比對過，貼一個理由上去就是在回答沒人問的問題。

### 3.22 改搜尋之前先跑 benchmark，改完再跑一次

`npm run benchmark:retrieval`。58 張卡、126 個查詢、五種檢索意圖加上 12 個「卡冊裡真的沒有」的查詢，跑的是**真的內建模型**，不是測試用的替身。

**單元測試和 benchmark 回答的是兩個不同的問題。** `tests/retrieval.test.mjs` 問「搜尋壞了沒」，用替身模型、不需要權重也不需要網路，所以它能進 `npm test`。benchmark 問「搜尋準不準」，那個問題只有真模型答得出來，而且一跑兩分鐘——所以它是一道指令，不是測試。

**動到下面任何一個之前，先跑一次存成 baseline：**

`LEXICAL_WEIGHT`、`LEXICAL_MIN_COVERAGE`、`EXACT_TITLE_BONUS`、`LEXICAL_FIELDS`、`SEMANTIC_STANDOUT`、`RELATION_MIN_SCORE`、`embeddingText()`、`/search` 的候選集或過濾條件、內建 embedding 模型。

**`--gate` 是自動的那一半。** 它拿 `tests/fixtures/retrieval-benchmark/baseline.json` 比對這次的結果：Recall@3 掉超過 2 個百分點、或 no-result accuracy 掉超過 5 個百分點就 exit 1。

**但 gate 失敗不等於「改回去」。** 有些交換是划算的——Recall@3 從 95 掉到 93、no-result 從 71 升到 96，那多半值得。規則是：**在 commit 訊息裡寫出前後數字與理由**，然後 `--update-baseline` 把基準線移下來。不准只寫「新模型比較好」。

**不准為了讓分數回升去改 ground truth。** 新增查詢可以，改既有的 `expected` 必須有人工理由。同理，benchmark 的查詢不可以全部挑現在特別好命中的句子——它現在就有兩題答不出來，那是它有在量東西的證據。

**實際用起來搜不到的句子，先加進 benchmark 再修搜尋。** 順序是「加查詢 → 確認現在真的失敗 → 修 → 確認不再失敗」，不是「憑感覺調權重」。這樣使用者的痛點會變成 regression test，而不是變成一次猜測。

`--lexical` 把模型換成一台全部回 503 的服務，量的是 P-02 那條退路實際上剩下多少。實測（EmbeddingGemma 768d，58 張卡）：

```
                  hybrid    lexical-only
Recall@1          92.1%     66.7%
Recall@3          98.2%     67.5%
MRR               0.951     0.670
no-result acc.    58.3%    100.0%
warm p50           194ms       4ms
```

（這兩欄同一次量。**延遲要成對量**：同一個模型在同一台機器上量到過 77ms 也量到過 194ms，機器忙不忙的差別比模型之間的差別還大，所以跨天的數字不能拿來比。）


### 3.23 內建哪個模型是量出來的，不是挑出來的

內建的 embedding 模型決定搜尋品質的一半，所以它必須用跟其他搜尋決定同一套數字來回答。**不准用這些理由選它**：比較新、比較大、參數比較多、leaderboard 比較高、比較多人用。只有 §3.22 那個 benchmark 算數。

`npm run benchmark:retrieval -- --model <catalog-id> --models-dir <快取目錄>` 可以量目錄裡的任何一個模型。`--models-dir` 是給人用的：不指定的話權重會下載進當次的暫存目錄，下一次再下載一遍。

四個模型，58 張卡、126 個查詢、同一台機器、同一段時間內連續量完（延遲不成對量就沒有意義，見上一節）：

| | Multilingual MiniLM 384d<br>（前一代內建） | BGE-Small-ZH 512d | **EmbeddingGemma 768d**<br>**（現在內建）** | BGE-M3 1024d |
| --- | --- | --- | --- | --- |
| Recall@1 | 71.1% | 79.8% | **92.1%** | 91.2% |
| Recall@3 | 78.1% | 89.5% | **98.2%** | 93.0% |
| Recall@5 | 81.6% | 91.2% | **99.1%** | 93.9% |
| MRR | 0.753 | 0.845 | **0.951** | 0.923 |
| no-result accuracy | 33.3% | 16.7% | **58.3%** | 16.7% |
| warm p50 | 10ms | **8ms** | 194ms | 39ms |
| warm p95 | 16ms | **10ms** | 284ms | 59ms |
| 建 58 張卡的向量 | 3.3s | **1.8s** | 43.0s | 16.1s |
| 權重大小 | 129 MB | **23 MB** | 316 MB | 560 MB |
| 常駐記憶體 | 545 MB | **164 MB** | 1222 MB | 559 MB |

**結論：維持 EmbeddingGemma。** 理由不是它比較新，是這兩行：

| Recall@3 | MiniLM | BGE-Small-ZH | EmbeddingGemma | BGE-M3 |
| --- | --- | --- | --- | --- |
| forgotten-name（想不起來叫什麼） | 50.0% | 81.3% | **93.8%** | 81.3% |
| natural-recall（用自己的話問） | 35.7% | 85.7% | **92.9%** | 71.4% |

這兩種意圖就是這個產品存在的理由。查得出精確標題的模型有的是——四個模型的 exact 意圖都是 Recall@3 100%。分得出高下的地方在使用者只剩模糊印象的時候。

幾個量出來才知道的事：

- **BGE-M3 比 EmbeddingGemma 大 244 MB、慢 5 倍**（以 warm p50 算），而且**每一項品質指標都輸**。它是前一份文件裡「中英最佳」的那個，那個標籤是從外面抄來的。
- **BGE-Small-ZH 是真的便宜**：23 MB、8ms、164 MB 記憶體，Recall@3 89.5%。但少掉的 8.7 個百分點裡有一半以上是 forgotten-name 和 natural-recall。
- **no-result accuracy 不能直接橫著比**，因為 `SEMANTIC_STANDOUT = 0.6` 是對著 EmbeddingGemma 量的（§3.3，門檻跟著模型走）。所以另外量了把門檻壓到 0.30（等於關掉過濾）時的 Recall@3 上限：BGE-Small-ZH 86.8%、BGE-M3 94.7%。**兩個都還是低於 EmbeddingGemma 有開過濾時的 98.2%**，所以再怎麼調門檻也追不上——這個結論不靠門檻設定成立。
- **1222 MB 常駐是量到的，不是需求。** 那是 ONNX runtime 的 arena，配了不還而不是一直用著。它仍然是四個裡最貴的，記在這裡是因為 8 GB 機器上這件事會被感覺到。
- **194ms 的 warm p50 剛好在 §1 的 ≤300ms 預算裡，p95 284ms 也是。** 這是唯一一個「維持現狀」有代價的地方，而且沒有多少餘裕。哪天卡冊大到讓它掉出預算，第一個該重量的就是這張表。

要換掉內建模型，先把新的量進這張表，前後數字寫進 commit 訊息。`scripts/fetch-bundled-model.mjs` 的 `MODEL_ID` 與 `model-runtime.cjs` 的 `BUNDLED_EMBEDDING_MODEL` 是同一個決定的兩半，兩邊都要改。

---

## 4. 連動地圖：改這裡，就一定要改那裡

| 你改了 | 就必須同時改 | 不改的後果 |
| --- | --- | --- |
| 新增一個 accent 色帶（`.search-hit--<色>` 之類） | 八組 `--domain-*` 選擇器每一組都要加；`--domain-*` 只設在列出來的選擇器上 | 色帶整條變透明，等於沒有分類顏色 |
| 快速搜尋疊層的視窗生命週期或快捷鍵 | 見 §3.16：藏不是關、搶不到要說、不開第二條 API、交卡片用 IPC 不用 `loadURL` | `tests/rendered-html.test.mjs` 會失敗（刻意的）——招牌功能靜靜地不動作 |
| `preload.cjs` 新增 bridge | 對應的 `ipcMain.handle` 要有，而且想清楚每個視窗都拿得到它 | 前端呼叫一個不存在的 handler，錯誤只會出現在 console |
| 有查詢時的收藏頁畫面 | 走 `SearchResults`，不要退回分類牆；一句話摘要必須在列上（P-03） | 讀者又得點開卡片才知道自己以前寫了什麼 |
| `/search` 的候選集或過濾條件 | 想清楚它擋掉的是哪一條管線；字面那條**永遠**要看到全部的卡（§3.14） | `tests/retrieval.test.mjs` 會失敗（刻意的）——模型一壞，整個搜尋跟著壞 |
| `LEXICAL_MIN_COVERAGE` / `LEXICAL_FIELDS` / `LEXICAL_WEIGHT` | 先跑 `tests/retrieval.test.mjs`，特別是「搜不到的東西要回 0 筆」那題；再跑 `npm run benchmark:retrieval -- --gate`（§3.22） | 放寬字面門檻＝「每個查詢都回整個卡冊」換一種形式回來 |
| 內建 embedding 模型（`BUNDLED_EMBEDDING_MODEL` 與 `fetch-bundled-model.mjs` 的 `MODEL_ID`） | 用 `--model` 把新舊模型都量進 §3.23 那張表；兩個檔案是同一個決定的兩半 | 內建模型又變成憑名氣選的；或安裝包裡的權重跟 runtime 要找的不是同一個，打包版開起來沒有語意搜尋 |
| `SEMANTIC_STANDOUT` / `EXACT_TITLE_BONUS` / `embeddingText()` / 內建 embedding 模型 | `npm run benchmark:retrieval` 前後各一次，數字寫進 commit 訊息（§3.22） | 搜尋品質變成主觀感覺，沒有人知道哪次改動讓它變差 |
| `tests/fixtures/retrieval-benchmark/` 的 ground truth | 只增不改；要改既有的 `expected` 必須有人工理由，不可以為了讓分數回升而改（§3.22） | benchmark 開始測量自己，不再測量搜尋 |
| `/search` 回應欄位 | `app/collection/types.ts` 的 `ApiCard`；只增不改（手機端已發布，§8） | 舊版 App 讀不到新欄位，或型別對不上 |
| `POST /cards` 的必要欄位 | 想清楚它擋掉的是誰；只有 `title` 是必要的（§3.17）。`desktop/mcp-server.cjs` 的 `create_card` 也要跟著鬆綁 | `tests/capture.test.mjs` 會失敗（刻意的）——記帳欄位又站回卡片前面 |
| `generateCardId()` / `nextCardNumber()` | 兩者都不可以從卡片內容算出來；編號指派一次就不重算（§3.17、§3.5） | 改一個錯字就重畫封面；或復原一張卡撞到別人的號碼 |
| `CreateCardForm` 的欄位 | 上面固定四個（標題／問題／一句話／分類），其餘進 `.create-card-advanced`——是收起來不是拿掉 | `tests/rendered-html.test.mjs` 會失敗（刻意的）——建卡又變成填表單，或某個欄位被悄悄刪掉 |
| `normalizeSourceUrl()` 允許的 scheme | `main.cjs` 的 `setWindowOpenHandler` 要一致；兩邊都只放行 http(s)（§3.18） | 來源欄位變成可執行的連結；`tests/source.test.mjs` 與 `tests/rendered-html.test.mjs` 會失敗（刻意的） |
| 任何 `source_*` 欄位 | `store.cjs` 的 `SOURCE_COLUMNS`（含 `ALTER TABLE` 補欄位）、`publicCard`、`types.ts` 的 `SourceMetadata`；**不要**加進 `embeddingText()` | 舊資料庫開不起來；或第一個人填來源時整櫃卡片重算向量 |
| 首頁的定位文案 | 不要寫「在任何裝置上存取」（§1 P-05）；`site/index.html` 的 title 與 og:description、以及 `app/layout.tsx` 的視窗標題一起改——**三個地方**，第三個曾經整整晚一個階段才跟上 | `tests/rendered-html.test.mjs` 會失敗（刻意的）——分享出去的連結講的是另一個產品 |
| `RECALL_COLUMNS` 或任何跟「讀過沒」有關的欄位 | 想清楚它會不會被拿去算間隔、分數或連續天數；會的話不要加（§3.20） | 產品變成 Anki；`tests/rendered-html.test.mjs` 會失敗（刻意的） |
| `RESURFACE_QUIET_DAYS` / `RESURFACE_OFFER_GAP_HOURS` | 間隔記在 `meta`，不是記在某一個視窗裡（§3.20） | 每開一個視窗就被推薦一次，建議變成嘮叨 |
| 任何新的對外請求 | 先讀 §3.19：要按鍵觸發、關得掉、不帶識別資訊、失敗算「不知道」、裝置權杖不可用 | 一個號稱資料留在本機的工具開始自己連網；`tests/rendered-html.test.mjs` 會失敗（刻意的） |
| `/sources` 底下的路由 | **不要**搬到 `/cards` 底下——`cards` 對配對裝置是全開的（§3.9、§3.19） | 一支被撿走的手機可以叫主機去連內網位址 |
| 手機版面（`max-width: 640px`） | 沒有查詢時給最近整理的列表，不是收藏牆；那份列表不帶命中理由（§3.21） | `tests/rendered-html.test.mjs` 會失敗（刻意的）——手機第一個畫面又變成展示櫃 |
| 前端決定「哪些卡符合查詢」的邏輯 | 不要加。有 query 時主機的答案就是結果集，本地只保留「主機還沒回答」的墊檔（§3.14） | `tests/rendered-html.test.mjs` 會失敗（刻意的）——本地 includes() 會把主機刻意丟掉的卡放回來 |
| `MOTIF_SHAPES`（local-api.cjs） | `app/cover-art.tsx` 的 `CoverGlyph` union + `glyphLibrary` | 封面靜默退回單一圖案 |
| `PALETTES`（local-api.cjs） | `globals.css` 的 `--accent-*` 與 `.collection-card--*` 規則、`types.ts` 的 `visualAccents` | 卡片沒有顏色樣式 |
| 封面產生邏輯 | `COVER_VERSION` +1 | 舊資料永不更新 |
| 新增 API 路由 | `app/api/**/route.ts` 代理、`openapi.json` 的 paths、根路徑的 `capabilities` 陣列 | 前端 404；整合工具看不到新能力 |
| `store.cjs` 的 `SCHEMA` | `load()`、`writeMeta()`、`STORE_VERSION` 遷移 | 欄位讀不回來或舊資料庫開不起來 |
| `MODEL_CATALOG` 新增項目 | `size_tier`（summary）或 `language` + `dimensions`（embedding） | 簡易模式選不到它 |
| `EMBEDDING_TIERS` / `EMBEDDING_LANGUAGES` | 每個「語言 × 大小」組合都要有專門訓練的模型 | `tests/model-catalogue.test.mjs` 會失敗（刻意的）——那個測試存在的目的就是不讓組合退回別種語言的模型 |
| `DIMENSION_GUIDE` 涵蓋範圍 | 任何新的 embedding 維度都要有對應條目 | `tests/model-catalogue.test.mjs` 會失敗（刻意的） |
| `package.json` 版本 | 無（其他地方都用讀的） | — |
| `electron-builder.yml` 的 extraResources | `main.cjs` 的路徑解析、`model-runtime.cjs` 的 `bundledModelsDir()` | 打包版找不到資源 |
| 手動叫 `electron-builder`（例如只想建 `--dir`） | 一定要帶 `--config desktop/electron-builder.yml`；漏掉就沒有 extraResources、`productName`、圖示 | 打包成功、exit code 0，開起來卻停在「找不到前端 runtime」 |
| README 提到的 npm script | `package.json` 必須真的有 | `tests/rendered-html.test.mjs` 會失敗（刻意的） |
| `networkController.status()` 的欄位 | `types.ts` 的 `LanSharingStatus`、`panels.tsx` 的顯示 | 介面顯示 `undefined`，或宣稱一個不存在的能力 |
| `deviceMayReach()` 白名單 | 想清楚新路由該不該給手機；預設不給，唯讀的要一條條列不要用前綴 | 配對過的裝置拿到主機管理權限；`tests/api-contract.test.mjs` 的政策表會失敗（刻意的） |
| 手機看得到的主機狀態欄位 | iOS 端 `KCCAPIClient` 與設定頁；新能力要加進根路徑的 `capabilities`，讓舊版 App 能優雅降級 | 舊版 App 猜路由存在、拿到 403 當成壞掉 |
| `setting-cards.tsx` 的卡片結構 | `globals.css` 的 `.setting-card` 覆寫（`.collection-card__copy span` 與 `__tags` 在收藏頁是 `display:none`） | 設定卡的說明與標籤整片消失 |
| 動到 `electron-builder.yml` 的 `files` 排除規則 | onnxruntime-web 與 transformers 是「整包排除、再把 Node 入口加回來」；改版時要對照它們 package.json 的 `exports.node` | 打包版少掉 transformers 在 module load 就 import 的模組，整個模型堆疊在打包版才炸，開發模式看不出來；`tests/rendered-html.test.mjs` 會失敗（刻意的） |
| 首頁的內容 | 改 `site/landing.tsx`，不要在 `app/` 底下重開一個首頁路由；`app/page.tsx` 只能是轉址 | 首頁又會被打包進每一個桌面版；`tests/rendered-html.test.mjs` 會失敗（刻意的） |
| 首頁要讀設定 | 用 `import.meta.env.VITE_*`，不要用 `process.env`——Vite 會把它換成 `{}`，設定會靜靜變成空字串 | 下載連結永遠不會出現，也不會報錯 |
| 首頁連到收藏 | 只能連 `VITE_KCC_APP_URL`；`/collection` 不再跟首頁放在同一台伺服器上 | 靜態站上的按鈕連到 404 |
| 首頁多讀一個 `VITE_KCC_*` | 同時加進 `.github/workflows/pages.yml` 的 `env:`；發佈時沒設的變數不會報錯，只會消失 | 線上的首頁少一塊，本機建置看起來完全正常；`tests/rendered-html.test.mjs` 會失敗（刻意的） |
| 關聯圖的節點版面（`createColorLayout`） | 算出來的位置必須落在 `moveDrag` 的 clamp 範圍內（目前 x 10–90、y 12–88） | 節點被排到拖不回來的地方；`tests/rendered-html.test.mjs` 會失敗（刻意的） |
| 顏色分道的色帶 | accent 類別要同時掛給 `.relation-lane--<色>`（`--domain-*` 只設在列出來的選擇器上） | 色帶全變灰，等於沒有分道 |
| `.card-deck__item` 加上任何 transform／filter／container-type | `card-drag.ts` 的 `holderOf()` 必須把它攤平 | 被拿起的卡片以卡槽為定位基準，會跟游標差一個展開位移 |
| `CardDeck` 的展開版面 | 位置只能用量出來的 px（`translate()` 裡的 `%` 是以被移動的卡片為基準）；展開是換行的牆，不是一長排 | 間距算出 0、卡堆永遠展不開（不會報錯）；或八張卡擠成一排，每張只剩右緣一條 |
| `SettingCard` 的拖曳 | 點擊路徑必須保留（鍵盤與螢幕閱讀器只有這條） | 拖不動的人完全無法換模型 |
| 翻卡的圓角 | 面與邊都吃 `--card-radius`，只改一邊會對不上 | 圓角卡片底下露出方角的邊 |
| 翻卡的厚度畫法 | 是「同一個輪廓沿 z 疊很多層」，不是站在四邊的平板 | 平板在圓角處切過去，看起來像板子從卡片長出來，四個角還是開的 |
| 想加一個「整理／清理」的批次面板 | 先問這件事能不能在儲存卡片時就做完；只有真的需要人判斷的（例如重複）才值得做成介面，而且要主動浮出來 | 沒人會為了發現自己不知道的東西而去開一個面板 |
| 重複判定 | 只看標題相同與**用字重疊**（字元 bigram，門檻 0.5）。不要把相似度加回去：卡冊少的時候 §3.3 的相對分佈就是雜訊——實測四張卡時，重打一次的卡片只拿到 0.29，兩張不相干的卡片卻是 1.00 | 原本「raw cosine ≥ 0.9」在使用者的卡冊上把 3 組只是相關的卡片（Attention ↔ QKV）判成重複；同一批卡片的用字重疊最高只有 0.092 |
| 標題比對 | 不要用 `\W`（中文字全被當成標點，整個中文卡冊會互相判定為重複）；用 `[\s\p{P}\p{S}]` | `tests/api-contract.test.mjs` 會失敗（刻意的） |
| 新增任何 transition／animation | 只能用 `--motion-quick/base/slow` 與 `--ease-out/in-out`；環境性的無限迴圈動畫除外 | `tests/rendered-html.test.mjs` 會失敗（刻意的）——九種時間長度混在一起，整個 app 就不像同一個東西在動 |
| 新增會「進場」的全螢幕介面 | 也要有離場：用 closing flag + 計時器延後 unmount，內容要留到動畫結束 | 開的時候有動畫、關的時候直接消失，比兩者都沒有更糟 |
| 新增介面文案 | 一件事只講一次，講在它會改變決定的地方；「這是什麼」交給旁邊的術語卡，不要inline 再講一遍 | `tests/rendered-html.test.mjs` 會失敗（刻意的）——同一句話出現在描述、卡槽提示、術語卡三個地方 |
| 換 embedding 模型的任何路徑（`/models/select`、`PUT /settings`、任務重試） | 走 `planXxx()` → `stageEmbeddings()` → `apply()` → `commitStagedEmbeddings()`，見 §3.7。**不要**先套用再重建 | `tests/model-migration.test.mjs` 會失敗（刻意的）——重建期間整個卡冊搜不到 |
| 新增一個會跑很久的工作（下載、重建向量） | 後端回 202 + `task_id`，前端用 `watchBackgroundTask` 接手，**不要 await**；設定關掉後靠 `.background-task-dock` 顯示 | `tests/rendered-html.test.mjs` 會失敗（刻意的）——整個 app 會被一個跟閱讀無關的工作鎖住好幾分鐘 |
| 拖曳卡片放開後的回位 | `card-drag.ts` 的 `clear()` 必須「還原 → flush → 才解開 transition」 | 卡片先飛回原位，接著卡槽再帶著它從最左邊滑一次 |
| 新增一個下拉選單 | 用 `CardSelect`，不要用原生 `<select>`；面板是 portal 到 body 的 fixed 元素 | `tests/rendered-html.test.mjs` 會失敗（刻意的）——原生選單長得像另一個程式，而且會被容器裁掉 |
| `CardSelect` 放進表單欄位 | 要在 `globals.css` 給那個 context 一條「label 在上、trigger 滿寬」的規則 | 它會維持工具列的橫式藥丸樣式，跟旁邊的 input 對不齊 |
| 翻卡要吃到卡片顏色 | `FlipCard` 必須收 `accent` 並把 `collection-card--<色>` 掛在 `.card-flip__inner` 上 | `--domain-*` 只設在 face 裡面的 `.collection-card`，邊緣繼承不到，會變成灰帶子貼在彩色卡片上 |
| 翻卡的兩個面 | 必須各自 `translateZ(厚度/2)`，四個側面才對得起來 | 卡片轉到 90 度變成一條髮絲——正好是有人想看它多厚的那個角度 |
| 在 `.collection-card` 之外用 `SeededCoverArt` | 該元素要自己定義 `--cover-color` / `--cover-soft-color` / `--cover-background` | 封面圖整片透明（術語卡的縮圖就這樣消失過一次） |
| `glossary.ts` 的 `glyph` / `accent` | 必須是 `cover-art.tsx` 畫得出來的 glyph、`visualAccents` 裡有的顏色 | `tests/cover-art.test.mjs` 會失敗（刻意的）；否則會靜靜退回同一個圖案 |
| 新增設定分頁 | `glossary.ts` 要有對應 `scope` 的條目 | 測試會失敗；使用者少一整區白話說明 |
| 更新檢查的行為 | 它是整個 app 唯一的對外請求：每天最多一次、`KCC_UPDATE_CHECK=off` 可完全關閉、失敗一律當成「沒有新版」。放寬任何一條之前先想清楚——這個產品的賣點就是不連外 | 一個號稱資料留在本機的工具在每次啟動時打電話回家；`tests/rendered-html.test.mjs` 會失敗（刻意的） |
| `desktop/package.json` 的 `repository` | 根 `package.json` 要一致（`release:check` 會擋）。更新檢查是從這裡讀出要查哪個 repo 的 release | fork 出去的版本把自己的使用者導到上游的下載頁 |
| 產品裡任何指向 `/` 的連結 | 不要加。產品沒有首頁，`/` 只會轉回 `/collection` | 使用者點了「回到首頁」，回到自己正在看的那一頁；`tests/rendered-html.test.mjs` 會失敗（刻意的） |
| 新增 `desktop/` 的執行期相依 | `desktop/package.json`（打包用，鎖定版號）**與**根 `package.json`（CI 測試用） | CI 綠、打包版 require 失敗，或反過來 |

---

## 5. 測試涵蓋什麼

| 檔案 | 守住什麼 |
| --- | --- |
| `api-contract.test.mjs` | 認證、卡片生命週期、搜尋、關聯上限與去重、備份完整性 |
| `retrieval.test.mjs` | 換句話說也搜得到；沒有向量的卡用標題搜得到；模型壞掉時文字搜尋照常；搜不到的東西要回 0 筆 |
| `capture.test.mjs` | 只給標題也能建卡；沒有標題要擋下；編號連號、不重用垃圾桶裡的號；自帶的 id／編號照用；改卡不換號；id 可排序、不重複、沒有會看錯的字母 |
| `source.test.mjs` | 來源連結只收 http(s)、壞連結不會弄丟卡片；種類從連結讀出來；連結一改描述舊文件的欄位全部清掉；舊卡的 source 讀得回來；缺欄位的舊資料庫會補上 |
| `resurface.test.mjs` | 全新卡冊不亂推薦；推最久沒看的那張；讀過就不再推；一天一次而 force 例外；靜音永久有效；略過不等於靜音；payload 裡沒有分數與排程；手機拿得到推薦但碰不到 `/sources` |
| `benchmark-retrieval.mjs`（不在 `npm test` 裡） | 搜尋準不準：Recall@1/3/5、MRR、no-result accuracy、五種意圖分別的命中率、冷熱延遲；`--gate` 擋品質退步 |
| `embedding-safety.test.mjs` | 維度不符會丟例外、相對計分、排序不會反轉 |
| `embedding-dimensions.test.mjs` | 寬度鎖定、fallback 不會偷換、目錄一致性 |
| `store-migration.test.mjs` | JSON→SQLite 不掉資料、全新安裝是空的 |
| `model-catalogue.test.mjs` | 自訂模型驗證、供應商預設、簡易模式解析、內建權重 |
| `category-colour.test.mjs` | 同分類同色、分布平均、既有分類不變色、三方一致 |
| `cover-art.test.mjs` | 封面圖案名稱前端畫得出來、且夠多樣；封面不隨編輯或換模型而變；術語卡的 glyph／顏色／編號一致 |
| `model-migration.test.mjs` | 換 embedding 模型期間卡冊仍可搜尋、取消不留痕跡、重建期間寫入的卡不會落在舊模型上 |
| `update-check.test.mjs` | 版號比較（含 prerelease 不算數）、一天只查一次且跨重啟、離線／限流不會壞、關得掉、送出去的請求不帶識別資訊 |
| `lan-certificate.test.mjs` | 選對網卡（含 Windows 虛擬網卡）、憑證指紋穩定、mDNS 缺席不會炸、LAN TLS 真的服務 v1 |
| `rendered-html.test.mjs` | 前端能 render、雙平台打包設定、README 指令存在、CLAUDE.md 引用的檔案存在 |

**加功能時請一起加測試。** 這個專案唯一沒有測試覆蓋的部分（文件）就曾經悄悄落後好幾個 commit。

---

## 6. 在這台機器上怎麼驗證前端

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

## 7. 雙平台：現況與還沒做的

macOS 支援已經進來了。`electron-builder.yml` 有 `mac:` 區塊（dmg + zip）、`build-icon.mjs` 同時產 `.ico` 與 `.icns`、release workflow 用 `macos-14`（Apple Silicon）建置——**Intel 刻意不建**，那台 runner 排隊排掉近一小時，而且是 Apple 已經不賣的機器；Intel 使用者可以自己從原始碼建、`mcp-server.cjs` 會查 `~/Library/Application Support/`。核心本來就不用改：`onnxruntime-node` 附有 `darwin/arm64` 與 `darwin/x64` 預編譯檔，`node:sqlite` 是 Node 內建。

**還沒做的：**

1. **簽章與公證。** 沒有 Apple Developer ID 的話使用者會被 Gatekeeper 隔離，比 Windows SmartScreen 更難繞過。這是要花錢的決定。在簽章之前**不要**改成 electron-updater：macOS 的 Squirrel 會拒絕未簽章的更新，裝出去的自動更新是壞的。目前的做法是查到新版就給一行連結，使用者自己下載。
2. **Windows 防火牆。** 第一次啟用區網分享時，Windows 會跳出允許 `知識卡冊.exe` 監聽的提示。使用者按了「取消」就會靜靜地連不上。目前只在 README 說明，沒有程式處理（加防火牆規則要管理員權限）。
3. **Windows 沒有 mDNS。** 需要 Apple Bonjour 才有 `dns-sd.exe`。目前的做法是誠實回報並要使用者掃 QR code——這是可接受的，因為 QR 本來就帶了位址。若要補齊，就是用 `dgram` 寫一個純 Node 的 mDNS responder，**不要**改成叫系統工具。
4. **產品名是中文（`知識卡冊`）。** appId 沒問題，但兩邊的 bundle 路徑都要實機確認過才算數。

**在哪台機器上驗證什麼：** 平台相關的改動不能只靠 CI。`lan-certificate.test.mjs` 兩邊都會跑（以前是 `skip: process.platform !== "darwin"`，等於 Windows 完全沒有覆蓋——**不要再把測試依平台 skip 掉**，要嘛寫成跨平台，要嘛注入假的 `networkInterfaces`）。

---

## 8. iOS 版：先做對的事

使用者的方向是「連到主機獲取資料」，這是對的——Electron 不能跑在 iOS 上，所以架構必然是**主機端 runtime + 手機端瘦客戶端**。

### 已經打好的基礎

主機端該有的東西大致齊了：

- API 路由已有版本前綴 `/api/v1/`，根路徑回報 `capabilities` 陣列供協商
- **裝置配對**：`desktop/device-auth.cjs`。桌面端產生一次性配對碼（十分鐘、只能換一把鑰匙），手機端拿 `kcc_dv_…` 長期 token，可個別撤銷；資料庫只存 SHA-256
- **權限分級**：裝置 token 全開的是卡片相關路由；主機狀態（設定、背景任務、版本）**只能讀**；其餘一律 403（見 §3.9）
- **手機的建置有 CI**：`knowledge-card-cabinet-ios` 的 `.github/workflows/ci.yml` 用 macOS runner 建模擬器版本。這個專案是在一台沒有 Swift 也沒有 Xcode 的 Windows 上寫的，那條 workflow 就是編譯器——**不要在沒讓它跑綠之前說 iOS 端改好了**
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

## 9. 不要做的事

- **不要做完整 Cloud Sync。** 它會一次帶進帳號、認證、加密、衝突解決、sync engine、雲端資料庫、隱私政策與機房成本，而這些正好抵銷 local-first 的全部優勢。跨裝置走的是既有的配對 TLS 通道（§3.9、§8）。
- **不要把它做成 Notion。** 不要加 block editor、看板、資料庫關聯系統、專案管理、共同編輯。那是另一個產品。Notion 負責保存，這裡負責想起來。
- **不要把它做成 Anki。** 不要加記憶分數、連續天數、考試、每日複習、FSRS。「偶爾把久沒看的卡重新浮出來」可以做，間隔重複不要做——目標是取回知識，不是學習管理。
- **不要為了讓封面更漂亮而排擠檢索。** 顏色、圖案、3D 翻卡已經足以辨識。新視覺對「多久能找回知識」沒有影響，一律排在檢索之後。
- **不要繼續擴充模型設定。** 本機模型、自訂模型、API 供應商、維度、下載、背景任務都已經齊了。除了修 bug，下一階段不加新的模型供應商——模型不是產品本身。
- **不要加第二套推論引擎**（llama.cpp / GGUF）。使用者已明確要求本體輕量。需要 GGUF 的話，透過設定頁的 Ollama / LM Studio 供應商即可，那本來就是 llama.cpp。
- **不要把範例卡片自動塞進全新安裝。** 全新安裝是空的，這是刻意的決定。範例卡只在明確要求時載入。
- **不要在沒實測的情況下宣稱修好了。** 這個專案有過「改了設定檔就以為修好」的紀錄。前端改動請照第 6 節實際抓畫面。
- **不要為了「修掉 npm audit」升 `@huggingface/transformers` 到 4.x。** 實測過（2026-08-20）：v4 的 `exports.node` 路徑沒變、打包排除規則仍然對得上，但它**沒有修掉任何一個現有漏洞**，反而多帶進兩個——onnxruntime-node 1.24.3 與它的 adm-zip。剩下的兩個（sharp <0.35 的 libvips CVE、transformers 因它被連坐）在**任何已發行版本都沒有修**，而且都在影像解碼路徑上，這個 app 只做文字。要升 v4 請為了它的 WebGPU 與 BERT 加速，不要為了安全數字。
- **不要相信自己對現況的記憶。** 寫文件或回報前，先去讀程式碼。README 曾經在多個 commit 中悄悄與現實脫節。
- **不要只在自己這台機器上驗平台相關的功能。** 在 macOS 上寫的區網分享曾經寫死 OpenSSL 路徑與 `/usr/bin/dns-sd`，在 Windows 上是「按下去就整個 main process 掛掉」。改到 `desktop/` 裡任何碰到檔案系統、網路介面或子行程的地方，先問「另一個平台上這個東西存在嗎」。

---

## 10. 提交前檢查表

```bash
npm run lint            # 0 問題
npm test                # 全綠（含 build）
npm run release:check   # 版號一致
npm run verify:runtime  # runtime 契約
```

- 加了功能 → 先過第 2 節那五題；一題都答不出「是」就先不要做
- 改了前端 → 照第 6 節用 Electron + CDP 實際看過
- 改了衍生資料的產生方式 → 升版本常數並確認遷移路徑
- 改了 API → 代理層、openapi、capabilities 三處都補上
- 改了行為 → 對應的測試也要改，並在 commit 訊息說明**為什麼**改，而不只是改了什麼

---
