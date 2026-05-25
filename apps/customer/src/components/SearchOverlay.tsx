import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { MENU, bottleFor, type MenuItem } from "../data/menu.js";

export function SearchOverlay({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  const results = useMemo<MenuItem[]>(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    return MENU.filter(
      (m) =>
        m.name.toLowerCase().includes(term) ||
        m.ingredients.some((i) => i.toLowerCase().includes(term)),
    ).slice(0, 8);
  }, [q]);

  if (!open) return null;

  return (
    <div
      className="ms-search__backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Search"
    >
      <div className="ms-search__panel" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="ms-search__input"
          placeholder="Search juices and ingredients…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {q.trim() && (
          <ul className="ms-search__results">
            {results.length === 0 && (
              <li className="ms-search__empty">No matches for "{q.trim()}".</li>
            )}
            {results.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  className="ms-search__result"
                  onClick={() => {
                    onClose();
                    void nav({
                      to: "/shop/$productId",
                      params: { productId: String(m.id) },
                    });
                  }}
                >
                  <img src={bottleFor(m)} alt="" />
                  <div>
                    <div className="ms-search__result-name">{m.name}</div>
                    <div className="ms-search__result-ings">
                      {m.ingredients.join(" · ")}
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
