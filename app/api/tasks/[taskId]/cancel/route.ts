import { backendFetch, forwardBackend } from "../../../_lib/backend";

export const dynamic = "force-dynamic";

export async function POST(_: Request, context: { params: Promise<{ taskId: string }> }): Promise<Response> {
  try {
    const { taskId } = await context.params;
    const response = await backendFetch(`/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" });
    return forwardBackend(response);
  } catch {
    return Response.json({ detail: "無法取消背景任務，請稍後再試。" }, { status: 503 });
  }
}
