import { CHAT_SETUP_LIMITS } from "@ms/shared";
import { shownProblems, type EditorProps } from "./chat-setup-logic.js";

/** Welcome text and the Get started button (Messenger only). */
export function GreetingEditor({ config, onChange, disabled, problems, touched, onTouch }: EditorProps): JSX.Element {
  const text = config.greeting ?? "";
  const hasMenu = config.menu.length > 0;
  const greetingProblems = shownProblems(problems, touched, "greeting");
  const over = [...text].length > CHAT_SETUP_LIMITS.greetingMax;
  return (
    <>
      <section className="card cs-block">
        <label className="field" htmlFor="cs-greeting">
          <span className="field__label">Welcome text</span>
          <span className="field__hint">Shown before someone sends their first message.</span>
        </label>
        <textarea
          id="cs-greeting"
          className="textarea cs-greeting"
          rows={3}
          value={text}
          disabled={disabled}
          onChange={(e) => onChange({ ...config, greeting: e.target.value === "" ? null : e.target.value })}
          onBlur={() => onTouch("greeting")}
          aria-invalid={greetingProblems.length > 0 || over}
        />
        <div className="cs-row cs-row--between">
          <button
            type="button"
            className="btn btn--subtle btn--sm"
            disabled={disabled}
            onClick={() => onChange({ ...config, greeting: `${text}{{user_first_name}}` })}
          >
            Insert first name
          </button>
          <span className={over ? "cs-count cs-count--over" : "cs-count"}>
            {[...text].length} / {CHAT_SETUP_LIMITS.greetingMax}
          </span>
        </div>
        {greetingProblems.map((m) => (
          <div key={m} className="field__error" role="alert">
            {m}
          </div>
        ))}
      </section>

      <section className="card cs-block">
        <label className="cs-switch">
          <input
            type="checkbox"
            checked={config.getStarted || hasMenu}
            disabled={disabled || hasMenu}
            onChange={(e) => onChange({ ...config, getStarted: e.target.checked })}
          />
          <span>Show a Get started button</span>
        </label>
        <span className="field__hint">
          People tap it to start the chat. You will see &ldquo;Get started&rdquo; arrive in the Inbox.
        </span>
        {hasMenu && <div className="cs-note">Needed while the menu is on.</div>}
        {config.iceBreakers.length > 0 && (
          <div className="cs-note">Starter questions are shown instead of the Get started button.</div>
        )}
      </section>
    </>
  );
}
