import { backendFetch, forwardBackend } from "../../_lib/backend";

export const dynamic = "force-dynamic";

/** See the note in app/api/settings/route.ts on why every handler catches. */
async function proxy(init: RequestInit, failure: string): Promise<Response> {
  try {
    return forwardBackend(await backendFetch("/network/lan", { ...init, cache: "no-store" }));
  } catch {
    return Response.json({ detail: failure }, { status: 503 });
  }
}

export async function GET(): Promise<Response> {
  return proxy({}, "無法讀取區網分享狀態，請確認本機 API 正在運作。");
}

export async function POST(): Promise<Response> {
  return proxy({ method: "POST" }, "無法開啟區網分享，請確認本機 API 正在運作。");
}

export async function DELETE(): Promise<Response> {
  return proxy({ method: "DELETE" }, "無法關閉區網分享，請確認本機 API 正在運作。");
}
