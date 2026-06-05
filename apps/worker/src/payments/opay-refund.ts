import crypto from "node:crypto";
import pino from "pino";

const logger = pino({ base: { service: "ms-worker", part: "opay-refund" } });

const BASE = process.env.OPAY_API_BASE ?? "https://liveapi.opaycheckout.com";

/**
 * Sign a refund body for OPay. Mirrors the signer in apps/api's opay client —
 * HMAC-SHA512 over the raw JSON keyed by the merchant private key, with an
 * OPAY_SIGN_ALG=rsa-sha256 escape hatch. Kept self-contained so the worker
 * doesn't depend on the api package.
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
 * Refund an OPay payment. Runs from the worker so refunds get retried/backed
 * off like other side effects. `processorReference` is the OPay orderNo we
 * stored on the payment row.
 *
 * Dev mode (no OPay creds): returns a mock refund reference so the full flow
 * can be exercised without real credentials.
 */
export async function refundOpay(opts: {
  processorReference: string;
  amountNgn: number;
}): Promise<{ refund_reference: string }> {
  const merchantId = process.env.OPAY_MERCHANT_ID;
  if (!merchantId || !process.env.OPAY_PRIVATE_KEY) {
    logger.warn({ ref: opts.processorReference }, "OPay creds unset — returning mock refund");
    return { refund_reference: `mock-refund-${Date.now()}` };
  }
  const bodyJson = JSON.stringify({
    orderNo: opts.processorReference,
    country: "NG",
    amount: { currency: "NGN", total: opts.amountNgn * 100 },
    reason: "customer return",
  });
  const res = await fetch(`${BASE}/api/v1/international/payment/refund`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${signOpayRequest(bodyJson)}`,
      MerchantId: merchantId,
    },
    body: bodyJson,
  });
  if (!res.ok) {
    throw new Error(`opay refund failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    code?: string;
    data?: { refundId?: string; orderNo?: string; reference?: string };
  };
  return {
    refund_reference: body.data?.refundId ?? body.data?.orderNo ?? body.data?.reference ?? "",
  };
}
