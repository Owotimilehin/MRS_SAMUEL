import crypto from "node:crypto";

export interface OpaySession {
  reference: string;
  authorization_url: string;
  orderNo: string | null;
}

/** OPay order states: INITIAL | PENDING | SUCCESS | FAIL | CLOSE. Kept as a
 *  plain string since OPay may add states we don't enumerate. */
export interface OpayOrderStatus {
  status: string;
  amountNgn: number | null;
  orderNo: string | null;
}

const BASE = process.env.OPAY_API_BASE ?? "https://liveapi.opaycheckout.com";

/**
 * Sign a request body for OPay's authenticated read/refund endpoints
 * (queryorder, refund). OPay's docs are inconsistent about the algorithm
 * across products — the international cashier suite is documented as
 * HMAC-SHA512 over the raw JSON body keyed by the merchant private key, while
 * a few pages show RSA-SHA256. We default to HMAC-SHA512 and leave a one-env
 * escape hatch (OPAY_SIGN_ALG=rsa-sha256) so the scheme can be flipped during
 * the live smoke test without touching code. Isolated here on purpose.
 */
function signOpayRequest(bodyJson: string): string {
  const key = process.env.OPAY_PRIVATE_KEY ?? "";
  if ((process.env.OPAY_SIGN_ALG ?? "hmac-sha512").toLowerCase() === "rsa-sha256") {
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(bodyJson);
    signer.end();
    return signer.sign(key, "base64");
  }
  return crypto.createHmac("sha512", key).update(bodyJson).digest("hex");
}

/**
 * Create an OPay Cashier (hosted checkout) session and return the URL we
 * redirect the customer to. OPay denominates amounts in cents, so naira is
 * multiplied by 100. The Cashier create call authenticates with the *public*
 * key in the Authorization header plus the MerchantId header — no body
 * signature (that only applies to the read/refund endpoints).
 *
 * Dev/test shim: when OPAY_PUBLIC_KEY / OPAY_MERCHANT_ID are absent we return
 * a fake URL that loops back to the customer return URL with ?mock=1 so the
 * webhook (also in mock mode) can auto-complete the order without real keys.
 */
export async function createOpaySession(opts: {
  amountNgn: number;
  email: string;
  reference: string;
  returnUrl: string;
  callbackUrl: string;
  productName: string;
  customerName?: string;
  customerPhone?: string;
}): Promise<OpaySession> {
  const publicKey = process.env.OPAY_PUBLIC_KEY;
  const merchantId = process.env.OPAY_MERCHANT_ID;
  if (!publicKey || !merchantId) {
    const sep = opts.returnUrl.includes("?") ? "&" : "?";
    return {
      reference: opts.reference,
      authorization_url: `${opts.returnUrl}${sep}mock=1&reference=${opts.reference}`,
      orderNo: null,
    };
  }

  const payload = {
    reference: opts.reference,
    country: "NG",
    amount: { currency: "NGN", total: opts.amountNgn * 100 },
    returnUrl: opts.returnUrl,
    callbackUrl: opts.callbackUrl,
    product: { name: opts.productName, description: opts.productName },
    userInfo: {
      userEmail: opts.email,
      ...(opts.customerName ? { userName: opts.customerName } : {}),
      ...(opts.customerPhone ? { userMobile: opts.customerPhone } : {}),
    },
    expireAt: 30,
  };

  const res = await fetch(`${BASE}/api/v1/international/cashier/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${publicKey}`,
      MerchantId: merchantId,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`opay cashier create failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    code?: string;
    message?: string;
    data?: { cashierUrl?: string; orderNo?: string; status?: string };
  };
  if (body.code !== "00000" || !body.data?.cashierUrl) {
    throw new Error(`opay cashier create rejected: ${body.code} ${body.message ?? ""}`);
  }
  return {
    reference: opts.reference,
    authorization_url: body.data.cashierUrl,
    orderNo: body.data.orderNo ?? null,
  };
}

/**
 * Authoritatively confirm a payment by asking OPay directly. The webhook uses
 * this rather than trusting the callback body — OPay's callback signature
 * scheme is poorly documented, so the money decision is gated on a signed
 * server-to-server status read instead.
 *
 * Dev/test shim: no creds → report SUCCESS with an unknown amount so the mock
 * checkout flow completes (mirrors the create shim). The unknown amount makes
 * the webhook's amount-equality guard skip, exactly like the legacy dev path.
 */
export async function queryOpayOrder(reference: string): Promise<OpayOrderStatus> {
  const merchantId = process.env.OPAY_MERCHANT_ID;
  if (!merchantId || !process.env.OPAY_PRIVATE_KEY) {
    return { status: "SUCCESS", amountNgn: null, orderNo: `mock-${reference}` };
  }
  const bodyJson = JSON.stringify({ reference, country: "NG" });
  const res = await fetch(`${BASE}/api/v1/international/payout/queryorder`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${signOpayRequest(bodyJson)}`,
      MerchantId: merchantId,
    },
    body: bodyJson,
  });
  if (!res.ok) {
    throw new Error(`opay queryorder failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    code?: string;
    data?: {
      status?: string;
      orderStatus?: string;
      orderNo?: string;
      amount?: { total?: number };
    };
  };
  const d = body.data ?? {};
  const cents = d.amount?.total;
  return {
    status: d.status ?? d.orderStatus ?? "PENDING",
    amountNgn: typeof cents === "number" ? Math.round(cents / 100) : null,
    orderNo: d.orderNo ?? null,
  };
}
