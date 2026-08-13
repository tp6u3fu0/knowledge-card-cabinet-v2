import { backendFetch, forwardBackend } from "../../_lib/backend";

export const dynamic = "force-dynamic";

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params;
    const response = await backendFetch(`/models/${encodeURIComponent(id)}`, { method: "DELETE" });
    return forwardBackend(response);
  } catch {
    return Response.json({ detail: "無法清理模型檔案，請確認本機 API 正在運作。" }, { status: 503 });
  }
}
