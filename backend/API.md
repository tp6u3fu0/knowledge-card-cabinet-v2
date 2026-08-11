# 知識卡冊 API v1

這份文件是給前端、MCP adapter、其他 AI client 與自動化工具使用的正式接口說明。

## 基本資訊

- Base URL：`http://localhost:8000/api/v1`
- Swagger UI：`http://localhost:8000/docs`
- ReDoc：`http://localhost:8000/redoc`
- OpenAPI JSON：`http://localhost:8000/openapi.json`
- 認證：目前沒有。這一版只適合本機或可信任的內網，尚未開放到公網。
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
| 列出所有啟用卡片 | `GET` | `/cards` |
| 取得單張卡片 | `GET` | `/cards/{card_id}` |
| 建立或完整更新卡片 | `POST` | `/cards` |
| 部分更新卡片 | `PATCH` | `/cards/{card_id}` |
| 產生 AI 卡片草稿 | `POST` | `/cards/draft` |
| 語意搜尋 | `GET` | `/search?q=...&limit=10` |
| 取得卡片關聯 | `GET` | `/cards/{card_id}/related` |
| 確認人工關聯 | `POST` | `/cards/{card_id}/relations/{target_id}/confirm` |
| 移到垃圾桶 | `DELETE` | `/cards/{card_id}` |
| 列出垃圾桶 | `GET` | `/trash` |
| 從垃圾桶復原 | `POST` | `/cards/{card_id}/restore` |
| 永久刪除 | `DELETE` | `/trash/{card_id}` |

## 卡片資料結構

```json
{
  "id": "attention",
  "number": "03",
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
  "embedding_model": "Qwen/Qwen3-Embedding-0.6B",
  "embedding_provider": "local-transformers",
  "embedding_dimensions": 384,
  "semantic_mode": true,
  "summary_provider": "local-transformers",
  "summary_model": "Qwen/Qwen2.5-0.5B-Instruct"
}
```

## 2. 卡片 CRUD

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
  "embedding_model": "Qwen/Qwen3-Embedding-0.6B",
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

## 3. AI 草稿整理

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

## 4. 搜尋與關聯

### `GET /search?q={query}&limit={limit}`

- `q`：必填，自然語言搜尋問題。
- `limit`：選填，`1` 到 `50`，預設 `10`。

回傳卡片陣列，每筆包含 `score`。搜尋只會查詢未刪除且有 embedding 的卡片。

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

## 5. 垃圾桶

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

正式對外開放前，還需要補上 API key 或登入驗證、HTTPS、來源限制、速率限制與操作紀錄；目前版本刻意維持本機可信任環境的簡單使用方式。
