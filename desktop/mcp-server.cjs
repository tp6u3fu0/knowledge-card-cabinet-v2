const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

const APP_DATA_DIRECTORY = "Knowledge Card Cabinet";

function runtimeManifestCandidates() {
  const candidates = [];
  if (process.env.KCC_RUNTIME_FILE) candidates.push(path.resolve(process.env.KCC_RUNTIME_FILE));
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, APP_DATA_DIRECTORY, "runtime.json"));
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, APP_DATA_DIRECTORY, "runtime.json"));
  if (process.platform === "darwin") {
    candidates.push(path.join(os.homedir(), "Library", "Application Support", APP_DATA_DIRECTORY, "runtime.json"));
  }
  return [...new Set(candidates)];
}

function readRuntimeManifest() {
  const candidates = runtimeManifestCandidates();
  for (const manifestPath of candidates) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest?.api_base_url && manifest?.token) return manifest;
    } catch {
      // The desktop app may not be open, or its manifest may be mid-refresh.
    }
  }
  throw new Error(`找不到執行中的知識卡冊桌面版。請先開啟應用程式；搜尋位置：${candidates.join("、") || "未設定"}`);
}

async function callLocalApi(runtime, route, options = {}) {
  const baseUrl = String(runtime.api_base_url).replace(/\/$/u, "");
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${runtime.token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await response.text();
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = raw;
  }
  if (!response.ok) {
    const detail = payload && typeof payload === "object" ? payload.detail : payload;
    throw new Error(`本機 API ${response.status}：${detail || "請求失敗"}`);
  }
  return payload;
}

function jsonResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: Array.isArray(payload)
      ? { items: payload }
      : payload && typeof payload === "object" ? payload : { value: payload },
  };
}

function toolError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

function jsonBody(body) {
  return { method: "POST", body: JSON.stringify(body) };
}

function registerTools(server) {
  server.registerTool("list_cards", {
    title: "列出知識卡",
    description: "列出目前收藏庫中的所有啟用知識卡。",
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    try {
      return jsonResult(await callLocalApi(readRuntimeManifest(), "/cards"));
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool("search_cards", {
    title: "搜尋知識卡",
    description: "使用本機 embedding 搜尋最相關的知識卡。",
    inputSchema: {
      query: z.string().min(1).describe("要搜尋的概念或問題"),
      limit: z.number().int().min(1).max(50).optional().describe("最多回傳幾張卡，預設 10"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ query, limit }) => {
    try {
      const params = new URLSearchParams({ q: query, limit: String(limit || 10) });
      return jsonResult(await callLocalApi(readRuntimeManifest(), `/search?${params.toString()}`));
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool("get_card", {
    title: "讀取知識卡",
    description: "依卡片 ID 讀取一張知識卡的完整內容。",
    inputSchema: { id: z.string().min(1).describe("知識卡 ID") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ id }) => {
    try {
      return jsonResult(await callLocalApi(readRuntimeManifest(), `/cards/${encodeURIComponent(id)}`));
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool("get_related_cards", {
    title: "讀取關聯卡片",
    description: "讀取一張知識卡的 semantic 與 manual 關聯。",
    inputSchema: { id: z.string().min(1).describe("知識卡 ID") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ id }) => {
    try {
      return jsonResult(await callLocalApi(readRuntimeManifest(), `/cards/${encodeURIComponent(id)}/related`));
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool("list_trash", {
    title: "列出垃圾桶",
    description: "列出已移至垃圾桶、但尚未永久刪除的知識卡。",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    try {
      return jsonResult(await callLocalApi(readRuntimeManifest(), "/trash"));
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool("create_card", {
    title: "新增知識卡",
    description: "建立一張知識卡；建立後會由桌面 runtime 產生 embedding、封面與語意關聯。",
    // Only the title is required, matching POST /cards. An id and a number are
    // bookkeeping the runtime can do itself, and a tool that demands them makes
    // the model invent identifiers nobody asked it to choose.
    inputSchema: {
      title: z.string().min(1).describe("卡片標題"),
      category: z.string().min(1).optional().describe("分類名稱，留空為「待分類」"),
      question: z.string().min(1).optional().describe("引導理解的問題"),
      summary: z.string().min(1).optional().describe("一句話摘要"),
      analogy: z.string().min(1).optional().describe("生活化類比"),
      detail: z.string().min(1).optional().describe("詳細說明"),
      source: z.string().default("").describe("來源，可留空"),
      tags: z.array(z.string()).default([]).describe("標籤列表"),
      id: z.string().min(1).optional().describe("自有的卡片 ID；留空由 runtime 產生"),
      number: z.string().min(1).optional().describe("自有的卡片編號；留空由 runtime 產生 KC-000123"),
      topic: z.string().min(1).optional().describe("主題；留空時沿用分類"),
    },
  }, async (card) => {
    try {
      return jsonResult(await callLocalApi(readRuntimeManifest(), "/cards", { method: "POST", body: JSON.stringify(card) }));
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool("update_card", {
    title: "編輯知識卡",
    description: "更新一張啟用中的知識卡；內容變更後會重新產生 embedding 與語意關聯，封面不變。",
    inputSchema: {
      id: z.string().min(1).describe("知識卡 ID"),
      number: z.string().min(1).optional(),
      topic: z.string().min(1).optional(),
      title: z.string().min(1).optional(),
      question: z.string().min(1).optional(),
      summary: z.string().min(1).optional(),
      analogy: z.string().min(1).optional(),
      detail: z.string().min(1).optional(),
      source: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
  }, async ({ id, ...changes }) => {
    try {
      return jsonResult(await callLocalApi(readRuntimeManifest(), `/cards/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(changes) }));
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool("move_card_to_trash", {
    title: "將知識卡移到垃圾桶",
    description: "將一張啟用中的知識卡移到垃圾桶。這是可復原操作，不會永久刪除資料。",
    inputSchema: { id: z.string().min(1).describe("知識卡 ID") },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id }) => {
    try {
      return jsonResult(await callLocalApi(readRuntimeManifest(), `/cards/${encodeURIComponent(id)}`, { method: "DELETE" }));
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool("restore_card", {
    title: "還原知識卡",
    description: "將垃圾桶中的知識卡還原到收藏庫。",
    inputSchema: { id: z.string().min(1).describe("知識卡 ID") },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id }) => {
    try {
      return jsonResult(await callLocalApi(readRuntimeManifest(), `/cards/${encodeURIComponent(id)}/restore`, jsonBody({})));
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool("confirm_relation", {
    title: "確認卡片關聯",
    description: "手動確認兩張知識卡之間的關聯；這會保留在語意關聯之外。",
    inputSchema: {
      id: z.string().min(1).describe("第一張卡片 ID"),
      target_id: z.string().min(1).describe("第二張卡片 ID"),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id, target_id }) => {
    try {
      return jsonResult(await callLocalApi(readRuntimeManifest(), `/cards/${encodeURIComponent(id)}/relations/${encodeURIComponent(target_id)}/confirm`, jsonBody({})));
    } catch (error) {
      return toolError(error);
    }
  });
}

async function main() {
  // Read, not repeated: a hardcoded copy here silently reported the wrong
  // version to every AI tool as soon as the app was bumped.
  const server = new McpServer({ name: "knowledge-card-cabinet", version: require("./package.json").version });
  registerTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
