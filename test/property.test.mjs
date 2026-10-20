// P0: property-test tooling (fast-check). Seeds are printed on failure; FC_SEED / FC_RUNS override.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createAudit } from "../audit.js";
import { SAMPLE_REQUIREMENT } from "../testkit.js";
let fc = null;
try { fc = (await import("fast-check")).default; } catch { /* devDep not installed */ }
const opts = { numRuns: Number(process.env.FC_RUNS || 100), ...(process.env.FC_SEED ? { seed: Number(process.env.FC_SEED) } : {}) };
const ctx = (amount, i) => { const req = { ...SAMPLE_REQUIREMENT, amount: String(amount) }; return { paymentRequired: { x402Version: 2, resource: { url: "https://seller.example/p" + i }, accepts: [req] }, selectedRequirements: req }; };

test("property: allowed reservations never exceed the daily budget; chain always verifies", { skip: !fc && "fast-check not installed" }, async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 100000 }), fc.array(fc.integer({ min: 1, max: 40000 }), { maxLength: 30 }), async (budget, amounts) => {
    const a = createAudit({ agentId: "prop", payloadKey: randomBytes(32), policy: { version: "p", dailyBudgetAtomic: budget } });
    let held = 0;
    for (const [i, amt] of amounts.entries()) {
      const r = await a.beforePayment(ctx(amt, i));
      if (!r?.abort) held += amt;
      else assert.match(r.reason, /budget|policy|deny/);
    }
    assert.ok(held <= budget, `held ${held} > budget ${budget}`);
    assert.equal((await a.verifyChain()).valid, true);
  }), opts);
});

test("property: concurrent reserves are serialised (no over-booking under Promise.all)", { skip: !fc && "fast-check not installed" }, async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1000, max: 50000 }), fc.array(fc.integer({ min: 1, max: 20000 }), { minLength: 1, maxLength: 25 }), async (budget, amounts) => {
    const a = createAudit({ agentId: "prop", payloadKey: randomBytes(32), policy: { version: "p", dailyBudgetAtomic: budget } });
    const rs = await Promise.all(amounts.map((amt, i) => a.beforePayment(ctx(amt, i))));
    const held = amounts.reduce((s, amt, i) => s + (rs[i]?.abort ? 0 : amt), 0);
    assert.ok(held <= budget);
    assert.equal(a.openReservations().length, rs.filter((r) => !r?.abort).length);
  }), opts);
});
