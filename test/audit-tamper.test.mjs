// P4: on-disk tamper matrix. Every variant must make the store refuse (beforePayment aborts audit_store_unavailable).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, statSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAudit } from "../audit.js";
import { SAMPLE_REQUIREMENT } from "../testkit.js";
let sqlite = null;
try { sqlite = await import("node:sqlite"); } catch { /* Node < 22.13 */ }
const { openAuditStore } = sqlite ? await import("../audit-sqlite.js") : {};
const skip = !sqlite && "node:sqlite not available";
const KEY = new Uint8Array(32).fill(3);
const ctx = (amount, i) => { const req = { ...SAMPLE_REQUIREMENT, amount: String(amount) }; return { paymentRequired: { x402Version: 2, resource: { url: "https://s.example/" + i }, accepts: [req] }, selectedRequirements: req }; };
const mk = async (path, shared = false) => createAudit({ store: await openAuditStore(path, { shared }), agentId: "t", payloadKey: KEY, policy: { version: "t", dailyBudgetAtomic: 10000 } });

let golden = null;
async function base() {
  if (golden) return golden;
  golden = join(mkdtempSync(join(tmpdir(), "tamper-")), "golden.db");
  const a = await mk(golden);
  for (let i = 0; i < 8; i++) await a.beforePayment(ctx(100 + i, i));
  await a.onDecision({ allowed: false, url: "https://s.example/2", verdict: "skip", reason_code: "price_mismatch" });
  await a.close();
  return golden;
}
async function variant(name, mutate) {
  const p = join(mkdtempSync(join(tmpdir(), "tamper-")), name + ".db");
  copyFileSync(await base(), p);
  if (mutate.sql) { const d = new sqlite.DatabaseSync(p); mutate.sql(d); d.close(); }
  if (mutate.file) mutate.file(p);
  return p;
}
const row = (d, seq) => JSON.parse(d.prepare("SELECT entry FROM ledger WHERE seq = ?").get(seq).entry);
const put = (d, seq, e) => d.prepare("UPDATE ledger SET entry = ? WHERE seq = ?").run(JSON.stringify(e), seq);
const MATRIX = {
  "edit amount in a ledger row": { sql: (d) => put(d, 3, { ...row(d, 3), amount_atomic: "1" }) },
  "edit pay_to in a ledger row": { sql: (d) => put(d, 4, { ...row(d, 4), pay_to: "0x" + "ee".repeat(20) }) },
  "edit hash column only": { sql: (d) => d.prepare("UPDATE ledger SET hash = 'sha256:00' WHERE seq = 2").run() },
  "re-hash an edited row (no chain fix-up)": { sql: (d) => { const e = row(d, 5); e.reason = "forged"; put(d, 5, e); } },
  "delete a middle row": { sql: (d) => d.prepare("DELETE FROM ledger WHERE seq = 4").run() },
  "delete the last row (tail truncation)": { sql: (d) => d.prepare("DELETE FROM ledger WHERE seq = (SELECT MAX(seq) FROM ledger)").run() },
  "delete the last 3 rows": { sql: (d) => d.prepare("DELETE FROM ledger WHERE seq > (SELECT MAX(seq) - 3 FROM ledger)").run() },
  "reorder two rows": { sql: (d) => { const a = row(d, 2), b = row(d, 6); put(d, 2, b); put(d, 6, a); } },
  "renumber rows (seq shift)": { sql: (d) => { d.exec("DELETE FROM ledger WHERE seq = 1"); d.exec("UPDATE ledger SET seq = seq - 1"); } },
  "lower a reservation amount (not chained)": { sql: (d) => { const r = d.prepare("SELECT id, rec FROM reservations LIMIT 1").get(); d.prepare("UPDATE reservations SET rec = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(r.rec), amount: "1" }), r.id); } },
  "delete a reservation row": { sql: (d) => d.exec("DELETE FROM reservations WHERE rowid = (SELECT MIN(rowid) FROM reservations)") },
  "reopen a released reservation": { sql: (d) => { for (const r of d.prepare("SELECT id, rec FROM reservations").all()) { const x = JSON.parse(r.rec); if (x.status !== "open") d.prepare("UPDATE reservations SET rec = ? WHERE id = ?").run(JSON.stringify({ ...x, status: "open" }), r.id); } } },
  "head anchor removed and tail dropped": { sql: (d) => { d.exec("DELETE FROM ledger WHERE seq = (SELECT MAX(seq) FROM ledger)"); d.exec("UPDATE meta SET v = '1:sha256:x' WHERE k = 'head'"); } },
  "truncate the file": { file: (p) => truncateSync(p, Math.floor(statSync(p).size / 2)) },
  "overwrite file bytes": { file: (p) => { const b = readFileSync(p); for (let i = 4096; i < Math.min(b.length, 8192); i++) b[i] ^= 0x5a; writeFileSync(p, b); } },
};
for (const [name, m] of Object.entries(MATRIX)) {
  test(`tamper detected: ${name}`, { skip }, async () => {
    const p = await variant(name.replace(/\W+/g, "_"), m);
    let r;
    try { const a = await mk(p); r = await a.beforePayment(ctx(1, "z")); await a.close().catch(() => {}); }
    catch (e) { r = { abort: true, reason: "open refused: " + e.code }; }
    assert.equal(r?.abort, true, `${name}: not detected`);
    assert.match(r.reason, /audit_store_unavailable/);
  });
}
test("untampered copy opens and works (control)", { skip }, async () => {
  const p = await variant("control", {});
  const a = await mk(p);
  assert.equal(await a.beforePayment(ctx(1, "z")), undefined);
  assert.equal((await a.verifyChain()).valid, true);
  await a.close();
});
