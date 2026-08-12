# 知識卡冊桌面應用程式

這是知識卡冊的獨立桌面應用程式。它會：

1. 啟動內嵌的本機 API 與前端 standalone server。
2. 將卡片資料保存到 Electron userData 資料夾，不依賴 Docker 或 PostgreSQL。
3. 第一次啟動時，若偵測到舊版 `localhost:8000` API，會嘗試匯入現有卡片。
4. 沒有舊服務時，使用安裝包內的 starter cards 建立本機資料。

## 開發啟動

在專案根目錄執行：

```powershell
npm install
npm run desktop:dev
```

桌面版不需要 Docker Desktop。Docker Compose 仍保留在專案根目錄，供開發者啟動完整 Python、PostgreSQL/pgvector 與 Qwen 模型環境。

獨立桌面模式預設使用內建的輕量本機向量與欄位整理 runtime，優先確保安裝後可以離線開啟、保存、搜尋、關聯、編輯與管理卡片。收藏頁的「模型設定」可以依硬體下載並啟用更完整的本機模型：

- 摘要：內建規則整理、LaMini-Flan-T5 248M、FLAN-T5 Small，以及較適合中文但較大的 mT5 Small。
- Embedding：內建 Hash 384、all-MiniLM-L6-v2，以及中文／英文較適合的 Multilingual MiniLM。

模型使用 Transformers.js／ONNX runtime 在本機 CPU 執行，不會把卡片內容送到外部 API。模型檔案會放在 Electron `userData/models`，卡片向量會依目前啟用的 embedding 模型重建。完整 Qwen embedding／摘要模型仍可透過 Docker 開發環境使用。

## 建立安裝包

```powershell
npm run desktop:dist
```

安裝包會放在 `release/`。建立安裝包前會先產生前端 standalone build，並將它與本機 API runtime 一起放入安裝包。

## 讓 AI 協作管理卡片

桌面版現在提供一個僅限本機的 MCP Bridge。桌面應用程式執行時，會在目前 Windows 使用者的 AppData 寫入短期 runtime manifest；MCP Bridge 讀取該 manifest 後，透過 Bearer 權杖呼叫 `127.0.0.1` 的 versioned API。它不會把 API port 暴露到區域網路，也不會把卡片內容送到外部服務。

先開啟桌面版，再將以下 MCP server 設定加入支援 MCP 的 AI 工具。開發模式使用 Node 啟動 Bridge：

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

在本機開發時，也可以從專案根目錄執行 `npm run desktop:mcp`，讓 MCP client 啟動這個 Bridge。桌面版關閉後，Bridge 會因找不到有效的 runtime 而停止提供工具。

安裝包則應直接啟動桌面應用程式的 MCP 模式，這樣不需要另外安裝 Node。將 `command` 改成安裝後的 `知識卡冊.exe` 路徑，並把 `args` 改成 `["--mcp"]`：

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

目前開放的工具包含：列出、搜尋、讀取、新增、編輯卡片；讀取關聯；確認手動關聯；列出垃圾桶；移入垃圾桶與還原卡片。永久刪除、資料庫重置、匯入匯出與 API key 設定暫時不透過 AI 開放，避免一次指令造成不可逆的資料變更。
