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
- AI 批次整理預覽：建議分類、統一標籤、偵測重複與提出關聯候選
- 自動產生與 embedding 對應的抽象卡片封面
- 卡片垃圾桶、還原與永久刪除
- 資料庫 JSON 匯出、匯入與重置
- 本機模型下載、切換與快取管理
- 支援自訂 OpenAI-compatible 摘要 API，以及 OpenAI-compatible／TEI embedding API
- 透過 MCP 讓 AI 協作管理桌面版卡片
- 模型下載與 embedding 重建背景任務進度追蹤
- 背景任務持久化、取消／重試，以及模型快取檢查與清理

## 開發環境

需求：Node.js 22.13 以上。

```bash
npm install
npm run dev
```

前端會開在 vinext 指定的埠。要連同本機 API 一起跑（含 SQLite 與模型）：

```bash
npm run build
npm run serve
```

資料預設寫入 `./data`，可用 `KCC_DATA_DIR` 指定其他位置。API 只監聽 loopback，權杖每次啟動隨機產生，或以 `KCC_API_TOKEN` 固定。

首頁同時作為公開產品介紹頁，包含收藏預覽與桌面版下載區。設定 `.env` 的 `NEXT_PUBLIC_DOWNLOAD_URL` 後，首頁會顯示下載連結；未設定時會顯示「桌面版準備中」。

## 桌面版

桌面版使用 Electron 啟動內嵌的本機 API 與前端 standalone server。卡片資料與模型檔案會保存於 Electron `userData`，可離線使用。

```powershell
npm install
npm run desktop:dev
```

建立 Windows 安裝包：

```powershell
npm run desktop:dist
```

安裝包會輸出到 `release/`。桌面版預設使用 Transformers.js／ONNX 在本機 CPU 執行模型，收藏頁的「模型設定」可下載與切換摘要模型、embedding 模型及自訂 API 設定。

## 常駐主機版（樹莓派、家用伺服器）

同一份 runtime 也可以不透過 Electron 執行，適合放在一台常開的機器上，讓手機或其他電腦連進來。不需要 PostgreSQL，也不需要 Python 服務。

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

可選的 embedding 模型：Hash 384（內建、免下載）、all-MiniLM-L6-v2（384 維、英文）、Multilingual MiniLM（384 維、中英）、**BGE-M3（1024 維、約 570 MB）**。Hash 384 是離線 deterministic fallback，不是語意模型——它只能處理詞彙重疊，正式使用請下載真正的模型。記憶體 16 GB 以上的機器預設推薦 BGE-M3。

向量維度由啟用的模型決定，自訂 embedding API 則由第一次成功的回應決定，之後必須維持一致——維度不符會被拒絕，不會混進資料庫。切換模型會在背景重建所有向量與關聯，不會刪除卡片文字。API key 只保存在本機，設定讀取時只回傳是否已設定。

## 資料管理

收藏頁的「資料管理」可以：

1. 匯出目前卡片、embedding、封面與關聯資料。
2. 匯入先前的 JSON 備份，匯入前可預覽，並選擇取代、略過同 ID 或更新同 ID。
3. 重置卡片資料，保留資料庫 schema、模型檔案與模型設定。

匯出格式目前為版本 2，包含 SHA-256 校驗碼。匯入會先驗證格式、卡片 ID、關聯引用、
embedding 維度與校驗碼，驗證失敗不會覆蓋現有資料。匯入與重置前會自動建立備份，最多保留最近 10 份，位置在資料夾下的 `backups/`。

> 備份的校驗碼只能由產生它的實作驗證。若備份來自其他工具，請移除 `checksum_sha256` 欄位再匯入——沒有校驗碼的 payload 會跳過該項檢查。

embedding 會保存內容指紋與模型識別。新增或編輯卡片只重建受影響的向量與關聯；切換
embedding 模型時，為確保維度與語意一致，仍會逐張檢查並重建過期向量。`category` 是
可管理的高層分類；同分類會提高關聯候選的輔助分數，但不會取代 embedding 關聯。搜尋採語意分數
與標題、主題、分類、問題、摘要、標籤等欄位的關鍵字命中混合排序，並限制每張卡片保留的
語意關聯數量。關聯建議會把語意分數與分類／主題／標籤命中混合計算。語意分數是**相對於這個收藏本身的相似度分布**測量的，不是絕對 cosine——強多語言模型會把所有配對壓在很窄的高分帶裡，絕對門檻無法分辨「相關」與「兩者都是文字」。
匯入端點提供 `/database/import/preview`、衝突策略與 SHA-256 校驗；批次整理預設只預覽，必須明確傳入
`apply: true` 才會修改卡片。

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
npm run dev              # 前端開發伺服器
npm run build            # 建立前端 standalone build
npm test                 # 建置並執行測試
npm run lint             # ESLint
npm run desktop:dev      # 啟動桌面開發版
npm run desktop:dist     # 建立桌面安裝包
npm run desktop:mcp      # 啟動桌面 MCP Bridge
npm run release:check    # 檢查根目錄與桌面版版本是否一致
npm run serve            # 以 headless 模式啟動（常駐主機用）
npm run verify:runtime   # 驗證 runtime capability 契約
```

GitHub Actions 會在 push／Pull Request 執行 build、測試與 runtime contract；推送符合
`vX.Y.Z` 的 tag 時，Windows runner 會建立並上傳桌面安裝包到 GitHub Release。這是目前
Installer 與後續自動更新功能的發佈基礎。

## 專案文件

- [`desktop/README.md`](desktop/README.md)：桌面版模型、安裝包與 MCP 詳細說明
