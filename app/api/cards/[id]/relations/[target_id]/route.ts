import { backendFetch, forwardBackend } from "../../../../_lib/backend";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; target_id: string }> };

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const { id, target_id } = await context.params;
    return forwardBackend(await backendFetch(
      `/cards/${encodeURIComponent(id)}/relations/${encodeURIComponent(target_id)}`,
      { method: "DELETE" },
    ));
  } catch {
    return Response.json({ detail: "無法連線到知識卡後端，請稍後再試。" }, { status: 503 });
  }
}
