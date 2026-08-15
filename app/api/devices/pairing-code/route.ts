import { backendFetch, forwardBackend } from "../../_lib/backend";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  try {
    return forwardBackend(await backendFetch("/devices/pairing-code", { method: "POST", cache: "no-store" }));
  } catch {
    return Response.json({ detail: "無法產生配對碼，請稍後再試。" }, { status: 503 });
  }
}
