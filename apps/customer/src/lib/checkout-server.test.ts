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
          ? new Response(
              JSON.stringify({ error: { code: "order_closed", message: "closed" } }),
              { status: 409, headers: { "content-type": "application/json" } },
            )
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

  it("OPay unreachable: sends the customer to their order page, basket cleared", async () => {
    stubApi(null);
    const res = await handleCheckoutPost(submit());
    expect(res?.status).toBe(303);
    // Not back to /checkout with an error: the order exists, so a second
    // submit would be a second order.
    expect(res?.headers.get("location")).toBe("/order/MS-1042?await_payment=1");
    const cookies = res?.headers.getSetCookie() ?? [];
    expect(cookies.some((c) => c.startsWith("ms_cart=;") && c.includes("Max-Age=0"))).toBe(true);
    expect(cookies.some((c) => c.startsWith("ms_cart_cleared=1"))).toBe(true);
  });
});
