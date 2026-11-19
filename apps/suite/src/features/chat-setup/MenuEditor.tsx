import { CHAT_SETUP_LIMITS, type ChatSetupMenuItem } from "@ms/shared";
import { moveItem, shownProblems, type EditorProps } from "./chat-setup-logic.js";

/** Up to five buttons that stay beside the message box (Messenger and Instagram). */
export function MenuEditor({ config, onChange, kind, disabled, problems, touched, onTouch }: EditorProps): JSX.Element {
  const list = config.menu;
  const set = (next: ChatSetupMenuItem[]): void => onChange({ ...config, menu: next });
  const patch = (i: number, p: Partial<ChatSetupMenuItem>): void => set(list.map((m, j) => (j === i ? { ...m, ...p } : m)));
  const groupProblems = shownProblems(problems, touched, "menu");
  return (
    <section className="card cs-block">
      <div className="field">
        <span className="field__label">Menu</span>
        <span className="field__hint">
          Buttons that are always available beside the message box. Up to 5.{" "}
          {kind === "messenger"
            ? "Changes can take up to a day to reach everyone."
            : "People see changes after they refresh their messages."}
        </span>
      </div>
      {list.map((m, i) => {
        const titleField = `menu.${i}.title`;
        const urlField = `menu.${i}.url`;
        const titleMsgs = shownProblems(problems, touched, titleField);
        const urlMsgs = shownProblems(problems, touched, urlField);
        const over = [...m.title].length > CHAT_SETUP_LIMITS.menuTitleMax;
        return (
          <div key={i} className="cs-item">
            <div className="cs-row">
              <input
                className="input"
                aria-label={`Menu button ${i + 1} name`}
                placeholder="Name"
                value={m.title}
                disabled={disabled}
                onChange={(e) => patch(i, { title: e.target.value })}
                onBlur={() => {
                  onTouch(titleField);
                  onTouch("menu");
                }}
                aria-invalid={titleMsgs.length > 0 || over}
              />
              <span className={over ? "cs-count cs-count--over" : "cs-count"}>
                {[...m.title].length} / {CHAT_SETUP_LIMITS.menuTitleMax}
              </span>
            </div>
            <select
              className="select"
              aria-label={`Menu button ${i + 1} does`}
              value={m.type}
              disabled={disabled}
              onChange={(e) => {
                const type = e.target.value === "web_url" ? "web_url" : "postback";
                set(list.map((x, j) => (j === i ? (type === "web_url" ? { type, title: x.title, url: x.url ?? "" } : { type, title: x.title }) : x)));
              }}
            >
              <option value="postback">Sends a message to you</option>
              <option value="web_url">Opens a web page</option>
            </select>
            {m.type === "web_url" && (
              <input
                className="input"
                aria-label={`Menu button ${i + 1} link`}
                placeholder="https://www.mrssamuel.com"
                inputMode="url"
                value={m.url ?? ""}
                disabled={disabled}
                onChange={(e) => patch(i, { url: e.target.value })}
                onBlur={() => {
                  onTouch(urlField);
                  onTouch("menu");
                }}
                aria-invalid={urlMsgs.length > 0}
              />
            )}
            <div className="cs-row cs-row--actions">
              <button type="button" className="btn btn--subtle btn--sm" disabled={disabled || i === 0} onClick={() => set(moveItem(list, i, -1))}>
                Up
              </button>
              <button
                type="button"
                className="btn btn--subtle btn--sm"
                disabled={disabled || i === list.length - 1}
                onClick={() => set(moveItem(list, i, 1))}
              >
                Down
              </button>
              <button type="button" className="btn btn--subtle btn--sm" disabled={disabled} onClick={() => set(list.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
            {[...titleMsgs, ...urlMsgs].map((msg) => (
              <div key={msg} className="field__error" role="alert">
                {msg}
              </div>
            ))}
          </div>
        );
      })}
      {groupProblems.map((msg) => (
        <div key={msg} className="field__error" role="alert">
          {msg}
        </div>
      ))}
      {list.length < CHAT_SETUP_LIMITS.menuCount && (
        <div>
          <button
            type="button"
            className="btn btn--subtle btn--sm"
            disabled={disabled}
            onClick={() => set([...list, { type: "postback", title: "" }])}
          >
            Add a button
          </button>
        </div>
      )}
    </section>
  );
}
