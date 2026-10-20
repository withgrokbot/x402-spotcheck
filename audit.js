// 1.5.0 opt-in audit layer. Sits in the buyer payment path and never sees keys.
// Order is the contract: spending cap, then this hook, then the spot-check hook.
// Policy runs before anything is signed. afterPay and the reconciler record what landed.
// Signed 402xAgent receipts are evidence. /v1/skips is a prior, not a verdict.
import { afterPay } from "./after.js";
import { canonicalize, verifyReceipt, RECEIPT_KEYS_URL } from "./receipt.js";
import { caip, BASE_MAINNET, SOLANA_MAINNET, USDC } from "./rules.js";
import { networkConfig as normaliseNetworkConfig, checkNetworkAsset } from "./networks.js";

export const AUDIT_VERSION = "1";
export const SKIPS_URL = "https://402xagent.com/v1/skips.json";
export const RECONCILE_AFTER_MS = 120_000;
export const ESCALATE_AFTER_MS = 24 * 60 * 60 * 1000;
export const RISK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const GENESIS = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const LEDGER_TYPES = new Set(["decision", "reserved", "denied", "settled", "released", "reconciled", "risk_flag"]);
const KEY_SHAPE = /^402x_live_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/;

const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const isSol = (n) => /^solana:/i.test(String(n ?? ""));
const hostOf = (u) => { try { return new URL(String(u)).host.toLowerCase(); } catch { return ""; } };
const payToKey = (payTo, network) => !payTo ? "" : isSol(network) ? String(payTo) : String(payTo).toLowerCase();
const samePayTo = (a, b, network) => !!a && !!b && payToKey(a, network) === payToKey(b, network);

function atomic(v) {
  if (typeof v === "bigint") return v >= 0n ? v : null;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  const s = String(v ?? "").trim();
  return /^\d+$/.test(s) ? BigInt(s) : null;
}
function formatUsdc(n) {
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
function isCanonicalUsdc(asset, network) {
  if (!asset) return true;
  const net = network ? caip(network) : "";
  if (USDC[net]) return isSol(net) ? String(asset) === USDC[net] : String(asset).toLowerCase() === USDC[net].toLowerCase();
  const known = Object.values(USDC).map((x) => String(x).toLowerCase());
  return known.includes(String(asset).toLowerCase());
}
function amountUsdc(n, asset, network) {
  return n == null ? null : isCanonicalUsdc(asset, network) ? formatUsdc(n) : null;
}
function isTestnet(network) {
  const n = caip(network || "");
  return /84532|11155111|80002|devnet|testnet|sepolia|amoy/.test(n);
}
function isMainnet(network) {
  const n = caip(network || "");
  return n === BASE_MAINNET || n === SOLANA_MAINNET;
}
async function sha256Prefixed(text) {
  const subtle = globalThis.crypto?.subtle || (await import("node:crypto")).webcrypto.subtle;
  const buf = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return "sha256:" + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function b64json(v) {
  try {
    const s = String(v).trim();
    const bin = atob(s);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}
function bytesToB64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64ToBytes(s) {
  const bin = atob(String(s));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
// Deterministic id for a skip row without id/receipt, so re-ingesting the same feed does not double-count it.
function skipRowId(raw) {
  const basis = canonicalize({
    url: raw.url ?? null, pay_to: raw.pay_to ?? raw.payTo ?? null, network: raw.network ?? null,
    reason: raw.reason ?? raw.reason_code ?? null, timestamp: raw.timestamp ?? raw.ts ?? null,
  });
  return "skip_" + fnv64(basis);
}
function fnv64(str) {
  // Two independent 32-bit FNV-1a lanes; synchronous so ingest stays sync. Not a security hash, only a dedupe key.
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c ^ (i & 0xff), 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}
function newId(prefix) {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return prefix + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function createLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.then(() => {}, () => {});
    return run;
  };
}
function requirementOf(ctx) {
  const r = ctx && (ctx.selectedRequirements || ctx.paymentRequirements);
  if (!r || typeof r !== "object") return null;
  const resource = r.resource || ctx?.paymentRequired?.resource;
  const url = typeof resource === "string" ? resource : resource?.url || null;
  return {
    url: url ? String(url) : null,
    amount: r.amount ?? r.maxAmountRequired ?? null,
    payTo: r.payTo || r.pay_to || null,
    network: r.network || null,
    asset: r.asset || null,
  };
}
function decodePayment(payload) {
  const p = b64json(payload);
  if (!p || typeof p !== "object") return null;
  const acc = p.accepted || {};
  const auth = (p.payload && p.payload.authorization) || {};
  const validBefore = auth.validBefore != null ? Number(auth.validBefore) : null;
  return {
    network: acc.network || p.network || null,
    payTo: acc.payTo || auth.to || null,
    amount: acc.amount ?? auth.value ?? null,
    asset: acc.asset || null,
    nonce: auth.nonce ? String(auth.nonce) : null,
    validBefore: Number.isFinite(validBefore) ? validBefore : null,
    from: auth.from || null,
  };
}

/** What a verified payment-status result is allowed to do to a reservation. Unverified never moves money. */
export function settlementAdvice(result = {}) {
  if (result.receipt_verified !== true) return { move: "hold", resign: "never", reason: "unverified_status" };
  switch (result.status) {
    case "landed": return { move: "settle", resign: "never" };
    case "not_landed": return { move: "release", resign: result.safe_to_resign === true ? "allowed" : "never" };
    case "pending": return { move: "hold", resign: "resend" };
    case "canceled": return { move: "release", resign: "new_decision", flag: "canceled" };
    default: return { move: "hold", resign: "never", reason: "unknown" };
  }
}

const SKIP_TEXT = [
  [/pay_to_mismatch|different wallet/i, "pay_to_mismatch"],
  [/network_mismatch|different network/i, "network_mismatch"],
  [/price_mismatch|different price/i, "price_mismatch"],
  [/asset_not_usdc|other than (canonical )?usdc|token other than/i, "asset_not_usdc"],
  [/bad_challenge|ambiguous|no readable|malformed|unparseable/i, "bad_challenge"],
];
/** Reason code for a /v1/skips row. Unknown prose stays null (a prior, not a verdict). */
export function skipReasonCode(row = {}) {
  if (typeof row.reason_code === "string" && row.reason_code) return row.reason_code;
  const text = String(row.reason || "");
  for (const [re, code] of SKIP_TEXT) if (re.test(text)) return code;
  return null;
}
function testnetToMainnet(row) {
  return isTestnet(row.listed_network || row.expected_network || "") && isMainnet(row.network || "");
}

export function createLedger({ now = () => Date.now(), initial = [] } = {}) {
  const entries = [...initial]; // initial: entries loaded from a store (verified by createAudit before use)
  async function append(partial = {}) {
    if (!LEDGER_TYPES.has(partial.type)) throw new TypeError("ledger type must be decision, reserved, denied, settled, released, reconciled, or risk_flag");
    const terms = partial.terms && typeof partial.terms === "object" ? partial.terms : {};
    const amountRaw = partial.amount_atomic ?? partial.amount ?? terms.amount ?? terms.maxAmountRequired ?? null;
    const amountBi = amountRaw == null || amountRaw === "" ? null : atomic(amountRaw);
    const network = partial.network ?? terms.network ?? null;
    const asset = partial.asset ?? terms.asset ?? null;
    const payTo = partial.pay_to ?? partial.payTo ?? terms.payTo ?? terms.pay_to ?? null;
    const resource = partial.url ?? terms.resource ?? null;
    const body = {
      seq: entries.length + 1,
      prev_hash: entries.length ? entries[entries.length - 1].hash : GENESIS,
      type: partial.type,
      ts: partial.ts || iso(now()),
      agent: partial.agent != null ? String(partial.agent) : null,
      url: resource ? String(typeof resource === "string" ? resource : resource.url || "") || null : null,
      amount_usdc: partial.amount_usdc !== undefined ? partial.amount_usdc : amountUsdc(amountBi, asset, network),
      amount_atomic: amountBi != null ? amountBi.toString() : (amountRaw == null ? null : String(amountRaw)),
      pay_to: payTo ? String(payTo) : null,
      network: network ? String(network) : null,
      policy_version: partial.policy_version ?? partial.policyVersion ?? null,
      reason: partial.reason != null ? String(partial.reason) : null,
      reservation_id: partial.reservation_id ?? (partial.type === "reserved" ? partial.id ?? null : partial.id && partial.type !== "decision" ? partial.id : null) ?? null,
      spotcheck_receipt: partial.spotcheck_receipt ?? partial.receiptUrl ?? null,
      settlement_tx: partial.settlement_tx ?? null,
      status_receipt: partial.status_receipt ?? null,
      safe_to_resign: partial.safe_to_resign === true ? true : partial.safe_to_resign === false ? false : null,
      resign: partial.resign ?? null,
      final: partial.final === true ? true : partial.final === false ? false : null,
      observe: partial.observe === true,
      receipt_verified: partial.receipt_verified === true ? true : partial.receipt_verified === false ? false : null,
      flag: partial.flag ?? null,
    };
    if (partial.reservation_id == null && partial.id && (partial.type === "reserved" || partial.type === "released" || partial.type === "settled" || partial.type === "reconciled")) body.reservation_id = String(partial.id);
    const hash = await sha256Prefixed(canonicalize(body));
    const entry = { ...body, hash };
    entries.push(entry);
    return entry;
  }
  async function verify() {
    let prev = GENESIS;
    for (const entry of entries) {
      if (entry.prev_hash !== prev) return { valid: false, seq: entry.seq, reason: "prev_hash does not link" };
      const { hash, ...body } = entry;
      const again = await sha256Prefixed(canonicalize(body));
      if (again !== hash) return { valid: false, seq: entry.seq, reason: "hash does not match entry" };
      prev = hash;
    }
    return { valid: true, seq: entries.length, reason: "chain links" };
  }
  function exportChain({ from = 1, to = entries.length } = {}) {
    const slice = entries.filter((e) => e.seq >= from && e.seq <= to);
    const receipts = [];
    for (const e of slice) {
      if (e.spotcheck_receipt) receipts.push(e.spotcheck_receipt);
      if (e.status_receipt) receipts.push(e.status_receipt);
    }
    return { from, to, entries: slice.map((e) => ({ ...e })), receipts: [...new Set(receipts)], keys_url: RECEIPT_KEYS_URL };
  }
  return { append, verify, exportChain, get entries() { return entries; } };
}

/** A persistent store (x402-spotcheck/audit/sqlite) is missing, corrupt, tampered, locked or failed to write. */
export class StoreUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "StoreUnavailableError";
    this.code = "audit_store_unavailable";
    this.cause = cause;
  }
}

export class BudgetExceededError extends Error {
  constructor() {
    super("budget_exhausted");
    this.name = "BudgetExceededError";
    this.code = "budget_exhausted";
  }
}

export function createBudgets({ dailyBudgetAtomic = null, now = () => Date.now(), initial = [] } = {}) {
  const daily = dailyBudgetAtomic == null ? null : atomic(dailyBudgetAtomic);
  if (dailyBudgetAtomic != null && daily == null) throw new TypeError("dailyBudgetAtomic must be a non-negative integer");
  const reservations = new Map();
  let seq = 0;
  for (const r of initial) { // loaded from a store: amounts come back as strings
    reservations.set(r.id, { ...r, amount: BigInt(r.amount) });
    seq = Math.max(seq, Number(r.n) || 0);
  }
  const used = (budgetId, day) => {
    let s = 0n;
    for (const r of reservations.values()) {
      if (r.budgetId === budgetId && r.day === day && (r.status === "open" || r.status === "settled")) s += r.amount;
    }
    return s;
  };
  return {
    remaining(budgetId, at = now()) {
      if (daily == null) return null;
      const left = daily - used(budgetId, dayKey(at));
      return left > 0n ? left : 0n;
    },
    reserve(budgetId, amount, meta = {}) {
      const amt = atomic(amount);
      if (amt == null) throw new TypeError("reserve amount must be a non-negative integer");
      const at = meta.at ?? now();
      if (daily != null && amt > this.remaining(budgetId, at)) throw new BudgetExceededError();
      const id = meta.id || newId("rsv_");
      const rec = {
        id, budgetId: String(budgetId), amount: amt, day: dayKey(at), status: "open",
        agent: meta.agent ?? null, url: meta.url ?? null, payTo: meta.payTo ?? null, network: meta.network ?? null, asset: meta.asset ?? null,
        openedAt: at, n: ++seq, nextCheckAt: 0, checks: 0, resign: null, nonce: null, validBefore: null, flag: null, txHash: null,
        unknownSince: null, escalated: false, lastStatus: null,
      };
      reservations.set(id, rec);
      return { id };
    },
    get(id) { return reservations.get(id) || null; },
    list() { return [...reservations.values()]; },
    listOpen() { return this.list().filter((r) => r.status === "open"); },
    settle(id, info = {}) {
      const r = reservations.get(id);
      if (!r || r.status !== "open") return r;
      r.status = "settled";
      r.txHash = info.txHash || null;
      r.resign = "never";
      r.lastStatus = "landed";
      return r;
    },
    release(id, info = {}) {
      const r = reservations.get(id);
      if (!r || r.status !== "open") return r;
      r.status = "released";
      r.resign = info.resign || "never";
      r.flag = info.flag || null;
      r.lastStatus = info.status || r.lastStatus;
      return r;
    },
  };
}

export function createPolicy(opts = {}) {
  const perCall = opts.perCallCeilingAtomic == null ? null : atomic(opts.perCallCeilingAtomic);
  if (opts.perCallCeilingAtomic != null && perCall == null) throw new TypeError("perCallCeilingAtomic must be a non-negative integer");
  const networks = opts.networks ? new Set(opts.networks.map((n) => caip(n))) : null;
  const addrKey = (a) => { const s = String(a); return /^0x/i.test(s) ? s.toLowerCase() : s; };
  const deny = new Set((opts.payToDeny || []).map(addrKey));
  const allow = opts.payToAllow ? new Set(opts.payToAllow.map(addrKey)) : null;
  const hits = new Map();
  const version = opts.version || "1";
  const netCfg = opts.networkConfig ? normaliseNetworkConfig(opts.networkConfig) : null; // 1.6.0, opt-in
  function velocityList(agent, now) {
    const windowMs = opts.velocity?.windowMs ?? 60_000;
    const list = (hits.get(agent) || []).filter((t) => now - t < windowMs);
    hits.set(agent, list);
    return list;
  }
  return {
    version,
    evaluate(input) {
      const now = input.now ?? Date.now();
      const agent = String(input.agent || "default");
      const amount = atomic(input.amount);
      const network = input.network ? caip(input.network) : "";
      const payTo = input.payTo ? String(input.payTo) : "";
      if (amount == null) return { allow: false, reason: "bad_amount", budgetId: agent };
      if (networks && !networks.has(network)) return { allow: false, reason: "network_not_allowed", budgetId: agent };
      if (netCfg) { const c = checkNetworkAsset(netCfg, network, input.asset); if (!c.ok) return { allow: false, reason: c.reason, budgetId: agent }; }
      if (payTo && deny.has(addrKey(payTo))) return { allow: false, reason: "pay_to_denied", budgetId: agent };
      if (allow && (!payTo || !allow.has(addrKey(payTo)))) return { allow: false, reason: "pay_to_not_allowed", budgetId: agent };
      if (perCall != null && amount > perCall) return { allow: false, reason: "per_call_ceiling", budgetId: agent };
      if (opts.velocity) {
        const list = velocityList(agent, now);
        if (list.length >= opts.velocity.max) return { allow: false, reason: "velocity", budgetId: agent };
      }
      if (typeof opts.remaining === "function") {
        const left = opts.remaining(agent, now);
        if (left != null && amount > left) return { allow: false, reason: "budget_exhausted", budgetId: agent };
      }
      return { allow: true, reason: "allow", budgetId: input.budgetId || agent };
    },
    noteAllow(agent, now) {
      if (!opts.velocity) return;
      velocityList(String(agent), now).push(now);
    },
  };
}

function backoffMs(checks) {
  return Math.min(60 * 60 * 1000, RECONCILE_AFTER_MS * 2 ** Math.min(Math.max(checks, 1), 5));
}

function createRisk({ windowMs = RISK_WINDOW_MS, assetAllow = [] } = {}) {
  const rows = new Map();
  const allow = new Set(assetAllow.map((a) => String(a).toLowerCase()));
  for (const asset of Object.values(USDC)) allow.add(String(asset).toLowerCase());
  function eventsFor(key, now) {
    const out = [];
    for (const row of rows.values()) {
      if (row.payToKey !== key) continue;
      if (now - row.ts > windowMs) continue;
      out.push(row);
    }
    return out;
  }
  return {
    rows,
    ingest(list, now) {
      let added = 0;
      for (const raw of list || []) {
        if (!raw || raw.verdict && raw.verdict !== "skip") continue;
        const id = String(raw.id || raw.receipt || skipRowId(raw));
        if (rows.has(id)) continue;
        const code = skipReasonCode(raw);
        const ts = Date.parse(raw.timestamp || raw.ts || "") || now;
        const network = raw.network || null;
        rows.set(id, {
          id, code, ts, url: raw.url || null, host: hostOf(raw.url || ""),
          payTo: raw.pay_to || raw.payTo || null,
          payToKey: payToKey(raw.pay_to || raw.payTo, network),
          network, listedNetwork: raw.listed_network || raw.expected_network || null,
          testnetToMainnet: testnetToMainnet(raw),
          receiptUrl: raw.permalink || (raw.id ? "https://402xagent.com/v1/receipts/" + raw.id : raw.receiptUrl || null),
          raw,
        });
        added++;
      }
      return added;
    },
    features(payTo, { network = null, asset = null, now = Date.now() } = {}) {
      const recent = eventsFor(payToKey(payTo, network), now);
      const count = (code) => recent.filter((e) => e.code === code).length;
      if (count("pay_to_mismatch")) return { action: "deny", reason: "risk_pay_to_mismatch", events: recent };
      if (recent.some((e) => e.code === "network_mismatch" && e.testnetToMainnet)) return { action: "deny", reason: "risk_testnet_listed_mainnet_charged", events: recent };
      if (count("asset_not_usdc") && asset && !allow.has(String(asset).toLowerCase())) return { action: "deny", reason: "risk_asset_not_usdc", events: recent };
      if (count("price_mismatch") >= 2) return { action: "deny", reason: "risk_price_mismatch_repeat", events: recent };
      if (count("network_mismatch")) return { action: "step_up", reason: "risk_network_mismatch", events: recent };
      if (count("price_mismatch")) return { action: "step_up", reason: "risk_price_mismatch", events: recent };
      return { action: "allow", reason: null, events: recent };
    },
    view(now = Date.now()) {
      const byPayTo = new Map();
      const byHost = new Map();
      for (const row of rows.values()) {
        if (now - row.ts > windowMs) continue;
        const bucket = (map, key) => {
          if (!key) return;
          const b = map.get(key) || { key, skips: 0, codes: {}, first: row.ts, last: row.ts };
          b.skips++;
          if (row.code) b.codes[row.code] = (b.codes[row.code] || 0) + 1;
          b.first = Math.min(b.first, row.ts);
          b.last = Math.max(b.last, row.ts);
          map.set(key, b);
        };
        bucket(byPayTo, row.payToKey);
        bucket(byHost, row.host);
      }
      return { payTo: [...byPayTo.values()], host: [...byHost.values()] };
    },
  };
}

async function aesFrom(secret) {
  if (!secret) return null;
  const subtle = globalThis.crypto?.subtle || (await import("node:crypto")).webcrypto.subtle;
  const raw = secret instanceof Uint8Array ? secret : new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(String(secret))));
  if (raw.length !== 32) throw new TypeError("payloadKey must be a string or 32 bytes");
  return subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
// The reservation id is bound as AES-GCM additionalData, so a blob cannot be swapped onto another reservation.
async function seal(key, text, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(String(aad)) }, key, new TextEncoder().encode(text)));
  return { v: 1, iv: bytesToB64(iv), ct: bytesToB64(ct) };
}
async function open(key, blob, aad) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(blob.iv), additionalData: new TextEncoder().encode(String(aad)) }, key, b64ToBytes(blob.ct));
  return new TextDecoder().decode(pt);
}

function txOf(result) {
  return result?.tx?.hash || result?.tx_hash || null;
}
function statusIdOf(result) {
  return result?.id || result?.receipt?.id || null;
}
function finalOf(result) {
  const conf = Number(result?.finality?.confirmations ?? result?.tx?.confirmations ?? NaN);
  const min = Number(result?.finality?.min_confirmations ?? 10);
  if (result?.finality?.reorg_safe === true) return true;
  return Number.isFinite(conf) && conf >= min;
}

/**
 * onBeforePaymentCreation hook. Deny returns { abort: true, reason }, which is what @x402/core
 * uses to stop signing. Pass deny: "throw" to throw instead. Observe mode logs and does not abort.
 */
export function auditPolicyHook({ policy, budgets, ledger, mode = "enforce", agentId = "default", failClosedAboveAtomic = 0, now = () => Date.now(), deny = "abort", onReserved } = {}) {
  if (!policy || typeof policy.evaluate !== "function") throw new TypeError("auditPolicyHook requires policy.evaluate");
  if (!budgets || typeof budgets.reserve !== "function") throw new TypeError("auditPolicyHook requires budgets.reserve");
  if (!ledger || typeof ledger.append !== "function") throw new TypeError("auditPolicyHook requires ledger.append");
  const ceiling = atomic(failClosedAboveAtomic) ?? 0n;
  const enforce = mode !== "observe";
  return async (ctx) => {
    const req = requirementOf(ctx);
    if (!req) return undefined;
    const at = now();
    const agent = String(typeof agentId === "function" ? await agentId(ctx) : (ctx?.agentId || ctx?.context?.agentId || agentId));
    const amount = atomic(req.amount);
    const terms = { ...req, amount: req.amount };
    const base = { agent, url: req.url, amount: req.amount, payTo: req.payTo, network: req.network, asset: req.asset, terms, policyVersion: policy.version || null, ts: iso(at) };
    const closed = enforce && (amount == null || amount > ceiling);
    const finishDeny = async (reason) => {
      try { await ledger.append({ type: "denied", ...base, reason, observe: !enforce }); } catch { /* a deny still stops when enforcing */ }
      if (!enforce) return undefined;
      if (deny === "throw") throw Object.assign(new Error(`audit deny: ${reason}`), { code: "audit_deny", reason });
      return { abort: true, reason: `audit deny: ${reason}` };
    };
    const outage = async () => {
      try { await ledger.append({ type: closed ? "denied" : "decision", ...base, reason: "audit_unavailable", observe: !closed }); } catch { /* outage is still decided below */ }
      if (!closed) return undefined;
      if (deny === "throw") throw Object.assign(new Error("audit deny: audit_unavailable"), { code: "audit_deny", reason: "audit_unavailable" });
      return { abort: true, reason: "audit deny: audit_unavailable" };
    };
    let verdict;
    try { verdict = await policy.evaluate({ agent, url: req.url, amount: amount ?? req.amount, payTo: req.payTo, network: req.network, asset: req.asset, approved: ctx?.auditApproved === true || ctx?.stepUpApproved === true, now: at }); }
    catch { return outage(); }
    if (!verdict || verdict.allow !== true) return finishDeny(verdict?.reason || "deny");
    if (!enforce) {
      try { await ledger.append({ type: "decision", ...base, reason: "allow", observe: true }); } catch { return outage(); }
      return undefined;
    }
    let reservation = null;
    try {
      reservation = await budgets.reserve(verdict.budgetId || agent, amount, { agent, url: req.url, payTo: req.payTo, network: req.network, asset: req.asset, at });
      if (typeof policy.noteAllow === "function") policy.noteAllow(agent, at);
      await ledger.append({ type: "reserved", ...base, id: reservation.id, policyVersion: policy.version || null, reason: "allow" });
    } catch (e) {
      if (reservation) { try { budgets.release(reservation.id, { resign: "never" }); } catch { /* release is best-effort on a failed record */ } }
      if (e && e.code === "budget_exhausted") return finishDeny("budget_exhausted");
      return outage();
    }
    if (typeof onReserved === "function") onReserved(ctx, reservation.id);
    return undefined;
  };
}

/**
 * Buyer-side audit layer: policy hook, hash-chained ledger, budget reservations,
 * afterPay transitions, reconciler, and skips-feed priors.
 */
export function createAudit(opts = {}) {
  if (opts.apiKey != null && (typeof opts.apiKey !== "string" || !KEY_SHAPE.test(opts.apiKey))) throw new TypeError("apiKey must look like 402x_live_<id>_<secret>");
  if (opts.payloadKey instanceof Uint8Array && opts.payloadKey.length !== 32) throw new TypeError("payloadKey must be a string or 32 bytes");
  const now = opts.now || (() => Date.now());
  const mode = opts.mode === "observe" ? "observe" : "enforce";
  // Optional persistence (opt-in, x402-spotcheck/audit/sqlite). Without opts.store nothing below changes.
  const store = opts.store || null;
  if (store && (opts.ledger || opts.budgets)) throw new TypeError("pass either store or ledger/budgets, not both");
  const loaded = store ? store.load() : null;
  const baseLock = createLock();
  const ledger = opts.ledger || createLedger({ now, initial: loaded ? loaded.entries : [] });
  const budgets = opts.budgets || createBudgets({ dailyBudgetAtomic: opts.dailyBudgetAtomic ?? opts.policy?.dailyBudgetAtomic ?? null, now, initial: loaded ? loaded.reservations : [] });
  // A loaded chain must verify before the first step; a tampered file fails closed.
  const storeReady = store ? ledger.verify().then((v) => {
    if (!v.valid) throw new StoreUnavailableError(`audit store chain does not verify at seq ${v.seq}: ${v.reason}`);
  }) : null;
  if (storeReady) storeReady.catch(() => {}); // surfaced on the first locked step
  const flushStore = () => store.flush({
    entries: ledger.entries,
    reservations: budgets.list().map((r) => ({ ...r, amount: r.amount.toString() })),
    payloads: blobs,
  });
  // Every locked step is written to the store before it resolves. A write failure rejects the step.
  const lock = store
    ? (fn) => baseLock(async () => {
        await storeReady;
        try { return await fn(); }
        finally { flushStore(); }
      })
    : baseLock;
  const netCfgOpt = opts.networkConfig ?? opts.policy?.networkConfig ?? null;
  const netCfgNorm = netCfgOpt ? normaliseNetworkConfig(netCfgOpt) : null;
  const netCfgAssets = netCfgNorm ? Object.values(netCfgNorm).flatMap((n) => Object.keys(n.assets)) : [];
  const risk = createRisk({ windowMs: opts.riskWindowMs, assetAllow: [...(opts.assetAllow || opts.policy?.assetAllow || []), ...netCfgAssets] });
  const inner = opts.policy && typeof opts.policy.evaluate === "function"
    ? opts.policy
    : createPolicy({ ...(opts.policy || {}), ...(netCfgOpt ? { networkConfig: netCfgOpt } : {}), remaining: (id, at) => budgets.remaining(id, at) });
  const policy = {
    version: inner.version || "1",
    evaluate(input) {
      if (netCfgNorm) { const c = checkNetworkAsset(netCfgNorm, input.network, input.asset); if (!c.ok) return { allow: false, reason: c.reason, budgetId: input.agent }; }
      const features = risk.features(input.payTo, { network: input.network, asset: input.asset, now: input.now });
      if (features.action === "deny") return { allow: false, reason: features.reason, budgetId: input.agent };
      if (features.action === "step_up" && input.approved !== true) return { allow: false, reason: features.reason || "step_up_required", budgetId: input.agent };
      return inner.evaluate(input);
    },
    noteAllow: typeof inner.noteAllow === "function" ? (agent, at) => inner.noteAllow(agent, at) : undefined,
  };
  const aesReady = aesFrom(opts.payloadKey);
  const secrets = new Map();
  const blobs = new Map(loaded ? loaded.payloads : []);
  const bound = new WeakMap();
  let pinned = normalizeKeys(opts.publicKey);
  const onUnknownKid = typeof opts.onUnknownKid === "function" ? opts.onUnknownKid : () => {};

  async function putPayload(id, payload) {
    const key = await aesReady;
    if (key) blobs.set(id, await seal(key, String(payload), id));
    else secrets.set(id, String(payload));
  }
  async function getPayload(id) {
    if (blobs.has(id)) {
      const key = await aesReady;
      return key ? open(key, blobs.get(id), id) : null;
    }
    return secrets.get(id) || null;
  }
  function hasPayload(id) { return blobs.has(id) || secrets.has(id); }
  function dropPayload(id) { secrets.delete(id); blobs.delete(id); }

  function remember(ctx, id) {
    if (ctx && typeof ctx === "object") {
      bound.set(ctx, id);
      try { ctx.audit = { reservationId: id }; } catch { /* frozen context still works via the WeakMap when we wrapped the hook */ }
    }
  }

  const innerHook = auditPolicyHook({
    policy, budgets, ledger, mode, now,
    agentId: opts.agentId || "default",
    failClosedAboveAtomic: opts.failClosedAboveAtomic ?? opts.policy?.failClosedAboveAtomic ?? 0,
    deny: opts.deny || "abort",
    onReserved: remember,
  });
  // Evaluate and reserve under one lock so concurrent calls cannot share one remaining budget.
  const beforePayment = store
    ? async (ctx) => {
        try { return await lock(() => innerHook(ctx)); }
        catch (e) {
          if (!(e instanceof StoreUnavailableError)) throw e;
          // Fail closed: if the reservation can't be written, don't let the payment be signed (observe never aborts).
          if (mode === "observe") return undefined;
          if (opts.deny === "throw") throw e;
          return { abort: true, reason: "audit_store_unavailable" };
        }
      }
    : (ctx) => lock(() => innerHook(ctx));

  function boundOpen(ctx) {
    if (!ctx || typeof ctx !== "object") return null;
    const id = bound.get(ctx) || ctx.audit?.reservationId || null;
    const rec = id ? budgets.get(id) : null;
    return rec && rec.status === "open" ? rec : null;
  }
  // Fallback when no reservation id reached us: the newest open reservation for this URL.
  function newestOpenFor(...urls) {
    const want = urls.filter(Boolean);
    if (!want.length) return null;
    return budgets.listOpen().filter((r) => want.includes(r.url)).sort((a, b) => b.n - a.n)[0] || null;
  }

  async function releaseOpen(ctx, info) {
    return lock(async () => {
      let rec = null;
      rec = boundOpen(ctx) || newestOpenFor(requirementOf(ctx)?.url);
      if (!rec || rec.status !== "open") return null;
      budgets.release(rec.id, { resign: "never", status: "skip" });
      await ledger.append({
        type: "released", agent: rec.agent, url: rec.url, amount: rec.amount.toString(), payTo: rec.payTo, network: rec.network, asset: rec.asset,
        id: rec.id, reason: info.reason || "skip", spotcheck_receipt: info.receipt || null, policyVersion: policy.version, resign: "never", safe_to_resign: false, ts: iso(now()),
      });
      return rec;
    });
  }

  // ctx is the before-payment hook context, when the caller passes it (spotCheckBeforePaymentHook does).
  async function onDecision(d, ctx) {
    if (!d || typeof d !== "object") return;
    try {
      await lock(async () => {
        await ledger.append({
          type: "decision", agent: opts.agentId || "default", url: d.url || null, reason: d.reason_code || d.verdict || null,
          spotcheck_receipt: d.receiptUrl || null, policyVersion: policy.version, ts: iso(now()),
          receipt_verified: null,
        });
        if (d.allowed === false) {
          const rec = boundOpen(ctx) || newestOpenFor(d.url, requirementOf(ctx)?.url);
          if (rec) {
            budgets.release(rec.id, { resign: "never", status: "skip" });
            await ledger.append({
              type: "released", agent: rec.agent, url: rec.url, amount: rec.amount.toString(), payTo: rec.payTo, network: rec.network, asset: rec.asset,
              id: rec.id, reason: d.reason_code || d.verdict || "skip", spotcheck_receipt: d.receiptUrl || null, policyVersion: policy.version,
              resign: "never", safe_to_resign: false, ts: iso(now()),
            });
          }
        }
      });
    } catch { /* the spot-check observer must not block the payment decision */ }
  }

  async function confirm(result) {
    if (pinned && result?.receipt) {
      const v = await verifyReceipt(result.receipt, { publicKey: pinned });
      if (!v.valid && result.receipt.kid) onUnknownKid(result.receipt.kid, v.reason);
      return { ...result, receipt_verified: v.valid === true, safe_to_resign: v.valid === true && result.safe_to_resign === true };
    }
    if (result?.receipt_verified === true) return result;
    return { ...result, receipt_verified: false, safe_to_resign: false };
  }

  async function applyResult(rec, result, via) {
    const advice = settlementAdvice(result);
    const tx = txOf(result);
    const statusId = statusIdOf(result);
    const common = {
      agent: rec.agent, url: rec.url, amount: rec.amount.toString(), payTo: rec.payTo, network: rec.network, asset: rec.asset,
      id: rec.id, policyVersion: policy.version, ts: iso(now()), status_receipt: statusId, receipt_verified: result.receipt_verified === true,
      safe_to_resign: result.safe_to_resign === true, reason: result.reason || result.status || advice.reason,
    };
    if (advice.move === "settle") {
      budgets.settle(rec.id, { txHash: tx });
      dropPayload(rec.id);
      await ledger.append({ ...common, type: via === "reconcile" ? "reconciled" : "settled", settlement_tx: tx, resign: "never", final: finalOf(result), safe_to_resign: false });
      return advice;
    }
    if (advice.move === "release") {
      budgets.release(rec.id, { resign: advice.resign, flag: advice.flag || null, status: result.status });
      dropPayload(rec.id);
      await ledger.append({ ...common, type: via === "reconcile" ? "reconciled" : "released", resign: advice.resign, flag: advice.flag || null, settlement_tx: tx });
      return advice;
    }
    rec.lastStatus = result.status || advice.reason;
    if (result.status === "unknown" || advice.reason === "unverified_status") {
      if (!rec.unknownSince) rec.unknownSince = now();
    }
    rec.checks += 1;
    rec.nextCheckAt = now() + backoffMs(rec.checks);
    if (via === "reconcile" && rec.lastLogged !== rec.lastStatus) {
      rec.lastLogged = rec.lastStatus;
      await ledger.append({ ...common, type: "reconciled", resign: advice.resign, final: false });
    }
    return advice;
  }

  async function attach(payload, url) {
    const decoded = decodePayment(payload);
    return lock(async () => {
      let rec = null;
      if (decoded?.nonce) rec = budgets.list().find((r) => r.nonce === decoded.nonce) || null;
      if (!rec) {
        const fits = (r, checkUrl) => {
          if (r.nonce) return false; // a payload already claimed this reservation; do not steal its nonce
          if (checkUrl && r.url && checkUrl !== r.url) return false;
          if (decoded?.amount != null && String(decoded.amount) !== r.amount.toString()) return false;
          if (decoded?.payTo && !samePayTo(decoded.payTo, r.payTo, decoded.network || r.network)) return false;
          return true;
        };
        const newest = (list) => list.sort((a, b) => b.n - a.n)[0] || null;
        rec = newest(budgets.listOpen().filter((r) => fits(r, url))) || (url ? newest(budgets.listOpen().filter((r) => fits(r, null))) : null);
      }
      if (!rec) {
        await ledger.append({ type: "risk_flag", agent: opts.agentId || "default", url: url || null, reason: "payment_without_reservation", payTo: decoded?.payTo || null, network: decoded?.network || null, amount: decoded?.amount ?? null, ts: iso(now()), policyVersion: policy.version });
        return null;
      }
      if (decoded?.nonce && !rec.nonce) rec.nonce = decoded.nonce;
      if (decoded?.validBefore != null) rec.validBefore = decoded.validBefore;
      await putPayload(rec.id, payload);
      return rec;
    });
  }

  async function onPayment(info = {}) {
    if (!info.paymentPayload) return;
    try { await attach(info.paymentPayload, info.url || null); }
    catch {
      try { await ledger.append({ type: "risk_flag", reason: "payload_not_stored", url: info.url || null, agent: opts.agentId || "default", ts: iso(now()), policyVersion: policy.version }); } catch { /* already fail-open */ }
    }
  }

  async function onAfterPay(result, ctx = {}) {
    const payload = ctx.paymentPayload || null;
    let rec = null;
    if (payload) rec = await attach(payload, ctx.url || null);
    const checked = await confirm(result || {});
    return lock(async () => {
      if (!rec && checked) {
        const decoded = payload ? decodePayment(payload) : null;
        if (decoded?.nonce) rec = budgets.list().find((r) => r.nonce === decoded.nonce) || null;
      }
      if (!rec || rec.status !== "open") return settlementAdvice(checked);
      return applyResult(rec, checked, "afterPay");
    });
  }

  function composeWith(spotHook) {
    if (typeof spotHook !== "function") throw new TypeError("composeWith expects the spot-check hook");
    return async (ctx) => {
      const first = await beforePayment(ctx);
      if (first && first.abort) return first;
      let second;
      try { second = await spotHook(ctx); }
      catch (e) {
        await releaseOpen(ctx, { reason: e?.reason || e?.message || "skip", receipt: e?.receiptUrl || e?.decision?.receiptUrl || null });
        throw e;
      }
      if (second && second.abort) {
        await releaseOpen(ctx, { reason: second.reason, receipt: null });
        return second;
      }
      return undefined;
    };
  }

  async function reconcile() {
    const due = await lock(() => budgets.listOpen().filter((r) => {
      if (now() < (r.nextCheckAt || 0)) return false;
      if (!hasPayload(r.id)) return r.openedAt + ESCALATE_AFTER_MS <= now();
      // No validBefore (Solana, non-EIP-3009): ask once the reservation is RECONCILE_AFTER_MS old.
      if (r.validBefore == null) return now() >= r.openedAt + RECONCILE_AFTER_MS;
      return now() >= r.validBefore * 1000 + RECONCILE_AFTER_MS;
    }).map((r) => r.id));
    const escalations = [];
    let checked = 0;
    for (const id of due) {
      const rec = budgets.get(id);
      if (!rec || rec.status !== "open") continue;
      let payload;
      try { payload = await getPayload(id); }
      catch (e) {
        // One unreadable blob (wrong key, tampered, swapped) must not stop the sweep.
        await lock(async () => {
          rec.nextCheckAt = now() + backoffMs((rec.checks || 0) + 1);
          if (rec.unreadableFlagged) return;
          rec.unreadableFlagged = true;
          await ledger.append({ type: "risk_flag", agent: rec.agent, url: rec.url, amount: rec.amount.toString(), payTo: rec.payTo, network: rec.network, id: rec.id, reason: "payload_unreadable", policyVersion: policy.version, ts: iso(now()) });
        });
        continue;
      }
      if (!payload) {
        await lock(async () => {
          if (rec.escalated || rec.status !== "open") return;
          rec.escalated = true;
          rec.unknownSince = rec.unknownSince || rec.openedAt;
          await ledger.append({ type: "risk_flag", agent: rec.agent, url: rec.url, amount: rec.amount.toString(), payTo: rec.payTo, network: rec.network, id: rec.id, reason: "unresolved_24h", policyVersion: policy.version, ts: iso(now()) });
          escalations.push({ reservationId: id, reason: "unresolved_24h", url: rec.url });
        });
        continue;
      }
      checked++;
      await lock(() => { rec.nextCheckAt = now() + backoffMs((rec.checks || 0) + 1); });
      const result = await afterPay({
        paymentPayload: payload,
        sellerUrl: rec.url || undefined,
        terms: { amount: rec.amount.toString(), payTo: rec.payTo || undefined, asset: rec.asset || undefined, network: rec.network || undefined },
      }, {
        fetch: opts.fetch, url: opts.paymentStatusUrl, apiKey: opts.apiKey, publicKey: pinned || undefined, verify: pinned ? true : opts.verify !== false, timeoutMs: opts.timeoutMs,
      });
      const checkedResult = await confirm(result);
      await lock(async () => {
        if (rec.status !== "open") return;
        await applyResult(rec, checkedResult, "reconcile");
        const since = rec.unknownSince || (rec.validBefore == null ? rec.openedAt : 0);
        const age = since ? now() - since : 0;
        if (rec.status === "open" && since && age >= ESCALATE_AFTER_MS && !rec.escalated) {
          rec.escalated = true;
          await ledger.append({ type: "risk_flag", agent: rec.agent, url: rec.url, amount: rec.amount.toString(), payTo: rec.payTo, network: rec.network, id: rec.id, reason: "unresolved_24h", status_receipt: statusIdOf(checkedResult), policyVersion: policy.version, ts: iso(now()) });
          escalations.push({ reservationId: id, reason: "unresolved_24h", url: rec.url, status: checkedResult.status, status_receipt: statusIdOf(checkedResult) });
        }
      });
    }
    if (escalations.length && typeof opts.onEscalate === "function") {
      try { await opts.onEscalate(escalations); } catch { /* escalation must not throw away the sweep result */ }
    }
    return { checked, escalations };
  }

  function paidKeys() {
    const keys = new Set();
    for (const r of budgets.list()) {
      if (r.status === "settled" || r.nonce) keys.add(payToKey(r.payTo, r.network));
    }
    return keys;
  }

  async function ingestSkips(list) {
    let rows = list;
    if (!Array.isArray(rows)) {
      // A feed outage is not a payment problem: priors stay as they were and the caller gets the error back.
      try { rows = await fetchSkips({ fetch: opts.fetch, url: opts.skipsUrl }); }
      catch (e) { return { added: 0, error: String((e && e.message) || e), view: risk.view(now()) }; }
    }
    return lock(async () => {
      const added = risk.ingest(rows, now());
      const paid = paidKeys();
      for (const row of risk.rows.values()) {
        if (!row.payToKey || !paid.has(row.payToKey)) continue;
        const reason = "paid_then_skipped:" + row.id;
        if (ledger.entries.some((e) => e.type === "risk_flag" && e.reason === reason)) continue;
        await ledger.append({
          type: "risk_flag", agent: opts.agentId || "default", url: row.url, payTo: row.payTo, network: row.network,
          reason, spotcheck_receipt: row.receiptUrl, policyVersion: policy.version, ts: iso(now()),
        });
      }
      return { added, view: risk.view(now()) };
    });
  }

  function mayResign(id) {
    const r = budgets.get(id);
    return !!(r && r.status === "released" && r.resign === "allowed");
  }
  ledger.decision = onDecision;
  ledger.settle = onAfterPay;

  return {
    version: AUDIT_VERSION,
    mode,
    policy,
    budgets,
    ledger,
    risk,
    beforePayment,
    onDecision,
    onPayment,
    onAfterPay,
    composeWith,
    reconcile,
    ingestSkips,
    mayResign,
    store,
    /** Persist pending changes (store only) and close the store. */
    async close() {
      if (!store) return;
      await lock(() => {});
      store.close();
    },
    openReservations: () => budgets.listOpen().map((r) => ({ ...r, amount: r.amount.toString() })),
    decision: onDecision,
    settle: onAfterPay,
    exportChain: (range) => ledger.exportChain(range),
    verifyChain: () => ledger.verify(),
    async exportState() {
      // Deep copies: editing the export must never change live state.
      return structuredClone({ entries: ledger.exportChain().entries, payloads: Object.fromEntries(blobs), reservations: budgets.list().map((r) => ({ ...r, amount: r.amount.toString() })) });
    },
  };
}

function normalizeKeys(publicKey) {
  if (!publicKey) return null;
  if (typeof publicKey === "string") return { keys: [{ kty: "OKP", crv: "Ed25519", x: publicKey }] };
  if (Array.isArray(publicKey)) return { keys: publicKey };
  if (publicKey.keys) return publicKey;
  return { keys: [publicKey] };
}

/** Pull /v1/skips.json, following same-origin `next` links, and return the skip rows. Rejects on HTTP or shape errors; `ingestSkips()` turns that into `{ added: 0, error }`. */
export async function fetchSkips({ fetch: fetchImpl = globalThis.fetch, url = SKIPS_URL, maxPages = 20 } = {}) {
  const out = [];
  const seen = new Set();
  const origin = new URL(url).origin;
  let next = url;
  let current = url;
  while (next && seen.size < maxPages) {
    if (seen.has(next)) break;
    seen.add(next);
    current = next;
    const res = await fetchImpl(next, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error("skips HTTP " + res.status);
    const body = await res.json();
    if (!body || typeof body !== "object") throw new TypeError("skips feed: body is not an object");
    const rows = Array.isArray(body) ? body : body.skips ?? body.receipts ?? [];
    if (!Array.isArray(rows)) throw new TypeError("skips feed: skips is not an array");
    out.push(...rows);
    next = null;
    if (!Array.isArray(body) && typeof body.next === "string" && body.next) {
      // Only follow `next` on the same origin as the first page.
      try {
        const u = new URL(body.next, current);
        if (u.origin === origin) next = u.href;
      } catch { /* bad next link: stop paging */ }
    }
  }
  return out;
}
