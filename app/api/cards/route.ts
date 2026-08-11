const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://localhost:8000";

export const dynamic = "force-dynamic";

async function forwardResponse(response: Response): Promise<Response> {
  const body = await response.text();
  return new Response(body, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("content-type") ?? "application/json",
    },
  });
}

export async function GET(): Promise<Response> {
  try {
    const response = await fetch(`${API_INTERNAL_URL}/cards`, {
      cache: "no-store",
    });
    return forwardResponse(response);
  } catch {
    return Response.json(
      { detail: "無法連線到知識卡後端，請確認 API container 正在運作。" },
      { status: 503 },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const response = await fetch(`${API_INTERNAL_URL}/cards`, {
      method: "POST",
      headers: {
        "Content-Type": request.headers.get("content-type") ?? "application/json",
      },
      body: await request.text(),
    });
    return forwardResponse(response);
  } catch {
    return Response.json(
      { detail: "無法連線到知識卡後端，請稍後再試。" },
      { status: 503 },
    );
  }
}
