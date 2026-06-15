import { local } from "../db/local.js";

interface CreateLocalSaleInput {
  branchId: string;
  items: Array<{
    product_id: string;
    // The exact can size sold. Sent to the server so it books that variant's
    // price instead of defaulting to the smallest can.
    variant_id: string;
    size_ml: number;
    quantity: number;
    unit_price_ngn: number;
  }>;
  payment_method: "cash" | "card" | "transfer";
  channel: "walkup" | "whatsapp" | "chowdeck_pickup";
  /**
   * Prepaid preorder: payment is taken now but the stock is NOT consumed — the
   * order waits in the Preorders queue for manual fulfilment. When true the
   * optimistic local ledger is left untouched (nothing leaves the branch yet),
   * mirroring the server, which defers the deduction to fulfilment.
   */
  is_preorder?: boolean;
  /** Target fulfilment day (ISO) for a preorder — the day it'll be made + handed over. */
  fulfill_by?: string;
  external_reference?: string;
  /** Optional bags handed to the customer (tracked-only, never blocks a sale). */
  packaging?: Array<{ packaging_material_id: string; quantity: number }>;
  /**
   * Optional customer captured at the till. Forwarded to the server, which
   * resolves a returning customer by phone (find-or-create) so their orders
   * roll up. Omitted entirely for an anonymous walk-up.
   */
  customer?: { name?: string; phone?: string };
}

interface CreateLocalSaleResult {
  saleId: string;
  orderNumber: string;
  subtotal: number;
}

/**
 * Create a sale locally and enqueue server-side confirm + pay mutations.
 *
 * The client-generated UUID becomes the SaleOrder.id AND the idempotency_key
 * on the server. Local ledger rows decrement available stock immediately so
 * the UI updates without waiting for the network.
 *
 * Two outbox rows are written: a Confirm and a Pay-depends_on-Confirm. The
 * sync engine will replay them in order; if Pay arrives before Confirm has
 * been acknowledged, the engine skips it and revisits next tick.
 */
export async function createLocalSale(
  input: CreateLocalSaleInput,
): Promise<CreateLocalSaleResult> {
  const subtotal = input.items.reduce(
    (sum, i) => sum + i.unit_price_ngn * i.quantity,
    0,
  );
  const saleId = crypto.randomUUID();
  const localOrderNumber = `LOCAL-${Date.now().toString(36)}`;
  const idempotencyKey = saleId;
  const nowIso = new Date().toISOString();
  const nowEpoch = Date.now();

  await local.transaction(
    "rw",
    local.sales,
    local.outbox,
    local.ledger,
    local.reservations,
    async () => {
      await local.sales.put({
        id: saleId,
        order_number: localOrderNumber,
        branch_id: input.branchId,
        channel: input.channel,
        status: "confirmed",
        total_ngn: subtotal,
        payment_method: input.payment_method,
        created_at_local: nowIso,
        idempotency_key: idempotencyKey,
      });

      // Optimistic ledger — branch availability drops immediately. A preorder
      // takes payment without consuming stock (it's fulfilled later from the
      // queue), so we record no ledger movement here, matching the server.
      for (const it of input.is_preorder ? [] : input.items) {
        await local.ledger.put({
          id: crypto.randomUUID(),
          location_type: "branch",
          location_id: input.branchId,
          product_id: it.product_id,
          variant_id: it.variant_id,
          delta: -it.quantity,
          source_type: "sale",
          source_id: saleId,
          recorded_at: nowIso,
        });
      }

      const confirmId = idempotencyKey;
      await local.outbox.put({
        id: confirmId,
        endpoint: `/v1/branches/${input.branchId}/sales`,
        method: "POST",
        payload: {
          id: saleId,
          channel: input.channel,
          items: input.items.map((i) => ({
            product_id: i.product_id,
            variant_id: i.variant_id,
            quantity: i.quantity,
          })),
          payment_method: input.payment_method,
          ...(input.external_reference
            ? { external_reference: input.external_reference }
            : {}),
          ...(input.customer && (input.customer.name || input.customer.phone)
            ? { customer: input.customer }
            : {}),
          ...(input.packaging && input.packaging.length > 0
            ? { packaging: input.packaging }
            : {}),
          ...(input.is_preorder && input.fulfill_by
            ? { scheduled_delivery_at: input.fulfill_by }
            : {}),
          created_at_local: nowIso,
        },
        attempt_count: 0,
        next_attempt_at: nowEpoch,
        status: "pending",
        created_at_local: nowEpoch,
      });

      const payId = crypto.randomUUID();
      await local.outbox.put({
        id: payId,
        endpoint: `/v1/branches/${input.branchId}/sales/${saleId}/pay`,
        method: "PATCH",
        payload: null,
        depends_on: confirmId,
        attempt_count: 0,
        next_attempt_at: nowEpoch,
        status: "pending",
        created_at_local: nowEpoch + 1, // ordered after confirm
      });
    },
  );

  return { saleId, orderNumber: localOrderNumber, subtotal };
}
