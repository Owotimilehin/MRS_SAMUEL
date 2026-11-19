/** The list of templates (suite spec 06, 7.1): one card per template, with its state and notes. */
import { Link } from "@tanstack/react-router";
import { humanTemplateName, languageName } from "@admin/lib/inbox-logic.js";
import { bodySnippet, rowNotes, statusOf, templateCategoryLabel, templateQualityWording, TONE_PILL } from "./template-labels.js";
import type { TemplateRow } from "./templates-api.js";

export function TemplateList({ rows }: { rows: TemplateRow[] }): JSX.Element {
  return (
    <ul className="tpl-list">
      {rows.map((t) => {
        const status = statusOf(t);
        const quality = t.status === "APPROVED" ? templateQualityWording(t.quality_score) : null;
        const notes = rowNotes(t);
        return (
          <li key={t.id}>
            <Link to="/templates/$templateId" params={{ templateId: t.id }} className="card card--hoverable tpl-card">
              <div className="tpl-card__top">
                <div>
                  <div className="tpl-card__name">{humanTemplateName(t.name)}</div>
                  <div className="tpl-card__raw">{t.name}</div>
                </div>
                <div className="tpl-card__pills">
                  <span className="pill">{languageName(t.language)}</span>
                  <span className="pill pill--accent">{templateCategoryLabel(t.category)}</span>
                  <span className={TONE_PILL[status.tone]}>{status.label}</span>
                </div>
              </div>
              {status.line && <div className="tpl-card__line">{status.line}</div>}
              {quality && <div className={`tpl-card__quality tpl-tone--${quality.tone}`}>{quality.label}</div>}
              <div className="tpl-card__body">{bodySnippet(t) || <em>No message yet</em>}</div>
              {notes.length > 0 && (
                <div className="tpl-card__notes">
                  {notes.map((n) => (
                    <span key={n.text} className={`tpl-note tpl-note--${n.tone}`}>
                      {n.text}
                    </span>
                  ))}
                </div>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
