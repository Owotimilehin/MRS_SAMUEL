const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Verify a Cloudflare Turnstile token.
 *
 * Fail-open by design — bot protection must never block a paying customer:
 *  - no `secret` configured (dev/test)        → pass (feature off)
 *  - Cloudflare unreachable / non-2xx / throws → pass (infra outage)
 * The ONLY way this returns false is a definitive negative: a secret is set but
 * the client sent no token, or Cloudflare actively rejects the token.
 *
 * Kept as a pure function (secret passed in) so it unit-tests without the env.
 */
export async function verifyTurnstileToken(
  secret: string | undefined,
  token: string | undefined,
  remoteIp?: string,
): Promise<boolean> {
  if (!secret) return true;
  if (!token) return false;
  try {
    const form = new URLSearchParams();
    form.set("secret", secret);
    form.set("response", token);
    if (remoteIp) form.set("remoteip", remoteIp);
    const res = await fetch(SITEVERIFY, { method: "POST", body: form });
    if (!res.ok) return true;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return true;
  }
}
