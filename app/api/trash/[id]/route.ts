import { backendFetch, forwardBackend } from "../../_lib/backend";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const { id } = await context.params;
    const response = await backendFetch(`/trash/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    return forwardBackend(response);
  } catch {
    return Response.json(
      { detail: "無法連線到知識卡後端，請稍後再試。" },
      { status: 503 },
    );
  }
}
