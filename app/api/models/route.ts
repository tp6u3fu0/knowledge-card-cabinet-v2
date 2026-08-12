const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://localhost:8000";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const response = await fetch(`${API_INTERNAL_URL}/models`, { cache: "no-store" });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: { "Content-Type": response.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return Response.json({ detail: "無法讀取本機模型設定，請確認本機 API 正在運作。" }, { status: 503 });
  }
}
