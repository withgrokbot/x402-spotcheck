// P4: property/fuzz tests. Junk 402s, junk headers, junk payment-status bodies and random ledger tampering must never
// crash the library and must never end up allowing something they shouldn't. FC_RUNS / FC_SEED override.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { checkBeforePay, readPaymentIntent } from "../index.js";
import { afterPay, paymentHeaderVersion, proofHeaderForVersion } from "../after.js";
import { createAudit, createLedger, settlementAdvice } from "../audit.js";
import { SAMPLE_REQUIREMENT } from "../testkit.js";
let fc = null;
try { fc = (await import("fast-check")).default; } catch { /* devDep missing */ }
const skip = !fc && "fast-check not installed";
const runs = (n) => ({ numRuns: Number(process.env.FC_RUNS || n), ...(process.env.FC_SEED ? { seed: Number(process.env.FC_SEED) } : {}) });
export const counts = {};
const count = (k) => (counts[k] = (counts[k] || 0) + 1);
const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64");

// generators
const junk = () => fc.oneof(fc.anything(), fc.string(), fc.constant(null), fc.constant(undefined), fc.integer(), fc.double(), fc.bigInt().map(String));
const amountish = () => fc.oneof(fc.bigUintN(80).map(String), fc.string(), fc.constant("-1"), fc.constant("1e21"), fc.constant("0x10"), fc.double().map(String), fc.constant(""), fc.integer());
const reqish = () => fc.record({
  scheme: fc.oneof(fc.constant("exact"), fc.string()), network: fc.oneof(fc.constantFrom("eip155:8453", "eip155:84532", "base", "base-sepolia", "solana", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"), fc.string()),
  amount: amountish(), maxAmountRequired: amountish(), asset: fc.oneof(fc.constant(SAMPLE_REQUIREMENT.asset), fc.hexaString({ minLength: 0, maxLength: 44 }), junk()),
  payTo: fc.oneof(fc.constant(SAMPLE_REQUIREMENT.payTo), fc.string(), junk()), maxTimeoutSeconds: junk(), extra: junk(), resource: junk(),
}, { requiredKeys: [] });

test("fuzz: checkBeforePay on malformed 402 accepts never throws and always returns a verdict", { skip }, async () => {
  await fc.assert(fc.asyncProperty(fc.oneof(fc.array(reqish(), { maxLength: 5 }), junk()), async (accepts) => {
    count("checkBeforePay");
    const d = await checkBeforePay("https://seller.example/x", { accepts, price: "0.01", payTo: SAMPLE_REQUIREMENT.payTo, network: "base" });
    assert.ok(d && typeof d.verdict === "string");
    if (d.verdict === "skip") assert.equal(d.allowed, false);
  }), runs(1500));
});
test("fuzz: payment headers (junk base64/JSON) never throw; only v1/v2 pick a header", { skip }, async () => {
  await fc.assert(fc.property(fc.oneof(fc.string(), fc.anything().map((v) => { try { return b64(JSON.stringify(v) ?? "null"); } catch { return "x"; } }), fc.record({ x402Version: junk(), payload: junk(), accepted: junk() }).map(b64)), (h) => {
    count("headers");
    readPaymentIntent(h);
    const v = paymentHeaderVersion(h);
    const hdr = proofHeaderForVersion(v);
    assert.ok(hdr === null || hdr === "X-PAYMENT" || hdr === "PAYMENT-SIGNATURE");
  }), runs(3000));
});
test("fuzz: afterPay on junk payment-status answers never throws and never says safe_to_resign unverified", { skip }, async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 100, max: 599 }), fc.oneof(fc.string(), fc.anything().map((v) => { try { return JSON.stringify(v) ?? "null"; } catch { return "{"; } }), fc.record({ status: junk(), safe_to_resign: junk(), receipt: junk() }).map((o) => JSON.stringify(o))), fc.oneof(fc.string(), fc.record({ x402Version: fc.constantFrom(1, 2, 3, "2", null) }).map(b64)), async (status, body, header) => {
    count("afterPay");
    const fetch = async () => new Response(status === 204 || status === 304 || status < 200 ? null : body, { status: status < 200 ? 200 : status });
    const r = await afterPay({ txHash: "0x" + "ab".repeat(32), network: "eip155:84532" }, { fetch, paymentHeader: header, timeoutMs: 500 });
    assert.equal(typeof r.status, "string");
    if (r.safe_to_resign === true) assert.notEqual(r.receipt_verified, false);
    const adv = settlementAdvice(r);
    assert.ok(adv && typeof adv.move === "string");
    if (r.receipt_verified !== true) assert.notEqual(adv.move, "settle");
  }), runs(1500));
});
test("fuzz: audit.beforePayment on junk contexts never throws; allowed bookings stay within budget; chain verifies", { skip }, async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.oneof(reqish().map((r) => ({ paymentRequired: { x402Version: 2, resource: { url: "https://s.example/" }, accepts: [r] }, selectedRequirements: r })), junk()), { maxLength: 15 }), async (ctxs) => {
    const a = createAudit({ agentId: "f", payloadKey: randomBytes(32), policy: { version: "f", dailyBudgetAtomic: 50000 } });
    for (const c of ctxs) { count("auditCtx"); const r = await a.beforePayment(c); assert.ok(r === undefined || r.abort === true); }
    const held = a.openReservations().reduce((s, r) => s + BigInt(r.amount), 0n);
    assert.ok(held <= 50000n, `held ${held}`);
    assert.equal((await a.verifyChain()).valid, true);
  }), runs(600));
});
test("property: any single edit, deletion, swap or middle truncation of the ledger is detected", { skip }, async () => {
  const L = createLedger({ now: () => 1_700_000_000_000 });
  for (let i = 0; i < 12; i++) await L.append({ type: i % 3 ? "reserved" : "decision", agent: "a", amount: String(100 + i), id: "rsv_" + i, url: "https://s.example/" + i });
  const pristine = L.entries.map((e) => ({ ...e }));
  const fields = Object.keys(pristine[0]);
  await fc.assert(fc.asyncProperty(fc.constantFrom("edit", "delete", "swap", "truncate-middle"), fc.nat(11), fc.nat(11), fc.constantFrom(...fields), fc.string({ minLength: 1 }), async (kind, i, j, field, val) => {
    count("tamper");
    const rows = pristine.map((e) => ({ ...e }));
    if (kind === "edit") { if (String(rows[i][field]) === val) return; rows[i][field] = val; }
    if (kind === "delete") { if (i === 11) return; rows.splice(i, 1); } // tail deletion = truncation: caught by the store head anchor (audit-tamper.test)
    if (kind === "swap") { if (i === j) return; [rows[i], rows[j]] = [rows[j], rows[i]]; }
    if (kind === "truncate-middle") { if (i >= 11) return; rows.splice(i, 12 - i - 1); }
    const T = createLedger({ initial: rows });
    const v = await T.verify();
    if (kind === "truncate-middle" && rows.length === 12) return;
    assert.equal(v.valid, false, `${kind} at ${i}/${j} ${field} not detected`);
  }), runs(2000));
});
test("fuzz totals", { skip }, () => { console.log("# fuzz cases " + JSON.stringify(counts)); });
