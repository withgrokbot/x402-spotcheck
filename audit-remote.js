// P3 (unreleased): client for a remote audit/authorize service (x402-spotcheck/audit/server).
// Same hook shape as createAudit: beforePayment / onPayment / onAfterPay / onDecision.
// Requests: HMAC-SHA256 per client over method, path, timestamp, nonce and body hash.
// Responses: Ed25519 over RFC 8785 JSON that echoes the request nonce, checked against a PINNED service key.
// Fail closed: down, slow (timeoutMs), non-2xx, bad/missing signature, wrong nonce or stale time => the payment
// is refused ({ abort: true, reason: "audit deny: audit_service_unavailable" | "audit_service_bad_signature" }).
import { createHmac, createHash, createPublicKey, randomBytes, verify as edVerify, sign as edSign, timingSafeEqual } from "node:crypto";
import { canonicalize } from "./receipt.js";

export const PROTOCOL = "x402-audit/1";
export const WINDOW_MS = 30_000;
const sha256hex = (s) => createHash("sha256").update(s).digest("hex");

/** String the client signs (and the server re-builds). */
export function requestSigningInput({ method, path, ts, nonce, body }) {
  return [PROTOCOL, method.toUpperCase(), path, String(ts), nonce, sha256hex(body || "")].join("\n");
}
export function hmac(key, input) { return createHmac("sha256", key).update(input).digest("base64url"); }
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
/** Server side: sign a response envelope. */
export function signEnvelope(privateKey, kid, env) {
  const body = { ...env, kid };
  return { ...body, signature: edSign(null, Buffer.from(canonicalize(body)), privateKey).toString("base64url") };
}
/** Client side: verify a response envelope against a pinned public key (KeyObject, JWK or PEM). */
export function verifyEnvelope(publicKey, env) {
  if (!env || typeof env !== "object" || typeof env.signature !== "string") return false;
  const { signature, ...body } = env;
  try {
    const key = publicKey?.type === "public" ? publicKey : createPublicKey(typeof publicKey === "string" ? publicKey : { key: publicKey, format: "jwk" });
    return edVerify(null, Buffer.from(canonicalize(body)), key, Buffer.from(signature, "base64url"));
  } catch { return false; }
}

export class AuditServiceError extends Error {
  constructor(code, message, cause) { super(message); this.name = "AuditServiceError"; this.code = code; if (cause) this.cause = cause; }
}

/**
 * remoteAudit({ url, clientId, clientKey, servicePublicKey, timeoutMs = 2000, fetch, now, deny })
 * clientKey: the shared HMAC secret for clientId. servicePublicKey: the service's Ed25519 key, pinned (never fetched).
 */
export function remoteAudit(opts = {}) {
  const { url, clientId, clientKey, servicePublicKey } = opts;
  if (!url || !clientId || !clientKey || !servicePublicKey) throw new TypeError("remoteAudit needs url, clientId, clientKey and servicePublicKey");
  const f = opts.fetch || globalThis.fetch;
  const now = opts.now || (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? 2000;
  const base = String(url).replace(/\/+$/, "");
  const bound = new WeakMap();

  async function call(method, path, payload) {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const ts = now(), nonce = randomBytes(16).toString("base64url");
    const sig = hmac(clientKey, requestSigningInput({ method, path, ts, nonce, body }));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let r, env;
    try {
      r = await f(base + path, { method, headers: { "content-type": "application/json", "x-audit-client": clientId, "x-audit-ts": String(ts), "x-audit-nonce": nonce, "x-audit-signature": sig }, body: method === "GET" ? undefined : body, signal: ac.signal });
      env = await r.json();
    } catch (e) {
      throw new AuditServiceError(e?.name === "AbortError" ? "timeout" : "unreachable", "audit service " + (e?.name === "AbortError" ? `timed out after ${timeoutMs} ms` : "unreachable"), e);
    } finally { clearTimeout(timer); }
    if (!verifyEnvelope(servicePublicKey, env)) throw new AuditServiceError("bad_signature", "audit service response signature does not verify");
    if (env.req_nonce !== nonce) throw new AuditServiceError("bad_signature", "audit service response is not for this request (nonce)");
    if (Math.abs(now() - Number(env.ts)) > WINDOW_MS) throw new AuditServiceError("bad_signature", "audit service response is stale");
    if (!r.ok || env.ok !== true) throw new AuditServiceError(env.error || "http_" + r.status, "audit service error: " + (env.error || r.status));
    return env.result;
  }
  const refuse = (e) => {
    const reason = e?.code === "bad_signature" ? "audit_service_bad_signature" : "audit_service_unavailable";
    if (opts.deny === "throw") throw Object.assign(new Error("audit deny: " + reason), { code: "audit_deny", reason, cause: e });
    return { abort: true, reason: "audit deny: " + reason, detail: e?.code || null };
  };
  const strip = (ctx) => ({ paymentRequired: ctx?.paymentRequired, selectedRequirements: ctx?.selectedRequirements || ctx?.paymentRequirements, idempotencyKey: ctx?.idempotencyKey ?? (typeof opts.idempotencyKey === "function" ? opts.idempotencyKey(ctx) : undefined) });

  return {
    async beforePayment(ctx) {
      let res;
      try { res = await call("POST", "/v1/authorize", { ctx: strip(ctx) }); } catch (e) { return refuse(e); }
      if (res?.reservationId && ctx && typeof ctx === "object") { bound.set(ctx, res.reservationId); try { ctx.audit = { reservationId: res.reservationId }; } catch { /* frozen */ } }
      if (res?.allow) return undefined;
      if (opts.deny === "throw") throw Object.assign(new Error("audit deny: " + res?.reason), { code: "audit_deny", reason: res?.reason });
      return { abort: true, reason: "audit deny: " + (res?.reason || "deny") };
    },
    async onPayment(info = {}) { return call("POST", "/v1/payment", { paymentPayload: info.paymentPayload, url: info.url }); },
    async onAfterPay(result, ctx = {}) { return call("POST", "/v1/settle", { result, ctx: { url: ctx.url, paymentPayload: ctx.paymentPayload } }); },
    async onDecision(d, ctx) { return call("POST", "/v1/release", { decision: d, reservationId: (ctx && (bound.get(ctx) || ctx.audit?.reservationId)) || null, url: ctx?.paymentRequired?.resource?.url || d?.url || null }); },
    async chain(range = {}) { return call("GET", `/v1/chain?from=${Number(range.from) || 1}`); },
  };
}
