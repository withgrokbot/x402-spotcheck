// P2 demo: 8 processes x 500 reserves on ONE shared SQLite store, a SIGKILL + restart mid-run, then an audit of the file.
// Offline, no keys, no network. Needs Node >= 22.13.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const W = Number(process.env.P2_WORKERS || 8), N = Number(process.env.P2_OPS || 500), PRICE = 10;
const BUDGET = Math.floor(W * N * 0.75) * PRICE; // over-subscribed on purpose: 25% of attempts must be denied
const db = join(mkdtempSync(join(tmpdir(), "p2-")), "shared.db");
const worker = (wid, killAt) => new Promise((res) => {
  const p = spawn(process.execPath, ["--no-warnings", new URL("./p2-worker.mjs", import.meta.url).pathname, db, String(wid), String(N), String(BUDGET), killAt ?? ""]);
  let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
  p.on("exit", (code, sig) => res({ code, sig, out: out.trim(), err: err.trim().slice(0, 300) }));
});
console.log(`store ${db}\n${W} workers x ${N} reserves of ${PRICE} atomic, shared budget ${BUDGET} (= ${BUDGET / PRICE} reservations)`);
const t0 = performance.now();
const runs = await Promise.all(Array.from({ length: W }, (_, w) => worker(w, w === 3 ? Math.floor(N / 2) : undefined)));
for (const r of runs) console.log("  ", r.sig ? `KILLED (${r.sig}) ${r.out}` : r.out, r.err ? "ERR " + r.err : "");
console.log("restart worker 3 (same keys: idempotency must stop re-booking its first half)");
const again = await worker(3);
console.log("  ", again.out, again.err ? "ERR " + again.err : "");
const wall = performance.now() - t0;

const { DatabaseSync } = await import("node:sqlite");
const d = new DatabaseSync(db);
const recs = d.prepare("SELECT rec FROM reservations").all().map((r) => JSON.parse(r.rec));
const live = recs.filter((r) => r.status === "open" || r.status === "settled");
const byKey = new Map(); for (const r of live) byKey.set(r.idem, (byKey.get(r.idem) || 0) + 1);
const dupKeys = [...byKey.values()].filter((v) => v > 1).length;
const held = live.reduce((s, r) => s + Number(r.amount), 0);
const entries = d.prepare("SELECT entry FROM ledger ORDER BY seq").all().map((r) => JSON.parse(r.entry));
const reservedIds = entries.filter((e) => e.type === "reserved").map((e) => e.reservation_id);
const qc = Object.values(d.prepare("PRAGMA quick_check").get())[0];
d.close();
const { createAudit } = await import("../audit.js");
const { openAuditStore } = await import("../audit-sqlite.js");
const a = createAudit({ store: await openAuditStore(db, { shared: true }), agentId: "fleet", policy: { version: "p2", dailyBudgetAtomic: BUDGET } });
const chain = await a.verifyChain(); await a.close();
const ops = runs.reduce((s, r) => s + (JSON.parse(r.out.split("\n").at(-1) || "{}").killedAt ?? N), 0) + N;
const shared = live.filter((r) => /^shared-/.test(r.idem)).length;
const summary = {
  attempts: ops, wall_ms: Math.round(wall), throughput_ops_s: Math.round(ops / (wall / 1000)),
  live_reservations: live.length, budget_slots: BUDGET / PRICE, held_atomic: held, budget_atomic: BUDGET, over_booked: held > BUDGET,
  duplicate_idempotency_keys: dupKeys, duplicate_reserved_ids: reservedIds.length - new Set(reservedIds).size,
  contested_keys_booked: `${shared} (each of ${N / 10} shared keys at most once)`,
  ledger_entries: entries.length, chain, quick_check: qc,
};
console.log(JSON.stringify(summary, null, 1));
const ok = !summary.over_booked && dupKeys === 0 && summary.duplicate_reserved_ids === 0 && chain.valid && qc === "ok" && held === BUDGET;
console.log(ok ? "P2 DEMO: no double booking" : "P2 DEMO: FAILED");
process.exit(ok ? 0 : 1);
