import { backendFetch, forwardBackend } from "../../../_lib/backend";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const response = await backendFetch("/models/api/probe-embedding", {
      method: "POST",
      headers: { "Content-Type": request.headers.get("content-type") ?? "application/json" },
      body: await request.text(),
    });
    return forwardBackend(response);
  } catch {
    return Response.json({ detail: "無法連線到本機 API。" }, { status: 503 });
  }
}
