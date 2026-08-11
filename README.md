# 知識卡冊

知識卡冊的前端與語意搜尋後端。前端使用 vinext 的 Node standalone 輸出，
可與 FastAPI、PostgreSQL/pgvector 一起由 Docker Compose 啟動。

## Prerequisites

- Docker Desktop

## Quick Start

```powershell
docker compose up --build -d
```

啟動後：

- 前端：http://localhost:3000
- 前端 health：http://localhost:3000/api/health
- 後端 Swagger：http://localhost:8000/docs

首頁目前同時作為知識卡冊的公開產品入口，包含產品介紹、收藏預覽與桌面版下載區。桌面版安裝包準備好後，可在 `.env` 設定 `NEXT_PUBLIC_DOWNLOAD_URL`，首頁會自動顯示下載連結；未設定時會顯示「桌面版準備中」。

This starter does not use `wrangler.jsonc`.

## 本地開發

```powershell
npm install
npm run dev
```

Docker production build 使用 `Dockerfile`，輸出位於 `dist/standalone`，不依賴
Sites 或 Cloudflare runtime。

## 後端初始化

```powershell
docker compose exec -T api python seed.py
```

## 卡片與本機 AI 整理

前端預留 `NEXT_PUBLIC_API_URL`（瀏覽器端）與 `API_INTERNAL_URL`（container
內部）設定。收藏頁目前已連接 FastAPI 的卡片、搜尋與關聯資料流；新增卡片時可貼上
筆記，讓本機 `Qwen/Qwen2.5-0.5B-Instruct` 先產生標題、問題、摘要與標籤草稿，
確認後再寫入資料庫。模型第一次使用才會下載，內容不會送到外部 API。

資料表也支援卡片編輯與垃圾桶：可以載入既有卡片修改，儲存時會重新建立 embedding；
也可以將卡片移到垃圾桶，再從垃圾桶面板復原或永久刪除。軟刪除不會立即破壞卡片資料，
永久刪除時資料庫會依外鍵級聯清除相關關聯。

## Workspace Auth Headers

Signed-in visitors receive both `oai-authenticated-user-id` and `oai-authenticated-user-email`. Private Sites require every visitor to sign in; public Sites may also have anonymous visitors, for whom neither header is present.

The user ID is stable for the same user on the same Site and different across Sites. Email and name are intended for display or contact purposes.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const userId = requestHeaders.get("oai-authenticated-user-id");
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: verify the vinext build output
- `npm test`: build the starter and verify its rendered loading skeleton
- `npm run db:generate`: generate Drizzle migrations after schema changes

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
