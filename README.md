# 知識卡冊

知識卡冊是一個將零散筆記整理成知識卡、建立本機 embedding、搜尋與探索卡片關聯的應用程式。

目前以 Docker 版作為主要開發環境；桌面版使用相同的前端互動與 API 契約，但資料保存於本機 JSON，不依賴 Docker 或 PostgreSQL。兩種 runtime 的開發與同步規則請見 [`DEVELOPMENT_SYNC.md`](DEVELOPMENT_SYNC.md)。

## 功能概覽

- 新增、編輯、搜尋與瀏覽知識卡
- 透過 embedding 建立語意關聯圖
- 自動產生與 embedding 對應的抽象卡片封面
- 卡片垃圾桶、還原與永久刪除
- 資料庫 JSON 匯出、匯入與重置
- Docker 與桌面版的本機模型設定
- 支援自訂 OpenAI-compatible 摘要 API，以及 OpenAI-compatible／TEI embedding API
- 透過 MCP 讓 AI 協作管理桌面版卡片

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

桌面版目前提供輕量的本機模型選項，包括 Hash 384、all-MiniLM-L6-v2、Multilingual MiniLM，以及數種摘要模型。Docker 版則使用 Python runtime 與較完整的模型環境。兩者的模型清單可以不同，但 API 回應格式與切換行為保持一致。

自訂 embedding 必須輸出 384 維向量，才能與目前資料庫 schema 相容。API key 只保存在本機 runtime，設定讀取時只回傳是否已設定，不會回傳金鑰內容。

## 資料管理

收藏頁的「資料管理」可以：

1. 匯出目前卡片、embedding、封面與關聯資料。
2. 匯入先前的 JSON 備份，取代目前本機資料。
3. 重置卡片資料，保留資料庫 schema、模型檔案與模型設定。

匯入前請保留一份匯出檔；匯入與重置都會影響目前收藏庫內容。

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

## 常用指令

```powershell
npm run dev              # 前端開發伺服器
npm run build            # 建立前端 standalone build
npm test                 # 建置並執行測試
npm run lint             # ESLint
npm run desktop:dev      # 啟動桌面開發版
npm run desktop:dist     # 建立桌面安裝包
npm run desktop:mcp      # 啟動桌面 MCP Bridge
```

## 專案文件

- [`DEVELOPMENT_SYNC.md`](DEVELOPMENT_SYNC.md)：Docker 版與桌面版的同步規則
- [`backend/API.md`](backend/API.md)：Docker／FastAPI API 說明
- [`desktop/README.md`](desktop/README.md)：桌面版模型、安裝包與 MCP 詳細說明
