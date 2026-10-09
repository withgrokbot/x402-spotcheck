// x402-spotcheck: check before you pay. Drop-in guard for x402 clients (@x402/fetch, x402-fetch, @x402/axios, x402-axios).
// Right before your client sends a payment, it asks Spot-Check about the target; skip blocks the payment,
// pay lets it through, recheck is configurable (default: block). It never sees or holds your keys.

export const DEFAULT_ENDPOINT = "https://verified-catalog-lookup.withgrokbot.workers.dev/v1/products/endpoint-spot-check";
const PAY_HEADERS = ["payment-signature", "x-payment"];
const USDC = new Set(["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "0x036cbd53842c5426634e7929541ec2318f3dcf7e"]);

export class SpotCheckBlockedError extends Error {
  constructor(decision) {
    super(`x402-spotcheck blocked payment to ${decision.url}: ${decision.verdict} (${decision.reason})`);
    this.name = "SpotCheckBlockedError";
    this.decision = decision;
  }
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
    qs.set("ref", opts.ref || "x402-spotcheck");
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
      d = { url: String(url), verdict: "unavailable", reason: res.unavailable, allowed: allow, checked: false };
    } else {
      const v = res.body.verdict;
      const allowed = v === "pay" || (v === "recheck" && opts.onRecheck === "allow");
      d = { url: String(url), verdict: v, reason: res.body.reason, allowed, checked: true, raw: res.body };
    }
    if (opts.onDecision) await opts.onDecision(d);
    return d;
  };
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
    if (pay && !isSpotCheck(url, opts)) {
      const d = await check(url, { method, intent: readPaymentIntent(pay) });
      if (!d.allowed) throw new SpotCheckBlockedError(d);
    }
    return fetchImpl(input, init);
  };
}

/**
 * Axios: adds a request interceptor that checks any request carrying a payment header.
 *   const api = wrapAxiosWithPayment(spotCheckAxios(axios.create()), client);
 */
export function spotCheckAxios(instance, opts = {}) {
  const check = createSpotChecker(opts);
  instance.interceptors.request.use(async (config) => {
    let pay = null;
    for (const h of PAY_HEADERS) pay = pay || headerOf(config.headers, h);
    if (!pay) return config;
    const url = (config.baseURL && !/^https?:/i.test(config.url || "") ? config.baseURL.replace(/\/+$/, "") + "/" + String(config.url || "").replace(/^\/+/, "") : config.url) || "";
    const full = config.params ? url + (url.includes("?") ? "&" : "?") + new URLSearchParams(config.params).toString() : url;
    if (isSpotCheck(full, opts)) return config;
    const d = await check(full, { method: (config.method || "GET").toUpperCase(), intent: readPaymentIntent(pay) });
    if (!d.allowed) throw new SpotCheckBlockedError(d);
    return config;
  });
  return instance;
}

/** Plain function for agents/MCP tools: await checkBeforePay(url, { price, payTo, network, client }). */
export async function checkBeforePay(url, o = {}) {
  const check = createSpotChecker({ ...o, expected: () => ({ price: o.price, payTo: o.payTo, network: o.network }) });
  return check(url, { method: o.method || "GET" });
}

export default spotCheckFetch;
