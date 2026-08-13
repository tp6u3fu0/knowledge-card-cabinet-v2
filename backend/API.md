# 知識卡冊 API v1

這份文件是給前端、MCP adapter、其他 AI client 與自動化工具使用的正式接口說明。

## 基本資訊

- Base URL：`http://localhost:8000/api/v1`
- Swagger UI：`http://localhost:8000/docs`
- ReDoc：`http://localhost:8000/redoc`
- OpenAPI JSON：`http://localhost:8000/openapi.json`
- 認證：除健康檢查、Swagger 與 OpenAPI 文件外，所有路徑都要求 `Authorization: Bearer <token>`。
  Docker 版由 `KCC_API_TOKEN` 設定完整讀寫權杖，也可用 `KCC_API_READ_TOKEN` 提供只讀權杖；
  只讀權杖只能呼叫 `GET`／`HEAD`。桌面版會在本機 runtime manifest 使用隨機權杖。
- CORS：由 `KCC_CORS_ORIGINS` 設定來源白名單，預設只允許 localhost 前端。
- 操作紀錄：API 會寫入 JSONL audit log，只記錄方法、路徑、狀態、角色與耗時，不記錄卡片內容、
  request body 或 API 金鑰。
- 舊版相容路徑：`/health`、`/cards`、`/search`、`/trash` 等仍保留，新的整合請使用 `/api/v1`。

所有請求與回應都使用 JSON。錯誤沿用 FastAPI 標準格式：

```json
{
  "detail": "Active card not found"
}
```

## API 能力總覽

| 能力 | 方法 | 路徑 |
| --- | --- | --- |
| API 資訊與能力 | `GET` | `/` |
| 健康檢查 | `GET` | `/health` |
| 取得模型目錄與硬體建議 | `GET` | `/models` |
| 檢查模型快取檔案 | `GET` | `/models/{model_id}/inspect` |
| 下載／預熱模型 | `POST` | `/models/{model_id}` |
| 清理模型快取檔案 | `DELETE` | `/models/{model_id}` |
| 啟用模型 | `POST` | `/models/select` |
| 查詢背景任務 | `GET` | `/tasks`、`/tasks/{task_id}` |
| 取消背景任務 | `POST` | `/tasks/{task_id}/cancel` |
| 重試背景任務 | `POST` | `/tasks/{task_id}/retry` |
| 讀取目前模型／API 設定 | `GET` | `/settings` |
| 儲存自訂模型／API 設定 | `PUT` | `/settings` |
| 匯出本機資料備份 | `GET` | `/database/export` |
| 重置本機資料庫資料 | `POST` | `/database/reset` |
| 匯入本機資料備份 | `POST` | `/database/import` |
| 匯入前預覽與驗證 | `POST` | `/database/import/preview` |
| 分類清單／新增／改名／合併 | `GET`、`POST`、`PATCH` | `/categories`、`/categories/{name}`、`/categories/merge` |
| 列出所有啟用卡片 | `GET` | `/cards` |
| 取得單張卡片 | `GET` | `/cards/{card_id}` |
| 建立或完整更新卡片 | `POST` | `/cards` |
| 部分更新卡片 | `PATCH` | `/cards/{card_id}` |
| 產生 AI 卡片草稿 | `POST` | `/cards/draft` |
| 語意搜尋 | `GET` | `/search?q=...&limit=10` |
| 取得卡片關聯 | `GET` | `/cards/{card_id}/related` |
| 確認人工關聯 | `POST` | `/cards/{card_id}/relations/{target_id}/confirm` |
| 移除人工關聯 | `DELETE` | `/cards/{card_id}/relations/{target_id}` |
| 疑似重複卡片 | `GET` | `/cards/duplicates` |
| AI 批次整理預覽／套用 | `POST` | `/cards/batch/organize` |
| 移到垃圾桶 | `DELETE` | `/cards/{card_id}` |
| 列出垃圾桶 | `GET` | `/trash` |
| 從垃圾桶復原 | `POST` | `/cards/{card_id}/restore` |
| 永久刪除 | `DELETE` | `/trash/{card_id}` |

## 卡片資料結構

```json
{
  "id": "attention",
  "number": "03",
  "category": "人工智慧",
  "topic": "Transformer",
  "title": "Attention 如何找到重要資訊？",
  "question": "模型如何知道哪些 token 比較重要？",
  "summary": "Attention 會根據 Query、Key 與 Value 計算關注權重。",
  "analogy": "像讀文章時先掃描關鍵字，再把注意力集中到相關句子。",
  "detail": "可以進一步查看 scaled dot-product attention 的計算流程。",
  "source": "自訂筆記",
  "tags": ["AI", "Transformer"]
}
```

回傳的卡片可能額外包含 `score`。它只在搜尋或關聯結果中有意義，代表向量相似度；一般卡片讀取時為 `0`。

`category` 是使用者可調整的高層分類，例如「人工智慧」或「自然科學」；`topic` 保留更細的
內容主題，例如「Transformer」。省略 `category` 時，後端會以 `topic` 回填，方便舊版 client
繼續建立卡片。同分類只會提高自動關聯候選的排序，不會取代 embedding 關聯或人工關聯。

每張卡也會包含由 embedding 自動產生的 `cover`。它是可重現的視覺指紋，不會把完整 embedding 暴露給前端：

```json
{
  "cover": {
    "version": 8,
    "seed": "a8f3c91d2e6b70aa",
    "pattern": "orbit",
    "accent": "coral",
    "color": "#c96f5f",
    "soft_color": "#f0d5cc",
    "background": "#fbf1eb",
    "rotation": 8.4,
    "scale": 1.02,
    "density": 0.72,
    "orbit": 0.41,
    "motifs": [
      {
        "shape": "stair",
        "x": 11.0,
        "y": 11.0,
        "size": 8.4,
        "rotation": 0,
        "opacity": 0.72,
        "weight": 0.81
      }
    ]
  }
}
```

`motifs` 是由 embedding 分段後產生的圖案單元，每張卡固定有 12 個，沿內框四邊排列並包含四個角落位置。圖案採線框方式呈現，不填滿色彩，且每個單元使用統一尺寸；圖案包含 `block`、`stair`、`corner`、`zigzag`、`stack`、`window`、`plus`、`frame`。每個單元的形狀、明暗與視覺重量，分別受到該向量區段的數值影響，位置與尺寸則固定貼合內框，讓不同卡片仍維持整齊的邊界構圖。

建立或編輯卡片完成後，API 會在同一次回應中提供新的 `cover`；既有卡片則會在 API 啟動時自動補齊。

## 1. API 資訊與健康檢查

### `GET /`

回傳版本、能力清單與目前認證狀態，適合 MCP adapter 啟動時做 capability discovery。

### `GET /health`

回傳資料庫服務、embedding 與摘要模型的目前設定，例如：

```json
{
  "status": "ok",
  "embedding_model": "embedding-qwen-0.6b",
  "embedding_provider": "local-transformers",
  "embedding_dimensions": 1024,
  "semantic_mode": true,
  "summary_provider": "local-transformers",
  "summary_model": "summary-qwen-0.5b",
  "summary_status": "available",
  "model_error": ""
}
```

`embedding_model` 與 `summary_model` 回傳的是模型目錄中的穩定 ID。Docker 版預設
使用 `embedding-qwen-0.6b` 與 `summary-qwen-0.5b`；Docker 預設使用 1024 維向量，桌面版會使用自己的
Transformers.js 模型目錄，但兩邊的模型管理回應格式相同。

## 2. 模型設定與本機 AI

### `GET /models`

回傳硬體概況、目前啟用的 summary／embedding，以及可下載的模型。每個模型都包含：

- `id`、`kind`、`label`：前端顯示與操作使用的穩定識別資訊。
- `provider`、`model_id`、`task`：runtime 內部實際使用的模型資訊。
- `installed`、`active`、`recommended`、`status`、`error`：下載與啟用狀態。
- `storage`：快取檔案狀態、目前大小、預估下載大小與是否可續傳。

回應也會包含 `storage.free_size_label`，代表模型快取所在磁碟的可用空間。模型下載會
沿用既有 Hugging Face／Transformers.js 快取；下載中斷後，保留的部分檔案會在下一次下載
時繼續使用，而不是從零開始。`error_code` 與 `error_hint` 會補充磁碟不足、網路中斷或
runtime 不相容等常見原因。

Docker 與桌面版會各自提供適合該 runtime 的模型。Docker 版目前提供內建規則整理、
Qwen2.5 0.5B 摘要，以及內建 Hash fallback、Qwen3 Embedding 0.6B、BGE-M3 與
Multilingual E5 Large 向量模型。Hash fallback 只適合離線或 smoke test，不代表語意模型；
BGE-M3 與 E5 Large 都是 1024 維多語言模型，適合在本機下載後比較關聯品質。

### `POST /models/{model_id}`

啟動模型下載與預熱，立即回傳 `202` 與 `task_id`。前端或整合工具應輪詢
`GET /tasks/{task_id}`；任務的 `status` 變成 `succeeded` 或 `failed` 後，再重新呼叫
`GET /models` 取得最新模型狀態。模型檔案會放在 Docker 的 `hf_cache` volume，不會寫入
Git，也不會送出卡片內容。

### `GET /models/{model_id}/inspect`

檢查指定模型的本機快取，不會下載或載入模型。回應包含 `status`（`ready`、`partial`、
`missing`）、檔案數、目前快取大小與 `resumable`。`partial` 代表下載曾中斷，但可以
直接重新提交下載。

### `DELETE /models/{model_id}`

清理指定模型的本機快取與安裝標記。內建模型、目前使用中的模型與下載中的模型不能清理；
卡片資料、embedding 與關聯不會被刪除。

### `POST /models/select`

下載完成後啟用模型：

```json
{
  "kind": "embedding",
  "model_id": "embedding-qwen-0.6b"
}
```

摘要模型切換會影響下一次 `POST /cards/draft`。embedding 模型切換會立即回傳 `202`
與 `task_id`，背景任務會檢查並重新建立所有過期啟用卡片的向量、封面與語意關聯；人工確認的
`manual` 關聯會保留。切換或重建過程失敗時會回復原本的模型設定。

### `GET /tasks` 與 `GET /tasks/{task_id}`

查詢模型下載、模型切換與 embedding 重建任務：

```json
{
  "task_id": "d3f7…",
  "operation": "model_select",
  "label": "啟用 embedding-qwen-0.6b 並重建 embedding",
  "status": "running",
  "progress": 62,
  "message": "已建立 5/8 張卡片向量",
  "result": null,
  "error": ""
}
```

`status` 可能是 `queued`、`running`、`succeeded`、`failed` 或 `cancelled`。成功時
結果會放在 `result`；失敗時讀取 `error`。`can_retry` 為 `true` 時可以呼叫：

```http
POST /tasks/{task_id}/cancel
POST /tasks/{task_id}/retry
```

取消只接受尚未完成的任務；重試會建立新的 `task_id`。任務歷史會保存於 Docker 的
`backend_data` volume 或桌面版 userData。服務重新啟動時，原本的 `queued`／`running`
任務會被標記為失敗並保留可重試資訊，避免前端刷新後遺失狀態。

### `GET /settings`

回傳摘要與 embedding 的目前執行來源。`api_key` 永遠不會出現在回應中，只會以
`api_key_set` 表示本機是否已保存金鑰。

### `GET /database/export`

下載目前本機資料的 JSON 結構。格式版本為 `2`，內容包含啟用卡片、垃圾桶卡片、embedding、
封面資料、卡片關聯與不含 API 金鑰的 runtime 設定，並附 `checksum_sha256`。可交由
`POST /database/import` 還原。

### `POST /database/reset`

清除卡片、垃圾桶與所有卡片關聯，但保留資料表結構、模型設定與已下載的模型檔案。請求必須包含精確確認文字：

```json
{
  "confirmation": "RESET DATABASE"
}
```

### `POST /database/import/preview`

先驗證備份格式、卡片必要欄位、重複 ID 與關聯引用，不會修改資料庫；驗證通過後也會依目前資料庫
與 request 的 `conflict_strategy` 回傳實際新增、更新、略過、移除卡片，以及新增／移除分類的差異。
正式匯入前建議先呼叫此端點。

### `POST /database/import`

以知識卡冊的 JSON 備份取代目前本機卡片資料、垃圾桶與關聯。匯入前會驗證格式版本
`1`／`2`、校驗碼、卡片 ID、關聯引用、分數範圍與 embedding 維度；資料驗證失敗時不會
清除現有資料。成功匯入前會先建立一份備份，不會覆寫 API 金鑰。可在 request body 加入
`conflict_strategy`：`replace`（預設，取代全部）、`skip`（保留現有同 ID）或 `update`（更新現有同 ID）。

### 分類、關聯與搜尋管理

`GET /categories` 會回傳分類名稱與卡片數量，包含系統保留的「待分類」。可用 `POST /categories`
新增分類、`PATCH /categories/{name}` 重新命名，或以 `POST /categories/merge` 將來源分類合併到目標分類。

`GET /cards/{card_id}/related` 的每筆結果會包含 `relation_type`、`score`、`reason`、`created_at` 與
`updated_at`。人工關聯可用 `DELETE /cards/{card_id}/relations/{target_id}` 移除，不會刪除 embedding 關聯。
`GET /search` 支援 `category`、`tag` 與 `sort=relevance|updated|title`，結果附帶 `search_reasons`。

`POST /cards/batch/organize` 傳入 `card_ids` 後預設只回傳預覽，加入 `apply: true` 才會套用分類與標籤整理，
並同時回傳疑似重複卡片與關聯候選；`GET /cards/duplicates` 可單獨取得重複偵測結果。

備份的 `metadata.schema_version` 會標示目前資料庫 schema 版本；Docker 版會在 `schema_migrations`
表記錄已套用的升級，桌面版則在啟動時將舊 JSON 的 `version` 升級到目前版本。

### `PUT /settings`

設定可使用本機模型或自訂 API。摘要 API 使用 OpenAI-compatible Chat Completions；
embedding API 支援 OpenAI-compatible 與 TEI：

```json
{
  "summary": {
    "source": "api",
    "api_url": "https://api.example.com/v1/chat/completions",
    "model": "gpt-4o-mini",
    "api_format": "openai",
    "api_key": "sk-example"
  },
  "embedding": {
    "source": "api",
    "api_url": "https://api.example.com/v1/embeddings",
    "model": "text-embedding-3-small",
    "api_format": "openai",
    "api_key": "sk-example"
  }
}
```

`source` 為 `local` 時可保留 API 欄位，之後切回自訂 API 不必重新輸入；`api_key`
留白會沿用已保存的金鑰，搭配 `clear_api_key: true` 才會清除。現有 PostgreSQL
Docker 向量欄位預設為 1024 維，因此自訂 embedding 必須回傳目前設定的維度。桌面版維持 384 維。儲存設定若改變
embedding 來源、endpoint、模型或格式，API 會以背景任務檢查並重建過期卡片的向量、
封面與語意關聯；失敗時會回復原設定。

API 金鑰只保存在本機 Docker runtime 的 `runtime_settings`，或桌面版使用者資料目錄
的 `models/settings.json`；此 API 適合本機／可信任內網，不應直接暴露到公網。

## 3. 卡片 CRUD

### `GET /cards`

列出所有未刪除卡片，依 `number` 排序。

### `GET /cards/{card_id}`

取得單張未刪除卡片。找不到時回傳 `404`。

### `POST /cards`

建立卡片；若 `id` 已存在，會以完整 payload 更新既有卡片。儲存時會重新建立 embedding，並更新語意關聯建議。

Request body：

```json
{
  "id": "attention",
  "number": "03",
  "topic": "Transformer",
  "title": "Attention 如何找到重要資訊？",
  "question": "模型如何知道哪些 token 比較重要？",
  "summary": "Attention 會根據 Query、Key 與 Value 計算關注權重。",
  "analogy": "像讀文章時找關鍵句。",
  "detail": "scaled dot-product attention 的細節。",
  "source": "自訂筆記",
  "tags": ["AI", "Transformer"]
}
```

Response：

```json
{
  "card": { "id": "attention" },
  "embedding_model": "embedding-qwen-0.6b",
  "suggested_relations": [
    { "id": "transformer", "score": 0.78 }
  ]
}
```

實際的 `card` 會包含完整卡片欄位與新的 `cover` 規格。

### `PATCH /cards/{card_id}`

只更新提供的欄位，至少要提供一個欄位。可更新欄位：`number`、`topic`、`title`、`question`、`summary`、`analogy`、`detail`、`source`、`tags`。

```json
{
  "summary": "更新後的摘要。",
  "tags": ["AI", "Attention"]
}
```

更新同樣會重新建立 embedding 與語意關聯建議。

## 4. AI 草稿整理

### `POST /cards/draft`

使用本機小型語言模型，把原始筆記整理成待確認的卡片欄位。這個接口不會寫入資料庫，也不會建立 embedding。

Request body：

```json
{
  "content": "至少 20 個字的原始筆記內容……",
  "source": "書名、網址或資料來源"
}
```

Response：

```json
{
  "draft": {
    "title": "...",
    "question": "...",
    "summary": "...",
    "analogy": "...",
    "detail": "...",
    "tags": ["..."]
  },
  "model": "Qwen/Qwen2.5-0.5B-Instruct"
}
```

模型無法使用時回傳 `503`，前端可以讓使用者改用手動輸入。

## 5. 搜尋與關聯

### `GET /search?q={query}&limit={limit}`

- `q`：必填，自然語言搜尋問題。
- `limit`：選填，`1` 到 `50`，預設 `10`。

回傳卡片陣列，每筆包含混合後的 `score`。搜尋只會查詢未刪除且有 embedding 的卡片，
分數由語意相似度與標題、主題、分類、問題、摘要、標籤等欄位的關鍵字命中混合計算；`SEARCH_KEYWORD_WEIGHT` 可調整搜尋關鍵字權重，
`RELATED_KEYWORD_WEIGHT` 可調整關聯的主題／標籤權重，`RELATED_MIN_SCORE` 控制關聯最低分數，
`RELATED_LIMIT` 控制關聯與保留的數量。預設關聯分數為 65% embedding 語意分數與 35% 主題／標籤命中分數。

### `GET /cards/{card_id}/related`

回傳自動語意關聯與人工確認關聯，依分數由高至低排序：

```json
[
  {
    "relation_type": "semantic",
    "score": 0.78,
    "status": "suggested",
    "card": { "id": "transformer" }
  },
  {
    "relation_type": "manual",
    "score": 1.0,
    "status": "confirmed",
    "card": { "id": "qkv" }
  }
]
```

### `POST /cards/{card_id}/relations/{target_id}/confirm`

將兩張不同的啟用卡片建立或更新為 `manual`／`confirmed` 關聯。這個動作是冪等的，重複呼叫不會建立重複關聯。

## 6. 垃圾桶

### `DELETE /cards/{card_id}`

軟刪除卡片，移入垃圾桶；卡片資料仍保留。成功時回傳：

```json
{
  "status": "trashed",
  "card": { "id": "attention", "deleted_at": "2026-08-11T10:00:00+00:00" }
}
```

### `GET /trash`

列出垃圾桶中的卡片，依刪除時間由新到舊排序。

### `POST /cards/{card_id}/restore`

復原一張垃圾桶卡片。復原後會重新出現在一般卡片清單中。

### `DELETE /trash/{card_id}`

永久刪除一張已在垃圾桶中的卡片。這個動作不可逆，資料庫會依外鍵設定清除它的關聯。

## MCP／AI client 建議映射

未來建立 MCP server 時，可以先把以下接口包成 tools：

| MCP tool | API |
| --- | --- |
| `list_cards` | `GET /cards` |
| `get_card` | `GET /cards/{card_id}` |
| `create_card` | `POST /cards` |
| `update_card` | `PATCH /cards/{card_id}` |
| `draft_card` | `POST /cards/draft` |
| `search_cards` | `GET /search` |
| `get_related_cards` | `GET /cards/{card_id}/related` |
| `confirm_relation` | `POST /cards/{card_id}/relations/{target_id}/confirm` |
| `trash_card` | `DELETE /cards/{card_id}` |
| `restore_card` | `POST /cards/{card_id}/restore` |

若要對外部署，仍應在反向代理層補上 HTTPS、登入／使用者級權限、速率限制與網路隔離。
目前的 Token、CORS 白名單與 audit log 是本機／可信任內網的安全底座，不等同完整的多使用者認證系統。
