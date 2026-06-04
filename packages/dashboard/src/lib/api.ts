// The API client — the SAME wire contract the vanilla page defined and intake
// adapters depend on, kept verbatim: a bearer token in localStorage sent as
// `Authorization: Bearer …` on every call, and `?token=` appended for the SSE
// stream (which cannot set a header). The dashboard is a thin client of the
// localhost control plane; the API base is same-origin (the server hosts both
// the static SPA and the routes), so every path is relative.

const TOKEN_KEY = "loom_token";

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(value: string): void {
  try {
    if (value.length > 0) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private-mode / disabled storage — the token simply isn't persisted */
  }
}

function headers(body: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (body) h["content-type"] = "application/json";
  const token = getToken();
  if (token.length > 0) h["authorization"] = `Bearer ${token}`;
  return h;
}

// A typed error carrying the server's envelope `{ error: { code, message } }`
// so a view can show the code (the same shape the vanilla page surfaced).
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: headers(body !== undefined),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    /* a non-JSON body (should not happen on the API surface) */
  }
  if (!res.ok) {
    const env = data as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(
      res.status,
      env?.error?.code ?? `HTTP_${res.status}`,
      env?.error?.message ?? `HTTP ${res.status}`,
    );
  }
  return data as T;
}

// The URL for an SSE subscription, with the token in the query string (an
// EventSource cannot set the Authorization header). Mirrors the vanilla page.
export function sseUrl(path: string): string {
  const token = getToken();
  return token.length > 0 ? `${path}?token=${encodeURIComponent(token)}` : path;
}
