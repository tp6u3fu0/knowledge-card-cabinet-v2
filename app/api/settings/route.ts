import { NextRequest } from "next/server";

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://api:8000";

export const dynamic = "force-dynamic";

export async function GET() {
  const response = await fetch(`${API_INTERNAL_URL}/settings`, { cache: "no-store" });
  const body = await response.text();
  return new Response(body, {
    status: response.status,
    headers: { "Content-Type": response.headers.get("content-type") ?? "application/json" },
  });
}

export async function PUT(request: NextRequest) {
  const response = await fetch(`${API_INTERNAL_URL}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: await request.text(),
    cache: "no-store",
  });
  const body = await response.text();
  return new Response(body, {
    status: response.status,
    headers: { "Content-Type": response.headers.get("content-type") ?? "application/json" },
  });
}
