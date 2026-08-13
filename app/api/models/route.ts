import { backendFetch, forwardBackend } from "../_lib/backend";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const response = await backendFetch("/models", { cache: "no-store" });
    return forwardBackend(response);
  } catch {
    return Response.json({ detail: "無法讀取本機模型設定，請確認本機 API 正在運作。" }, { status: 503 });
  }
}
