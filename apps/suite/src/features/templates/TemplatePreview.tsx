/**
 * A WhatsApp-style preview of a template (suite spec 06, 7.4): the heading, the message with the
 * examples filled in, the small print, a time and the buttons. A blank that has no example yet is
 * highlighted in amber. It is only a picture: WhatsApp may draw the real one slightly differently.
 */
import { ClipboardList, CornerUpLeft, ExternalLink, FileText, Image as ImageIcon, List, Phone, Video } from "lucide-react";
import { draftPreview, type TemplateDraft } from "@ms/shared";

function Filled({ text }: { text: string }): JSX.Element {
  return (
    <>
      {text.split(/(\{\{\d+\}\})/).map((part, i) =>
        /^\{\{\d+\}\}$/.test(part) ? (
          <mark key={i} className="tpl-blank">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

const MEDIA_LABEL = { image: "Picture", video: "Video", document: "PDF" } as const;

export function TemplatePreview({
  draft,
  sampleUrl,
  sampleName,
}: {
  draft: TemplateDraft;
  /** A link to the picture sample, when there is one. */
  sampleUrl?: string | null;
  sampleName?: string | null;
}): JSX.Element {
  const p = draftPreview(draft);
  const kinds = draft.buttons.map((b) => b.type);
  // More than three buttons: two show and the rest sit behind "See all options".
  const shown = p.buttons.length > 3 ? 2 : p.buttons.length;
  const time = new Date().toLocaleTimeString("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit" });
  const MediaIcon = p.headerMedia === "video" ? Video : p.headerMedia === "document" ? FileText : ImageIcon;

  return (
    <figure className="tpl-phone" aria-label="Preview of the message">
      <div className="tpl-phone__chat">
        <div className="tpl-bubble">
          {p.headerMedia && (
            <div className="tpl-media">
              {p.headerMedia === "image" && sampleUrl ? (
                <img src={sampleUrl} alt="The sample picture" />
              ) : (
                <>
                  <MediaIcon size={22} aria-hidden="true" />
                  <span>{sampleName ? sampleName : MEDIA_LABEL[p.headerMedia]}</span>
                </>
              )}
            </div>
          )}
          {p.header && (
            <div className="tpl-bubble__head">
              <Filled text={p.header} />
            </div>
          )}
          <div className="tpl-bubble__body">
            {p.body.trim() === "" ? <span className="tpl-bubble__empty">Your message shows here.</span> : <Filled text={p.body} />}
          </div>
          {p.footer && <div className="tpl-bubble__foot">{p.footer}</div>}
          <div className="tpl-bubble__time">{time}</div>
        </div>
        {p.buttons.slice(0, shown).map((label, i) => {
          const kind = kinds[i];
          const Icon = kind === "URL" ? ExternalLink : kind === "PHONE_NUMBER" ? Phone : kind === "FLOW" ? ClipboardList : CornerUpLeft;
          return (
            <div key={i} className="tpl-btn-row">
              <Icon size={14} aria-hidden="true" />
              <span>{label || "Button"}</span>
            </div>
          );
        })}
        {p.buttons.length > 3 && (
          <div className="tpl-btn-row">
            <List size={14} aria-hidden="true" />
            <span>See all options</span>
          </div>
        )}
      </div>
      <figcaption>A preview. WhatsApp may draw it slightly differently.</figcaption>
    </figure>
  );
}
