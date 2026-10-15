// x402-spotcheck 1.1.0: offline verification of signed 402xAgent receipts.
// A signed receipt carries `kid` and `signature` (base64url ed25519, 64 bytes). The signed bytes are the RFC 8785 (JCS)
// canonical JSON of the receipt with only the `signature` field removed (so `kid` is covered). Public keys are published at
// https://api.402xagent.com/.well-known/402xagent-keys.json as { keys: [{ kty: "OKP", crv: "Ed25519", kid, x }] }.
export const RECEIPT_KEYS_URL = "https://api.402xagent.com/.well-known/402xagent-keys.json";

/** RFC 8785 JSON Canonicalization Scheme. ES number serialisation already matches RFC 8785 for finite numbers. */
export function canonicalize(v) {
  if (v === null || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new TypeError("JCS: non-finite number"); return JSON.stringify(v); }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map((x) => (x === undefined || typeof x === "function" ? "null" : canonicalize(x))).join(",") + "]";
  if (typeof v === "object") {
    if (typeof v.toJSON === "function") return canonicalize(v.toJSON());
    const keys = Object.keys(v).filter((k) => v[k] !== undefined && typeof v[k] !== "function").sort(); // UTF-16 code-unit order
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(v[k])).join(",") + "}";
  }
  throw new TypeError("JCS: unsupported type " + typeof v);
}
/** The exact bytes that are signed: JCS of the receipt minus `signature`. */
export function receiptSigningInput(receipt) {
  const { signature, ...rest } = receipt || {};
  return new TextEncoder().encode(canonicalize(rest));
}
const b64uToBytes = (s) => {
  const t = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
async function subtle() {
  return globalThis.crypto && globalThis.crypto.subtle ? globalThis.crypto.subtle : (await import("node:crypto")).webcrypto.subtle;
}
function pickKey(keys, kid) {
  const list = Array.isArray(keys) ? keys : keys && Array.isArray(keys.keys) ? keys.keys : keys ? [keys] : [];
  return list.find((k) => k && k.kty === "OKP" && k.crv === "Ed25519" && typeof k.x === "string" && (kid == null || k.kid === kid)) || null;
}

/**
 * Verify a signed 402xAgent receipt. Never throws for a bad receipt; returns { valid, kid, reason }.
 * opts.publicKey: a JWK ({kty:"OKP",crv:"Ed25519",x,kid?}), a JWKS-like { keys: [...] }, or a base64url raw 32-byte key.
 * Without publicKey, the key set is fetched from opts.keysUrl (default RECEIPT_KEYS_URL) with opts.fetch (default global fetch)
 * and matched by `kid`.
 */
export async function verifyReceipt(receipt, opts = {}) {
  const kid = receipt && typeof receipt.kid === "string" ? receipt.kid : null;
  const sig = receipt && typeof receipt.signature === "string" ? receipt.signature : null;
  if (!receipt || typeof receipt !== "object") return { valid: false, kid, reason: "not a receipt object" };
  if (!sig) return { valid: false, kid, reason: "unsigned receipt (no signature field)" };
  try {
    let jwk;
    if (typeof opts.publicKey === "string") jwk = { kty: "OKP", crv: "Ed25519", x: opts.publicKey };
    else if (opts.publicKey) {
      jwk = pickKey(opts.publicKey, kid);
      if (!jwk && !Array.isArray(opts.publicKey) && !opts.publicKey.keys) jwk = pickKey(opts.publicKey, null); // single JWK without kid
    } else {
      const f = opts.fetch || globalThis.fetch;
      const r = await f(opts.keysUrl || RECEIPT_KEYS_URL, { headers: { accept: "application/json" } });
      if (!r.ok) return { valid: false, kid, reason: `key fetch failed (${r.status})` };
      jwk = pickKey(await r.json(), kid);
    }
    if (!jwk) return { valid: false, kid, reason: kid ? `no Ed25519 key with kid ${kid}` : "no Ed25519 key" };
    const raw = b64uToBytes(jwk.x), s = b64uToBytes(sig);
    if (raw.length !== 32) return { valid: false, kid, reason: "public key is not 32 bytes" };
    if (s.length !== 64) return { valid: false, kid, reason: "signature is not 64 bytes" };
    const c = await subtle();
    const key = await c.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    const ok = await c.verify({ name: "Ed25519" }, key, s, receiptSigningInput(receipt));
    return ok ? { valid: true, kid, reason: "signature valid" } : { valid: false, kid, reason: "signature does not match" };
  } catch (e) {
    return { valid: false, kid, reason: "verify error: " + (e && e.message ? e.message : String(e)) };
  }
}
