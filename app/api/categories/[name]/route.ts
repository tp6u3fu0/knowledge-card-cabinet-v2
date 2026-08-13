import { backendFetch, forwardBackend } from "../../_lib/backend";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ name: string }> };

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { name } = await context.params;
    return forwardBackend(await backendFetch(`/categories/${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: await request.text(),
    }));
  } catch {
    return Response.json({ detail: "無法連線到知識卡後端，請稍後再試。" }, { status: 503 });
  }
}
