/** "Why?" for an item Meta refused or we did not send (suite spec 08, 7.2): plain reason, Meta's own words, what to do, Try again. */
import { Modal } from "@admin/components/Modal.js";
import type { CatalogueItem } from "./catalogue-api.js";
import { stateLabel, whatToDo } from "./catalogue-logic.js";

export function ItemProblemDialog({
  item,
  busy,
  onRetry,
  onClose,
}: {
  item: CatalogueItem;
  busy: boolean;
  onRetry: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <Modal title={item.title} onClose={onClose} maxWidth={520}>
      <div style={{ display: "grid", gap: 12 }}>
        <div>
          <span className="pill pill--danger">{stateLabel(item.state)}</span>
        </div>
        <p style={{ margin: 0 }}>{item.problem_plain ?? "Meta refused this item."}</p>
        {item.problem_raw && (
          <div className="cat-quote">
            What Meta said: “{item.problem_raw}”
          </div>
        )}
        <p className="cat-fine">{whatToDo(item)}</p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
          <button type="button" className="btn btn--subtle" onClick={onClose} disabled={busy}>
            Close
          </button>
          <button type="button" className="btn btn--primary" onClick={onRetry} disabled={busy}>
            {busy ? "Sending…" : "Try again"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
