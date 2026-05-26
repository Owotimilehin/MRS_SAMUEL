const BASE = "/v1/public";

/** crypto.randomUUID() requires a secure context — on plain HTTP previews it
 *  throws, so we fall back to a Math.random RFC4122-shaped uuid. */
function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (!headers.has("content-type") && init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (["POST", "PATCH", "PUT", "DELETE"].includes(method) && !headers.has("idempotency-key")) {
    headers.set("idempotency-key", uuid());
  }
  const res = await fetch(BASE + path, { ...init, headers });
  if (!res.ok) {
    let body: { error?: { message?: string } } = {};
    try {
      body = (await res.json()) as { error?: { message?: string } };
    } catch {
      /* not json */
    }
    throw new Error(body.error?.message ?? `request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export function ngn(amount: number): string {
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 0,
  }).format(amount);
}
