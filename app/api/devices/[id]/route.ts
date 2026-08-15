import { backendFetch, forwardBackend } from "../../_lib/backend";

export const dynamic = "force-dynamic";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params;
    // Without ?purge=1 this only revokes; with it, the record is removed too.
    const purge = new URL(request.url).searchParams.get("purge") === "1" ? "?purge=1" : "";
    return forwardBackend(await backendFetch(`/devices/${encodeURIComponent(id)}${purge}`, { method: "DELETE", cache: "no-store" }));
  } catch {
    return Response.json({ detail: "無法更新裝置，請稍後再試。" }, { status: 503 });
  }
}
