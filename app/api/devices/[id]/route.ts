import { backendFetch, forwardBackend } from "../../_lib/backend";

export const dynamic = "force-dynamic";

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params;
    return forwardBackend(await backendFetch(`/devices/${encodeURIComponent(id)}`, { method: "DELETE", cache: "no-store" }));
  } catch {
    return Response.json({ detail: "無法撤銷裝置，請稍後再試。" }, { status: 503 });
  }
}
