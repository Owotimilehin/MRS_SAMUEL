import { useLiveQuery } from "dexie-react-hooks";
import { Link } from "@tanstack/react-router";
import { local, type OutboxRow } from "../db/local.js";
import { countFailures } from "../lib/sale-failure.js";
import "./till-extras.css";

/**
 * Live count of outbox rows the server turned down. `sales` counts each stuck
 * sale once (its Confirm and Pay rows together); `other` is anything else
 * (e.g. a shift count). Updates the moment the sync engine dead-letters a row.
 */
export function useFailedOutbox(): { sales: number; other: number; total: number } {
  const rows = useLiveQuery(
    () => local.outbox.where("status").equals("dead").toArray(),
    [],
    [] as OutboxRow[],
  );
  const { sales, other } = countFailures(rows ?? []);
  return { sales, other, total: sales + other };
}

/**
 * Loud warning at the top of the Sell screen when a paid sale did not reach
 * the server. Without it a cashier could go hours not knowing.
 */
export function FailedSalesBanner(): JSX.Element | null {
  const { sales, other } = useFailedOutbox();
  if (sales === 0 && other === 0) return null;
  const headline =
    sales > 0
      ? `${sales} ${sales === 1 ? "sale didn't" : "sales didn't"} go through`
      : `${other} ${other === 1 ? "change didn't" : "changes didn't"} reach the system`;
  const body =
    sales > 0
      ? `The customer has paid, but the system turned ${sales === 1 ? "this sale" : "these sales"} down. Open the queue to fix it.`
      : "Open the queue to see what went wrong.";
  return (
    <div className="failed-banner" role="alert">
      <span className="failed-banner__icon" aria-hidden>
        ⚠️
      </span>
      <div className="failed-banner__text">
        <strong>{headline}</strong>
        {body}
      </div>
      <Link to="/branch/queue" className="failed-banner__cta">
        Open the queue
      </Link>
    </div>
  );
}
