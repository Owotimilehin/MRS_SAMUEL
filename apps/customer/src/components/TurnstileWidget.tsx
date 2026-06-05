import { useEffect, useRef } from "react";

/**
 * Cloudflare Turnstile checkout widget. Renders nothing (and requires nothing)
 * unless `VITE_TURNSTILE_SITEKEY` is baked into the build — so dev and
 * unconfigured builds keep working. On solve it hands the token up via onToken;
 * on error/expiry it clears it.
 */
export const TURNSTILE_SITEKEY = import.meta.env.VITE_TURNSTILE_SITEKEY as string | undefined;
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  remove: (id: string) => void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export function TurnstileWidget({
  onToken,
}: {
  onToken: (t: string | null) => void;
}): JSX.Element | null {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  // Hold the latest callback in a ref so the effect can stay mount-only.
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    if (!TURNSTILE_SITEKEY) return;
    let cancelled = false;
    let poll: number | undefined;

    const render = (): void => {
      if (cancelled || widgetIdRef.current || !window.turnstile || !containerRef.current) return;
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: TURNSTILE_SITEKEY,
        callback: (t: string) => onTokenRef.current(t),
        "error-callback": () => onTokenRef.current(null),
        "expired-callback": () => onTokenRef.current(null),
      });
    };

    if (window.turnstile) {
      render();
    } else {
      if (!document.querySelector(`script[src="${SCRIPT_SRC}"]`)) {
        const s = document.createElement("script");
        s.src = SCRIPT_SRC;
        s.async = true;
        s.defer = true;
        document.head.appendChild(s);
      }
      poll = window.setInterval(() => {
        if (window.turnstile) {
          window.clearInterval(poll);
          render();
        }
      }, 200);
    }

    return () => {
      cancelled = true;
      if (poll) window.clearInterval(poll);
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, []);

  if (!TURNSTILE_SITEKEY) return null;
  return <div ref={containerRef} style={{ marginTop: 12 }} />;
}
