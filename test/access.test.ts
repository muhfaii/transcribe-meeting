import { beforeAll, describe, expect, it } from "vitest";
import { verifyAccessJwt, type AccessKey } from "../src/worker/access";

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const OPTS = { aud: "aud-123", issuer: "https://team.cloudflareaccess.com", nowSec: 1_800_000_000 };

let privateKey: CryptoKey;
let keys: AccessKey[];
let otherPrivate: CryptoKey;

async function sign(claims: Record<string, unknown>, opts: { kid?: string; alg?: string; key?: CryptoKey } = {}) {
  const head = enc({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1", typ: "JWT" });
  const body = enc(claims);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.key ?? privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(sig).toString("base64url")}`;
}
const good = { aud: ["aud-123"], iss: OPTS.issuer, exp: OPTS.nowSec + 600, email: "me@example.com" };

beforeAll(async () => {
  const algo = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  const pair = await crypto.subtle.generateKey(algo, true, ["sign", "verify"]);
  privateKey = pair.privateKey;
  keys = [{ ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" }];
  otherPrivate = (await crypto.subtle.generateKey(algo, true, ["sign", "verify"])).privateKey;
});

describe("verifyAccessJwt", () => {
  it("accepts a valid token and returns the email", async () => {
    expect(await verifyAccessJwt(await sign(good), keys, OPTS)).toEqual({ ok: true, email: "me@example.com" });
  });
  it("accepts aud as a plain string", async () => {
    expect((await verifyAccessJwt(await sign({ ...good, aud: "aud-123" }), keys, OPTS)).ok).toBe(true);
  });
  it("rejects the wrong audience, issuer and expired tokens", async () => {
    expect(await verifyAccessJwt(await sign({ ...good, aud: ["x"] }), keys, OPTS)).toMatchObject({ ok: false, reason: "wrong audience" });
    expect(await verifyAccessJwt(await sign({ ...good, iss: "https://evil.example" }), keys, OPTS)).toMatchObject({ reason: "wrong issuer" });
    expect(await verifyAccessJwt(await sign({ ...good, exp: OPTS.nowSec - 1 }), keys, OPTS)).toMatchObject({ reason: "expired" });
    expect(await verifyAccessJwt(await sign({ ...good, exp: undefined }), keys, OPTS)).toMatchObject({ reason: "expired" });
  });
  it("rejects a token signed with another key, a tampered body, and an unknown kid", async () => {
    expect(await verifyAccessJwt(await sign(good, { key: otherPrivate }), keys, OPTS)).toMatchObject({ reason: "bad signature" });
    const [h, , s] = (await sign(good)).split(".");
    expect(await verifyAccessJwt(`${h}.${enc({ ...good, email: "evil@example.com" })}.${s}`, keys, OPTS)).toMatchObject({ reason: "bad signature" });
    expect(await verifyAccessJwt(await sign(good, { kid: "nope" }), keys, OPTS)).toMatchObject({ reason: "unknown key" });
  });
  it("rejects other algorithms and garbage", async () => {
    expect(await verifyAccessJwt(await sign(good, { alg: "none" }), keys, OPTS)).toMatchObject({ reason: "unsupported algorithm" });
    expect(await verifyAccessJwt(await sign(good, { alg: "HS256" }), keys, OPTS)).toMatchObject({ reason: "unsupported algorithm" });
    for (const bad of ["", "a.b", "a.b.c", "....", "x.y.z.w"]) {
      expect((await verifyAccessJwt(bad, keys, OPTS)).ok).toBe(false);
    }
  });
});
