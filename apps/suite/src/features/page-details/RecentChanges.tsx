import { useQuery } from "@tanstack/react-query";
import { PAGE_EDITABLE_KEYS, type PageEditable, type PageEditableKey } from "@ms/shared";
import { pageDetailsApi, pageDetailsKeys } from "./page-details-api.js";
import { NOT_SET, addressText, hoursText, labelsOf, lagosDateTime, resultChip } from "./page-details-logic.js";

function show(key: PageEditableKey, v: Partial<PageEditable>): string {
  const x = v[key];
  if (x === undefined || x === null || x === "") return NOT_SET;
  if (key === "emails") return (x as string[]).length === 0 ? NOT_SET : (x as string[]).join(", ");
  if (key === "hours") return hoursText(x as never, false).join("\n");
  if (key === "address") return addressText(x as never);
  if (key === "always_open") return x === true ? "Always open" : "Not always open";
  return String(x);
}

/** Who changed what, and when, from the audit log (suite spec 10, section 7). */
export function RecentChanges({ accountId }: { accountId: string }): JSX.Element {
  const q = useQuery({ queryKey: pageDetailsKeys.history(accountId), queryFn: () => pageDetailsApi.history(accountId), refetchOnWindowFocus: false });
  return (
    <details className="card pd-card">
      <summary className="pd-h" style={{ cursor: "pointer" }}>Recent changes</summary>
      {q.isLoading && <p className="pd-fine">Loading…</p>}
      {q.error && <p className="pd-fine">We could not load the history.</p>}
      {q.data && q.data.length === 0 && <p className="pd-fine">No changes made from the suite yet.</p>}
      <ul className="pd-history">
        {(q.data ?? []).map((row, i) => (
          <li key={i}>
            <details>
              <summary>
                {lagosDateTime(row.at)} · {row.by_name ?? "Someone"} · changed {labelsOf(row.fields).join(", ")}{" "}
                <span className={`pd-chip pd-chip--${row.result}`}>{resultChip(row.result)}</span>
              </summary>
              <table className="table pd-diff">
                <tbody>
                  {PAGE_EDITABLE_KEYS.filter((k) => row.fields.includes(k)).map((k) => (
                    <tr key={k}>
                      <th scope="row">{labelsOf([k])[0]}</th>
                      <td data-label="Before" style={{ whiteSpace: "pre-line" }}>{show(k, row.before)}</td>
                      <td data-label="After" style={{ whiteSpace: "pre-line" }}>{show(k, row.after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </li>
        ))}
      </ul>
    </details>
  );
}
