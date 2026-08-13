import { backendFetch, forwardBackend } from "../_lib/backend";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const incoming = new URL(request.url);
    const query = new URLSearchParams();
    for (const key of ["q", "limit", "category", "tag", "sort"]) {
      const value = incoming.searchParams.get(key);
      if (value) query.set(key, value);
    }
    return forwardBackend(await backendFetch(`/search?${query.toString()}`, { cache: "no-store" }));
  } catch {
    return Response.json({ detail: "無法連線到知識卡搜尋服務，請稍後再試。" }, { status: 503 });
  }
}
