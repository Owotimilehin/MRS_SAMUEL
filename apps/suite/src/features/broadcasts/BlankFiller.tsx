/** Fill the blanks (suite spec 14, 7.9 section 4): each {{n}} from the customer's name or the same words for everyone. */
import type { BlankSource, BroadcastBlanks, TemplateNeeds } from "@ms/shared";

type Choice = "first_name" | "full_name" | "fixed";

function SourceRow({ tag, src, onChange, nameAllowed = true }: { tag: string; src: BlankSource; onChange: (s: BlankSource) => void; nameAllowed?: boolean }): JSX.Element {
  const choice: Choice = src.from;
  const pick = (c: Choice) => onChange(c === "fixed" ? { from: "fixed", text: src.from === "fixed" ? src.text : "" } : { from: c, fallback: src.from === "fixed" ? "there" : src.fallback });
  return (
    <div className="bc-blank">
      <span className="bc-blank__tag">{tag}</span>
      <select className="select" value={choice} onChange={(e) => pick(e.target.value as Choice)} aria-label={`What goes in ${tag}`}>
        {nameAllowed && <option value="first_name">The customer's first name</option>}
        {nameAllowed && <option value="full_name">The customer's full name</option>}
        <option value="fixed">The same words for everyone</option>
      </select>
      {src.from === "fixed" ? (
        <input className="input" value={src.text} maxLength={60} placeholder="Type the words" aria-label={`Words for ${tag}`} onChange={(e) => onChange({ from: "fixed", text: e.target.value })} />
      ) : (
        <label className="bc-field" style={{ gap: 2 }}>
          <small>If we don't know their name, say:</small>
          <input className="input" value={src.fallback} maxLength={60} aria-label={`If we don't know their name, ${tag}`} onChange={(e) => onChange({ from: src.from, fallback: e.target.value })} />
        </label>
      )}
    </div>
  );
}

export function BlankFiller({
  needs,
  blanks,
  onChange,
  noName,
  picture,
}: {
  needs: TemplateNeeds;
  blanks: BroadcastBlanks;
  onChange: (b: BroadcastBlanks) => void;
  /** How many people who will get it have no usable name. */
  noName: number | null;
  picture: { has: boolean; busy: boolean; onChoose: (f: File) => void } | null;
}): JSX.Element {
  const body = Array.from({ length: needs.bodyParams }, (_, i): BlankSource => blanks.body[i] ?? { from: "fixed", text: "" });
  const setBody = (i: number, s: BlankSource) => onChange({ ...blanks, body: body.map((b, j) => (j === i ? s : b)) });
  const fallback = body.find((b) => b.from !== "fixed");
  const nothing = needs.bodyParams === 0 && needs.headerParams === 0 && needs.urlButtons.length === 0 && !needs.headerMedia;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {nothing && <p className="bc-soft">This message has no blanks to fill.</p>}
      {body.map((src, i) => (
        <SourceRow key={i} tag={`{{${i + 1}}}`} src={src} onChange={(s) => setBody(i, s)} />
      ))}
      {!needs.headerMedia && needs.headerParams > 0 && (
        <SourceRow tag="Heading" src={blanks.header ?? { from: "fixed", text: "" }} onChange={(s) => onChange({ ...blanks, header: s })} />
      )}
      {needs.urlButtons.map((u) => {
        const text = blanks.buttons?.find((b) => b.index === u.index)?.text ?? "";
        return (
          <div className="bc-blank" key={u.index}>
            <span className="bc-blank__tag">Link</span>
            <span className="bc-soft">End of the link for “{u.text}” (the same for everyone)</span>
            <input
              className="input"
              value={text}
              maxLength={60}
              aria-label={`End of the link for ${u.text}`}
              onChange={(e) => onChange({ ...blanks, buttons: [...(blanks.buttons ?? []).filter((b) => b.index !== u.index), { index: u.index, text: e.target.value }] })}
            />
          </div>
        );
      })}
      {picture && (
        <div className="bc-field">
          <span>Picture heading</span>
          <small>JPG or PNG, up to 5 MB.</small>
          <div className="bc-row">
            <label className="btn">
              {picture.busy ? "Uploading…" : picture.has ? "Choose another picture" : "Choose picture"}
              <input
                type="file"
                accept="image/jpeg,image/png"
                hidden
                disabled={picture.busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) picture.onChoose(f);
                  e.target.value = "";
                }}
              />
            </label>
            {picture.has && <span className="pill pill--success">Picture added</span>}
          </div>
        </div>
      )}
      {fallback && "fallback" in fallback && noName !== null && noName > 0 && (
        <p className="bc-soft">
          {noName} {noName === 1 ? "person" : "people"} on this list {noName === 1 ? "has" : "have"} no name and will get “{fallback.fallback.trim() || "…"}”.
        </p>
      )}
    </div>
  );
}
