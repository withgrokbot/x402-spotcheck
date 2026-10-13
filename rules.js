// Vendored copy of spotcheck-rules 1.0.0 (github.com/withgrokbot/spotcheck-rules, MIT). Do not edit here; test/vendor checks it.
// spotcheck-rules: judge an x402 402 you already received, locally. No network calls, no dependencies, no service.
// Verdicts: "pay" or "skip". Skip only with a reason code from https://402xagent.com/rules.json; anything unknown,
// unjudged or erroring is "pay". Verdict behaviour changes only on a major version (see README).
export const RULES_VERSION = "1.0.0";
export const SKIP_CODES = Object.freeze(["price_mismatch", "pay_to_mismatch", "network_mismatch", "asset_not_usdc", "bad_challenge"]);
export const BASE_MAINNET = "eip155:8453";
export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const USDC = Object.freeze({ [BASE_MAINNET]: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", [SOLANA_MAINNET]: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" });
const TEXT = {
  price_ok: "payment request matches the listed price",
  price_below_listing: "live price lower than listed",
  price_mismatch: "asks a different price than listed",
  pay_to_mismatch: "pays a different wallet than listed",
  network_mismatch: "asks for payment on a different network than listed",
  asset_not_usdc: "asks for a token other than USDC",
  bad_challenge: "payment request has no readable USDC price",
};
const ALIASES = { base: BASE_MAINNET, "base-sepolia": "eip155:84532", solana: SOLANA_MAINNET, "solana-devnet": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" };
/** CAIP-2 id; v1 names mapped. EVM ids lower-case, Solana ids keep case. */
export function caip(n) {
  const s = String(n ?? "").trim();
  if (ALIASES[s.toLowerCase()]) return ALIASES[s.toLowerCase()];
  return /^solana:/i.test(s) ? "solana:" + s.slice(7) : s.toLowerCase();
}
const isEvmAddr = (v) => /^0x[0-9a-fA-F]{40}$/.test(String(v ?? ""));
const isSolAddr = (v) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(v ?? ""));
const sameAddr = (a, b, sol) => (sol ? String(a ?? "") === String(b ?? "") : String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase());
const pay = (reason, extra = {}) => ({ verdict: "pay", reason_code: extra.code || null, reason, checked: !!extra.checked });
const skip = (code, detail) => ({ verdict: "skip", reason_code: code, reason: TEXT[code] + (detail ? ` (${detail})` : ""), checked: true });

/**
 * Judge one 402 requirement (one `accepts` entry, v1 or v2).
 * opts.listing: { price?: USD number, payTo?: string, network?: string } what you expect (optional)
 * opts.solana: also judge Solana mainnet (default false: passes through untouched)
 * opts.tolerance: price tolerance as a fraction (default 0.01, as in rules.json)
 */
export function judgeRequirement(req, opts = {}) {
  try {
    if (!req || typeof req !== "object") return pay("no requirement to judge");
    const net = caip(req.network);
    const sol = net === SOLANA_MAINNET;
    if (net !== BASE_MAINNET && !(sol && opts.solana)) return pay(`network ${req.network || "unknown"} not judged`);
    const l = opts.listing || {};
    if (l.network && caip(l.network) !== net) return skip("network_mismatch", `402 ${req.network}, listed ${l.network}`);
    const amount = String(req.amount ?? req.maxAmountRequired ?? "");
    if (!/^\d{1,30}$/.test(amount) || !(sol ? isSolAddr(req.payTo) : isEvmAddr(req.payTo)) || !req.asset) return skip("bad_challenge");
    if (!sameAddr(req.asset, USDC[net], sol)) return skip("asset_not_usdc", String(req.asset));
    if (l.payTo && !sameAddr(req.payTo, l.payTo, sol)) return skip("pay_to_mismatch", `402 ${req.payTo}, listed ${l.payTo}`);
    const usd = Number(amount) / 1e6;
    const price = l.price == null || l.price === "" ? NaN : Number(l.price);
    if (Number.isFinite(price) && price >= 0) {
      const tol = opts.tolerance == null ? 0.01 : Math.max(0, Number(opts.tolerance));
      if (usd > price * (1 + tol) + 1e-9) return skip("price_mismatch", `402 $${usd}, listed $${price}`);
      if (usd < price * (1 - tol) - 1e-9) return pay(TEXT.price_below_listing, { code: "price_below_listing", checked: true });
      return pay(TEXT.price_ok, { code: "price_ok", checked: true });
    }
    return pay("terms are readable USDC; no listed price to compare", { checked: true });
  } catch {
    return pay("rules error");
  }
}

/** Judge a whole PaymentRequired: { verdict, reason_code, reason, results, kept } (kept = accepts judged pay). */
export function judge402(paymentRequired, opts = {}) {
  try {
    const accepts = paymentRequired && Array.isArray(paymentRequired.accepts) ? paymentRequired.accepts : null;
    if (!accepts || !accepts.length) return { ...pay("no readable accepts"), results: [], kept: accepts || [] };
    const results = accepts.map((a) => judgeRequirement(a, opts));
    const kept = accepts.filter((_, i) => results[i].verdict === "pay");
    if (kept.length) return { ...results[results.findIndex((r) => r.verdict === "pay")], results, kept };
    return { ...results[0], results, kept };
  } catch {
    return { ...pay("rules error"), results: [], kept: [] };
  }
}

/** x402 onBeforePaymentCreation hook (x402-foundation/x402 @x402/core): ({ paymentRequired, selectedRequirements }). */
export function rulesBeforePaymentHook(opts = {}) {
  return async (ctx) => {
    try {
      const url = ctx && ctx.paymentRequired && ctx.paymentRequired.resource && ctx.paymentRequired.resource.url;
      const listing = typeof opts.listing === "function" ? await opts.listing(url, ctx.selectedRequirements) : opts.listing;
      const d = judgeRequirement(ctx && ctx.selectedRequirements, { ...opts, listing });
      if (opts.onDecision) { try { await opts.onDecision(d, ctx); } catch { /* observers never block */ } }
      if (d.verdict === "skip" && SKIP_CODES.includes(d.reason_code)) return { abort: true, reason: `spotcheck-rules: ${d.reason_code}: ${d.reason}` };
    } catch { /* unknown = pay */ }
    return undefined;
  };
}
export default judgeRequirement;
