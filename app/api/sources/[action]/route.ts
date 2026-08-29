import { backendFetch, forwardBackend } from "../../_lib/backend";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ action: string }> };

/**
 * Checking a source is the one thing in the app that makes the host fetch a
 * url someone pasted, so the proxy names the two actions it will pass on
 * rather than forwarding whatever turns up in the path.
 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { action } = await context.params;
  if (action !== "check" && action !== "accept") {
    return Response.json({ detail: "不支援的來源操作。" }, { status: 404 });
  }
  try {
    return forwardBackend(await backendFetch(`/sources/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await request.text(),
    }));
  } catch {
    return Response.json({ detail: "無法連線到知識卡後端，請稍後再試。" }, { status: 503 });
  }
}
