import { Link } from "@tanstack/react-router";
import { useCart } from "../store/cart.js";
import { ngn } from "../lib/api.js";

export function CartPage(): JSX.Element {
  const cart = useCart();
  const items = cart.items;
  const subtotal = cart.subtotal();

  if (items.length === 0) {
    return (
      <main className="max-w-2xl mx-auto py-20 px-6 text-center">
        <h1 className="font-display text-3xl font-bold mb-4">Your cart is empty</h1>
        <p className="mb-6" style={{ color: "var(--ms-ink-3)" }}>
          Browse the menu and add a bottle.
        </p>
        <Link
          to="/"
          className="inline-block px-6 py-3 rounded-full text-white font-bold no-underline"
          style={{ background: "var(--ms-green-500)" }}
        >
          See the menu →
        </Link>
      </main>
    );
  }

  return (
    <main className="max-w-2xl mx-auto py-12 px-6">
      <Link
        to="/"
        className="text-sm no-underline mb-6 inline-block"
        style={{ color: "var(--ms-ink-3)" }}
      >
        ← Continue browsing
      </Link>
      <h1 className="font-display text-3xl font-bold mb-6">Your order</h1>

      <div
        className="rounded-2xl divide-y mb-6"
        style={{ background: "white", border: "1px solid var(--ms-border)" }}
      >
        {items.map((item) => (
          <div key={item.product_id} className="flex items-center gap-4 p-4">
            <div
              className="w-12 h-12 rounded-lg grid place-items-center text-xl"
              style={{
                background: "linear-gradient(135deg, var(--ms-orange), var(--ms-yellow))",
              }}
            >
              🥤
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold">{item.name}</div>
              <div className="text-xs" style={{ color: "var(--ms-ink-3)" }}>
                {ngn(item.unit_price_ngn)} each
              </div>
            </div>
            <div
              className="flex items-center gap-2 rounded-full px-1"
              style={{ background: "var(--ms-bg)" }}
            >
              <button
                onClick={() => cart.setQuantity(item.product_id, item.quantity - 1)}
                className="w-7 h-7 rounded-full bg-white grid place-items-center"
              >
                −
              </button>
              <span className="w-5 text-center font-semibold tabular-nums">{item.quantity}</span>
              <button
                onClick={() => cart.setQuantity(item.product_id, item.quantity + 1)}
                className="w-7 h-7 rounded-full bg-white grid place-items-center"
              >
                +
              </button>
            </div>
            <div className="w-24 text-right font-semibold tabular-nums">
              {ngn(item.unit_price_ngn * item.quantity)}
            </div>
          </div>
        ))}
      </div>

      <div
        className="rounded-2xl p-5 mb-6"
        style={{ background: "white", border: "1px solid var(--ms-border)" }}
      >
        <div className="flex justify-between mb-2">
          <span style={{ color: "var(--ms-ink-3)" }}>Subtotal</span>
          <span className="tabular-nums">{ngn(subtotal)}</span>
        </div>
        <div className="flex justify-between mb-2" style={{ color: "var(--ms-ink-3)", fontSize: 14 }}>
          <span>Delivery</span>
          <span>calculated at checkout</span>
        </div>
        <div
          className="flex justify-between font-display text-2xl font-bold pt-3 mt-3"
          style={{ borderTop: "1px dashed var(--ms-border)" }}
        >
          <span>Total</span>
          <span className="tabular-nums">{ngn(subtotal)}</span>
        </div>
      </div>

      <Link
        to="/checkout"
        className="block w-full py-4 rounded-full text-white text-center font-bold no-underline"
        style={{ background: "var(--ms-ink)" }}
      >
        Checkout →
      </Link>
    </main>
  );
}
