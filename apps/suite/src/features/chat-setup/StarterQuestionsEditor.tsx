import { CHAT_SETUP_LIMITS } from "@ms/shared";
import { moveItem, shownProblems, type EditorProps } from "./chat-setup-logic.js";

/** Up to four questions people can tap to start a chat (Messenger and Instagram). */
export function StarterQuestionsEditor({ config, onChange, kind, disabled, problems, touched, onTouch }: EditorProps): JSX.Element {
  const list = config.iceBreakers;
  const set = (next: string[]): void => onChange({ ...config, iceBreakers: next });
  const groupProblems = shownProblems(problems, touched, "iceBreakers");
  return (
    <section className="card cs-block">
      <div className="field">
        <span className="field__label">Starter questions</span>
        <span className="field__hint">
          Up to 4 questions people can tap to start a chat. The question is sent to you as their first message.
          {kind === "instagram" && " Shown in the Instagram app on phones, not on computers."}
        </span>
      </div>
      {list.map((q, i) => {
        const field = `iceBreakers.${i}`;
        const msgs = shownProblems(problems, touched, field);
        const over = [...q].length > CHAT_SETUP_LIMITS.iceBreakerMax;
        return (
          <div key={i} className="cs-item">
            <div className="cs-row">
              <input
                className="input"
                aria-label={`Starter question ${i + 1}`}
                value={q}
                disabled={disabled}
                onChange={(e) => set(list.map((x, j) => (j === i ? e.target.value : x)))}
                onBlur={() => {
                  onTouch(field);
                  onTouch("iceBreakers");
                }}
                aria-invalid={msgs.length > 0 || over}
              />
              <span className={over ? "cs-count cs-count--over" : "cs-count"}>
                {[...q].length} / {CHAT_SETUP_LIMITS.iceBreakerMax}
              </span>
            </div>
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
            {msgs.map((m) => (
              <div key={m} className="field__error" role="alert">
                {m}
              </div>
            ))}
          </div>
        );
      })}
      {groupProblems.map((m) => (
        <div key={m} className="field__error" role="alert">
          {m}
        </div>
      ))}
      {list.length < CHAT_SETUP_LIMITS.iceBreakerCount && (
        <div>
          <button type="button" className="btn btn--subtle btn--sm" disabled={disabled} onClick={() => set([...list, ""])}>
            Add a question
          </button>
        </div>
      )}
    </section>
  );
}
