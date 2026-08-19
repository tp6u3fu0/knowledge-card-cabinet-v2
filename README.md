# 知識卡冊

知識卡冊是一個將零散筆記整理成知識卡、建立本機 embedding、搜尋與探索卡片關聯的應用程式。

單一使用者的本機應用程式：一份 Node runtime，資料存在本機 SQLite，模型在本機 CPU 上執行，不需要伺服器或雲端服務。

同一份 runtime 有兩種跑法——用 Electron 包成桌面應用程式，或以 headless 模式跑在一台常開的機器上（例如樹莓派），讓手機或其他電腦連進來。

## 功能概覽

- 新增、編輯、搜尋與瀏覽知識卡
- 可管理分類：新增、重新命名、合併，以及集中檢視待分類卡片
- 透過 embedding 建立語意關聯圖
- 關聯圖支援分類聚焦、強關聯篩選、關聯來源／原因／分數與自製關聯移除
- 搜尋支援分類、標籤與排序篩選，並顯示命中原因
- 標籤拼法與分類在儲存時自動整理；疑似重複的卡片會自己浮上來
- 自動產生與 embedding 對應的抽象卡片封面，同一分類的卡片使用同一個顏色
- 卡片垃圾桶、還原與永久刪除
- 資料庫 JSON 匯出、匯入與重置
- 本機模型下載、切換與快取管理
- 支援自訂 OpenAI-compatible 摘要 API，以及 OpenAI-compatible／TEI embedding API
- 透過 MCP 讓 AI 協作管理桌面版卡片
- 模型下載與 embedding 重建背景任務進度追蹤
- 背景任務持久化、取消／重試，以及模型快取檢查與清理

## 開發環境

需求：Node.js 22.13 以上。

前端與本機 API 是分開的兩個行程，開兩個終端機：

```bash
npm install
npm run dev:api      # 本機 API，固定在 127.0.0.1:8000
npm run dev          # 前端，存檔即更新
```

或用單一指令跑完整的正式組合（無 HMR）：

```bash
npm run build
npm run serve
```

資料預設寫入 `./data`，可用 `KCC_DATA_DIR` 指定其他位置。API 只監聽 loopback，權杖每次啟動隨機產生，或以 `KCC_API_TOKEN` 固定。

應用程式的根路徑 `/` 會直接轉到 `/collection`：**產品裡沒有首頁**。

## 公開首頁

介紹頁是獨立的靜態網站，原始碼在 `site/`，跟產品分開建置與發佈：

```bash
npm run dev:site     # 首頁開發伺服器
npm run build:site   # 輸出到 dist-site/，可以放到任何靜態主機
```

它重用 `app/` 的卡片元件與樣式，所以頁面上的卡片就是應用程式畫出來的那些卡片，不是截圖。兩個設定都可以不給：

| 建置變數 | 沒給的話 |
| --- | --- |
| `VITE_KCC_DOWNLOAD_URL` | 顯示「桌面版準備中」，不會連到不存在的頁面 |
| `VITE_KCC_APP_URL` | 不提供「瀏覽版」入口——收藏本身不一定有公開網址 |

```bash
VITE_KCC_DOWNLOAD_URL=https://github.com/<you>/<repo>/releases/latest npm run build:site
```

輸出使用相對路徑，所以放在網域根目錄或 `/<repo>/` 子目錄都可以（GitHub Pages 是後者）。

## 桌面版

桌面版使用 Electron 啟動內嵌的本機 API 與前端 standalone server，完全離線可用。

**剛裝好是空的**——不會預先塞入任何範例卡片。卡片存在「文件\知識卡冊」（Windows）或「文件／知識卡冊」（macOS），你找得到也好備份，甚至可以直接把它放進同步資料夾；模型快取留在 Electron `userData`，因為那是可重新下載的東西，不值得備份。從舊版升級時，原本在 `userData` 的卡片會自動搬到新位置，舊檔保留不動。

資料位置可用 `KCC_DATA_DIR` 覆寫。

```sh
npm install
npm run desktop:dev
```

建立目前作業系統的桌面安裝包：

```sh
npm run desktop:dist
```

安裝包會輸出到 `release/`：Windows 產生 NSIS 安裝程式，macOS 產生目前 CPU 架構的 `.dmg` 與 `.zip`。`desktop:dist` 會先跑 `models:bundle` 把內建的 embedding 權重抓下來（約 130 MB，已存在就略過）。桌面版使用 Transformers.js／ONNX 在本機 CPU 執行模型，收藏頁的「模型設定」可下載與切換摘要模型、embedding 模型，加入 Hugging Face 上的其他模型，或改用自訂 API。

### 裝置配對與區網分享

收藏頁「模型設定 → 裝置配對」可以把這台電腦分享給同一個 Wi-Fi 上的手機，Windows 與 macOS 行為一致。

啟用後會**另外**開一個 HTTPS server（連接埠 8443）；原本的桌面 API 仍然只在 loopback，不受影響。分享的位址取自路由表上實際在用的那張網卡，所以 VPN、VirtualBox、VMware、WSL 之類的虛擬網卡不會被誤選。

配對流程：桌面端產生一次性配對碼（十分鐘失效，只能換一把鑰匙），手機掃描 QR code 或手動輸入。手機拿到的是自己的長期權杖，桌面端不顯示也不保存它，隨時可以單獨撤銷。憑證是自簽的，**手機端必須比對畫面上的 SHA-256 指紋**。裝置權杖只能讀寫卡片，模型、設定與資料庫管理一律拒絕。

兩件事要知道：

- **Windows 第一次啟用時會跳出防火牆提示**，要允許「知識卡冊」在私人網路監聽，按取消就會連不上。
- **mDNS（Bonjour）自動探索在 Windows 上要另外裝 Apple Bonjour。** 沒有也沒關係——QR code 本來就帶了位址，介面會告訴你目前是哪種情況。

## 常駐主機版（樹莓派、家用伺服器）

同一份 runtime 也可以不透過 Electron 執行，適合放在一台常開的機器上，讓手機或其他電腦連進來。

```bash
npm ci && npm run build
KCC_DATA_DIR=~/kcc-data npm run serve
```

或用容器（`node:22-bookworm-slim` 有 arm64，樹莓派 4／5 可直接建置）：

```bash
docker build -f Dockerfile.standalone -t knowledge-card-cabinet .
docker run -d --name kcc -p 3000:3000 -v kcc-data:/data \
  -e KCC_HOST=0.0.0.0 -e KCC_API_TOKEN=請換成自己的字串 knowledge-card-cabinet
```

| 環境變數 | 預設 | 說明 |
| --- | --- | --- |
| `KCC_DATA_DIR` | `./data` | `cards.db`、備份與稽核記錄的位置 |
| `KCC_MODELS_DIR` | `<data>/models` | 模型快取 |
| `KCC_HOST` | `127.0.0.1` | 介面監聽位址 |
| `KCC_PORT` | `3000` | 介面連接埠 |
| `KCC_API_TOKEN` | 每次啟動隨機產生 | 固定 API 權杖 |

> **對外開放前請先讀這段。** 本機 API 只監聽 loopback，由前端在伺服器端代理，權杖不會經過網路。但**介面本身沒有登入機制**，所以把 `KCC_HOST` 設成 `0.0.0.0` 等於讓所有能連到這個埠的人都能讀寫你的卡片。請只在私人網路使用（例如 Tailscale、WireGuard），不要直接對公網開放。

Alpine 映像檔不適用：embedding 模型依賴的 `onnxruntime-node` 只提供 glibc 預編譯檔，在 musl 上會安裝失敗。

## 本機 AI 與模型

新增卡片時，可以貼上筆記，讓摘要模型產生標題、問題、摘要與標籤草稿，確認後再寫入資料庫。embedding 會在新增或編輯卡片後重新建立，並更新語意關聯與封面。

**桌面安裝包內建 Multilingual MiniLM（384 維）的權重**，所以裝好就有真正的語意搜尋與關聯，不需要先下載任何東西，也不需要連網。內建的 Hash 384 仍然保留作為最後的離線 fallback，但它不是語意模型——只能處理詞彙重疊。（`npm run build` 這類沒跑過 `npm run models:bundle` 的建置會退回 Hash 384，行為與以前相同。）

模型設定頁預設是**簡易模式**：整理筆記只要選「不下載／小／中／大」，語意向量只要選「中文為主／英文為主／中英皆可」與 384／1024 維，應用程式會決定實際用哪個模型並顯示它是什麼。沒有完全對應的組合會直接說明——例如 384 維目前沒有純中文模型，會退到多語言模型並標示出來。

切到**進階模式**才會看到完整清單、384 vs 1024 的詳細對照，以及自訂模型。模型清單不是固定的：可以填入任何 Hugging Face 模型 id 加入，加入前會檢查該 repo 是否有 ONNX 權重、並自動讀出向量維度。內建可選項包含 all-MiniLM-L6-v2（384 維、英文）、Multilingual MiniLM（384 維、中英）、**BGE-M3（1024 維、約 570 MB）**。

### 384 維還是 1024 維？

不是越大越好，是取捨，設定頁會把兩邊都列出來：

| | 384 維 | 1024 維（BGE-M3） |
| --- | --- | --- |
| 下載 | 90–140 MB | 約 570 MB |
| 每張卡片 | 1.5 KB | 4 KB |
| 中文語意 | 尚可，長句與跨領域較弱 | 明顯較好，支援長文 |
| CPU 負擔 | 最低，樹莓派可行 | 較高，建議 8 GB 以上記憶體 |

維度必須全庫一致；切換模型會在背景重建所有向量與關聯，不會刪除卡片文字。自訂 embedding API 的維度由第一次成功的回應決定，之後必須維持一致——維度不符會被拒絕，不會混進資料庫。API key 只保存在本機，設定讀取時只回傳是否已設定。

### 雲端與本機 API

除了本機模型，也可以接任何 OpenAI-compatible 服務。設定頁提供 **Ollama**、**LM Studio**、OpenAI 與 Hugging Face TEI 的預設位址，選好供應商後按「偵測可用模型」就會列出該服務已經載入的模型。用 Ollama 或 LM Studio 這類本機服務時，卡片內容不會離開這台電腦。

## 資料管理

收藏頁的「資料管理」可以：

1. 匯出目前卡片、embedding、封面與關聯資料。
2. 匯入先前的 JSON 備份，匯入前可預覽，並選擇取代、略過同 ID 或更新同 ID。
3. 重置卡片資料，保留資料庫 schema、模型檔案與模型設定。

匯出格式目前為版本 2，包含 SHA-256 校驗碼。匯入會先驗證格式、卡片 ID、關聯引用、
embedding 維度與校驗碼，驗證失敗不會覆蓋現有資料。匯入與重置前會自動建立備份，最多保留最近 10 份，位置在資料夾下的 `backups/`。

> 備份的校驗碼只能由產生它的實作驗證。若備份來自其他工具，請移除 `checksum_sha256` 欄位再匯入——沒有校驗碼的 payload 會跳過該項檢查。

卡片顏色由分類決定，同一分類必定同色。顏色在分類第一次出現時指派，之後就固定下來——新增或刪除其他分類不會讓既有卡片變色。共有八個顏色，超過八個分類就會有分類共用同一色。

embedding 會保存內容指紋與模型識別。新增或編輯卡片只重建受影響的向量與關聯；切換
embedding 模型時，為確保維度與語意一致，仍會逐張檢查並重建過期向量。`category` 是
可管理的高層分類；同分類會提高關聯候選的輔助分數，但不會取代 embedding 關聯。搜尋採語意分數與標題、主題、分類、問題、摘要、標籤等欄位的關鍵字命中混合排序，並限制每張卡片保留的
語意關聯數量。搜尋的語意分數同樣是相對值——相對於該次查詢自己的分數分布，因此「語意相似」這個標記在同一批結果之間才有區辨力；結果太少而測不出分布時就不標記。關聯建議會把語意分數與分類／主題／標籤命中混合計算。語意分數是**相對於這個收藏本身的相似度分布**測量的，不是絕對 cosine——強多語言模型會把所有配對壓在很窄的高分帶裡，絕對門檻無法分辨「相關」與「兩者都是文字」。
匯入端點提供 `/database/import/preview`、衝突策略與 SHA-256 校驗。

資料格式與 schema 分開版本化：備份的 `format_version` 目前是 2，資料庫以 `version` 欄位在啟動時自動升級。
升級採冪等方式執行，並保留既有卡片內容；匯入前的預覽會依 `replace`、`skip` 或 `update` 顯示實際新增、更新、略過、移除與分類變更。

## AI 協作與 MCP

桌面版提供僅限本機的 MCP Bridge。桌面程式執行時會產生隨機 API port 與 Bearer token，並將短期 runtime manifest 寫入目前 Windows 使用者的 AppData。MCP Bridge 只呼叫 `127.0.0.1`，不會把 API 開放到區域網路，也不會把卡片內容送到外部服務。

開發模式：先開啟桌面版，再將以下設定加入支援 MCP 的 AI 工具：

```json
{
  "mcpServers": {
    "knowledge-card-cabinet": {
      "command": "node",
      "args": ["C:\\path\\to\\knowledge-card-cabinet\\desktop\\mcp-server.cjs"]
    }
  }
}
```

也可以在專案根目錄執行：

```powershell
npm run desktop:mcp
```

安裝版不需要另外安裝 Node，可直接使用：

```json
{
  "mcpServers": {
    "knowledge-card-cabinet": {
      "command": "C:\\Program Files\\知識卡冊\\知識卡冊.exe",
      "args": ["--mcp"]
    }
  }
}
```

目前 MCP 工具可以列出、搜尋、讀取、新增、編輯、確認關聯、列出垃圾桶、移入垃圾桶與還原卡片。永久刪除、資料庫重置、匯入匯出與 API key 設定暫時不開放給 AI。

模型下載、embedding 切換與會觸發重建索引的設定更新會在背景執行。前端或整合工具可以透過 `GET /tasks` 與 `GET /tasks/{task_id}` 取得進度，也能取消或重試可管理的任務。任務歷史保存在資料夾下的 `tasks.json`，重新整理頁面或重啟後仍可恢復狀態。模型設定頁同時顯示模型預估大小、快取實際大小與磁碟剩餘空間，並提供檔案檢查、清理與中斷後續傳。

## 常用指令

```powershell
npm run dev              # 前端開發伺服器（需搭配 dev:api）
npm run dev:api          # 本機 API，供開發用
npm run build            # 建立前端 standalone build
npm run build:site       # 建立公開首頁（輸出到 dist-site/）
npm run dev:site         # 首頁開發伺服器
npm run models:bundle    # 下載安裝包內建的 embedding 權重（約 130 MB）
npm test                 # 建置並執行全部測試
npm run test:api         # 只跑 API 行為契約（較快）
npm run lint             # ESLint
npm run desktop:dev      # 啟動桌面開發版
npm run desktop:dist     # 建立桌面安裝包
npm run desktop:mcp      # 啟動桌面 MCP Bridge
npm run release:check    # 檢查根目錄與桌面版版本是否一致
npm run serve            # 以 headless 模式啟動（常駐主機用）
npm run verify:runtime   # 驗證 runtime capability 契約
```

GitHub Actions 會在 push／Pull Request 執行 lint、build、測試與 runtime contract；推送符合
`vX.Y.Z` 的 tag 時，Windows runner 會建立安裝程式，macOS runner 會分別建立 Intel 與 Apple
Silicon 的 DMG／ZIP，最後一起上傳至 GitHub Release。這是目前 Installer 與後續自動更新功能的發佈基礎。

## 專案文件

- [`CLAUDE.md`](CLAUDE.md)：開發指南——哪些不變式不能動、改哪裡會牽動哪裡、以及 macOS／iOS 版的前置工作
- [`desktop/README.md`](desktop/README.md)：桌面版模型、安裝包與 MCP 詳細說明

## 授權

MIT License，詳見 [`LICENSE`](LICENSE)。
