// 1.2.0: opt-in after-payment check. After your client sent a payment and the paid call timed out, failed (5xx), or
// came back 402 again, ask 402xAgent's payment-status endpoint whether the payment landed and whether it is safe to
// sign a new one. Off unless you pass `afterPay`. Fail-open: any error here leaves your call exactly as 1.1.0 would
// (the original response or error), with the outcome attached as `.afterPay`.
import { verifyReceipt } from "./receipt.js";

export const PAYMENT_STATUS_URL = "https://api.402xagent.com/v1/products/payment-status";
export const AFTER_PAY_TIMEOUT_MS = 4000;
const UNKNOWN = (error) => ({ status: "unknown", safe_to_retry_same_payload: true, safe_to_resign: false, error, why: "could not reach 402xAgent payment status; do not sign a new payment until you know (retrying the SAME payment is safe: an EIP-3009 nonce is single-use)" });

/**
 * Ask whether a payment landed. `ref` = { paymentPayload | txHash | from+nonce(+validBefore), sellerUrl?, terms? }.
 * Never throws: returns the service answer, or { status: "unknown", safe_to_resign: false, error } on any failure.
 * opts: { url, fetch, timeoutMs, client, verify (check the receipt signature; default true), paymentHeader (to pay us after the free quota) }
 */
export async function afterPay(ref = {}, opts = {}) {
  const f = opts.fetch || globalThis.fetch;
  const body = {};
  if (ref.paymentPayload) body.payment_payload = String(ref.paymentPayload);
  if (ref.txHash) body.tx_hash = String(ref.txHash);
  if (ref.from) body.from = String(ref.from);
  if (ref.nonce) body.nonce = String(ref.nonce);
  if (ref.validBefore != null) body.valid_before = String(ref.validBefore);
  if (ref.sellerUrl) body.seller_url = String(ref.sellerUrl);
  if (ref.terms) body.terms = ref.terms;
  if (opts.client) body.client = String(opts.client);
  if (!body.payment_payload && !body.tx_hash && !(body.from && body.nonce)) return UNKNOWN("missing_reference");
  const ac = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), opts.timeoutMs ?? AFTER_PAY_TIMEOUT_MS) : null;
  try {
    const headers = { "content-type": "application/json", accept: "application/json" };
    if (opts.paymentHeader) headers["payment-signature"] = String(opts.paymentHeader);
    if (opts.apiKey) headers.authorization = "Bearer " + String(opts.apiKey); // 1.3.0 hosted mode (opt-in)
    const r = await f(opts.url || PAYMENT_STATUS_URL, { method: "POST", headers, body: JSON.stringify(body), ...(ac ? { signal: ac.signal } : {}) });
    let j = null;
    try { j = await r.json(); } catch (_) { j = null; }
    if (r.status === 402) return { ...UNKNOWN("payment_required"), payment_required: j };
    if (r.status !== 200 || !j || typeof j.status !== "string") return UNKNOWN(j && j.code ? j.code : "http_" + r.status);
    const out = { ...j, safe_to_retry_same_payload: true, safe_to_resign: j.safe_to_resign === true };
    if (opts.verify !== false && j.receipt) {
      try {
        const v = await verifyReceipt(j.receipt, { fetch: f, ...(opts.publicKey ? { publicKey: opts.publicKey } : {}) });
        out.receipt_verified = !!(v && v.valid);
        if (!out.receipt_verified) out.safe_to_resign = false; // never trust an unverifiable "safe"
      } catch (_) {
        out.receipt_verified = false;
        out.safe_to_resign = false;
      }
    }
    return out;
  } catch (e) {
    return UNKNOWN(e && e.name === "AbortError" ? "timeout" : "unreachable");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** When to ask: a paid call that threw (timeout/network), answered 5xx, or answered 402 again. */
export function needsAfterPay(resOrError) {
  if (!resOrError) return true;
  if (resOrError instanceof Error || resOrError.name === "AbortError") return true;
  const s = Number(resOrError.status);
  return s === 402 || s >= 500;
}

/** Internal: run afterPay for a paid request and attach the outcome; never changes the result (fail-open). */
export async function runAfterPay(cfg, { paymentHeader, url, result, error, fetchImpl, apiKey }) {
  const o = { ...(fetchImpl ? { fetch: fetchImpl } : {}), ...(apiKey ? { apiKey } : {}), ...(cfg === true ? {} : cfg || {}) };
  let ap;
  try {
    ap = await afterPay({ paymentPayload: paymentHeader, sellerUrl: url }, o);
  } catch (e) {
    ap = UNKNOWN("hook_error");
  }
  try { if (typeof o.onResult === "function") await o.onResult(ap, { url, response: result || null, error: error || null, paymentPayload: paymentHeader || null }); } catch (_) {}
  const target = error || result;
  try { if (target && typeof target === "object") Object.defineProperty(target, "afterPay", { value: ap, configurable: true, enumerable: false }); } catch (_) {}
  return ap;
}
