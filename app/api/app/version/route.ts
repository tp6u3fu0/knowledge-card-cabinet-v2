import { backendFetch, forwardBackend } from "../../_lib/backend";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const response = await backendFetch("/app/version", { cache: "no-store" });
    return forwardBackend(response);
  } catch {
    // A missing answer here must never be visible: the header simply shows no
    // version rather than an error about a version.
    return Response.json({ detail: "無法讀取版本資訊。" }, { status: 503 });
  }
}
