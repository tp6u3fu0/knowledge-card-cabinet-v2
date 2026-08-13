# Docker／桌面版同步規則

從這一版開始，知識卡冊以 Docker 版作為主要開發 runtime，桌面版是同步發行
runtime。兩者共用根目錄的 Next.js 前端與卡片 API 契約，但模型檔案與推論引擎
可以依平台不同。

## 每個功能的開發順序

1. 先在 `backend/app` 完成資料、API、模型或關聯邏輯。
2. 共用前端放在 `app`，使用 `/api/...` proxy，不直接依賴某一個 runtime。
3. 在 `backend/API.md` 更新正式契約；公開整合使用 `/api/v1`。
4. 確認桌面 `desktop/local-api.cjs` 提供相同的路徑、欄位與錯誤語意。
5. 通過 Docker backend 編譯、`npm test` 與必要的 API smoke test 後，再建立桌面安裝包。

## 模型同步原則

- 兩個版本共用模型管理接口：`GET /models`、`POST /models/{id}`、
  `POST /models/select`，以及自訂模型設定的 `GET/PUT /settings`。
- 模型下載、embedding 切換與會觸發重建索引的設定更新都以背景任務執行；前端與整合工具
  應使用 `GET /tasks` 或 `GET /tasks/{task_id}` 追蹤狀態，不要假設 `202` 代表已完成；
  尚未完成的任務可以使用 `/cancel` 取消，失敗或取消的可重試任務可以使用 `/retry`。
- 任務歷史必須可在 runtime 重啟後讀回：Docker 使用 `backend_data` volume，桌面版使用
  userData 下的 `tasks.json`。前端開啟設定頁時要重新查詢任務列表，不把任務狀態只放在 React state。
- 模型目錄可以不同：Docker 使用 Python／Hugging Face 模型，桌面版使用
  Transformers.js／ONNX 模型；前端只依賴共同欄位與狀態，不把模型檔案打包進 Git。
- embedding 切換必須重建向量與語意關聯；人工確認的關聯不可被清除。
- 卡片欄位共用 `category` 高層分類、`topic` 細部主題與 `tags`；舊資料沒有 `category` 時，
  必須以既有 `topic` 回填，不能讓同一批舊卡片失去分類。
- 每張卡保存 embedding 內容指紋與模型識別；新增／編輯只處理內容或模型過期的卡片，
  不可因單純刷新頁面或重新輸入同一個 API key 而整批重建。
- 搜尋必須維持語意相似度與關鍵字命中的混合排序；關聯建議必須套用共同的數量上限，
  避免某一張卡片的邊數無限制增長。
- Docker 的關聯建議預設以 65% embedding 語意分數加上 35% 主題／標籤命中分數；
  `RELATED_MIN_SCORE` 與 `RELATED_KEYWORD_WEIGHT` 必須同步記錄在 Docker 設定與測試說明。
- 自訂 API 金鑰只能保存於本機 Docker `runtime_settings` 或桌面 userData，GET 回應
  只提供 `api_key_set`；自訂 embedding 必須維持該 runtime 回傳的 embedding 維度（Docker 預設 1024，桌面版 384）。
- 模型快取留在 Docker volume 或桌面使用者資料目錄，Git 只保存程式碼、設定契約
  與必要的鎖定檔。
- 模型管理必須共用檔案檢查、磁碟可用空間、清理與可續傳欄位；模型下載失敗不能刪除
  尚未完成的快取，讓下一次重試可以沿用已下載內容。

## API 安全與資料復原

- Docker 的 API 透過 `KCC_API_TOKEN` 提供讀寫權杖，`KCC_API_READ_TOKEN` 可提供只讀整合；
  桌面版使用每次啟動產生的本機 runtime token。共享前端的 server-side proxy 必須轉發
  token，瀏覽器不直接持有後端密鑰。
- CORS 來源由 `KCC_CORS_ORIGINS` 白名單控制；所有受保護請求都要留下不含卡片內容與
  API key 的操作紀錄。
- Docker 與桌面版都使用 format version 2、checksum、匯入驗證、匯入／重置前備份與最多
  10 份輪替備份；兩邊的復原行為與 API 回應格式必須保持一致。

## 發行前檢查

```powershell
docker compose config
docker compose build api web
docker run --rm knowledge-card-cabinet-api sh -c "python -m py_compile app/*.py"
npm test
npm run verify:runtime
npm run release:check
```

`npm run verify:runtime` 會啟動一個暫時的桌面 runtime，驗證模型目錄、快取檢查、任務列表
與 capability contract；若 Docker API 正在 `http://127.0.0.1:8000`，也會一併驗證 Docker。
CI 或發行前若要求 Docker 必須在線，可設定 `KCC_REQUIRE_DOCKER=1`。

若要製作桌面版，再執行：

```powershell
npm run desktop:prepare
npm run desktop:dist
```

GitHub Actions 的 CI 會執行 build、測試與 runtime contract；只有推送 `vX.Y.Z` tag 才會在
Windows runner 建立並上傳桌面安裝包。版本更新前先執行 `npm run release:check`，確保根目錄
與 `desktop/package.json` 的版本一致。

這樣每完成一個 Docker 進度，就能以 API 契約、共享前端與驗證命令為基準，同步到
應用程式版，而不是讓兩套功能逐漸分叉。
