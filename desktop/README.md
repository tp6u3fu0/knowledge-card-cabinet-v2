# 知識卡冊桌面應用程式

這是知識卡冊的獨立桌面應用程式。它會：

1. 啟動內嵌的本機 API 與前端 standalone server。
2. 將卡片資料保存到「文件\知識卡冊」的本機 SQLite，模型快取留在 Electron userData。
3. 第一次啟動時，若偵測到舊版 `localhost:8000` API，會嘗試匯入現有卡片。
4. 沒有舊服務時，使用安裝包內的 starter cards 建立本機資料。

## 開發啟動

在專案根目錄執行：

```powershell
npm install
npm run desktop:dev
```

桌面版不需要任何外部服務：資料存在本機 SQLite，模型在本機 CPU 上執行。

獨立桌面模式預設使用內建的輕量本機向量與欄位整理 runtime，優先確保安裝後可以離線開啟、保存、搜尋、關聯、編輯與管理卡片。收藏頁的「模型設定」可以依硬體下載並啟用更完整的本機模型：

- 摘要：內建規則整理、LaMini-Flan-T5 248M、FLAN-T5 Small，以及較適合中文但較大的 mT5 Small。
- Embedding：內建 Hash 384、all-MiniLM-L6-v2，以及中文／英文較適合的 Multilingual MiniLM。

模型使用 Transformers.js／ONNX runtime 在本機 CPU 執行，不會把卡片內容送到外部 API。模型檔案會放在 Electron `userData/models`，卡片向量會依目前啟用的 embedding 模型重建。

桌面本機 API 只監聽 `127.0.0.1`，所有非公開路徑都需要 runtime manifest 中的隨機 Bearer
Token；回應會寫入不含內容與密鑰的 `userData/audit.jsonl`。因此 MCP Bridge 必須先讀取有效
manifest，桌面程式關閉或 token 過期後不會繼續存取卡片。

卡片會保存 embedding 內容指紋與模型識別。新增／編輯只重建受影響的卡片與關聯，啟動時也只
處理過期向量；切換 embedding 模型則會重新檢查整個集合，以確保所有卡片使用同一模型。

模型下載、embedding 切換與會觸發重建索引的設定更新會在桌面 runtime 背景執行；可以透過本機 API 的 `/tasks` 與 `/tasks/{task_id}` 查詢進度，並使用 `/cancel` 或 `/retry` 管理任務。任務歷史保存於 userData 的 `tasks.json`，重新啟動後未完成任務會保留為可重試狀態。模型設定也提供快取檔案檢查、磁碟空間資訊與清理模型檔案功能；下載中斷時會沿用既有 Transformers.js 快取。

## 建立安裝包

```powershell
npm run desktop:dist
```

安裝包會放在 `release/`。建立安裝包前會先產生前端 standalone build，並將它與本機 API runtime 一起放入安裝包。

桌面資料管理 API 支援版本化 JSON 匯出／匯入與重置。匯出格式含 SHA-256 校驗碼；匯入前
會驗證資料結構，匯入／重置前會先把目前資料備份到 `userData/backups`，最多保留最近 10 份。
若主要 `cards.json` 損壞，啟動時會嘗試從最近的有效備份復原。

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
