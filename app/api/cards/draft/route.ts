const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://localhost:8000";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const response = await fetch(`${API_INTERNAL_URL}/cards/draft`, {
      method: "POST",
      headers: {
        "Content-Type": request.headers.get("content-type") ?? "application/json",
      },
      body: await request.text(),
    });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("content-type") ?? "application/json",
      },
    });
  } catch {
    return Response.json(
      { detail: "無法連線到本機整理模型，請確認 API container 正在運作。" },
      { status: 503 },
    );
  }
}
