// P2 demo worker: one process, one shared store, N reserves with idempotency keys.
import { createAudit } from "../audit.js";
import { openAuditStore } from "../audit-sqlite.js";
import { SAMPLE_REQUIREMENT } from "../testkit.js";
const [db, wid, n, budget, killAt] = process.argv.slice(2);
const store = await openAuditStore(db, { shared: true });
const audit = createAudit({ store, agentId: "fleet", payloadKey: new Uint8Array(32).fill(9), policy: { version: "p2", dailyBudgetAtomic: Number(budget) } });
const ctx = (key) => { const req = { ...SAMPLE_REQUIREMENT, amount: "10" }; return { paymentRequired: { x402Version: 2, resource: { url: "https://seller.example/" + key }, accepts: [req] }, selectedRequirements: req, idempotencyKey: key }; };
const c = { allowed: 0, denied: 0, reused: 0, store_errors: 0 };
const t0 = performance.now();
const keys = [];
for (let i = 0; i < Number(n); i++) keys.push(i % 10 === 0 ? `shared-${i / 10}` : `w${wid}-${i}`); // 10% of keys contested by all workers
for (const [i, key] of keys.entries()) {
  if (killAt && i === Number(killAt)) { process.stdout.write(JSON.stringify({ wid, killedAt: i, ...c }) + "\n"); process.kill(process.pid, "SIGKILL"); }
  const before = audit.openReservations().length;
  const r = await audit.beforePayment(ctx(key));
  if (r?.abort) { if (/store_unavailable/.test(r.reason)) c.store_errors++; else c.denied++; continue; }
  const after = audit.openReservations().length;
  if (after > before) c.allowed++; else c.reused++;
}
const ms = performance.now() - t0;
await audit.close();
process.stdout.write(JSON.stringify({ wid, ops: keys.length, ms: Math.round(ms), ...c }) + "\n");
