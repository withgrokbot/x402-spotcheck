// x402-spotcheck: check before you pay. Drop-in guard for x402 clients (@x402/fetch, x402-fetch, @x402/axios, x402-axios).
// Right before your client sends a payment, it asks Spot-Check about the target; skip blocks the payment,
// pay lets it through, recheck is configurable (default: block). It never sees or holds your keys.

export const DEFAULT_REF = "via-x402-spotcheck"; // attribution only; integrators set their own (e.g. via-cdp)
export const DEFAULT_ENDPOINT = "https://verified-catalog-lookup.withgrokbot.workers.dev/v1/products/endpoint-spot-check";
const PAY_HEADERS = ["payment-signature", "x-payment"];
const USDC = new Set(["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "0x036cbd53842c5426634e7929541ec2318f3dcf7e"]);

export class SpotCheckBlockedError extends Error {
  constructor(decision, detail) {
    super(`x402-spotcheck blocked payment to ${decision.url}: ${detail || `${decision.verdict} (${decision.reason})`}` + (decision.receiptUrl ? ` — receipt: ${decision.receiptUrl}` : ""));
    this.name = "SpotCheckBlockedError";
    this.decision = decision;
    this.reason = detail || decision.reason;
    this.receiptUrl = decision.receiptUrl || null;
  }
}

// ---------------------------------------------------------------- PAY STEP (0.2.0)
// Spot-Check approves one exact payment (paid tier: the terms; free tier: a sha256 of them). Before the x402
// client signs, the target's 402 is narrowed to the requirements that fit those terms; none left = no signature.
const lc = (v) => String(v ?? "").toLowerCase();
async function sha256hex(text) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle ? globalThis.crypto.subtle : (await import("node:crypto")).webcrypto.subtle;
  const buf = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function termsString(t) {
  return [lc(t.network), lc(t.asset), String(t.amount_atomic ?? t.amount ?? t.maxAmountRequired), lc(t.pay_to ?? t.payTo)].join("|");
}
const reqAmount = (r) => String(r.amount ?? r.maxAmountRequired ?? "");
/** Why a 402 requirement does not fit the approved terms ("" = it fits). */
export async function termsMismatch(req, approved) {
  if (!approved) return "";
  if (approved.payment) {
    const p = approved.payment;
    if (lc(req.network) !== lc(p.network)) return `network differs (402 ${req.network}, approved ${p.network})`;
    if (lc(req.asset) !== lc(p.asset)) return `asset differs (402 ${req.asset}, approved ${p.asset})`;
    if (lc(req.payTo) !== lc(p.pay_to)) return `pay_to differs (402 ${req.payTo}, approved ${p.pay_to})`;
    if (!/^\d+$/.test(reqAmount(req)) || BigInt(reqAmount(req)) > BigInt(p.amount_atomic)) return `amount above approved (402 ${reqAmount(req)}, approved ${p.amount_atomic} atomic)`;
    return "";
  }
  if (approved.sha256) return (await sha256hex(termsString(req))) === approved.sha256 ? "" : "terms differ from the approved payment (network, asset, amount or pay_to)";
  return "";
}
function approvedOf(d) {
  if (!d || !d.raw) return null;
  if (d.raw.payment) return { payment: d.raw.payment };
  if (d.raw.payment_terms_sha256) return { sha256: d.raw.payment_terms_sha256 };
  return null;
}
/** Keep only the 402 requirements that fit; returns { kept, reasons }. */
export async function narrowRequirements(accepts, approved) {
  const kept = [], reasons = [];
  for (const a of accepts || []) {
    const why = await termsMismatch(a, approved);
    if (why) reasons.push(why); else kept.push(a);
  }
  return { kept, reasons };
}
function encodeB64Json(o) {
  const bytes = new TextEncoder().encode(JSON.stringify(o));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
}

function b64json(v) {
  try {
    const s = String(v).trim();
    const bin = typeof atob === "function" ? atob(s) : Buffer.from(s, "base64").toString("binary");
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

/** What the client is about to sign, read from its own PAYMENT-SIGNATURE / X-PAYMENT header. */
export function readPaymentIntent(headerValue) {
  const p = b64json(headerValue);
  if (!p || typeof p !== "object") return null;
  const acc = p.accepted || {};
  const auth = (p.payload && p.payload.authorization) || {};
  const network = acc.network || p.network || null;
  const payTo = acc.payTo || auth.to || null;
  const atomic = acc.amount ?? auth.value ?? null;
  const asset = String(acc.asset || "").toLowerCase();
  // USD only when we know it is USDC (6 decimals): v2 names the asset; v1 "exact" on base is USDC.
  const isUsdc = asset ? USDC.has(asset) : /^(base|base-sepolia)$/.test(String(network));
  const priceUsd = atomic != null && isUsdc && /^\d+$/.test(String(atomic)) ? Number(atomic) / 1e6 : null;
  return { network, payTo, priceUsd };
}

function headerOf(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  if (Array.isArray(headers)) {
    const hit = headers.find(([k]) => String(k).toLowerCase() === name);
    return hit ? hit[1] : null;
  }
  for (const k of Object.keys(headers)) if (k.toLowerCase() === name) return headers[k];
  return null;
}

/**
 * Core check. Returns { url, verdict, reason, allowed, checked, raw }.
 * opts: client, endpoint, payFetch, maxCheckUsd, onRecheck ("block"|"allow"), onUnavailable ("allow"|"block"),
 *       expected(url, intent) -> {price?, payTo?, network?} (your listing), cacheTtlMs, timeoutMs, onDecision, fetch.
 */
export function createSpotChecker(opts = {}) {
  const base = opts.fetch || globalThis.fetch;
  const endpoint = opts.endpoint || DEFAULT_ENDPOINT;
  const maxCheckUsd = opts.maxCheckUsd ?? 0.05;
  const ttl = opts.cacheTtlMs ?? 5 * 60 * 1000;
  const cache = new Map();

  async function ask(qs, payFetch) {
    const u = endpoint + "?" + qs.toString();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 15000);
    try {
      let r = await base(u, { headers: { accept: "application/json" }, signal: ac.signal });
      if (r.status === 402) {
        // Spot-Check's own price: 1/10 of the target's quote, $0.01-$0.25. Pay only within maxCheckUsd.
        const req = b64json(r.headers.get("payment-required") || "") || (await r.json().catch(() => ({})));
        const amt = Number(((req.accepts || [])[0] || {}).amount);
        if (!payFetch || !(amt / 1e6 <= maxCheckUsd)) return { unavailable: "spot-check needs payment" + (payFetch ? ` above maxCheckUsd ($${amt / 1e6})` : " (no payFetch given)") };
        r = await payFetch(u, { headers: { accept: "application/json" } });
      }
      if (r.status !== 200) return { unavailable: "spot-check HTTP " + r.status };
      return { body: await r.json() };
    } catch (e) {
      return { unavailable: "spot-check unreachable: " + (e && e.name === "AbortError" ? "timeout" : String((e && e.message) || e)) };
    } finally {
      clearTimeout(timer);
    }
  }

  return async function check(url, { method = "GET", intent = null } = {}) {
    const exp = (opts.expected && (await opts.expected(url, intent))) || {};
    const qs = new URLSearchParams({ url: String(url) });
    if (opts.client) qs.set("client", opts.client);
    qs.set("ref", opts.ref || DEFAULT_REF);
    if (String(method).toUpperCase() === "POST") qs.set("method", "POST");
    const price = exp.price;
    if (price != null) qs.set("claimed_price", String(price));
    if (exp.payTo) qs.set("pay_to", exp.payTo);
    if (exp.network) qs.set("network", exp.network);
    const key = qs.toString();
    const hit = cache.get(key);
    let res;
    if (hit && hit.at > Date.now() - ttl) res = hit.res;
    else {
      res = await ask(qs, opts.payFetch);
      if (!res.unavailable) cache.set(key, { at: Date.now(), res });
    }
    let d;
    if (res.unavailable) {
      const allow = (opts.onUnavailable || "allow") === "allow";
      d = { url: String(url), verdict: "unavailable", reason: res.unavailable, allowed: allow, checked: false, approved: null, receiptUrl: null };
    } else {
      const v = res.body.verdict;
      const allowed = v === "pay" || (v === "recheck" && opts.onRecheck === "allow");
      d = { url: String(url), verdict: v, reason: res.body.reason, allowed, checked: true, raw: res.body, receiptUrl: res.body.receipt_url || null };
      d.approved = approvedOf(d);
    }
    if (opts.onDecision) await opts.onDecision(d);
    return d;
  };
}

// A 402 came back: check now, before the x402 client can sign anything.
async function guard402(res, url, method, check) {
  const hdr = res.headers.get("payment-required");
  const fromHdr = hdr ? b64json(hdr) : null;
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  const d = await check(url, { method });
  if (!d.allowed) throw new SpotCheckBlockedError(d);
  const rebuilt = (h, b) => {
    const headers = new Headers(res.headers);
    if (h) headers.set("payment-required", encodeB64Json(h));
    return new Response(b ? JSON.stringify(b) : text, { status: 402, statusText: res.statusText, headers });
  };
  if (!d.approved) return rebuilt(null, null); // unavailable + allowed: pass the 402 through untouched
  const pr = fromHdr || body;
  if (!pr || !Array.isArray(pr.accepts)) throw new SpotCheckBlockedError(d, "refused to sign: unreadable 402");
  const { kept, reasons } = await narrowRequirements(pr.accepts, d.approved);
  if (!kept.length) throw new SpotCheckBlockedError(d, "refused to sign: " + (reasons[0] || "no requirement fits the approved payment"));
  return rebuilt(fromHdr ? { ...fromHdr, accepts: kept } : null, body && Array.isArray(body.accepts) ? { ...body, accepts: kept } : null);
}

function isSpotCheck(url, opts) {
  return String(url).startsWith(opts.endpoint || DEFAULT_ENDPOINT);
}

/**
 * Wrap the fetch you hand to your x402 client. Requests without a payment header pass straight through;
 * a request carrying PAYMENT-SIGNATURE / X-PAYMENT is checked first and throws SpotCheckBlockedError on skip.
 *   const pay = wrapFetchWithPayment(spotCheckFetch(fetch), client);
 */
export function spotCheckFetch(fetchImpl = globalThis.fetch, opts = {}) {
  const check = createSpotChecker({ fetch: fetchImpl, ...opts });
  return async function guardedFetch(input, init = {}) {
    const isReq = typeof Request !== "undefined" && input instanceof Request;
    const url = isReq ? input.url : String(input);
    const method = (init.method || (isReq ? input.method : "GET") || "GET").toUpperCase();
    let pay = null;
    for (const h of PAY_HEADERS) pay = pay || headerOf(init.headers, h) || (isReq ? input.headers.get(h) : null);
    if (isSpotCheck(url, opts)) return fetchImpl(input, init);
    if (pay) {
      // Last line: the signed payment must still fit the approved terms (cached check, no extra call).
      const d = await check(url, { method, intent: readPaymentIntent(pay) });
      if (!d.allowed) throw new SpotCheckBlockedError(d);
      const p = b64json(pay);
      const why = p && p.accepted ? await termsMismatch(p.accepted, d.approved) : "";
      if (why) throw new SpotCheckBlockedError(d, "refused to send: " + why);
      return fetchImpl(input, init);
    }
    const res = await fetchImpl(input, init);
    if (res.status !== 402) return res;
    return guard402(res, url, method, check);
  };
}

/**
 * Axios: adds a request interceptor that checks any request carrying a payment header.
 *   const api = wrapAxiosWithPayment(spotCheckAxios(axios.create()), client);
 */
export function spotCheckAxios(instance, opts = {}) {
  const check = createSpotChecker(opts);
  const fullUrl = (config) => {
    const url = (config.baseURL && !/^https?:/i.test(config.url || "") ? config.baseURL.replace(/\/+$/, "") + "/" + String(config.url || "").replace(/^\/+/, "") : config.url) || "";
    return config.params ? url + (url.includes("?") ? "&" : "?") + new URLSearchParams(config.params).toString() : url;
  };
  instance.interceptors.request.use(async (config) => {
    let pay = null;
    for (const h of PAY_HEADERS) pay = pay || headerOf(config.headers, h);
    if (!pay) return config;
    const full = fullUrl(config);
    if (isSpotCheck(full, opts)) return config;
    const d = await check(full, { method: (config.method || "GET").toUpperCase(), intent: readPaymentIntent(pay) });
    if (!d.allowed) throw new SpotCheckBlockedError(d);
    const p = b64json(pay);
    const why = p && p.accepted ? await termsMismatch(p.accepted, d.approved) : "";
    if (why) throw new SpotCheckBlockedError(d, "refused to send: " + why);
    return config;
  });
  // Registered before the x402 payment interceptor, so it sees the 402 first: check, then narrow or refuse.
  instance.interceptors.response.use(undefined, async (error) => {
    const res = error && error.response;
    const config = (error && error.config) || {};
    if (!res || res.status !== 402) throw error;
    let pay = null;
    for (const h of PAY_HEADERS) pay = pay || headerOf(config.headers, h);
    const full = fullUrl(config);
    if (pay || isSpotCheck(full, opts)) throw error;
    const d = await check(full, { method: (config.method || "GET").toUpperCase() });
    if (!d.allowed) throw new SpotCheckBlockedError(d);
    if (!d.approved) throw error;
    const hkey = Object.keys(res.headers || {}).find((k) => k.toLowerCase() === "payment-required");
    const fromHdr = hkey ? b64json(res.headers[hkey]) : null;
    const body = typeof res.data === "string" ? (() => { try { return JSON.parse(res.data); } catch { return null; } })() : res.data;
    const pr = fromHdr || body;
    if (!pr || !Array.isArray(pr.accepts)) throw new SpotCheckBlockedError(d, "refused to sign: unreadable 402");
    const { kept, reasons } = await narrowRequirements(pr.accepts, d.approved);
    if (!kept.length) throw new SpotCheckBlockedError(d, "refused to sign: " + (reasons[0] || "no requirement fits the approved payment"));
    if (fromHdr) res.headers[hkey] = encodeB64Json({ ...fromHdr, accepts: kept });
    if (body && Array.isArray(body.accepts)) res.data = { ...body, accepts: kept };
    throw error;
  });
  return instance;
}

/** Plain function for agents/MCP tools: await checkBeforePay(url, { price, payTo, network, client }). */
export async function checkBeforePay(url, o = {}) {
  const check = createSpotChecker({ ...o, expected: () => ({ price: o.price, payTo: o.payTo, network: o.network }) });
  return check(url, { method: o.method || "GET" });
}

/** For agents that sign themselves: throws SpotCheckBlockedError unless `requirement` (one 402 accepts entry) fits. */
export async function assertApprovedPayment(decision, requirement) {
  if (!decision.allowed) throw new SpotCheckBlockedError(decision);
  const why = await termsMismatch(requirement, decision.approved);
  if (why) throw new SpotCheckBlockedError(decision, "refused to sign: " + why);
  return true;
}

export default spotCheckFetch;
