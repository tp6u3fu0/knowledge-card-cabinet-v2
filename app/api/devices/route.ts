import { backendFetch, forwardBackend } from "../_lib/backend";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    return forwardBackend(await backendFetch("/devices", { cache: "no-store" }));
  } catch {
    return Response.json({ detail: "無法讀取已配對裝置，請稍後再試。" }, { status: 503 });
  }
}
