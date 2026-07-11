import { createHmac } from "node:crypto";

/**
 * OPay Cashier / Express Checkout integration. Unlike Payaza (client-side
 * popup), OPay is a server-created REDIRECT flow: we POST cashier/create, get a
 * cashierUrl, and redirect the customer. Payment is confirmed authoritatively by
 * re-querying cashier/status (server-to-server, signed) — never from a callback
 * body. Amounts on the wire are kobo (naira × 100).
 */

/** Normalized confirmed-transaction shape shared by Payaza + OPay so the
 *  reconcile money-path is provider-agnostic. Structurally identical to the old
 *  PayazaTransactionStatus (which is now an alias of this). */
export interface ConfirmedTransaction {
  status: string;
  amountNgn: number | null;
  feeNgn: number | null;
  netNgn: number | null;
  processorReference: string | null;
  authorization: { token: string; reusable: boolean } | null;
  raw: unknown;
}

// `||` not `??`: an empty-string env should fall back to the default, not
// produce a relative URL. OPay's real hosts are liveapi.* (production) and
// testapi.* (sandbox) — verified against OPay's cashier-create docs. Override
// with OPAY_API_BASE=https://testapi.opaycheckout.com for sandbox.
const BASE = process.env.OPAY_API_BASE || "https://liveapi.opaycheckout.com";

/** HMAC-SHA512 hex of the request body JSON, signed with the merchant private
 *  (secret) key. Used as the Bearer token for signed server-to-server calls
 *  (cashier/status). Pure + synchronous so it is unit-tested without HTTP. */
export function signOpayBody(bodyJson: string, privateKey: string): string {
  return createHmac("sha512", privateKey).update(bodyJson, "utf8").digest("hex");
}

/** Map an OPay cashier/status body to the normalized shape. `amount.total` is
 *  kobo → naira. OPay status carries no per-txn fee, so feeNgn is null and net
 *  falls back to gross. 401/403/5xx throw (so a webhook 500s and OPay retries);
 *  a 2xx/4xx JSON envelope is a legitimate "not confirmed yet" answer. */
export function parseOpayStatus(httpStatus: number, text: string): ConfirmedTransaction {
  if (httpStatus === 401 || httpStatus === 403 || httpStatus >= 500) {
    throw new Error(`opay status failed: ${httpStatus} ${text}`);
  }
  let body: {
    code?: string;
    message?: string;
    data?: {
      reference?: string;
      orderNo?: string;
      status?: string;
      // v3 cashier/status returns amount as a kobo STRING with a sibling
      // `currency`; the older/international shape nested it as { total }.
      // Accept both so a wire-format change can't silently null the amount.
      amount?: string | number | { total?: number; currency?: string };
      currency?: string;
    } | null;
  };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`opay status failed: ${httpStatus} ${text}`);
  }
  // A cashier/status query only succeeds with envelope code 00000. Any other
  // code (e.g. 02000 "Authentication failed") is a hard error we MUST surface —
  // never silently treat it as "PENDING", which masks a broken money path and
  // leaves paid orders stuck. (This is exactly what happened in prod: an auth
  // failure read as PENDING so no OPay order could ever auto-confirm.)
  if (body.code && body.code !== "00000") {
    throw new Error(`opay status error: ${body.code} ${body.message ?? text}`);
  }
  const d = body.data ?? {};
  // We only ever create NGN orders. A non-NGN currency in a status response
  // means the amount is not in kobo we can trust — surface it loudly rather
  // than silently mis-booking a foreign-currency figure as naira.
  const currency = typeof d.amount === "object" ? d.amount?.currency : d.currency;
  if (currency && currency !== "NGN") {
    throw new Error(`opay status unexpected currency: ${currency}`);
  }
  const koboToNgn = (v: unknown): number | null => {
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    return Number.isFinite(n) ? Math.round(n / 100) : null;
  };
  const amountKobo = d.amount && typeof d.amount === "object" ? d.amount.total : d.amount;
  const gross = koboToNgn(amountKobo);
  return {
    status: d.status ?? "PENDING",
    amountNgn: gross,
    feeNgn: null,
    netNgn: gross,
    processorReference: d.orderNo ?? null,
    authorization: null,
    raw: body,
  };
}

/** OPay reports a completed payment as status "SUCCESS". */
export function isOpaySuccess(status: string): boolean {
  return status.toUpperCase() === "SUCCESS";
}

function requireOpayEnv(): { merchantId: string; publicKey: string; secretKey: string } {
  const merchantId = process.env.OPAY_MERCHANT_ID ?? "";
  const publicKey = process.env.OPAY_PUBLIC_KEY ?? "";
  const secretKey = process.env.OPAY_SECRET_KEY ?? "";
  if (!merchantId || !publicKey || !secretKey) {
    throw new Error("OPAY_MERCHANT_ID / OPAY_PUBLIC_KEY / OPAY_SECRET_KEY not configured");
  }
  return { merchantId, publicKey, secretKey };
}

export interface OpayCashierOpts {
  amountNgn: number;
  reference: string;
  email: string;
  customerName?: string;
  customerPhone?: string;
  returnUrl: string;
  callbackUrl: string;
}

/** Build the cashier/create request body. Pure + exported so the wire shape is
 *  unit-tested without HTTP. OPay's international cashier REQUIRES a `product`
 *  (or `productList`) field — omitting it is rejected with 02001. We send a
 *  single `product` describing the order rather than a line-item `productList`
 *  (which additionally demands a per-item productId we don't mint). */
export function buildOpayCashierBody(opts: OpayCashierOpts) {
  return {
    country: "NG",
    reference: opts.reference,
    amount: { total: opts.amountNgn * 100, currency: "NGN" }, // kobo
    returnUrl: opts.returnUrl,
    callbackUrl: opts.callbackUrl,
    expireAt: 30, // minutes — matches the 30-min stock hold
    userInfo: {
      userName: opts.customerName ?? "Customer",
      userEmail: opts.email,
      userMobile: opts.customerPhone ?? "",
    },
    product: {
      name: "Mrs Samuel juice order",
      description: `Order ${opts.reference}`,
    },
  };
}

/** Create an OPay cashier session and return the URL to redirect the customer
 *  to. `reference` is our order number (also the key we query status by). */
export async function createOpayCashier(
  opts: OpayCashierOpts,
): Promise<{ cashierUrl: string; orderNo: string | null }> {
  const { merchantId, publicKey } = requireOpayEnv();
  const body = buildOpayCashierBody(opts);
  const res = await fetch(`${BASE}/api/v1/international/cashier/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${publicKey}`,
      MerchantId: merchantId,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: { code?: string; message?: string; data?: { cashierUrl?: string; orderNo?: string } };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`opay create failed: ${res.status} ${text}`);
  }
  const url = parsed.data?.cashierUrl;
  if (parsed.code !== "00000" || !url) {
    throw new Error(`opay create rejected: ${parsed.code} ${parsed.message ?? text}`);
  }
  return { cashierUrl: url, orderNo: parsed.data?.orderNo ?? null };
}

/** Authoritatively confirm a payment by querying OPay cashier/status, signed
 *  with the private key. Throws without OPAY_* creds — a missing key must fail
 *  loudly, never fabricate a confirmation. */
export async function verifyOpayTransaction(reference: string): Promise<ConfirmedTransaction> {
  const { merchantId, secretKey } = requireOpayEnv();
  // OPay's cashier status lives at /api/v3/cashier/status and the signed body
  // must contain ONLY { reference }. Any extra field (we previously sent
  // `country`) changes the payload OPay re-signs on its side, so the HMAC no
  // longer matches and every call fails with 02000 "Authentication failed".
  const bodyJson = JSON.stringify({ reference });
  const res = await fetch(`${BASE}/api/v3/cashier/status`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${signOpayBody(bodyJson, secretKey)}`,
      MerchantId: merchantId,
    },
    body: bodyJson,
  });
  const text = await res.text();
  return parseOpayStatus(res.status, text);
}
