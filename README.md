# 知識卡冊

知識卡冊是一個將零散筆記整理成知識卡、建立本機 embedding、搜尋與探索卡片關聯的應用程式。

目前以 Docker 版作為主要開發環境；桌面版使用相同的前端互動與 API 契約，但資料保存於本機 JSON，不依賴 Docker 或 PostgreSQL。兩種 runtime 的開發與同步規則請見 [`DEVELOPMENT_SYNC.md`](DEVELOPMENT_SYNC.md)。

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
- Docker 與桌面版的本機模型設定
- 支援自訂 OpenAI-compatible 摘要 API，以及 OpenAI-compatible／TEI embedding API
- 透過 MCP 讓 AI 協作管理桌面版卡片
- 模型下載與 embedding 重建背景任務進度追蹤
- 背景任務持久化、取消／重試，以及模型快取檢查與清理

## Docker 版快速開始

需求：

- Docker Desktop

啟動完整開發環境：

```powershell
docker compose up --build -d
```

啟動後：

- 前端：http://localhost:3000
- 前端 health：http://localhost:3000/api/health
- 後端 Swagger：http://localhost:8000/docs

### 改前端時用這個（有 HMR）

`web` 容器把 build 烤進 image，所以改一行程式也要重建才看得到。開發前端時讓
API 與資料庫留在 Docker，前端跑在本機：

```powershell
docker compose up -d api db   # 後端與資料庫
npm run dev                   # 前端，存檔即更新
```

前端會開在 http://localhost:5173（或 vinext 指定的埠），並自動連到
`http://localhost:8000` 的容器化 API——`npm run dev` 會補上 `API_INTERNAL_URL`
與 `API_INTERNAL_TOKEN` 預設值，不需要額外設定。若你改了 `KCC_API_TOKEN`，
設定同名環境變數即可。

> 前端 dev server 不放進 Docker 是刻意的：Windows bind mount 的 IO 太慢，
> Vite 的 RSC module runner 會在載入模組時逾時（實測 60 秒失敗）。

Docker API 預設要求 Bearer Token。請在 `.env` 設定自己的 `KCC_API_TOKEN`；若要讓
只讀整合工具使用不同權杖，可另外設定 `KCC_API_READ_TOKEN`。瀏覽器來源由
`KCC_CORS_ORIGINS` 白名單限制，預設只允許本機前端。`/health`、Swagger 與 OpenAPI
文件可公開讀取，其餘 API 都需要認證。

若需要重新載入 starter cards：

```powershell
docker compose exec -T api python seed.py
```

Docker 版使用 Python、FastAPI、PostgreSQL／pgvector 與 Hugging Face 模型。模型第一次使用時才會下載，卡片內容預設留在本機 Docker volume 中。

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

## 本機 AI 與模型

新增卡片時，可以貼上筆記，讓摘要模型產生標題、問題、摘要與標籤草稿，確認後再寫入資料庫。embedding 會在新增或編輯卡片後重新建立，並更新語意關聯與封面。

桌面版目前提供輕量的本機模型選項，包括 Hash 384、all-MiniLM-L6-v2、Multilingual MiniLM，以及數種摘要模型。Hash 384 是離線 deterministic fallback，不是語意模型；新增卡片仍會建立它的向量，但只能可靠處理詞彙重疊，正式關聯建議使用真正的 embedding 模型。Docker 版的 Qwen3 Embedding 0.6B 預設使用 1024 維輸出，以保留更多語意資訊，並可另外下載 BGE-M3 或 Multilingual E5 Large 做品質比較；兩者的模型清單可以不同，但 API 回應格式與切換行為保持一致。

桌面版自訂 embedding 必須輸出 384 維向量；Docker 版預設為 1024 維。變更 Docker 的向量維度時，啟動會先建立備份、清除舊向量並在背景重建，不會刪除卡片文字資料。API key 只保存在本機 runtime，設定讀取時只回傳是否已設定，不會回傳金鑰內容。

## 資料管理

收藏頁的「資料管理」可以：

1. 匯出目前卡片、embedding、封面與關聯資料。
2. 匯入先前的 JSON 備份，匯入前可預覽，並選擇取代、略過同 ID 或更新同 ID。
3. 重置卡片資料，保留資料庫 schema、模型檔案與模型設定。

匯出格式目前為版本 2，包含 SHA-256 校驗碼。匯入會先驗證格式、卡片 ID、關聯引用、
embedding 維度與校驗碼，驗證失敗不會覆蓋現有資料。匯入與重置前會自動建立備份；Docker
版最多保留最近 10 份備份，桌面版則保存在 Electron `userData/backups`。服務啟動時若
沒有近期備份，也會建立一份自動備份。

embedding 會保存內容指紋與模型識別。新增或編輯卡片只重建受影響的向量與關聯；切換
embedding 模型時，為確保維度與語意一致，仍會逐張檢查並重建過期向量。`category` 是
可管理的高層分類；同分類會提高關聯候選的輔助分數，但不會取代 embedding 關聯。搜尋採語意分數
與標題、主題、分類、問題、摘要、標籤等欄位的關鍵字命中混合排序，並限制每張卡片保留的
語意關聯數量。關聯建議會把 embedding 語意分數與分類／主題／標籤命中混合計算，Docker 可用
`RELATED_MIN_SCORE` 調整最低關聯門檻，`RELATED_KEYWORD_WEIGHT` 調整主題／標籤對關聯的影響。
匯入端點提供 `/database/import/preview`、衝突策略與 SHA-256 校驗；批次整理預設只預覽，必須明確傳入
`apply: true` 才會修改卡片。

資料格式與資料庫 schema 分開版本化：備份的 `format_version` 目前是 2，Docker PostgreSQL 會在
`schema_migrations` 記錄已套用的 schema 版本，桌面版 JSON 會以 `version` 欄位啟動時自動升級。
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

模型下載、embedding 切換與會觸發重建索引的設定更新會在背景執行。前端或整合工具可以透過 `GET /tasks` 與 `GET /tasks/{task_id}` 取得進度，也能取消或重試可管理的任務。任務歷史會保存在 Docker `backend_data` volume 或桌面版 userData，重新整理頁面或重啟 runtime 後仍可恢復狀態。模型設定頁同時顯示模型預估大小、快取實際大小與磁碟剩餘空間，並提供檔案檢查、清理與中斷後續傳。

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
npm run verify:runtime   # 驗證桌面版與可用的 Docker runtime 契約
```

GitHub Actions 會在 push／Pull Request 執行 build、測試與 runtime contract；推送符合
`vX.Y.Z` 的 tag 時，Windows runner 會建立並上傳桌面安裝包到 GitHub Release。這是目前
Installer 與後續自動更新功能的發佈基礎。

## 專案文件

- [`DEVELOPMENT_SYNC.md`](DEVELOPMENT_SYNC.md)：Docker 版與桌面版的同步規則
- [`backend/API.md`](backend/API.md)：Docker／FastAPI API 說明
- [`desktop/README.md`](desktop/README.md)：桌面版模型、安裝包與 MCP 詳細說明
