// P4: 1,000 crash/restart/concurrency runs on ONE shared store. 8 lanes run children concurrently; each child is
// SIGKILLed at a random moment (or finishes), and the lane restarts another. Integrity is checked every 100 runs.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const RUNS = Number(process.env.CRASH_RUNS || 1000), LANES = Number(process.env.CRASH_LANES || 8), BUDGET = Number(process.env.CRASH_BUDGET || 5000);
const db = join(mkdtempSync(join(tmpdir(), "crash-")), "shared.db");
const child = new URL("./crash-child.mjs", import.meta.url).pathname;
const stats = { runs: 0, killed: 0, finished: 0, failed: 0, failures: [], checks: 0, check_failures: [] };
async function check(label) {
  stats.checks++;
  const { DatabaseSync } = await import("node:sqlite");
  const { createAudit } = await import("../audit.js");
  const { openAuditStore } = await import("../audit-sqlite.js");
  let a;
  try { a = createAudit({ store: await openAuditStore(db, { shared: true }), agentId: "crash", policy: { version: "c", dailyBudgetAtomic: BUDGET } }); }
  catch (e) { stats.check_failures.push(label + ": open " + e.message); return; }
  const v = await a.verifyChain();
  const probe = { paymentRequired: { x402Version: 2, resource: { url: "https://s.example/probe" }, accepts: [] }, selectedRequirements: { scheme: "exact", network: "eip155:8453", amount: "0", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x" + "ab".repeat(20) } };
  const r = await a.beforePayment(probe); // runs the load-time integrity checks (chain, head anchor, reservation cross-check)
  if (r?.abort && /store_unavailable/.test(r.reason)) stats.check_failures.push(label + ": " + r.reason);
  await a.close();
  const d = new DatabaseSync(db);
  const live = d.prepare("SELECT rec FROM reservations").all().map((x) => JSON.parse(x.rec)).filter((x) => x.status === "open" || x.status === "settled");
  d.close();
  const held = live.reduce((s, x) => s + Number(x.amount), 0);
  const keyed = live.filter((x) => x.idem != null); const keys = new Set(keyed.map((x) => x.idem));
  if (!v.valid) stats.check_failures.push(`${label}: chain ${v.reason}`);
  if (held > BUDGET) stats.check_failures.push(`${label}: over budget ${held}`);
  if (keys.size !== keyed.length) stats.check_failures.push(`${label}: duplicate live keys`);
  stats.last = { seq: v.seq, live: live.length, held, budget: BUDGET };
}
function runOne(seed) {
  return new Promise((res) => {
    const p = spawn(process.execPath, ["--no-warnings", child, db, String(BUDGET), String(seed)]);
    let err = "", timer = null;
    p.stdout.once("data", () => { timer = setTimeout(() => p.kill("SIGKILL"), Math.floor(Math.random() * 250)); });
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code, sig) => { clearTimeout(timer); stats.runs++; if (sig === "SIGKILL") stats.killed++; else if (code === 0) stats.finished++; else { stats.failed++; stats.failures.push(`code ${code}: ${err.trim().slice(0, 160)}`); } res(); });
  });
}
const t0 = performance.now();
let next = 0;
await Promise.all(Array.from({ length: LANES }, async () => {
  while (next < RUNS) {
    const n = next++;
    await runOne(n + 1);
    if ((n + 1) % 100 === 0) await check("after " + (n + 1));
  }
}));
await check("final");
stats.wall_s = +((performance.now() - t0) / 1000).toFixed(1);
stats.failures = stats.failures.slice(0, 5);
console.log(JSON.stringify(stats, null, 1));
process.exit(stats.failed || stats.check_failures.length ? 1 : 0);
