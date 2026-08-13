import { backendFetch, forwardBackend } from "../../../_lib/backend";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  try {
    const response = await backendFetch(`/models/${encodeURIComponent(id)}`, {
      method: "POST",
    });
    return forwardBackend(response);
  } catch {
    return Response.json({ detail: "無法開始下載本機模型，請確認網路連線後再試。" }, { status: 503 });
  }
}
