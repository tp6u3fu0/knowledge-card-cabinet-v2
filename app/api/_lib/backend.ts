// The desktop app and `npm run serve` both inject the local API's real address;
// this default only covers `npm run dev:api`, which pins that port.
const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:8000";

export function backendHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra);
  const token = process.env.API_INTERNAL_TOKEN?.trim();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

export function backendUrl(path: string): string {
  return `${API_INTERNAL_URL}${path}`;
}

export function backendFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(backendUrl(path), {
    ...init,
    headers: backendHeaders(init.headers),
  });
}

export async function forwardBackend(response: Response): Promise<Response> {
  const body = await response.text();
  return new Response(body, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("content-type") ?? "application/json",
    },
  });
}

export function backendUnavailable(message = "無法連線到知識卡本機 API，請稍後再試。") {
  return Response.json({ detail: message }, { status: 503 });
}
