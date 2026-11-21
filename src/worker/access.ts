// Defence in depth for Cloudflare Access: verify the signed JWT Access adds to every request,
// so the API stays closed even if it is reached through a hostname Access does not cover
// (for example *.workers.dev). Pure verification + a small cached key fetch.
import type { Env } from "./env";

export interface AccessKey extends JsonWebKey {
  kid: string;
}

export type AccessResult = { ok: true; email?: string } | { ok: false; reason: string };

const b64urlToBytes = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

const decodeJson = (part: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export async function verifyAccessJwt(
  token: string,
  keys: AccessKey[],
  opts: { aud: string; issuer: string; nowSec: number },
): Promise<AccessResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };
  const header = decodeJson(parts[0]);
  const claims = decodeJson(parts[1]);
  if (!header || !claims) return { ok: false, reason: "malformed token" };
  if (header.alg !== "RS256") return { ok: false, reason: "unsupported algorithm" };

  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: "unknown key" };

  let valid = false;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    return { ok: false, reason: "bad key" };
  }
  if (!valid) return { ok: false, reason: "bad signature" };

  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.aud)) return { ok: false, reason: "wrong audience" };
  if (claims.iss !== opts.issuer) return { ok: false, reason: "wrong issuer" };
  if (typeof claims.exp !== "number" || claims.exp <= opts.nowSec) return { ok: false, reason: "expired" };
  if (typeof claims.nbf === "number" && claims.nbf > opts.nowSec + 60) return { ok: false, reason: "not yet valid" };
  return { ok: true, email: typeof claims.email === "string" ? claims.email : undefined };
}

// ---- key cache (per isolate); refetched when a token names an unknown key ----
let cache: { team: string; keys: AccessKey[]; at: number } | null = null;
const CACHE_MS = 60 * 60 * 1000;

async function loadKeys(team: string, force: boolean): Promise<AccessKey[]> {
  if (!force && cache && cache.team === team && Date.now() - cache.at < CACHE_MS) return cache.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Could not load Access keys (${res.status}).`);
  const { keys } = (await res.json()) as { keys?: AccessKey[] };
  cache = { team, keys: keys ?? [], at: Date.now() };
  return cache.keys;
}

export type AccessCheck =
  | { enforce: false }
  | { enforce: true; ok: true; email?: string }
  | { enforce: true; ok: false; status: 401 | 503; message: string };

/**
 * REQUIRE_ACCESS=1 (the production default in wrangler.jsonc) is fail-closed: without
 * ACCESS_TEAM_DOMAIN + ACCESS_AUD every API call is refused instead of silently open.
 * Local dev runs with REQUIRE_ACCESS=0.
 */
export async function checkAccess(env: Env, request: Request): Promise<AccessCheck> {
  if (env.REQUIRE_ACCESS === "0") return { enforce: false };
  const team = (env.ACCESS_TEAM_DOMAIN ?? "").trim();
  const aud = (env.ACCESS_AUD ?? "").trim();
  if (!team || !aud) {
    return { enforce: true, ok: false, status: 503, message: "Access is required but not configured (ACCESS_TEAM_DOMAIN / ACCESS_AUD)." };
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return { enforce: true, ok: false, status: 401, message: "Sign in through Cloudflare Access." };

  const opts = { aud, issuer: `https://${team}`, nowSec: Math.floor(Date.now() / 1000) };
  try {
    let result = await verifyAccessJwt(token, await loadKeys(team, false), opts);
    if (!result.ok && result.reason === "unknown key") result = await verifyAccessJwt(token, await loadKeys(team, true), opts);
    return result.ok
      ? { enforce: true, ok: true, email: result.email }
      : { enforce: true, ok: false, status: 401, message: `Access denied (${result.reason}).` };
  } catch {
    // Fail closed, and keep runtime error details out of the response.
    return { enforce: true, ok: false, status: 503, message: "Could not verify the Access login (the key lookup failed). Check ACCESS_TEAM_DOMAIN." };
  }
}
