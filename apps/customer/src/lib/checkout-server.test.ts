import { describe, it, expect, vi, afterEach } from "vitest";
import { handleCheckoutPost } from "./checkout-server";
import { CHECKOUT_POST_PATH } from "./checkout-post";

afterEach(() => {
  vi.unstubAllGlobals();
});

function submit(): Request {
  const form = new URLSearchParams({
    name: "Ada Lovelace",
    phone: "08012345678",
    address: "12 Allen Avenue",
    state: "Lagos",
    branch_id: "11111111-1111-4111-8111-111111111111",
  });
  form.append("item", "22222222-2222-4222-8222-222222222222:2");
  return new Request(`https://www.example.test${CHECKOUT_POST_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

/** The API answers the order POST with `redirectUrl`; telemetry calls just succeed. */
function stubApi(redirectUrl: string | null): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const data = String(url).endsWith("/v1/public/orders")
        ? {
            id: "33333333-3333-4333-8333-333333333333",
            order_number: "MS-1042",
            total_ngn: 5000,
            is_preorder: false,
            payment: { provider: "opay", reference: "MS-1042", redirect_url: redirectUrl },
          }
        : null;
      return new Response(JSON.stringify({ data }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

describe("handleCheckoutPost (no-JS checkout)", () => {
  it("an order that is already paid or expired bounces back with the 'closed' message code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/v1/public/orders")
          ? new Response(JSON.stringify({ error: { code: "order_closed", message: "closed" } }), {
              status: 409,
              headers: { "content-type": "application/json" },
            })
          : new Response(JSON.stringify({ data: null }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
      ),
    );
    const res = await handleCheckoutPost(submit());
    expect(res?.status).toBe(303);
    expect(res?.headers.get("location")).toBe("/checkout?e=closed");
  });

  it("redirects to OPay's payment page when the API returns one", async () => {
    stubApi("https://cashier.example.test/pay/abc");
    const res = await handleCheckoutPost(submit());
    expect(res?.status).toBe(303);
    expect(res?.headers.get("location")).toBe("https://cashier.example.test/pay/abc");
  });

  it("OPay unreachable: a plain page with a 'Try payment again' button, basket cleared", async () => {
    stubApi(null);
    const res = await handleCheckoutPost(submit());
    // Not back to /checkout with an error (a second submit would be a second
    // order), and not the order page (it needs JavaScript and a stored phone).
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toContain("text/html");
    expect(res?.headers.get("cache-control")).toBe("no-store");
    const html = (await res?.text()) ?? "";
    expect(html).toContain("Your order MS-1042 is saved");
    expect(html).toContain('<form method="POST" action="/checkout/pay">');
    expect(html).toContain('name="order" value="MS-1042"');
    expect(html).toContain('name="phone" value="08012345678"');
    expect(html).not.toContain("<script");
    const cookies = res?.headers.getSetCookie() ?? [];
    expect(cookies.some((c) => c.startsWith("ms_cart=;") && c.includes("Max-Age=0"))).toBe(true);
    expect(cookies.some((c) => c.startsWith("ms_cart_cleared=1"))).toBe(true);
  });
});

describe("handleCheckoutPost: 'Try payment again' (POST /checkout/pay)", () => {
  function pay(fields: Record<string, string>): Request {
    return new Request("https://www.example.test/checkout/pay", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
  }

  /** The API's resume-payment endpoint: a fresh URL, or an error. */
  function stubSession(ok: boolean) {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      ok
        ? new Response(
            JSON.stringify({ data: { redirect_url: "https://cashier.example.test/again" } }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          )
        : new Response(JSON.stringify({ error: { code: "internal_error", message: "x" } }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("opens a fresh OPay session for the order and redirects there", async () => {
    const fetchMock = stubSession(true);
    const res = await handleCheckoutPost(pay({ order: "SO-2026-1042", phone: "0801 234 5678" }));
    expect(res?.status).toBe(303);
    expect(res?.headers.get("location")).toBe("https://cashier.example.test/again");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/v1/public/orders/SO-2026-1042/opay-session?phone=08012345678");
    expect(init?.method).toBe("POST");
  });

  it("OPay still unreachable: shows the page again rather than an error", async () => {
    stubSession(false);
    const res = await handleCheckoutPost(pay({ order: "SO-2026-1042", phone: "08012345678" }));
    expect(res?.status).toBe(200);
    const html = (await res?.text()) ?? "";
    expect(html).toContain("We still couldn't open the payment page");
    expect(html).toContain('name="order" value="SO-2026-1042"');
  });

  it("rejects a malformed order number or phone without calling the API", async () => {
    const fetchMock = stubSession(true);
    for (const fields of [
      { order: '"><script>alert(1)</script>', phone: "08012345678" },
      { order: "SO-2026-1042", phone: '"><script>' },
      { order: "", phone: "" },
    ]) {
      const res = await handleCheckoutPost(pay(fields));
      expect(res?.status).toBe(303);
      expect(res?.headers.get("location")).toBe("/checkout?e=badform");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
