# Knowledge Card API

這是知識卡冊的後端 MVP，負責卡片資料、向量搜尋與自動關聯建議。

預設使用本機 Docker 中的 `Qwen/Qwen3-Embedding-0.6B`，由
SentenceTransformers 在 FastAPI container 內載入。第一次啟動會下載模型並保存到
`hf_cache` volume；不需要把資料送到外部 embedding API。

卡片新增頁也提供本機 AI 草稿整理，預設使用較小的
`Qwen/Qwen2.5-0.5B-Instruct`。它只負責摘要、問題、標題、比喻、細節與標籤欄位，
而且採延遲載入：第一次按下「AI 整理欄位」才下載與載入，不會在 API 啟動時強制佔用
額外記憶體。模型輸出仍會先回到表單讓使用者檢查，儲存後才建立 embedding，並依 embedding
自動產生專屬的 `cover` 視覺指紋；封面會將 embedding 分成多個區段，讓每個向量區段對應一個圖案單元，再拼成完整封面。

## 啟動

```powershell
docker compose up --build -d
docker compose exec -T api python seed.py
```

啟動後：

- API 文件：http://localhost:8000/docs
- 健康檢查：http://localhost:8000/health
- 正式 API v1：http://localhost:8000/api/v1
- 完整接口說明：[API.md](./API.md)
- 語意搜尋：`GET http://localhost:8000/search?q=模型如何找出重要資訊`
- 相似卡片：`GET http://localhost:8000/cards/attention/related`

## Embedding 模式

預設使用 `Qwen/Qwen3-Embedding-0.6B` 的本機 SentenceTransformers。它支援中文／英文混合內容；目前保留 384 維向量以配合 MVP 的 PostgreSQL schema，並使用模型支援的 Matryoshka 截取維度。

如果本機 embedding 服務不可用，仍可清空 `EMBEDDING_API_URL` 回到 deterministic local hash embedder；那個模式只適合 smoke test，不代表真正的語意相似度。

要啟用真正的語意搜尋，請在專案根目錄建立 `.env`，加入 OpenAI-compatible embeddings endpoint、API key、model 與對應的 `EMBEDDING_DIMENSIONS`。資料庫的向量維度必須和模型輸出一致。

## API 版本

新的整合、MCP adapter 與 AI client 請使用 `/api/v1`；舊版未加版本前綴的路徑仍保留，供目前 Next.js 前端相容使用。完整方法、request body、response 與錯誤格式請見 [API.md](./API.md)。

## 目前 API 能力

- `GET /cards`：列出卡片
- `GET /cards/{id}`：取得單張卡片
- `POST /cards`：建立或更新卡片，並產生相似卡片建議
- `PATCH /cards/{id}`：編輯卡片欄位，並重新建立 embedding 與相似卡片建議
- `POST /cards/draft`：使用本機小型語言模型產生知識卡草稿
- `DELETE /cards/{id}`：將卡片移到垃圾桶（軟刪除）
- `GET /trash`：列出垃圾桶中的卡片
- `POST /cards/{id}/restore`：復原垃圾桶中的卡片
- `DELETE /trash/{id}`：永久刪除垃圾桶中的卡片
- `GET /search?q=...`：向量搜尋
- `GET /cards/{id}/related`：取得自動或人工關聯
- `POST /cards/{id}/relations/{target_id}/confirm`：確認一條關聯

這一版刻意不包含登入、Notion 寫回與公開部署；先驗證卡片、Embedding、搜尋與關聯資料流。
