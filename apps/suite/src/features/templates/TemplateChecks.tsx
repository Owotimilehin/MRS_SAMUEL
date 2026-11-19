/** The "Before you send" panel (suite spec 06, 7.4): what WhatsApp would refuse, in plain words. */
import { CheckCircle2 } from "lucide-react";
import type { DraftProblem } from "@ms/shared";

export const OFTEN_REFUSED = [
  "A blank at the very start or end of the message.",
  "Two blanks side by side.",
  "More blanks than words.",
  "No example for a blank.",
  "Selling words in an order update.",
  "The same wording as another template.",
  "Threats, insults, or anything that looks like a scam.",
  "Asking for card numbers, bank PINs or other private details.",
];

export function TemplateChecks({ problems }: { problems: DraftProblem[] }): JSX.Element {
  return (
    <section className="card tpl-checks" aria-label="Before you send">
      <h2 className="tpl-h">Before you send</h2>
      {problems.length === 0 ? (
        <p className="tpl-ok">
          <CheckCircle2 size={16} aria-hidden="true" /> Nothing here should get it refused.
        </p>
      ) : (
        <ul className="tpl-problems">
          {problems.map((p, i) => (
            <li key={`${p.code}-${p.field}-${i}`} className={p.level === "error" ? "tpl-problem tpl-problem--error" : "tpl-problem tpl-problem--warning"}>
              <span className="tpl-dot" aria-hidden="true" />
              <span>
                <span className="sr-only">{p.level === "error" ? "Problem: " : "Warning: "}</span>
                {p.message}
              </span>
            </li>
          ))}
        </ul>
      )}
      <details className="tpl-often">
        <summary>What WhatsApp refuses most often</summary>
        <ul>
          {OFTEN_REFUSED.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}
