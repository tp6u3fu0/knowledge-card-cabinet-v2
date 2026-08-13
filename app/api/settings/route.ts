import { NextRequest } from "next/server";
import { backendFetch, forwardBackend } from "../_lib/backend";

export const dynamic = "force-dynamic";

export async function GET() {
  const response = await backendFetch("/settings", { cache: "no-store" });
  return forwardBackend(response);
}

export async function PUT(request: NextRequest) {
  const response = await backendFetch("/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: await request.text(),
    cache: "no-store",
  });
  return forwardBackend(response);
}
