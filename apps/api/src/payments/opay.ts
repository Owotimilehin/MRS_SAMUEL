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
      amount?: { total?: number; currency?: string };
    } | null;
  };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`opay status failed: ${httpStatus} ${text}`);
  }
  const d = body.data ?? {};
  const koboToNgn = (v: unknown): number | null =>
    typeof v === "number" ? Math.round(v / 100) : null;
  const gross = koboToNgn(d.amount?.total);
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

/** Create an OPay cashier session and return the URL to redirect the customer
 *  to. `reference` is our order number (also the key we query status by). */
export async function createOpayCashier(opts: {
  amountNgn: number;
  reference: string;
  email: string;
  customerName?: string;
  customerPhone?: string;
  returnUrl: string;
  callbackUrl: string;
}): Promise<{ cashierUrl: string; orderNo: string | null }> {
  const { merchantId, publicKey } = requireOpayEnv();
  const body = {
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
  };
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
  const bodyJson = JSON.stringify({ reference, country: "NG" });
  const res = await fetch(`${BASE}/api/v1/international/cashier/status`, {
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
