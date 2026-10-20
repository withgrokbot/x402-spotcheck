// P4 crash child: random reserves/releases on a shared store until killed (or 200 ops).
import { createAudit } from "../audit.js";
import { openAuditStore } from "../audit-sqlite.js";
import { SAMPLE_REQUIREMENT } from "../testkit.js";
const [db, budget, seed] = process.argv.slice(2);
let x = Number(seed) >>> 0 || 1; const rnd = () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32);
let audit;
try { audit = createAudit({ store: await openAuditStore(db, { shared: true }), agentId: "crash", payloadKey: new Uint8Array(32).fill(5), policy: { version: "c", dailyBudgetAtomic: Number(budget) }, deny: "throw" }); }
catch (e) { process.stderr.write("open " + e.message + "\n"); process.exit(3); }
const mine = [];
process.stdout.write("up\n");
for (let i = 0; i < 200; i++) {
  if (rnd() < 0.75 || !mine.length) {
    const key = "k" + Math.floor(rnd() * 8000);
    const req = { ...SAMPLE_REQUIREMENT, amount: "10" };
    const c = { paymentRequired: { x402Version: 2, resource: { url: "https://s.example/" + key }, accepts: [req] }, selectedRequirements: req, idempotencyKey: key };
    let r;
    try { r = await audit.beforePayment(c); } catch (e) { if (e.code === "audit_deny") r = { abort: true, reason: e.message }; else { process.stderr.write("store " + e.message + "\n"); process.exit(4); } }
    if (r?.abort && /store_unavailable/.test(r.reason)) { process.stderr.write("store " + r.reason + "\n"); process.exit(4); }
    if (!r) mine.push(c);
  } else {
    const c = mine.splice(Math.floor(rnd() * mine.length), 1)[0];
    await audit.onDecision({ allowed: false, url: c.paymentRequired.resource.url, verdict: "skip", reason_code: "price_mismatch" }, c);
  }
}
await audit.close();
