/**
 * A close likeness of how one network will show the post (suite spec 09, 7.3), with
 * that network's problems listed under it: blocking ones in red, warnings in amber.
 */
import { Facebook, Instagram, Play } from "lucide-react";
import { networkName, type PostProblem, type SocialNetwork, type SocialPostKind } from "@ms/shared";
import { captionRuns } from "./posts-logic.js";

export interface PreviewMedia {
  /** A link the browser can show (a local object URL, or the server's preview link); null when there is none. */
  src: string | null;
  mime: string;
  width: number;
  height: number;
}

export function NetworkIcon({ network, size = 16 }: { network: SocialNetwork; size?: number }): JSX.Element {
  return network === "facebook" ? <Facebook size={size} aria-hidden="true" /> : <Instagram size={size} aria-hidden="true" />;
}

function Frame({ m, ratio }: { m: PreviewMedia; ratio?: string }): JSX.Element {
  const style = ratio ? { aspectRatio: ratio } : undefined;
  if (!m.src) {
    return (
      <div className="po-preview__missing" style={style}>
        The preview of this file is not available right now.
      </div>
    );
  }
  if (m.mime.startsWith("video/")) {
    return (
      <div className="po-preview__frame" style={style}>
        <video src={m.src} preload="metadata" muted playsInline />
        <div className="po-preview__play">
          <span>
            <Play size={24} aria-hidden="true" />
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="po-preview__frame" style={style}>
      <img src={m.src} alt="" />
    </div>
  );
}

export function ProblemList({ problems }: { problems: PostProblem[] }): JSX.Element | null {
  if (problems.length === 0) return null;
  return (
    <ul className="po-problems">
      {problems.map((p, i) => (
        <li key={`${p.code}-${i}`} className={`po-problem ${p.blocking ? "po-problem--block" : "po-problem--warn"}`}>
          <span aria-hidden="true">{p.blocking ? "✕" : "!"}</span>
          <span>{p.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function PostPreview({
  network,
  label,
  kind,
  caption,
  linkUrl,
  media,
  problems,
}: {
  network: SocialNetwork;
  label: string;
  kind: SocialPostKind;
  /** The text this network gets (already the override, if one is set). */
  caption: string;
  linkUrl: string | null;
  media: PreviewMedia[];
  problems: PostProblem[];
}): JSX.Element {
  const first = media[0];
  // Instagram crops every picture of an album to the first picture's shape.
  const igRatio = first && first.width > 0 && first.height > 0 ? `${first.width} / ${first.height}` : "1 / 1";
  return (
    <div className="po-block">
      <div className="po-preview">
        <div className="po-preview__head">
          <NetworkIcon network={network} />
          <span>
            On {networkName(network)} · {label}
          </span>
        </div>
        {network === "facebook" && caption !== "" && (
          <div className="po-preview__text">
            {captionRuns(caption).map((r, i) =>
              r.tag ? (
                <span key={i} className="po-preview__tag">
                  {r.text}
                </span>
              ) : (
                <span key={i}>{r.text}</span>
              ),
            )}
          </div>
        )}
        {media.length > 0 &&
          (network === "instagram" ? (
            <>
              <Frame m={first!} ratio={kind === "story" || kind === "video" ? "9 / 16" : igRatio} />
              {media.length > 1 && (
                <div className="po-preview__dots" aria-label={`${media.length} pictures`}>
                  {media.map((_, i) => (
                    <span key={i} />
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className={`po-preview__grid${media.length === 1 ? " po-preview__grid--one" : ""}`}>
              {media.slice(0, 4).map((m, i) => (
                <Frame key={i} m={m} {...(media.length > 1 ? { ratio: "1 / 1" } : {})} />
              ))}
            </div>
          ))}
        {network === "facebook" && media.length > 4 && <div className="po-preview__text">+{media.length - 4} more</div>}
        {kind === "link" && network === "facebook" && (
          <div className="po-preview__link">
            <strong>{linkUrl || "No web address yet"}</strong>
            <span>Facebook adds the link's own picture and title when it posts.</span>
          </div>
        )}
        {network === "instagram" && caption !== "" && (
          <div className="po-preview__text" style={{ paddingTop: 10 }}>
            {captionRuns(caption).map((r, i) =>
              r.tag ? (
                <span key={i} className="po-preview__tag">
                  {r.text}
                </span>
              ) : (
                <span key={i}>{r.text}</span>
              ),
            )}
          </div>
        )}
        {media.length === 0 && caption === "" && kind !== "link" && <div className="po-preview__missing">Nothing to show yet.</div>}
      </div>
      <p className="po-fine">This is a close likeness. The apps may crop or wrap slightly differently.</p>
      <ProblemList problems={problems} />
    </div>
  );
}
