// 1.6.1 security fixes: M1 (exact reservation release), L5 (payFetch fee pinning), L6 (verdicts, not budgets).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAudit } from "../audit.js";
import { createSpotChecker, spotCheckFetch, CHECK_FEE_TERMS } from "../index.js";
import { SAMPLE_REQUIREMENT } from "../testkit.js";

const URL = "https://seller.example/api";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const ctx = (amount) => { const req = { ...SAMPLE_REQUIREMENT, amount: String(amount) }; return { paymentRequired: { x402Version: 2, resource: { url: URL }, accepts: [req] }, selectedRequirements: req }; };
const signed = (amount, nonce) => b64({ x402Version: 2, accepted: { ...SAMPLE_REQUIREMENT, amount: String(amount) },
  payload: { authorization: { from: "0x" + "11".repeat(20), to: SAMPLE_REQUIREMENT.payTo, value: String(amount), validBefore: "9999999999", nonce } } });
const mk = (o = {}) => createAudit({ agentId: "a", now: () => Date.parse("2026-10-22T12:00:00Z"), policy: { version: "t", dailyBudgetAtomic: 1_000_000 }, logger: { warn() {} }, ...o });

test("M1: concurrent same-URL payments, a skip on one releases exactly its own reservation", async () => {
  const layer = mk();
  const a = ctx("1000"), b = ctx("1000");
  await Promise.all([layer.beforePayment(a), layer.beforePayment(b)]);
  assert.equal(layer.openReservations().length, 2);
  const blocked = spotCheckFetch(async () => new Response("ok"), { expected: () => ({ price: 0.0001 }), onDecision: layer.onDecision, onPayment: layer.onPayment });
  const [ra, rb] = await Promise.allSettled([
    blocked(URL, { headers: { "payment-signature": signed(1000, "0x" + "aa".repeat(32)) }, reservationId: a.audit.reservationId }),
    Promise.resolve("b continues"),
  ]);
  assert.equal(ra.status, "rejected");
  assert.equal(rb.status, "fulfilled");
  assert.deepEqual(layer.openReservations().map((r) => r.id), [b.audit.reservationId], "only a's (the older) reservation released; the URL heuristic would have picked b");
});

test("M1: without an id, an ambiguous URL match releases nothing and logs release_heuristic", async () => {
  const layer = mk();
  const a = ctx("1000"), b = ctx("1000");
  await Promise.all([layer.beforePayment(a), layer.beforePayment(b)]);
  await Promise.all([layer.onDecision({ allowed: false, url: URL, verdict: "skip" }), layer.onDecision({ allowed: true, url: URL, verdict: "allow" })]);
  assert.equal(layer.openReservations().length, 2);
  const flags = layer.exportChain().entries.filter((e) => e.type === "risk_flag" && e.reason === "release_heuristic");
  assert.equal(flags.length, 1);
  // a unique heuristic match still releases, and is logged
  const l2 = mk(); const c = ctx("1000"); await l2.beforePayment(c);
  await l2.onDecision({ allowed: false, url: URL, verdict: "skip" });
  assert.equal(l2.openReservations().length, 0);
  assert.equal(l2.exportChain().entries.filter((e) => e.reason === "release_heuristic").length, 1);
});

test("M1: onPayment binds the payload to the threaded reservation id", async () => {
  const layer = mk();
  const a = ctx("1000"), b = ctx("1000");
  await layer.beforePayment(a); await layer.beforePayment(b);
  await layer.onPayment({ paymentPayload: signed(1000, "0x" + "bb".repeat(32)), url: URL, reservationId: a.audit.reservationId });
  const recA = layer.openReservations().find((r) => r.id === a.audit.reservationId);
  const recB = layer.openReservations().find((r) => r.id === b.audit.reservationId);
  assert.equal(recA.nonce, "0x" + "bb".repeat(32));
  assert.ok(!recB.nonce);
});

function feeServer(accept) {
  return async (u) => String(u).startsWith("https://check.test")
    ? new Response(JSON.stringify({ x402Version: 2, accepts: [accept] }), { status: 402, headers: { "content-type": "application/json" } })
    : new Response("ok");
}
const fee = (o = {}) => ({ scheme: "exact", network: CHECK_FEE_TERMS.network, asset: CHECK_FEE_TERMS.asset, payTo: CHECK_FEE_TERMS.payTo, amount: "10000", ...o });

for (const [name, bad] of [["payTo", { payTo: "0x" + "66".repeat(20) }], ["network", { network: "eip155:84532" }], ["asset", { asset: "0x" + "77".repeat(20) }]]) {
  test(`L5: payFetch is not called when the check fee's ${name} differs from the pinned terms`, async () => {
    let paid = 0;
    const check = createSpotChecker({ endpoint: "https://check.test/v1/check", fetch: feeServer(fee(bad)), payFetch: async () => { paid++; return new Response("{}"); }, maxCheckUsd: 0.05 });
    const d = await check(URL);
    assert.equal(paid, 0);
    assert.match(d.reason || "", /pinned/);
  });
}
test("L5: payFetch is still used when the fee matches the pinned terms", async () => {
  let paid = 0;
  const check = createSpotChecker({ endpoint: "https://check.test/v1/check", fetch: feeServer(fee()), payFetch: async () => { paid++; return new Response(JSON.stringify({ verdict: "allow", reason: "ok" })); }, maxCheckUsd: 0.05 });
  await check(URL);
  assert.equal(paid, 1);
});

test("L6: audit observers warn once when no reservation is bound (spotCheckFetch does not enforce budgets)", async () => {
  const warns = [];
  const layer = mk({ logger: { warn: (m) => warns.push(m) } });
  await layer.onDecision({ allowed: true, url: URL, verdict: "allow" });
  await layer.onPayment({ paymentPayload: signed(1000, "0x" + "cc".repeat(32)), url: URL });
  await layer.onDecision({ allowed: true, url: URL, verdict: "allow" });
  assert.equal(warns.length, 1);
  assert.match(warns[0], /zero reservations bound/);
  const quiet = []; const l2 = mk({ logger: { warn: (m) => quiet.push(m) } });
  const c = ctx("1000"); await l2.beforePayment(c);
  await l2.onDecision({ allowed: true, url: URL, verdict: "allow" }, c);
  assert.equal(quiet.length, 0);
});
