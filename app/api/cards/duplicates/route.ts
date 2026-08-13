import { backendFetch, forwardBackend } from "../../_lib/backend";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    return forwardBackend(await backendFetch("/cards/duplicates", { cache: "no-store" }));
  } catch {
    return Response.json({ detail: "無法連線到知識卡後端，請稍後再試。" }, { status: 503 });
  }
}
