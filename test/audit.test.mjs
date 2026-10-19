// 1.5.0 audit layer. node --test test/audit.test.mjs (no network: payment-status and skips are injected)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAudit, createLedger, settlementAdvice, skipReasonCode, AUDIT_VERSION } from "../audit.js";
import { canonicalize } from "../receipt.js";
import { composeBeforePaymentHooks, spotCheckBeforePaymentHook, spotCheckFetch, PAYMENT_STATUS_URL } from "../index.js";
import { sampleContext, SAMPLE_REQUIREMENT } from "../testkit.js";

const URL = "https://seller.example/api";
const USDC = SAMPLE_REQUIREMENT.asset;
const T0 = Date.parse("2026-10-16T17:05:11Z");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const pay = (extra = {}) => b64({
  x402Version: 2,
  accepted: { scheme: "exact", network: "eip155:8453", amount: extra.amount || "10000", asset: USDC, payTo: extra.payTo || SAMPLE_REQUIREMENT.payTo },
  payload: { authorization: { from: "0x" + "11".repeat(20), to: extra.payTo || SAMPLE_REQUIREMENT.payTo, value: extra.amount || "10000", validBefore: String(extra.validBefore ?? 1_700_000_000), nonce: extra.nonce || "0x" + "22".repeat(32) } },
});
function ctx(amount = "10000", extra = {}) {
  const req = { ...SAMPLE_REQUIREMENT, amount: String(amount), ...(extra.req || {}) };
  return { paymentRequired: { x402Version: 2, resource: { url: extra.url || URL }, accepts: [req] }, selectedRequirements: req, ...(extra.ctx || {}) };
}
function make(opts = {}) {
  let now = opts.at ?? T0;
  const { at, policy, ...rest } = opts;
  const layer = createAudit({ agentId: "agent-7", now: () => now, policy: { version: "2026-10-14.3", ...(policy || {}) }, ...rest });
  return { layer, setNow(t) { now = t; } };
}

async function signed(body) {
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const x = (await crypto.subtle.exportKey("jwk", publicKey)).x;
  const rc = { ...body, kid: "t-1" };
  const sig = Buffer.from(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(canonicalize(rc)))).toString("base64url");
  return { receipt: { ...rc, signature: sig }, key: { kty: "OKP", crv: "Ed25519", kid: "t-1", x } };
}

test("ledger is append-only and hash-chained", async () => {
  const ledger = createLedger({ now: () => T0 });
  const a = await ledger.append({ type: "denied", agent: "agent-7", url: URL, amount: "10000", payTo: SAMPLE_REQUIREMENT.payTo, network: "eip155:8453", asset: USDC, policyVersion: "2026-10-14.3", reason: "per_call_ceiling" });
  const b = await ledger.append({ type: "reserved", agent: "agent-7", url: URL, amount: "1000", id: "rsv_1", policyVersion: "2026-10-14.3", reason: "allow" });
  assert.equal(a.seq, 1);
  assert.equal(a.prev_hash, "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(b.prev_hash, a.hash);
  assert.equal(a.amount_usdc, "0.01");
  assert.equal(a.ts, "2026-10-16T17:05:11Z");
  assert.equal((await ledger.verify()).valid, true);
  a.amount_usdc = "9";
  const bad = await ledger.verify();
  assert.equal(bad.valid, false);
  assert.equal(bad.seq, 1);
  const exported = JSON.stringify(ledger.exportChain());
  assert.equal(exported.includes("PAYMENT-SIGNATURE"), false);
});

test("settlement advice never re-signs an unverified or landed result", () => {
  assert.deepEqual(settlementAdvice({ status: "landed", receipt_verified: true, safe_to_resign: true }), { move: "settle", resign: "never" });
  assert.equal(settlementAdvice({ status: "not_landed", receipt_verified: true, safe_to_resign: true }).resign, "allowed");
  assert.equal(settlementAdvice({ status: "not_landed", receipt_verified: true, safe_to_resign: false }).resign, "never");
  assert.equal(settlementAdvice({ status: "pending", receipt_verified: true }).resign, "resend");
  assert.equal(settlementAdvice({ status: "canceled", receipt_verified: true, safe_to_resign: true }).resign, "new_decision");
  assert.equal(settlementAdvice({ status: "landed", receipt_verified: false, safe_to_resign: true }).move, "hold");
  assert.equal(settlementAdvice({ status: "unknown" }).resign, "never");
});

test("enforce: ceiling, allowlist, and velocity deny before a reservation", async () => {
  const { layer } = make({ policy: { perCallCeilingAtomic: 5000, networks: ["eip155:8453"], payToDeny: ["0x" + "cd".repeat(20)], velocity: { max: 2, windowMs: 60_000 } } });
  const over = await layer.beforePayment(ctx("10000"));
  assert.equal(over.abort, true);
  assert.match(over.reason, /per_call_ceiling/);
  assert.equal(layer.openReservations().length, 0);
  assert.equal(layer.ledger.entries.at(-1).type, "denied");
  const wrongNet = await layer.beforePayment(ctx("1000", { req: { network: "eip155:84532" } }));
  assert.match(wrongNet.reason, /network_not_allowed/);
  const deniedTo = await layer.beforePayment(ctx("1000", { req: { payTo: "0x" + "CD".repeat(20) } }));
  assert.match(deniedTo.reason, /pay_to_denied/);
  assert.equal(await layer.beforePayment(ctx("1000")), undefined);
  assert.equal(await layer.beforePayment(ctx("1000")), undefined);
  const fast = await layer.beforePayment(ctx("1000"));
  assert.match(fast.reason, /velocity/);
  assert.equal(layer.openReservations().length, 2);
});

test("concurrent reserves cannot share one remaining budget", async () => {
  const { layer } = make({ policy: { dailyBudgetAtomic: 15_000, perCallCeilingAtomic: 10_000 } });
  const results = await Promise.all([layer.beforePayment(ctx()), layer.beforePayment(ctx()), layer.beforePayment(ctx())]);
  const allowed = results.filter((r) => r == null);
  const denied = results.filter((r) => r && r.abort);
  assert.equal(allowed.length, 1);
  assert.equal(denied.length, 2);
  assert.match(denied[0].reason, /budget_exhausted/);
  assert.equal(layer.openReservations().length, 1);
  assert.equal(layer.budgets.remaining("agent-7", T0), 5000n);
});

test("observe logs the deny and does not reserve or abort", async () => {
  const { layer } = make({ mode: "observe", policy: { perCallCeilingAtomic: 5000 } });
  assert.equal(await layer.beforePayment(ctx()), undefined);
  const row = layer.ledger.entries.at(-1);
  assert.equal(row.type, "denied");
  assert.equal(row.observe, true);
  assert.equal(row.reason, "per_call_ceiling");
  assert.equal(layer.openReservations().length, 0);
});

test("outage fails closed above the threshold and open below it", async () => {
  const down = { version: "9", evaluate() { throw new Error("audit down"); } };
  const { layer } = make({ policy: down, failClosedAboveAtomic: 5000 });
  const high = await layer.beforePayment(ctx("10000"));
  assert.match(high.reason, /audit_unavailable/);
  assert.equal(layer.ledger.entries.at(-1).type, "denied");
  const low = await layer.beforePayment(ctx("1000"));
  assert.equal(low, undefined);
  assert.equal(layer.ledger.entries.at(-1).type, "decision");
  assert.equal(layer.ledger.entries.at(-1).reason, "audit_unavailable");
  assert.equal(layer.openReservations().length, 0);
});

test("deny: throw matches the hook sample", async () => {
  const { layer } = make({ deny: "throw", policy: { perCallCeilingAtomic: 1 } });
  await assert.rejects(layer.beforePayment(ctx()), (e) => e.code === "audit_deny" && /per_call_ceiling/.test(e.message));
});

test("a spending cap in front of the audit hook never reserves", async () => {
  const { layer } = make({ policy: { dailyBudgetAtomic: 1_000_000 } });
  const cap = async ({ selectedRequirements }) => (BigInt(selectedRequirements.amount) > 5000n ? { abort: true, reason: "over cap" } : undefined);
  const chain = composeBeforePaymentHooks(cap, layer.beforePayment);
  assert.deepEqual(await chain(ctx()), { abort: true, reason: "over cap" });
  assert.equal(layer.ledger.entries.length, 0);
});

test("spot-check skip releases the reservation and keeps the receipt url", async () => {
  const { layer } = make({ policy: { dailyBudgetAtomic: 1_000_000 } });
  const spot = spotCheckBeforePaymentHook({ expected: () => ({ price: 0.001 }), onDecision: layer.onDecision });
  const chain = composeBeforePaymentHooks(layer.beforePayment, spot);
  const result = await chain(sampleContext(URL));
  assert.equal(result.abort, true);
  assert.match(result.reason, /price_mismatch/);
  assert.equal(layer.openReservations().length, 0);
  const released = layer.ledger.entries.filter((e) => e.type === "released");
  assert.equal(released.length, 1);
  assert.match(released[0].reason, /price_mismatch/);
  assert.equal(layer.budgets.remaining("agent-7", T0), 1_000_000n);
  const { layer: tap } = make({});
  assert.equal(await tap.beforePayment(ctx()), undefined);
  await tap.onDecision({ url: URL, verdict: "skip", reason_code: "pay_to_mismatch", allowed: false, receiptUrl: "https://402xagent.com/v1/receipts/sc-96e5586bcffcfab8" });
  assert.equal(tap.openReservations().length, 0);
  assert.equal(tap.ledger.entries.some((e) => e.spotcheck_receipt === "https://402xagent.com/v1/receipts/sc-96e5586bcffcfab8"), true);
});

test("composeWith releases when the spot hook aborts without onDecision", async () => {
  const { layer } = make({});
  const chain = layer.composeWith(async () => ({ abort: true, reason: "x402-spotcheck: pay_to_mismatch: pays a different wallet" }));
  const result = await chain(ctx());
  assert.match(result.reason, /pay_to_mismatch/);
  assert.equal(layer.openReservations().length, 0);
  assert.equal(layer.ledger.entries.some((e) => e.type === "reserved"), true);
  assert.match(layer.ledger.entries.at(-1).reason, /pay_to_mismatch/);
});

test("afterPay transitions: landed, not_landed, pending, canceled, unknown, unverified", async () => {
  const { layer } = make({ policy: { dailyBudgetAtomic: 50_000 } });
  let n = 0;
  const send = async (status, extra = {}) => {
    assert.equal(await layer.beforePayment(ctx(extra.payAmount || "10000")), undefined);
    const id = layer.openReservations().at(-1).id;
    const nonce = extra.nonce || status + ":" + (++n);
    const advice = await layer.onAfterPay({ status, receipt_verified: true, id: "ps-0123456789abcdef", tx: { hash: "0xabc", confirmations: extra.conf ?? 12 }, finality: { confirmations: extra.conf ?? 12, min_confirmations: 10, reorg_safe: extra.final !== false }, ...extra }, { url: URL, paymentPayload: pay({ nonce, amount: extra.payAmount || "10000" }) });
    return { id, advice };
  };
  const landed = await send("landed", { nonce: "landed" });
  assert.equal(landed.advice.move, "settle");
  assert.equal(layer.mayResign(landed.id), false);
  const row = layer.ledger.entries.find((e) => e.type === "settled");
  assert.equal(row.settlement_tx, "0xabc");
  assert.equal(row.status_receipt, "ps-0123456789abcdef");
  assert.equal(row.final, true);
  assert.equal(JSON.stringify(layer.exportChain()).includes(pay({ nonce: "landed" })), false);
  await layer.onAfterPay({ status: "landed", receipt_verified: true, id: "ps-0123456789abcdef" }, { url: URL, paymentPayload: pay({ nonce: "landed" }) });
  assert.equal(layer.ledger.entries.filter((e) => e.type === "settled").length, 1);

  const freed = await send("not_landed", { safe_to_resign: true, reason: "expired_unused" });
  assert.equal(layer.mayResign(freed.id), true);
  assert.equal(layer.budgets.get(freed.id).status, "released");

  const held = await send("not_landed", { safe_to_resign: false });
  assert.equal(layer.mayResign(held.id), false);
  assert.equal(layer.budgets.get(held.id).status, "released");

  const pending = await send("pending");
  assert.equal(layer.budgets.get(pending.id).status, "open");
  assert.equal(layer.mayResign(pending.id), false);
  assert.equal(pending.advice.resign, "resend");

  const canceled = await send("canceled", { safe_to_resign: true });
  assert.equal(layer.budgets.get(canceled.id).flag, "canceled");
  assert.equal(layer.mayResign(canceled.id), false);

  const unknown = await send("unknown");
  assert.equal(layer.budgets.get(unknown.id).status, "open");

  assert.equal(await layer.beforePayment(ctx("1000")), undefined);
  const open = layer.openReservations().find((r) => r.amount === "1000");
  await layer.onAfterPay({ status: "landed", receipt_verified: false, safe_to_resign: true, id: "ps-bad" }, { url: URL, paymentPayload: pay({ nonce: "bad", amount: "1000" }) });
  assert.equal(layer.budgets.get(open.id).status, "open");
  assert.equal((await layer.verifyChain()).valid, true);
});

test("reconciler waits for validBefore + 120s, verifies, and escalates the 24h tail", async () => {
  const calls = [];
  const escalations = [];
  let answer = { status: "pending", safe_to_resign: false, id: "ps-wait" };
  const { receipt, key } = await signed({ status: "landed", id: "ps-landed", safe_to_resign: false });
  const fetch = async (url) => {
    calls.push(String(url));
    if (String(url) !== PAYMENT_STATUS_URL) throw new Error("unexpected " + url);
    return Response.json(answer);
  };
  const { layer, setNow } = make({ at: T0, fetch, publicKey: { keys: [key] }, onEscalate(rows) { escalations.push(...rows); } });
  const future = Math.floor(T0 / 1000) + 1000;
  assert.equal(await layer.beforePayment(ctx()), undefined);
  await layer.onPayment({ url: URL, paymentPayload: pay({ validBefore: future, nonce: "future" }) });
  assert.deepEqual(await layer.reconcile(), { checked: 0, escalations: [] });
  assert.equal(calls.length, 0);

  setNow(future * 1000 + 120_000);
  answer = { status: "landed", safe_to_resign: false, id: "ps-landed", tx: { hash: "0x" + "ab".repeat(32), confirmations: 12 }, finality: { confirmations: 12, min_confirmations: 10, reorg_safe: true }, receipt };
  const swept = await layer.reconcile();
  assert.equal(swept.checked, 1);
  assert.equal(calls.length, 1);
  assert.equal(layer.openReservations().length, 0);
  assert.equal(layer.ledger.entries.some((e) => e.type === "reconciled" && e.settlement_tx && e.settlement_tx.startsWith("0xab")), true);

  answer = { status: "unknown", id: "ps-unknown" };
  assert.equal(await layer.beforePayment(ctx()), undefined);
  const past = Math.floor(T0 / 1000) - 500;
  await layer.onPayment({ url: URL, paymentPayload: pay({ validBefore: past, nonce: "stuck" }) });
  setNow(past * 1000 + 120_000);
  await layer.reconcile();
  assert.equal(layer.openReservations().length, 1);
  setNow(past * 1000 + 120_000 + 24 * 60 * 60 * 1000 + 1000);
  const tail = await layer.reconcile();
  assert.equal(tail.escalations.length, 1);
  assert.equal(tail.escalations[0].reason, "unresolved_24h");
  assert.equal(escalations.length, 1);
  assert.equal(layer.ledger.entries.some((e) => e.reason === "unresolved_24h"), true);
});

test("unknown kid is not applied, and a pinned key verifies", async () => {
  const kids = [];
  const { receipt, key } = await signed({ status: "landed", id: "ps-kid", safe_to_resign: false });
  const other = { ...receipt, kid: "rotated" };
  const fetch = async () => Response.json({ status: "landed", safe_to_resign: true, id: "ps-kid", tx: { hash: "0x1" }, receipt: other });
  const { layer } = make({ fetch, publicKey: { keys: [key] }, onUnknownKid(kid) { kids.push(kid); } });
  const past = Math.floor(T0 / 1000) - 500;
  assert.equal(await layer.beforePayment(ctx()), undefined);
  await layer.onPayment({ url: URL, paymentPayload: pay({ validBefore: past, nonce: "kid" }) });
  await layer.reconcile();
  assert.deepEqual(kids, ["rotated"]);
  assert.equal(layer.openReservations().length, 1);
  assert.equal(layer.mayResign(layer.openReservations()[0].id), false);
});

test("payload is encrypted at rest and absent from the chain", async () => {
  const { layer } = make({ payloadKey: "audit-secret" });
  const payload = pay({ nonce: "secret-nonce" });
  assert.equal(await layer.beforePayment(ctx()), undefined);
  await layer.onPayment({ url: URL, paymentPayload: payload });
  const state = await layer.exportState();
  const dumped = JSON.stringify({ chain: layer.exportChain(), payloads: state.payloads });
  assert.equal(dumped.includes(payload), false);
  assert.equal(dumped.includes("secret-nonce"), false);
  assert.equal(Object.keys(state.payloads).length, 1);
});

test("skips feed: testnet-to-mainnet denies, price steps up, repeats deny, paid history joins", async () => {
  const payTo = "0x" + "b1".repeat(20);
  const { layer } = make({ policy: { dailyBudgetAtomic: 1_000_000 } });
  assert.equal(skipReasonCode({ reason: "asks for payment on a different network than listed" }), "network_mismatch");
  await layer.ingestSkips([{
    id: "b5e13e8271", url: "https://topagentx402.vercel.app/api/send-token", pay_to: payTo,
    network: "eip155:8453", listed_network: "eip155:84532", verdict: "skip",
    reason: "asks for payment on a different network than listed (listed eip155:84532, offers eip155:8453)",
    timestamp: "2026-10-13T14:55:57Z",
  }]);
  const blocked = await layer.beforePayment(ctx("1000", { req: { payTo } }));
  assert.match(blocked.reason, /risk_testnet_listed_mainnet_charged/);

  const { layer: prices } = make({ policy: { dailyBudgetAtomic: 1_000_000 } });
  const seller = "0x" + "d4".repeat(20);
  await prices.ingestSkips([{ id: "price-1", pay_to: seller, network: "eip155:8453", verdict: "skip", reason: "asks a different price than listed", timestamp: "2026-10-16T00:00:00Z", url: "https://seller.example/api" }]);
  const step = await prices.beforePayment(ctx("1000", { req: { payTo: seller } }));
  assert.match(step.reason, /risk_price_mismatch/);
  const approved = await prices.beforePayment(ctx("1000", { req: { payTo: seller }, ctx: { auditApproved: true } }));
  assert.equal(approved, undefined);
  await prices.ingestSkips([{ id: "price-2", pay_to: seller, network: "eip155:8453", verdict: "skip", reason: "price_mismatch", timestamp: "2026-10-16T01:00:00Z" }]);
  const repeat = await prices.beforePayment(ctx("1000", { req: { payTo: seller }, ctx: { auditApproved: true } }));
  assert.match(repeat.reason, /risk_price_mismatch_repeat/);

  const { layer: joined } = make({});
  assert.equal(await joined.beforePayment(ctx("1000", { req: { payTo: seller } })), undefined);
  await joined.onAfterPay({ status: "landed", receipt_verified: true, id: "ps-join", tx: { hash: "0xjoin", confirmations: 11 }, finality: { confirmations: 11, min_confirmations: 10 } }, { url: URL, paymentPayload: pay({ amount: "1000", payTo: seller, nonce: "join" }) });
  await joined.ingestSkips([{ id: "later", pay_to: seller.toUpperCase(), network: "eip155:8453", verdict: "skip", reason: "pays a different wallet than listed", timestamp: "2026-10-16T02:00:00Z", url: URL }]);
  assert.equal(joined.ledger.entries.some((e) => e.type === "risk_flag" && e.reason === "paid_then_skipped:later"), true);
  const again = await joined.beforePayment(ctx("1000", { req: { payTo: seller } }));
  assert.match(again.reason, /risk_pay_to_mismatch/);
  assert.equal(joined.risk.view(T0).payTo.length, 1);
});

test("spotCheckFetch onPayment stores the payload without changing a paid 200", async () => {
  const { layer } = make({});
  assert.equal(await layer.beforePayment(ctx()), undefined);
  const seen = [];
  const fetch = async (url) => {
    seen.push(String(url));
    return Response.json({ ok: true });
  };
  const guarded = spotCheckFetch(fetch, { onPayment: layer.onPayment, onDecision: layer.onDecision });
  const res = await guarded(URL, { headers: { "payment-signature": pay() } });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(layer.openReservations()[0].nonce, "0x" + "22".repeat(32));
  assert.equal(AUDIT_VERSION, "1");
  assert.equal((await layer.verifyChain()).valid, true);
});
