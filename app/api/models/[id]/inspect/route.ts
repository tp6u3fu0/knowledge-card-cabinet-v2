import { backendFetch, forwardBackend } from "../../../_lib/backend";

export const dynamic = "force-dynamic";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params;
    const response = await backendFetch(`/models/${encodeURIComponent(id)}/inspect`, { cache: "no-store" });
    return forwardBackend(response);
  } catch {
    return Response.json({ detail: "無法檢查模型檔案，請確認本機 API 正在運作。" }, { status: 503 });
  }
}
