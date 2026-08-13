import { backendFetch, forwardBackend } from "../_lib/backend";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const query = url.search ? url.search : "";
    const response = await backendFetch(`/tasks${query}`, { cache: "no-store" });
    return forwardBackend(response);
  } catch {
    return Response.json({ detail: "無法讀取背景任務狀態。" }, { status: 503 });
  }
}
