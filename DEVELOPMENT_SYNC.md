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
- 模型目錄可以不同：Docker 使用 Python／Hugging Face 模型，桌面版使用
  Transformers.js／ONNX 模型；前端只依賴共同欄位與狀態，不把模型檔案打包進 Git。
- embedding 切換必須重建向量與語意關聯；人工確認的關聯不可被清除。
- 自訂 API 金鑰只能保存於本機 Docker `runtime_settings` 或桌面 userData，GET 回應
  只提供 `api_key_set`；自訂 embedding 必須維持現有 384 維資料庫契約。
- 模型快取留在 Docker volume 或桌面使用者資料目錄，Git 只保存程式碼、設定契約
  與必要的鎖定檔。

## 發行前檢查

```powershell
docker compose config
docker compose build api web
docker run --rm knowledge-card-cabinet-api sh -c "python -m py_compile app/*.py"
npm test
```

若要製作桌面版，再執行：

```powershell
npm run desktop:install
npm run desktop:dist
```

這樣每完成一個 Docker 進度，就能以 API 契約、共享前端與驗證命令為基準，同步到
應用程式版，而不是讓兩套功能逐漸分叉。
