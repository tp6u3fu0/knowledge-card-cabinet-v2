const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://localhost:8000";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  try {
    const response = await fetch(`${API_INTERNAL_URL}/models/${encodeURIComponent(id)}`, {
      method: "POST",
    });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: { "Content-Type": response.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return Response.json({ detail: "無法開始下載本機模型，請確認網路連線後再試。" }, { status: 503 });
  }
}
