import type { PageSnapshot } from "./page-details-api.js";

/** What can only be changed on Facebook (suite spec 10, section 7). */
export function LockedDetails({ page }: { page: PageSnapshot }): JSX.Element {
  const rows: [string, string | null, string][] = [
    ["Name", page.name, "Facebook reviews name changes. Change it on Facebook."],
    ["Username", page.username ? `@${page.username}` : null, "The @name in your Page's address. Change it on Facebook."],
    ["Category", page.category, "Change it on Facebook."],
    ["Profile picture", page.picture_url ? "Set" : null, "Change it on Facebook."],
    ["Cover photo", page.cover_url ? "Set" : null, "Change it on Facebook."],
  ];
  return (
    <section className="card pd-card">
      <h2 className="pd-h">Changed on Facebook only</h2>
      <dl className="pd-locked">
        {rows.map(([label, value, note]) => (
          <div key={label} className="pd-locked__row">
            <dt>{label}</dt>
            <dd>
              <strong>{value ?? "Not set"}</strong>
              <span className="pd-fine">{note}</span>
            </dd>
          </div>
        ))}
      </dl>
      <p className="pd-fine">
        To change these: open the Page on Facebook, choose <strong>Edit</strong>, and make the change there.
      </p>
      {page.link && (
        <a className="btn btn--subtle" href={page.link} target="_blank" rel="noreferrer">
          Open the Page on Facebook
        </a>
      )}
    </section>
  );
}
