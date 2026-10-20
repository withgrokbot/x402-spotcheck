// x402-spotcheck: check before you pay. Drop-in guard for x402 clients (@x402/fetch, x402-fetch, @x402/axios, x402-axios).
// 1.0.0: judges the 402 your client already received with local rules (spotcheck-rules, vendored); no network calls,
// no tracking. Calling the 402xAgent service is opt-in (mode: "service"). It never sees or holds your keys.
import { judgeRequirement, judge402, SKIP_CODES, BASE_MAINNET, SOLANA_MAINNET, caip } from "./rules.js";

import { runAfterPay, needsAfterPay } from "./after.js";
import { expiryOpts, judgeExpiry, EXPIRY_CODE } from "./expiry.js";
export { judgeExpiry, EXPIRY_CODE, MAX_SKEW_S } from "./expiry.js";
export { afterPay, needsAfterPay, PAYMENT_STATUS_URL } from "./after.js";
export const VERSION = "1.6.0";
export const DEFAULT_REF = "via-x402-spotcheck"; // 0.x default; since 1.0.0 sent only if you pass ref
// Every earlier host serves the same Worker and stays valid; all are recognised as the check itself, never guarded.
export const DEFAULT_ENDPOINT = "https://api.402xagent.com/v1/products/endpoint-spot-check";
export const LEGACY_ENDPOINT = "https://verified-catalog-lookup.withgrokbot.workers.dev/v1/products/endpoint-spot-check";
const KNOWN_ENDPOINTS = [
  DEFAULT_ENDPOINT,
  "https://402xagent.com/v1/products/endpoint-spot-check",
  LEGACY_ENDPOINT,
  "https://api.payscout.dev/v1/products/endpoint-spot-check",
  "https://payscout.dev/v1/products/endpoint-spot-check",
];
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
// 402xAgent approves one exact payment (paid tier: the terms; free tier: a sha256 of them). Before the x402
// client signs, the target's 402 is narrowed to the requirements that fit those terms; none left = no signature.
const lc = (v) => String(v ?? "").toLowerCase();
async function sha256hex(text) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle ? globalThis.crypto.subtle : (await import("node:crypto")).webcrypto.subtle;
  const buf = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// 0.5.0: matches the Worker's termsSha256 (since Worker 0.23.1): the network is always lower-cased; EVM asset/pay_to are
// lower-cased (Base hashes unchanged); Solana mint/pay_to are base58, case-sensitive, and hashed as-is.
const isSol = (n) => /^solana(:|-|$)/i.test(String(n ?? ""));
const addrKey = (network) => (isSol(network) ? (v) => String(v ?? "") : lc);
export function termsString(t) {
  const a = addrKey(t.network);
  return [lc(t.network), a(t.asset), String(t.amount_atomic ?? t.amount ?? t.maxAmountRequired), a(t.pay_to ?? t.payTo)].join("|");
}
const reqAmount = (r) => String(r.amount ?? r.maxAmountRequired ?? "");
/** Why a 402 requirement does not fit the approved terms ("" = it fits). */
export async function termsMismatch(req, approved) {
  if (!approved) return "";
  if (approved.payment) {
    const p = approved.payment;
    if (lc(req.network) !== lc(p.network)) return `network differs (402 ${req.network}, approved ${p.network})`;
    const a = addrKey(p.network); // Solana base58 compares case-sensitively, as in the Worker
    if (a(req.asset) !== a(p.asset)) return `asset differs (402 ${req.asset}, approved ${p.asset})`;
    if (a(req.payTo) !== a(p.pay_to)) return `pay_to differs (402 ${req.payTo}, approved ${p.pay_to})`;
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

// ---------------------------------------------------------------- AUTO-PAY THE CHECK (0.5.0, opt-in)
// autoPayCheck: { wrapFetch, maxPerCheck, dailyCap, maxFraction?, spendStore? }. Off unless set. When the free check is
// used up (402xAgent answers 402), the check fee is paid with the same x402 client BEFORE the seller, only if every rule
// holds; any failure = the old behaviour (the check counts as unavailable). Amounts are USDC atomic units (6 decimals).
// The documented 402xAgent fee terms (Worker cfg/paymentRequirements): x402 v2, exact, USDC on Base, this pay_to.
export const CHECK_FEE_TERMS = Object.freeze({
  scheme: "exact",
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674",
  minAtomic: 10000, // $0.01
  maxAtomic: 250000, // $0.25
  flatAtomic: 20000, // $0.02 flat check fee (402xAgent Worker 0.38.0+); accepted alongside the 1/10 rule (1.1.0)
});
/** True when `fee` (atomic) matches the documented terms for one of the target quotes: the flat $0.02 fee, or the older 1/10 rule. */
export function isDocumentedCheckFee(fee, quotes) {
  const f = Number(fee);
  if (!Number.isFinite(f) || f <= 0) return false;
  if (f === CHECK_FEE_TERMS.flatAtomic) return true;
  return f >= CHECK_FEE_TERMS.minAtomic && f <= CHECK_FEE_TERMS.maxAtomic && (quotes || []).some((q) => Math.abs(f - expectedCheckFee(q)) <= 1);
}
// USDC (6 decimals) per mainnet the target may quote in; Solana mints are case-sensitive.
const TARGET_USDC = { "eip155:8453": (a) => lc(a) === lc(CHECK_FEE_TERMS.asset), "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": (a) => a === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" };
const MAX_FRACTION = 0.25;
const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const usdToAtomic = (v) => Math.floor(Number(v) * 1e6 + 1e-6);
/** Legacy (Worker <= 0.37) expected 402xAgent fee for a target quote (atomic): 1/10, $0.01 min, $0.25 cap, as the Worker computes it. */
export function expectedCheckFee(targetAtomic) {
  const q = Number(targetAtomic);
  const a = Number.isFinite(q) && q > 0 ? Math.round(q / 10) : CHECK_FEE_TERMS.minAtomic;
  return Math.min(CHECK_FEE_TERMS.maxAtomic, Math.max(CHECK_FEE_TERMS.minAtomic, a));
}
function targetQuotes(target) {
  const out = [];
  for (const a of (target && Array.isArray(target.accepts) ? target.accepts : [])) {
    const n = String((a && a.network) || "");
    const net = /^solana:/i.test(n) ? n : lc(n);
    const amt = String(a && (a.amount ?? a.maxAmountRequired) || "");
    if (TARGET_USDC[net] && TARGET_USDC[net](String(a.asset || "")) && /^\d{1,15}$/.test(amt) && Number(amt) > 0) out.push(Number(amt));
  }
  return out;
}
const isFeeAccept = (a, amount) => !!a && a.scheme === CHECK_FEE_TERMS.scheme && a.network === CHECK_FEE_TERMS.network
  && lc(a.asset) === lc(CHECK_FEE_TERMS.asset) && lc(a.payTo) === lc(CHECK_FEE_TERMS.payTo)
  && /^\d{1,15}$/.test(String(a.amount)) && (amount == null || String(a.amount) === String(amount));

function makeAutoPay(cfg, base) {
  const maxPer = usdToAtomic(cfg.maxPerCheck), cap = usdToAtomic(cfg.dailyCap);
  const frac = cfg.maxFraction == null ? MAX_FRACTION : Number(cfg.maxFraction);
  if (typeof cfg.wrapFetch !== "function") throw new TypeError("autoPayCheck.wrapFetch is required, e.g. (f) => wrapFetchWithPayment(f, client)");
  if (!(maxPer > 0) || !(cap > 0)) throw new TypeError("autoPayCheck.maxPerCheck and dailyCap must be positive USD amounts");
  if (!(frac > 0 && frac <= MAX_FRACTION)) throw new TypeError(`autoPayCheck.maxFraction must be > 0 and <= ${MAX_FRACTION}`);
  const store = cfg.spendStore || null; // optional persistence: { get(day) -> atomic, add(day, atomic) }
  const spent = new Map(); // day -> atomic, in-process, includes in-flight reservations

  async function pay(u, r402, target, signal) {
    let reserved = 0, day = utcDay(), sent = false;
    try {
      const pr = b64json(r402.headers.get("payment-required") || "") || (await r402.json().catch(() => null));
      if (!pr || pr.x402Version !== 2 || !Array.isArray(pr.accepts)) return { why: "unreadable or non-v2 402" };
      const acc = pr.accepts.find((a) => isFeeAccept(a));
      if (!acc) return { why: "402 terms are not the documented 402xAgent pay_to/asset/network" };
      const fee = Number(acc.amount);
      const quotes = targetQuotes(target);
      if (!quotes.length) return { why: "target price unknown (needs a USDC quote on Base or Solana)" };
      if (!isDocumentedCheckFee(fee, quotes)) return { why: `fee ${fee} is neither the flat ${CHECK_FEE_TERMS.flatAtomic} nor 1/10 of the target price` };
      if (fee > maxPer) return { why: `fee ${fee} above maxPerCheck` };
      if (fee > Math.min(...quotes) * frac) return { why: `fee ${fee} above ${frac} of the target price` };
      let persisted = 0;
      if (store && typeof store.get === "function") {
        persisted = Number(await store.get(day));
        if (!Number.isFinite(persisted) || persisted < 0) return { why: "spendStore.get returned an invalid amount" };
      }
      day = utcDay(); // re-read after the await; reserve synchronously so concurrent checks can't both pass
      const today = Math.max(spent.get(day) || 0, persisted);
      if (fee + today > cap) return { why: `fee ${fee} would exceed dailyCap (spent ${today})` };
      spent.set(day, (spent.get(day) || 0) + fee);
      reserved = fee;

      // The client's fetch: only the validated fee, to this URL, once. Anything else throws before a signature leaves.
      const inner = async (input, init = {}) => {
        const isReq = typeof Request !== "undefined" && input instanceof Request;
        const url = isReq ? input.url : String(input);
        if (url !== u) throw new Error("autoPayCheck: unexpected URL");
        let ph = null;
        for (const h of PAY_HEADERS) ph = ph || headerOf(init.headers, h) || (isReq ? input.headers.get(h) : null);
        if (ph) {
          if (sent) throw new Error("autoPayCheck: second payment refused");
          const p = b64json(ph), a = p && p.accepted, auth = (p && p.payload && p.payload.authorization) || null;
          if (!a || !isFeeAccept(a, acc.amount)) throw new Error("autoPayCheck: signed payment differs from the validated fee");
          if (auth && (String(auth.value) !== String(acc.amount) || lc(auth.to) !== lc(CHECK_FEE_TERMS.payTo))) throw new Error("autoPayCheck: signed authorization differs from the validated fee");
          sent = true;
          return base(input, init);
        }
        const res = await base(input, init);
        if (res.status !== 402) return res;
        const fresh = b64json(res.headers.get("payment-required") || "") || (await res.clone().json().catch(() => null));
        const keep = fresh && Array.isArray(fresh.accepts) ? fresh.accepts.filter((a) => isFeeAccept(a, acc.amount)) : [];
        if (!keep.length) throw new Error("autoPayCheck: fee terms changed between probes");
        const narrowed = { ...fresh, accepts: [keep[0]] };
        const headers = new Headers(res.headers);
        headers.set("payment-required", encodeB64Json(narrowed));
        return new Response(JSON.stringify(narrowed), { status: 402, headers });
      };
      const res = await cfg.wrapFetch(inner)(u, { headers: { accept: "application/json" }, signal });
      if (res && res.status === 200) return { res };
      return { why: "paid check HTTP " + (res && res.status) };
    } catch (e) {
      return { why: String((e && e.message) || e).slice(0, 200) };
    } finally {
      if (reserved && !sent) spent.set(day, Math.max(0, (spent.get(day) || 0) - reserved)); // nothing signed left: release
      if (sent && store && typeof store.add === "function") {
        try { await store.add(day, reserved); } catch { /* the in-process total still counts it */ }
      }
    }
  }
  return { pay, spentToday: () => spent.get(utcDay()) || 0 };
}

// ---------------------------------------------------------------- 1.0.0: local by default, the service is opt-in
// Verdict contract (changes only on a major version): skip blocks only with a reason code from
// https://402xagent.com/rules.json; unknown, unchecked, timeout or error pays (unless you set onUnavailable: "block").
export const SERVICE_SKIP_CODES = Object.freeze(["price_mismatch", "pay_to_mismatch", "network_mismatch", "asset_not_usdc", "network_unsupported", "ssrf_blocked", "bad_challenge", "ambiguous", "challenge_expired"]); // 1.4.0: challenge_expired only with checkExpiry // no_paywall is not here: we only ask after a 402, so it is a misprobe = unknown = pay
export const DEFAULT_TIMEOUT_MS = 1500;
const LOCAL_SKIP = new Set(SKIP_CODES);
const SERVICE_SKIP = new Set(SERVICE_SKIP_CODES);
const judged = (opts) => (a) => !!a && (caip(a.network) === BASE_MAINNET || (opts.solana && caip(a.network) === SOLANA_MAINNET));
const passThrough = (url, why) => ({ url: String(url), mode: "none", verdict: "pay", reason_code: null, reason: why, allowed: true, checked: false, approved: null, receiptUrl: null, fits: async () => "" });

// Promise with a hard deadline: resolves to `fallback` at timeoutMs even if `p` never settles.
function deadline(p, ms, fallback) {
  let t;
  return Promise.race([p, new Promise((r) => { t = setTimeout(() => r(fallback()), ms); })]).finally(() => clearTimeout(t));
}

async function listingOf(opts, url, intent) {
  if (!opts.expected) return undefined;
  try {
    const e = await opts.expected(url, intent);
    return e ? { price: e.price, payTo: e.payTo, network: e.network } : undefined;
  } catch { return undefined; }
}

function localDecider(opts) {
  return async function decide(url, { intent = null, target = null } = {}) {
    const ropts = { listing: await listingOf(opts, url, intent), solana: !!opts.solana, tolerance: opts.tolerance };
    const r = judge402(target, ropts);
    const blocked = r.verdict === "skip" && LOCAL_SKIP.has(r.reason_code);
    return {
      url: String(url), mode: "local", verdict: blocked ? "skip" : "pay", reason_code: r.reason_code, reason: r.reason,
      allowed: !blocked, checked: r.checked, approved: null, receiptUrl: null,
      fits: async (req) => { const x = judgeRequirement(req, ropts); return x.verdict === "skip" && LOCAL_SKIP.has(x.reason_code) ? `${x.reason_code}: ${x.reason}` : ""; },
    };
  };
}

/**
 * The 402xAgent service check (opt-in: mode "service"). Returns { url, verdict, reason, reason_code, allowed, checked, raw }.
 * opts: client, ref (both sent only if you set them), endpoint, timeoutMs (default 1500, hard), onRecheck ("allow"|"block",
 *       default allow), onUnavailable ("allow"|"block", default allow), expected, cacheTtlMs, payFetch, maxCheckUsd,
 *       autoPayCheck, solana, onDecision, fetch.
 */
export function createSpotChecker(opts = {}) {
  const base = opts.fetch || globalThis.fetch;
  const endpoint = opts.endpoint || DEFAULT_ENDPOINT;
  const maxCheckUsd = opts.maxCheckUsd ?? 0.05;
  const ttl = opts.cacheTtlMs ?? 5 * 60 * 1000;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cache = new Map();
  const auto = opts.autoPayCheck ? makeAutoPay(opts.autoPayCheck, base) : null;

  async function ask(qs, payFetch, target, signal) {
    const u = endpoint + "?" + qs.toString();
    let r = await base(u, { headers: keyHeaders(opts), signal });
    if (r.status === 402 && auto) {
      const paid = await auto.pay(u, r, target, signal);
      if (!paid.res) return { unavailable: "402xAgent check needs payment (autoPayCheck declined: " + paid.why + ")" };
      r = paid.res;
    } else if (r.status === 402) {
      const req = b64json(r.headers.get("payment-required") || "") || (await r.json().catch(() => ({})));
      const amt = Number(((req.accepts || [])[0] || {}).amount);
      if (!payFetch || !(amt / 1e6 <= maxCheckUsd)) return { unavailable: "402xAgent check needs payment" + (payFetch ? ` above maxCheckUsd ($${amt / 1e6})` : " (no payFetch given)") };
      r = await payFetch(u, { headers: { accept: "application/json" }, signal });
    }
    if (r.status !== 200) return { unavailable: "402xAgent check HTTP " + r.status };
    const body = await r.json().catch(() => null);
    if (!body || typeof body !== "object") return { unavailable: "402xAgent check: unreadable answer" };
    return { body };
  }

  return async function check(url, { method = "GET", intent = null, target = null } = {}) {
    if (target && Array.isArray(target.accepts) && !target.accepts.some(judged(opts))) return passThrough(url, "network not checked (Base only by default)");
    const exp = (await listingOf(opts, url, intent)) || {};
    const qs = new URLSearchParams({ url: String(url) });
    if (opts.client) qs.set("client", opts.client);
    if (opts.ref) qs.set("ref", opts.ref);
    if (String(method).toUpperCase() === "POST") qs.set("method", "POST");
    if (exp.price != null) qs.set("claimed_price", String(exp.price));
    if (exp.payTo) qs.set("pay_to", exp.payTo);
    if (exp.network) qs.set("network", exp.network);
    const eo = expiryOpts(opts.checkExpiry);
    if (eo) { qs.set("check_expiry", "1"); qs.set("skew_s", String(eo.skewS)); } // 1.4.0 opt-in (402xAgent 0.42.0+)
    const key = qs.toString();
    const hit = cache.get(key);
    let res;
    if (hit && hit.at > Date.now() - ttl) res = hit.res;
    else {
      const ac = new AbortController();
      res = await deadline(
        ask(qs, opts.payFetch, target, ac.signal).catch((e) => ({ unavailable: "402xAgent check unreachable: " + String((e && e.message) || e) })),
        timeoutMs,
        () => { ac.abort(); return { unavailable: `402xAgent check timeout (${timeoutMs} ms)` }; },
      );
      // A failed check is remembered briefly, so the signed retry of the same payment does not wait a second timeout.
      cache.set(key, { at: res.unavailable ? Date.now() - ttl + Math.min(ttl, opts.unavailableTtlMs ?? 10000) : Date.now(), res });
    }
    let d;
    if (res.unavailable) {
      const allow = (opts.onUnavailable || "allow") !== "block";
      d = { url: String(url), mode: "service", verdict: "unavailable", reason_code: null, reason: res.unavailable, allowed: allow, checked: false, approved: null, receiptUrl: null };
    } else {
      const b = res.body;
      const code = typeof b.reason_code === "string" ? b.reason_code : typeof b.reason === "string" && SERVICE_SKIP.has(b.reason) ? b.reason : null;
      const v = b.verdict === "skip" && SERVICE_SKIP.has(code) ? "skip" : b.verdict === "skip" ? "pay" : b.verdict === "recheck" ? "recheck" : "pay";
      const allowed = v === "pay" || (v === "recheck" && opts.onRecheck !== "block");
      d = { url: String(url), mode: "service", verdict: v, reason_code: code, reason: b.reason, allowed, checked: true, raw: b, receiptUrl: b.receipt_url || null };
      d.approved = v === "pay" ? approvedOf(d) : null;
    }
    d.fits = async (req) => {
      if (!d.approved) return "";
      const why = await termsMismatch(req, d.approved);
      if (!why) return "";
      if (d.approved.payment) {
        const code = why.startsWith("network") ? "network_mismatch" : why.startsWith("asset") ? "asset_not_usdc" : why.startsWith("pay_to") ? "pay_to_mismatch" : "price_mismatch";
        return `${code}: ${why}`;
      }
      // free tier (hash only): block only if the local rules name a concrete problem; otherwise unknown = pay.
      const x = judgeRequirement(req, { listing: exp, solana: !!opts.solana });
      return x.verdict === "skip" && LOCAL_SKIP.has(x.reason_code) ? `${x.reason_code}: ${x.reason}` : "";
    };
    return d;
  };
}

// 1.3.0: opt-in hosted mode. With apiKey (402x_live_...), the key goes ONLY to the 402xAgent endpoints as a Bearer token;
// hosted calls are billed on the integrator's invoice, so no x402 per check. Without apiKey nothing changes.
const KEY_SHAPE = /^402x_live_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/;
export function checkApiKey(k) {
  if (k == null) return null;
  if (typeof k !== "string" || !KEY_SHAPE.test(k)) throw new TypeError("apiKey must look like 402x_live_<id>_<secret>");
  return k;
}
function keyHeaders(opts) {
  const h = { accept: "application/json" };
  if (opts.apiKey) h.authorization = "Bearer " + opts.apiKey;
  if (opts.apiKey && opts.endUser) h["x-402xagent-end-user"] = String(opts.endUser).slice(0, 64);
  return h;
}

function makeDecider(opts) {
  checkApiKey(opts.apiKey);
  if (opts.autoPayCheck && opts.mode !== "service") throw new TypeError('autoPayCheck needs mode: "service"');
  const decide = opts.mode === "service" ? createSpotChecker(opts) : localDecider(opts);
  const eo = expiryOpts(opts.checkExpiry);
  return async (url, o, ctx) => {
    let d;
    try { d = await decide(url, o); } catch (e) { d = passThrough(url, "check error: " + String((e && e.message) || e)); }
    if (eo) d = withExpiry(d, o, eo); // 1.4.0 opt-in only
    if (opts.onDecision) { try { await (ctx === undefined ? opts.onDecision(d) : opts.onDecision(d, ctx)); } catch { /* observers never block */ } }
    return d;
  };
}

// 1.4.0: opt-in expiry layer on top of any decision. Skips when every judged accepts entry (or the signed
// authorization) is expired; per-requirement fits() also reports expiry so expired options are narrowed away.
function withExpiry(d, o = {}, eo) {
  if (!d || d.allowed === false) return d;
  const accepts = o.target && Array.isArray(o.target.accepts) ? o.target.accepts.filter(Boolean) : [];
  const auth = o.authorization || null;
  const whys = accepts.map((a) => judgeExpiry(a, auth, eo));
  const authOnly = !accepts.length && auth ? judgeExpiry(null, auth, eo) : "";
  const fitsBase = d.fits;
  const fits = async (req) => (await fitsBase(req)) || judgeExpiry(req, auth, eo);
  if ((accepts.length && whys.every(Boolean)) || authOnly) {
    const why = authOnly || whys[0];
    return { ...d, verdict: "skip", reason_code: EXPIRY_CODE, reason: why.slice(EXPIRY_CODE.length + 2), allowed: false, approved: null, fits };
  }
  return { ...d, fits };
}

// A 402 came back: decide now, before the x402 client can sign anything.
async function guard402(res, url, method, decide) {
  const hdr = res.headers.get("payment-required");
  const fromHdr = hdr ? b64json(hdr) : null;
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  const pr = fromHdr || body;
  const d = await decide(url, { method, target: pr && Array.isArray(pr.accepts) ? pr : null });
  if (!d.allowed) throw new SpotCheckBlockedError(d);
  const untouched = () => new Response(text, { status: 402, statusText: res.statusText, headers: new Headers(res.headers) });
  if (!pr || !Array.isArray(pr.accepts)) return untouched(); // unreadable = unknown = pass through
  const kept = [], reasons = [];
  for (const a of pr.accepts) { const why = await d.fits(a); if (why) reasons.push(why); else kept.push(a); }
  if (!reasons.length) return untouched();
  if (!kept.length) throw new SpotCheckBlockedError(d, "refused to sign: " + reasons[0]);
  const headers = new Headers(res.headers);
  if (fromHdr) headers.set("payment-required", encodeB64Json({ ...fromHdr, accepts: kept }));
  return new Response(body && Array.isArray(body.accepts) ? JSON.stringify({ ...body, accepts: kept }) : text, { status: 402, statusText: res.statusText, headers });
}

function isSpotCheck(url, opts) {
  const u = String(url);
  return [opts.endpoint, ...KNOWN_ENDPOINTS].some((e) => e && u.startsWith(e));
}

async function checkSigned(pay, url, method, decide) {
  const p = b64json(pay);
  const auth = (p && p.payload && p.payload.authorization) || null;
  const d = await decide(url, { method, intent: readPaymentIntent(pay), target: p && p.accepted ? { accepts: [p.accepted] } : null, authorization: auth });
  if (!d.allowed) throw new SpotCheckBlockedError(d);
  const why = p && p.accepted ? await d.fits(p.accepted) : "";
  if (why) throw new SpotCheckBlockedError(d, "refused to send: " + why);
}

/**
 * Wrap the fetch you hand to your x402 client. Local rules by default (no network calls of its own).
 *   const pay = wrapFetchWithPayment(spotCheckFetch(fetch), client);
 */
export function spotCheckFetch(fetchImpl = globalThis.fetch, opts = {}) {
  const decide = makeDecider({ fetch: fetchImpl, ...opts });
  return async function guardedFetch(input, init = {}) {
    const isReq = typeof Request !== "undefined" && input instanceof Request;
    const url = isReq ? input.url : String(input);
    const method = (init.method || (isReq ? input.method : "GET") || "GET").toUpperCase();
    let pay = null;
    for (const h of PAY_HEADERS) pay = pay || headerOf(init.headers, h) || (isReq ? input.headers.get(h) : null);
    if (isSpotCheck(url, opts)) return fetchImpl(input, init);
    if (pay) {
      await checkSigned(pay, url, method, decide);
      if (typeof opts.onPayment === "function") {
        try { await opts.onPayment({ paymentPayload: pay, url, method }); } catch { /* observers never block a payment that already passed the check */ }
      }
      if (!opts.afterPay) return fetchImpl(input, init); // 1.1.0 behaviour unless afterPay is opted in
      let res;
      try {
        res = await fetchImpl(input, init);
      } catch (error) {
        await runAfterPay(opts.afterPay, { paymentHeader: pay, url, error, fetchImpl, apiKey: opts.apiKey });
        throw error; // fail-open: same error as without the hook, outcome on error.afterPay
      }
      if (needsAfterPay(res)) await runAfterPay(opts.afterPay, { paymentHeader: pay, url, result: res, fetchImpl, apiKey: opts.apiKey });
      return res;
    }
    const res = await fetchImpl(input, init);
    if (res.status !== 402) return res;
    return guard402(res, url, method, decide);
  };
}

/** Axios: request + response interceptors (register before the x402 interceptor). */
export function spotCheckAxios(instance, opts = {}) {
  const decide = makeDecider(opts);
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
    await checkSigned(pay, full, (config.method || "GET").toUpperCase(), decide);
    if (typeof opts.onPayment === "function") {
      try { await opts.onPayment({ paymentPayload: pay, url: full, method: (config.method || "GET").toUpperCase() }); } catch { /* observers never block a payment that already passed the check */ }
    }
    return config;
  });
  instance.interceptors.response.use(undefined, async (error) => {
    const res = error && error.response;
    const config = (error && error.config) || {};
    if (!res || res.status !== 402) throw error;
    let pay = null;
    for (const h of PAY_HEADERS) pay = pay || headerOf(config.headers, h);
    const full = fullUrl(config);
    if (pay || isSpotCheck(full, opts)) throw error;
    const hkey = Object.keys(res.headers || {}).find((k) => k.toLowerCase() === "payment-required");
    const fromHdr = hkey ? b64json(res.headers[hkey]) : null;
    const body = typeof res.data === "string" ? (() => { try { return JSON.parse(res.data); } catch { return null; } })() : res.data;
    const pr = fromHdr || body;
    const d = await decide(full, { method: (config.method || "GET").toUpperCase(), target: pr && Array.isArray(pr.accepts) ? pr : null });
    if (!d.allowed) throw new SpotCheckBlockedError(d);
    if (!pr || !Array.isArray(pr.accepts)) throw error;
    const kept = [], reasons = [];
    for (const a of pr.accepts) { const why = await d.fits(a); if (why) reasons.push(why); else kept.push(a); }
    if (!reasons.length) throw error;
    if (!kept.length) throw new SpotCheckBlockedError(d, "refused to sign: " + reasons[0]);
    if (fromHdr) res.headers[hkey] = encodeB64Json({ ...fromHdr, accepts: kept });
    if (body && Array.isArray(body.accepts)) res.data = { ...body, accepts: kept };
    throw error;
  });
  return instance;
}

/** Plain function: await checkBeforePay(url, { accepts, price, payTo, network, mode }). Local needs `accepts` (the 402). */
export async function checkBeforePay(url, o = {}) {
  const decide = makeDecider({ ...o, expected: () => ({ price: o.price, payTo: o.payTo, network: o.network }) });
  return decide(url, { method: o.method || "GET", target: o.accepts ? { accepts: o.accepts } : null });
}

/** For agents that sign themselves: throws SpotCheckBlockedError unless `requirement` (one 402 accepts entry) fits. */
export async function assertApprovedPayment(decision, requirement) {
  if (!decision.allowed) throw new SpotCheckBlockedError(decision);
  const why = decision.fits ? await decision.fits(requirement) : await termsMismatch(requirement, decision.approved);
  if (why) throw new SpotCheckBlockedError(decision, "refused to sign: " + why);
  return true;
}

// ---------------------------------------------------------------- hook adapters
/**
 * x402 (x402-foundation/x402, @x402/core >= 2) onBeforePaymentCreation hook:
 *   client.onBeforePaymentCreation(spotCheckBeforePaymentHook({ expected }))
 * Context: { paymentRequired, selectedRequirements }. Returns { abort: true, reason } only on a skip code; never throws.
 */
export function spotCheckBeforePaymentHook(opts = {}) {
  const decide = makeDecider(opts);
  return async (ctx) => {
    try {
      const req = ctx && ctx.selectedRequirements;
      const url = (ctx && ctx.paymentRequired && ctx.paymentRequired.resource && ctx.paymentRequired.resource.url) || (req && req.resource) || null;
      if (!req || !url) return undefined;
      const method = typeof opts.method === "function" ? await opts.method(url) : opts.method || "GET";
      const d = await decide(url, { method, target: { accepts: [req] } }, ctx);
      if (!d.allowed) return { abort: true, reason: `x402-spotcheck: ${d.reason_code || d.verdict}: ${d.reason}` };
      const why = await d.fits(req);
      if (why) return { abort: true, reason: "x402-spotcheck: " + why };
    } catch { /* unknown = pay */ }
    return undefined;
  };
}

/** Run before-payment hooks in order; the first abort wins (put your spending cap first). */
export function composeBeforePaymentHooks(...hooks) {
  const list = hooks.filter((h) => typeof h === "function");
  return async (ctx) => {
    for (const h of list) {
      const r = await h(ctx);
      if (r && r.abort) return r;
    }
    return undefined;
  };
}

/**
 * three.ws mcp-bridge: compose its buildSpendingCapHook (mcp-bridge/src/x402-axios-client.js) with this check.
 * The spending cap runs first, so a payment over the cap never reaches the check.
 *   client.onBeforePaymentCreation(threeWsSpendingCapThenSpotCheck(buildSpendingCapHook, { mode: "local" }))
 */
export function threeWsSpendingCapThenSpotCheck(buildSpendingCapHook, opts = {}) {
  const cap = typeof buildSpendingCapHook === "function" ? buildSpendingCapHook() : null;
  if (typeof cap !== "function") throw new TypeError("pass three.ws buildSpendingCapHook (the builder, not its result)");
  return composeBeforePaymentHooks(cap, spotCheckBeforePaymentHook(opts));
}

export { judgeRequirement, judge402 };
export { verifyReceipt, canonicalize, receiptSigningInput, RECEIPT_KEYS_URL } from "./receipt.js";
export { createAudit, auditPolicyHook, createLedger, createPolicy, createBudgets, settlementAdvice, skipReasonCode, fetchSkips, SKIPS_URL, RECONCILE_AFTER_MS, AUDIT_VERSION } from "./audit.js";
export default spotCheckFetch;
