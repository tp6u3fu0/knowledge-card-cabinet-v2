import { backendFetch, forwardBackend } from "../../_lib/backend";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return forwardBackend(await backendFetch("/network/lan", { cache: "no-store" }));
}

export async function POST(): Promise<Response> {
  return forwardBackend(await backendFetch("/network/lan", { method: "POST", cache: "no-store" }));
}

export async function DELETE(): Promise<Response> {
  return forwardBackend(await backendFetch("/network/lan", { method: "DELETE", cache: "no-store" }));
}
