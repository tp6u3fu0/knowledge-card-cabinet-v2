import { backendFetch, forwardBackend } from "../_lib/backend";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const response = await backendFetch("/cards", {
      cache: "no-store",
    });
    return forwardBackend(response);
  } catch {
    return Response.json(
      { detail: "無法連線到知識卡本機 API，請重新啟動應用程式。" },
      { status: 503 },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const response = await backendFetch("/cards", {
      method: "POST",
      headers: {
        "Content-Type": request.headers.get("content-type") ?? "application/json",
      },
      body: await request.text(),
    });
    return forwardBackend(response);
  } catch {
    return Response.json(
      { detail: "無法連線到知識卡本機 API，請稍後再試。" },
      { status: 503 },
    );
  }
}
