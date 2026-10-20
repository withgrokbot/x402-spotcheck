// Phase A: opt-in SQLite audit store (ported from Gatecheck test/persistence.test.mjs): restart, races, crash,
// corrupt / tampered / locked fail-closed. Skipped where node:sqlite is missing (Node < 22.13). Temp files only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createAudit, StoreUnavailableError } from "../audit.js";
import { SAMPLE_REQUIREMENT } from "../testkit.js";

let sqlite = null;
try { sqlite = await import("node:sqlite"); } catch { /* Node < 22.13 */ }
const skip = !sqlite && "node:sqlite not available (Node >= 22.13)";
const { openAuditStore } = sqlite ? await import("../audit-sqlite.js") : {};

const URL_ = "https://seller.example/api";
const T0 = Date.parse("2026-10-20T16:00:00Z");
const KEY = new Uint8Array(32).fill(7);
const tmp = () => join(mkdtempSync(join(tmpdir(), "spotcheck-audit-")), "a.db");
const SRC = new URL("../", import.meta.url).href;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const pay = (amount = "10000", nonce = "0x" + "22".repeat(32)) => b64({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453", amount, asset: SAMPLE_REQUIREMENT.asset, payTo: SAMPLE_REQUIREMENT.payTo }, payload: { authorization: { from: "0x" + "11".repeat(20), to: SAMPLE_REQUIREMENT.payTo, value: amount, validBefore: "1700000000", nonce } } });
const ctx = (amount = "10000") => { const req = { ...SAMPLE_REQUIREMENT, amount }; return { paymentRequired: { x402Version: 2, resource: { url: URL_ }, accepts: [req] }, selectedRequirements: req }; };
const make = (store) => createAudit({ store, agentId: "agent-7", payloadKey: KEY, now: () => T0, policy: { version: "p1", dailyBudgetAtomic: 1000 } });
function child(code, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { env: { ...process.env, ...env } });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => resolve({ code, out, err }));
  });
}

test("default is unchanged: no store, in memory, close() is a no-op", { skip: false }, async () => {
  const a = createAudit({ policy: { dailyBudgetAtomic: 1000 } });
  assert.equal(a.store, null);
  assert.equal(await a.beforePayment(ctx("100")), undefined);
  await a.close();
});

test("restart: chain, reservations and the sealed (AAD-bound) payload survive", { skip }, async () => {
  const path = tmp();
  let store = await openAuditStore(path);
  let a = make(store);
  const c = ctx("400");
  assert.equal(await a.beforePayment(c), undefined);
  await a.onPayment({ paymentPayload: pay("400"), url: URL_ });
  const id = c.audit.reservationId;
  const before = a.exportChain();
  await a.close();

  store = await openAuditStore(path);
  a = make(store);
  assert.deepEqual(a.exportChain().entries, before.entries);
  assert.equal((await a.verifyChain()).valid, true);
  const open = a.openReservations();
  assert.equal(open.length, 1);
  assert.equal(open[0].id, id);
  assert.equal(open[0].amount, "400");
  assert.equal(open[0].nonce, "0x" + "22".repeat(32));
  const st = await a.exportState();
  const blob = st.payloads[id];
  const k = await crypto.subtle.importKey("raw", KEY, "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(blob.iv, "base64"), additionalData: new TextEncoder().encode(id) }, k, Buffer.from(blob.ct, "base64"));
  assert.equal(new TextDecoder().decode(pt), pay("400"));
  // budget is still held after the restart: 400 of 1000 used, so 700 is denied
  const r = await a.beforePayment(ctx("700"));
  assert.equal(r.abort, true);
  assert.equal(await a.beforePayment(ctx("600")), undefined);
  // new entries keep linking onto the loaded chain
  assert.equal((await a.verifyChain()).valid, true);
  assert.ok(a.exportChain().entries.length > before.entries.length);
  await a.close();
});

test("restart: a swapped payload blob fails AES-GCM (AAD binding persists)", { skip }, async () => {
  const path = tmp();
  let a = make(await openAuditStore(path));
  const c1 = ctx("100"), c2 = ctx("200");
  await a.beforePayment(c1); await a.onPayment({ paymentPayload: pay("100", "0x" + "31".repeat(32)), url: URL_ });
  await a.beforePayment(c2); await a.onPayment({ paymentPayload: pay("200", "0x" + "32".repeat(32)), url: URL_ });
  await a.close();
  const db = new sqlite.DatabaseSync(path);
  const rows = db.prepare("SELECT id, blob FROM payloads ORDER BY id").all();
  db.prepare("UPDATE payloads SET blob = ? WHERE id = ?").run(rows[1].blob, rows[0].id);
  db.close();
  a = make(await openAuditStore(path));
  const blob = (await a.exportState()).payloads[rows[0].id];
  const k = await crypto.subtle.importKey("raw", KEY, "AES-GCM", false, ["decrypt"]);
  await assert.rejects(crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(blob.iv, "base64"), additionalData: new TextEncoder().encode(rows[0].id) }, k, Buffer.from(blob.ct, "base64")));
  await a.close();
});

test("race: concurrent reserves against one budget persist exactly what was allowed", { skip }, async () => {
  const path = tmp();
  let a = make(await openAuditStore(path));
  const results = await Promise.all([ctx("400"), ctx("400"), ctx("400")].map((c) => a.beforePayment(c)));
  assert.equal(results.filter((r) => r === undefined).length, 2);
  assert.equal(results.filter((r) => r && r.abort).length, 1);
  await a.close();
  a = make(await openAuditStore(path));
  assert.equal(a.openReservations().length, 2);
  assert.equal((await a.verifyChain()).valid, true);
  await a.close();
});

test("race: 4 processes open one file at once; exactly one gets it (single writer)", { skip }, async () => {
  const path = tmp();
  (await openAuditStore(path)).close();
  const code = `import { openAuditStore } from "${SRC}audit-sqlite.js";
    try { const s = await openAuditStore(process.env.DB, { busyTimeoutMs: 100 }); console.log("got"); await new Promise((r) => setTimeout(r, 800)); s.close(); }
    catch (e) { console.log(e.code); }`;
  const runs = await Promise.all(Array.from({ length: 4 }, () => child(code, { DB: path })));
  const outs = runs.map((r) => (assert.equal(r.code, 0, r.err), r.out.trim()));
  assert.equal(outs.filter((o) => o === "got").length, 1);
  assert.equal(outs.filter((o) => o === "audit_store_unavailable").length, 3);
});

test("crash: exit inside an open write transaction leaves the previous state", { skip }, async () => {
  const path = tmp();
  let a = make(await openAuditStore(path));
  await a.beforePayment(ctx("100"));
  const n = a.exportChain().entries.length;
  await a.close();
  const code = `import { DatabaseSync } from "node:sqlite"; const d = new DatabaseSync(process.env.DB);
    d.exec("BEGIN IMMEDIATE"); d.prepare("INSERT INTO ledger (seq, hash, entry) VALUES (999, 'x', '{}')").run();
    d.prepare("DELETE FROM reservations").run(); process.exit(9);`;
  assert.equal((await child(code, { DB: path })).code, 9);
  a = make(await openAuditStore(path));
  assert.equal(a.exportChain().entries.length, n);
  assert.equal(a.openReservations().length, 1);
  assert.equal((await a.verifyChain()).valid, true);
  await a.close();
});

test("crash: SIGKILL during a reserve loop leaves a chain that verifies", { skip }, async () => {
  const path = tmp();
  (await openAuditStore(path)).close();
  const code = `import { openAuditStore } from "${SRC}audit-sqlite.js"; import { createAudit } from "${SRC}audit.js";
    const a = createAudit({ store: await openAuditStore(process.env.DB), policy: { version: "p1" } });
    const req = { scheme: "exact", network: "eip155:8453", amount: "1", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x" + "ab".repeat(20) };
    console.log("ready"); for (;;) await a.beforePayment({ paymentRequired: { x402Version: 2, resource: { url: "https://s.test/a" }, accepts: [req] }, selectedRequirements: req });`;
  const p = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { env: { ...process.env, DB: path } });
  await new Promise((res) => p.stdout.once("data", res));
  await new Promise((res) => setTimeout(res, 200));
  p.kill("SIGKILL");
  await new Promise((res) => p.on("exit", res));
  const a = createAudit({ store: await openAuditStore(path), policy: { version: "p1" } });
  const chain = a.exportChain().entries;
  assert.ok(chain.length > 0);
  assert.equal((await a.verifyChain()).valid, true);
  assert.equal(a.openReservations().length, chain.filter((e) => e.type === "reserved").length);
  await a.close();
});

test("fail closed: a corrupt or truncated file refuses to open", { skip }, async () => {
  const garbage = tmp();
  writeFileSync(garbage, Buffer.alloc(8192, 0x5a));
  await assert.rejects(openAuditStore(garbage), StoreUnavailableError);
  const good = tmp();
  const a = make(await openAuditStore(good));
  for (let i = 0; i < 5; i++) await a.beforePayment(ctx("10"));
  await a.close();
  const bytes = readFileSync(good);
  bytes.write("not a sqlite header", 0);
  writeFileSync(good, bytes);
  await assert.rejects(openAuditStore(good), StoreUnavailableError);
});

test("fail closed: a tampered ledger row aborts payments instead of trusting the chain", { skip }, async () => {
  const path = tmp();
  let a = make(await openAuditStore(path));
  await a.beforePayment(ctx("100"));
  await a.close();
  const db = new sqlite.DatabaseSync(path);
  const row = db.prepare("SELECT seq, entry FROM ledger ORDER BY seq LIMIT 1").get();
  const e = JSON.parse(row.entry); e.amount_atomic = "1";
  db.prepare("UPDATE ledger SET entry = ? WHERE seq = ?").run(JSON.stringify(e), row.seq);
  db.close();
  a = make(await openAuditStore(path));
  assert.equal((await a.verifyChain()).valid, false);
  assert.deepEqual(await a.beforePayment(ctx("100")), { abort: true, reason: "audit_store_unavailable" });
  await a.close().catch(() => {});
});

test("fail closed: a file locked by another process refuses to open; a failed write aborts the payment", { skip }, async () => {
  const path = tmp();
  const holder = await openAuditStore(path);
  await assert.rejects(openAuditStore(path, { busyTimeoutMs: 50 }), StoreUnavailableError);
  const a = make(holder);
  holder.close(); // the store goes away under the audit layer
  assert.deepEqual(await a.beforePayment(ctx("100")), { abort: true, reason: "audit_store_unavailable" });
  const observe = createAudit({ store: { load: () => ({ entries: [], reservations: [], payloads: new Map() }), flush() { throw new StoreUnavailableError("down"); }, close() {} }, mode: "observe", policy: { version: "p1" } });
  assert.equal(await observe.beforePayment(ctx("100")), undefined); // observe never aborts
});
