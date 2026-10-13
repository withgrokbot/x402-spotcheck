// 0.5.0: autoPayCheck + Solana terms hash. Mocks only: no network, no keys, no real payments.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as NEW from "./service-shim.mjs";
import * as OLD from "./fixtures/index-0.4.1.mjs"; // the published 0.4.1 code, verbatim
import { fakeWrapFetchWithPayment } from "./mock.mjs";

const { spotCheckFetch, spotCheckAxios, checkBeforePay, termsString, DEFAULT_ENDPOINT, CHECK_FEE_TERMS, expectedCheckFee, SpotCheckBlockedError } = NEW;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_PAYTO = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const FEE_PAYTO = "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const sha = (s) => createHash("sha256").update(s).digest("hex");
// The Worker's termsSha256 (src/lib.js, 0.23.1+), restated: network lower-cased; EVM asset/pay_to lower-cased; Solana as-is.
const workerHash = (pm) => { const sol = String(pm.network).toLowerCase().startsWith("solana:"); const a = sol ? (v) => String(v ?? "") : (v) => String(v ?? "").toLowerCase(); return sha([String(pm.network).toLowerCase(), a(pm.asset), String(pm.amount_atomic), a(pm.pay_to)].join("|")); };

const baseAcc = (amount = "500000") => ({ scheme: "exact", network: "eip155:8453", amount, asset: USDC, payTo: "0x" + "ab".repeat(20), maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } });
const solAcc = (amount = "1000000") => ({ scheme: "exact", network: SOL_NET, amount, asset: SOL_USDC, payTo: SOL_PAYTO, maxTimeoutSeconds: 300, extra: { feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4" } });
const feeAcc = (amount, o = {}) => ({ scheme: "exact", network: "eip155:8453", amount: String(amount), asset: USDC, payTo: FEE_PAYTO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" }, ...o });

// A mock world that records every request byte for byte, in order.
function world({ target = baseAcc(), spot402 = null, verdict = ["pay", "price_ok"], hashTerms = true, paidStatus = 200 } = {}) {
  const ev = [], log = [];
  let spotProbe = 0;
  const fetch = async (input, init = {}) => {
    const isReq = input instanceof Request;
    const url = isReq ? input.url : String(input);
    const h = new Headers(init.headers || (isReq ? input.headers : {}));
    log.push(JSON.stringify({ url, method: init.method || (isReq ? input.method : "GET"), headers: [...h.entries()].sort(), body: init.body ?? null }));
    const paid = h.get("payment-signature") || h.get("x-payment");
    if (url.startsWith(DEFAULT_ENDPOINT)) {
      if (!paid && spot402) {
        const accepts = typeof spot402 === "function" ? spot402(spotProbe++) : spot402;
        const req = { x402Version: 2, resource: { url }, accepts };
        ev.push("spot:402");
        return new Response(JSON.stringify(req), { status: 402, headers: { "payment-required": b64(req) } });
      }
      ev.push(paid ? "spot:paid" : "spot:free");
      if (paid && paidStatus !== 200) return new Response("err", { status: paidStatus });
      const pm = { scheme: target.scheme, network: target.network, asset: target.asset, amount_atomic: target.amount, pay_to: target.payTo };
      const body = verdict[0] !== "pay" ? { verdict: verdict[0], reason: verdict[1], payment: null, payment_terms_sha256: null }
        : paid ? { verdict: "pay", reason: "price_ok", payment: pm, payment_terms_sha256: workerHash(pm), access: { tier: "paid" } }
        : { verdict: "pay", reason: "price_ok", payment_terms_sha256: hashTerms ? workerHash(pm) : null, access: { tier: "free" } };
      return Response.json({ ...body, receipt_url: "https://402xagent.com/v1/receipts/sc-test" });
    }
    if (!paid) { const c = { x402Version: 2, resource: { url }, accepts: [target] }; ev.push("target:402"); return new Response(JSON.stringify(c), { status: 402, headers: { "content-type": "application/json", "payment-required": b64(c) } }); }
    ev.push("target:paid");
    return Response.json({ ok: true });
  };
  return { fetch, ev, log, spotPaid: () => ev.filter((e) => e === "spot:paid").length, targetPaid: () => ev.filter((e) => e === "target:paid").length };
}
const ap = (o = {}) => ({ wrapFetch: fakeWrapFetchWithPayment, maxPerCheck: 0.1, dailyCap: 1, ...o });
const run = (w, opts, url = "https://seller.test/api") => fakeWrapFetchWithPayment(spotCheckFetch(w.fetch, opts))(url);

const T = [];
const test = (n, f) => T.push([n, f]);

// ---------------------------------------------------------------- off = 0.4.1, byte for byte
const SCENARIOS = [
  ["pay, hash", {}, {}],
  ["pay, no hash", { hashTerms: false }, {}],
  ["skip", { verdict: ["skip", "pay_to_mismatch"] }, {}],
  ["recheck allowed", { verdict: ["recheck", "timeout"] }, { onRecheck: "allow" }],
  ["check 402, no payFetch", { spot402: [feeAcc(50000)] }, {}],
  ["check 402, legacy payFetch", { spot402: [feeAcc(50000)] }, "PAYFETCH"],
  ["check 402, legacy payFetch over maxCheckUsd", { spot402: [feeAcc(250000)] }, "PAYFETCH"],
  ["expected + POST", {}, { client: "r1", expected: () => ({ price: 0.5, payTo: "0x" + "ab".repeat(20), network: "eip155:8453" }) }],
  ["solana target, paid terms", { target: solAcc(), spot402: [feeAcc(100000)] }, "PAYFETCH"],
];
test("1.0.0 service mode with 0.x settings (ref, onRecheck: block, solana): requests byte-identical to 0.4.1", async () => {
  for (const [name, wo, o] of SCENARIOS) {
    const out = [];
    for (const mod of [OLD, NEW]) {
      const w = world(wo);
      const compat = mod === NEW ? { ref: NEW.DEFAULT_REF, onRecheck: "block", solana: true, unavailableTtlMs: 0 } : {};
      const opts = { ...compat, ...(o === "PAYFETCH" ? { payFetch: fakeWrapFetchWithPayment(w.fetch) } : o) };
      const init = name.includes("POST") ? { method: "POST", body: "{}" } : undefined;
      let err = null;
      try { await fakeWrapFetchWithPayment(mod.spotCheckFetch(w.fetch, opts))("https://seller.test/api?q=1", init); } catch (e) { err = e.name + ":" + e.reason; }
      await mod.checkBeforePay("https://seller.test/x", { ...compat, fetch: w.fetch, price: 0.5, client: "c" });
      const handlers = [];
      mod.spotCheckAxios({ interceptors: { request: { use: (f) => handlers.push(f) }, response: { use: () => {} } } }, { ...compat, fetch: w.fetch });
      try { await handlers[0]({ url: "https://seller.test/ax", method: "get", headers: { "X-PAYMENT": b64({ accepted: baseAcc() }) } }); } catch (e) { err = (err || "") + "|" + e.reason; }
      out.push({ log: w.log, ev: w.ev, err });
    }
    assert.deepEqual(out[1], out[0], "scenario differs from 0.4.1: " + name);
    assert.ok(out[0].log.length > 0);
  }
});

test("autoPayCheck off: a 402 from the check is never paid without payFetch", async () => {
  const w = world({ spot402: [feeAcc(50000)] });
  assert.equal((await run(w, {})).status, 200);
  assert.equal(w.spotPaid(), 0);
});

// ---------------------------------------------------------------- on: Base + Solana paths
test("Base target: check fee paid first (same signer), paid verdict used, then the seller", async () => {
  const w = world({ spot402: [feeAcc(50000)] });
  const ds = [];
  assert.equal((await run(w, { autoPayCheck: ap(), onDecision: (d) => ds.push(d) })).status, 200);
  assert.deepEqual(w.ev, ["target:402", "spot:402", "spot:402", "spot:paid", "target:paid"]);
  assert.equal(ds[0].raw.access.tier, "paid");
  assert.ok(ds[0].approved.payment, "paid terms enforced on the seller payment");
});
test("Solana target: fee (1/10 of $1) paid on Base, Solana seller paid with the exact base58 terms", async () => {
  const w = world({ target: solAcc("1000000"), spot402: [feeAcc(100000)] });
  assert.equal((await run(w, { solana: true, autoPayCheck: ap({ maxPerCheck: 0.1 }) })).status, 200);
  assert.deepEqual(w.ev, ["target:402", "spot:402", "spot:402", "spot:paid", "target:paid"]);
  const off = world({ target: solAcc("1000000"), spot402: [feeAcc(100000)] });
  assert.equal((await run(off, { autoPayCheck: ap() })).status, 200);
  assert.deepEqual(off.ev, ["target:402", "target:paid"], "1.0.0: Solana passes through untouched unless solana: true");
});
test("Solana target on the free tier: the hash now matches the Worker (0.4.1 refused to sign)", async () => {
  const w = world({ target: solAcc() });
  assert.equal((await run(w, { solana: true })).status, 200);
  assert.ok(w.ev.includes("spot:free"), "the check ran");
  assert.equal(w.targetPaid(), 1);
  const w0 = world({ target: solAcc() });
  await assert.rejects(fakeWrapFetchWithPayment(OLD.spotCheckFetch(w0.fetch))("https://seller.test/api"), /terms differ/);
});
test("terms hash: Solana keeps base58 case, Base stays lower-case (identical to 0.4.1)", () => {
  const sol = { network: SOL_NET, asset: SOL_USDC, amount_atomic: "1000000", pay_to: SOL_PAYTO };
  assert.equal(termsString(sol), `solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp|${SOL_USDC}|1000000|${SOL_PAYTO}`);
  assert.equal(sha(termsString(sol)), workerHash(sol));
  const evm = { network: "eip155:8453", asset: USDC, amount_atomic: "10000", pay_to: "0xAbCd" + "ab".repeat(18) };
  assert.equal(termsString(evm), OLD.termsString(evm));
  assert.equal(sha(termsString(evm)), workerHash(evm));
  // paid tier: Solana pay_to compares case-sensitively, like the Worker's sameAddr
  return NEW.termsMismatch({ ...solAcc(), payTo: SOL_PAYTO.toLowerCase() }, { payment: { network: SOL_NET, asset: SOL_USDC, amount_atomic: "1000000", pay_to: SOL_PAYTO } }).then((why) => assert.match(why, /pay_to differs/));
});

// ---------------------------------------------------------------- caps
test("per-check cap: fee above maxPerCheck is not paid; falls back to today's behaviour", async () => {
  const w = world({ spot402: [feeAcc(50000)] });
  const ds = [];
  assert.equal((await run(w, { autoPayCheck: ap({ maxPerCheck: 0.049 }), onDecision: (d) => ds.push(d) })).status, 200);
  assert.equal(w.spotPaid(), 0);
  assert.equal(ds[0].verdict, "unavailable");
  assert.match(ds[0].reason, /maxPerCheck/);
  const w2 = world({ spot402: [feeAcc(50000)] });
  await assert.rejects(run(w2, { autoPayCheck: ap({ maxPerCheck: 0.049 }), onUnavailable: "block" }), SpotCheckBlockedError);
  assert.equal(w2.targetPaid(), 0);
});
test("daily cap: per process, exact boundary, and never exceeded under concurrency", async () => {
  const w = world({ spot402: [feeAcc(50000)] });
  const g = fakeWrapFetchWithPayment(spotCheckFetch(w.fetch, { autoPayCheck: ap({ dailyCap: 0.1 }) }));
  for (const u of ["https://a.test/1", "https://a.test/2", "https://a.test/3"]) await g(u);
  assert.equal(w.spotPaid(), 2, "0.05 + 0.05 = cap; third would exceed");
  const c = world({ spot402: [feeAcc(50000)] });
  const gc = fakeWrapFetchWithPayment(spotCheckFetch(c.fetch, { autoPayCheck: ap({ dailyCap: 0.05 }) }));
  await Promise.all(["https://c.test/1", "https://c.test/2", "https://c.test/3", "https://c.test/4"].map((u) => gc(u)));
  assert.equal(c.spotPaid(), 1, "parallel checks reserve before paying");
});
test("daily cap: spendStore hook persists spend and blocks when its total is at the cap", async () => {
  const db = new Map();
  const store = { get: async (d) => db.get(d) || 0, add: async (d, a) => db.set(d, (db.get(d) || 0) + a) };
  const w = world({ spot402: [feeAcc(50000)] });
  await run(w, { autoPayCheck: ap({ dailyCap: 0.1, spendStore: store }) }, "https://s.test/1");
  assert.equal([...db.values()][0], 50000);
  const w2 = world({ spot402: [feeAcc(50000)] }); // a "restarted" process sharing the store
  await run(w2, { autoPayCheck: ap({ dailyCap: 0.1, spendStore: store }) }, "https://s.test/2");
  await run(w2, { autoPayCheck: ap({ dailyCap: 0.1, spendStore: store }) }, "https://s.test/3");
  assert.equal(w2.spotPaid(), 1);
  assert.equal([...db.values()][0], 100000);
});
test("fraction cap: fee must be <= 25% of the target price (configurable lower only)", async () => {
  const at25 = world({ target: baseAcc("40000"), spot402: [feeAcc(10000)] }); // $0.01 of $0.04
  await run(at25, { autoPayCheck: ap() });
  assert.equal(at25.spotPaid(), 1);
  const cheap = world({ target: baseAcc("30000"), spot402: [feeAcc(10000)] }); // $0.01 minimum is 33% of $0.03
  await run(cheap, { autoPayCheck: ap() });
  assert.equal(cheap.spotPaid(), 0);
  const lower = world({ spot402: [feeAcc(50000)] });
  await run(lower, { autoPayCheck: ap({ maxFraction: 0.05 }) });
  assert.equal(lower.spotPaid(), 0);
  assert.throws(() => spotCheckFetch(fetch, { autoPayCheck: ap({ maxFraction: 0.5 }) }), /maxFraction/);
  assert.throws(() => spotCheckFetch(fetch, { autoPayCheck: ap({ dailyCap: 0 }) }), /dailyCap/);
  assert.throws(() => spotCheckFetch(fetch, { autoPayCheck: { maxPerCheck: 0.1, dailyCap: 1 } }), /wrapFetch/);
});
test("terms: only the documented 402xAgent pay_to / asset / network, and exactly 1/10 within bounds", async () => {
  assert.deepEqual([expectedCheckFee(500000), expectedCheckFee(1000), expectedCheckFee(1e9)], [50000, 10000, 250000]);
  for (const bad of [feeAcc(50000, { payTo: "0x" + "66".repeat(20) }), feeAcc(50000, { asset: "0x" + "99".repeat(20) }), feeAcc(50000, { network: "eip155:84532" }),
    feeAcc(50000, { network: SOL_NET, asset: SOL_USDC, payTo: SOL_PAYTO }), feeAcc(60000), feeAcc(5000), feeAcc(50000, { scheme: "upto" })]) {
    const w = world({ spot402: [bad] });
    await run(w, { autoPayCheck: ap() });
    assert.equal(w.spotPaid(), 0, JSON.stringify(bad));
  }
  const unknown = world({ target: { ...baseAcc(), asset: "0x" + "77".repeat(20) }, spot402: [feeAcc(50000)] }); // non-USDC target: price unknown
  await run(unknown, { autoPayCheck: ap() });
  assert.equal(unknown.spotPaid(), 0);
});

// ---------------------------------------------------------------- errors -> fallback
test("errors fall back to today's behaviour and release the reservation when nothing was signed", async () => {
  const cases = [
    ["signer throws", { wrapFetch: () => async () => { throw new Error("wallet locked"); } }, {}],
    ["fee changes on the second probe", {}, { spot402: (i) => [feeAcc(i === 0 ? 50000 : 60000)] }],
    ["signer signs a different amount", { wrapFetch: (f) => async (u, init) => { await f(u, init); return f(u, { headers: { "PAYMENT-SIGNATURE": b64({ accepted: feeAcc(250000) }) } }); } }, {}],
    ["signer pays twice", { wrapFetch: (f) => async (u, init) => { const h = { "PAYMENT-SIGNATURE": b64({ accepted: feeAcc(50000) }) }; await f(u, { headers: h }); return f(u, { headers: h }); } }, {}],
    ["spendStore.get throws", { spendStore: { get: async () => { throw new Error("db down"); }, add: async () => {} } }, {}],
    ["paid check answers 500", {}, { paidStatus: 500 }],
    ["unreadable 402", {}, { spot402: "nope" }],
  ];
  for (const [name, o, wo] of cases) {
    const w = world({ spot402: [feeAcc(50000)], ...wo });
    const ds = [];
    const r = await run(w, { autoPayCheck: ap({ dailyCap: 0.05, ...o }), onDecision: (d) => ds.push(d) });
    assert.equal(r.status, 200, name);
    assert.equal(ds[0].verdict, "unavailable", name);
    assert.equal(w.spotPaid(), ["paid check answers 500", "signer pays twice"].includes(name) ? 1 : 0, name + ": no extra signed fee left the process");
    assert.equal(w.targetPaid(), 1, name + ": seller still paid exactly as without autoPayCheck");
  }
  // after a failure with nothing signed, the budget is intact: a good check still fits a cap of one fee
  let n = 0;
  const w = world({ spot402: [feeAcc(50000)] });
  const g = fakeWrapFetchWithPayment(spotCheckFetch(w.fetch, { autoPayCheck: ap({ dailyCap: 0.05, wrapFetch: (f) => (n++ === 0 ? async () => { throw new Error("x"); } : fakeWrapFetchWithPayment(f)) }) }));
  await g("https://e.test/1"); await g("https://e.test/2");
  assert.equal(w.spotPaid(), 1);
  // a signed-but-failed payment stays counted: the cap is never exceeded
  const f = world({ spot402: [feeAcc(50000)], paidStatus: 500 });
  const gf = fakeWrapFetchWithPayment(spotCheckFetch(f.fetch, { autoPayCheck: ap({ dailyCap: 0.05 }) }));
  await gf("https://f.test/1"); await gf("https://f.test/2");
  assert.equal(f.spotPaid(), 1);
});
test("axios response path and checkBeforePay({ accepts }) use autoPayCheck too", async () => {
  const w = world({ spot402: [feeAcc(50000)] });
  const d = await checkBeforePay("https://seller.test/api", { fetch: w.fetch, autoPayCheck: ap(), accepts: [baseAcc()] });
  assert.equal(d.raw.access.tier, "paid");
  const w2 = world({ spot402: [feeAcc(50000)] });
  let onErr;
  spotCheckAxios({ interceptors: { request: { use: () => {} }, response: { use: (_, f) => (onErr = f) } } }, { fetch: w2.fetch, autoPayCheck: ap() });
  const c = { x402Version: 2, accepts: [baseAcc()] };
  const err = { response: { status: 402, headers: { "payment-required": b64(c) }, data: c }, config: { url: "https://seller.test/ax", method: "get", headers: {} } };
  await assert.rejects(onErr(err), (e) => e === err);
  assert.equal(w2.spotPaid(), 1);
  assert.equal(CHECK_FEE_TERMS.payTo, FEE_PAYTO);
});

let ok = 0;
for (const [n, f] of T) {
  try { await f(); ok++; console.log("PASS " + n); } catch (e) { console.log("FAIL " + n + "\n  " + (e.stack || e).toString().split("\n").slice(0, 6).join("\n  ")); }
}
console.log(`${ok}/${T.length} autopay tests passed`);
process.exit(ok === T.length ? 0 : 1);
