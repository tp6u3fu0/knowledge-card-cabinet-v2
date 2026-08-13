import { backendFetch, forwardBackend } from "../../_lib/backend";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const response = await backendFetch("/database/export", {
      cache: "no-store",
    });
    return forwardBackend(response);
  } catch {
    return Response.json(
      { detail: "無法連線到知識卡本機 API，請稍後再試。" },
      { status: 503 },
    );
  }
}
