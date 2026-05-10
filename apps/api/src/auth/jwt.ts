import { SignJWT, jwtVerify, type JWTPayload } from "jose";

const ISSUER = "ms-api";
const AUDIENCE = "ms-admin";
const ACCESS_TTL = "15m";

function getKey(env: "current" | "previous"): Uint8Array | null {
  const raw =
    env === "current"
      ? process.env.JWT_SIGNING_KEY
      : process.env.JWT_SIGNING_KEY_PREVIOUS;
  if (!raw || raw.length < 32) return null;
  return new TextEncoder().encode(raw);
}

export interface AccessPayload extends JWTPayload {
  sub: string;
  role: "owner" | "factory_dispatcher" | "branch_manager" | "branch_staff";
  branch_id: string | null;
  device_id: string;
}

export async function issueAccessToken(
  p: Omit<AccessPayload, "iat" | "exp" | "iss" | "aud">,
): Promise<string> {
  const key = getKey("current");
  if (!key) throw new Error("JWT_SIGNING_KEY missing or too short");
  return new SignJWT(p as JWTPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(ACCESS_TTL)
    .sign(key);
}

export async function verifyAccessToken(token: string): Promise<AccessPayload> {
  const current = getKey("current");
  if (!current) throw new Error("JWT_SIGNING_KEY missing or too short");
  try {
    const { payload } = await jwtVerify(token, current, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    return payload as AccessPayload;
  } catch (errCurrent) {
    const previous = getKey("previous");
    if (!previous) throw errCurrent;
    const { payload } = await jwtVerify(token, previous, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    return payload as AccessPayload;
  }
}
