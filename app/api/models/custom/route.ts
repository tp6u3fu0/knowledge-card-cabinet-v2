import { backendFetch, forwardBackend } from "../../_lib/backend";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const response = await backendFetch("/models/custom", {
      method: "POST",
      headers: { "Content-Type": request.headers.get("content-type") ?? "application/json" },
      body: await request.text(),
    });
    return forwardBackend(response);
  } catch {
    return Response.json({ detail: "無法加入模型，請確認本機 API 正在運作。" }, { status: 503 });
  }
}
