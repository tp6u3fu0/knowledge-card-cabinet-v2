import { NextRequest } from "next/server";
import { backendFetch, forwardBackend } from "../_lib/backend";

export const dynamic = "force-dynamic";

/**
 * A backend that cannot be reached has to arrive as a sentence.
 *
 * Without the catch, a failed `backendFetch` escapes the handler and the
 * framework answers with the plain text "Internal Server Error". The settings
 * dialog then calls `.json()` on it and shows the user
 * `Unexpected token 'I', "Internal S"... is not valid JSON` — the only place in
 * the app that did this, because every other proxy route already catches.
 */
export async function GET() {
  try {
    const response = await backendFetch("/settings", { cache: "no-store" });
    return forwardBackend(response);
  } catch {
    return Response.json({ detail: "無法讀取模型設定，請確認本機 API 正在運作。" }, { status: 503 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const response = await backendFetch("/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: await request.text(),
      cache: "no-store",
    });
    return forwardBackend(response);
  } catch {
    return Response.json({ detail: "無法套用模型設定，請確認本機 API 正在運作。" }, { status: 503 });
  }
}
