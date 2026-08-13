import { backendFetch, forwardBackend } from "../../_lib/backend";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  try {
    const { taskId } = await context.params;
    const response = await backendFetch(`/tasks/${encodeURIComponent(taskId)}`, { cache: "no-store" });
    return forwardBackend(response);
  } catch {
    return Response.json({ detail: "無法讀取背景任務狀態。" }, { status: 503 });
  }
}
