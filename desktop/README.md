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

獨立桌面模式使用內嵌的輕量本機向量與欄位整理 runtime，優先確保安裝後可以離線開啟、保存、搜尋、關聯、編輯與管理卡片；完整 Qwen embedding／摘要模型仍可透過 Docker 開發環境使用。

## 建立安裝包

```powershell
npm run desktop:dist
```

安裝包會放在 `release/`。建立安裝包前會先產生前端 standalone build，並將它與本機 API runtime 一起放入安裝包。
