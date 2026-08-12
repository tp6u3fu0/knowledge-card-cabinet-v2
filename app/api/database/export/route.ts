const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://api:8000";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const response = await fetch(`${API_INTERNAL_URL}/database/export`, {
      cache: "no-store",
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
      { detail: "無法連線到知識卡本機 API，請稍後再試。" },
      { status: 503 },
    );
  }
}
