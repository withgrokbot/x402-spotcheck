// P2: idempotency keys, settle-twice, shared multi-process store. Shared-store tests need node:sqlite (Node >= 22.13).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createAudit } from "../audit.js";
import { SAMPLE_REQUIREMENT } from "../testkit.js";
let sqlite = null;
try { sqlite = await import("node:sqlite"); } catch { /* Node < 22.13 */ }
const { openAuditStore } = sqlite ? await import("../audit-sqlite.js") : {};
const NO = !sqlite && "node:sqlite not available";
const KEY = new Uint8Array(32).fill(7);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const ctx = (key, amount = "100", url = "https://seller.example/a") => { const req = { ...SAMPLE_REQUIREMENT, amount }; return { paymentRequired: { x402Version: 2, resource: { url }, accepts: [req] }, selectedRequirements: req, ...(key ? { idempotencyKey: key } : {}) }; };
const pay = (nonce, amount = "100") => b64({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453", amount, asset: SAMPLE_REQUIREMENT.asset, payTo: SAMPLE_REQUIREMENT.payTo }, payload: { authorization: { from: "0x" + "11".repeat(20), to: SAMPLE_REQUIREMENT.payTo, value: amount, validBefore: "1700000000", nonce } } });
const landed = () => ({ status: "landed", receipt_verified: true, id: "ps-0123456789abcdef", tx: { hash: "0xabc", confirmations: 12 }, finality: { confirmations: 12, min_confirmations: 10, reorg_safe: true } });
const tmp = () => join(mkdtempSync(join(tmpdir(), "p2t-")), "a.db");
const mk = (extra = {}) => createAudit({ agentId: "a", payloadKey: KEY, policy: { version: "p", dailyBudgetAtomic: 1000 }, ...extra });

test("idempotency: a retried open key reuses its reservation (no double booking)", async () => {
  const a = mk();
  assert.equal(await a.beforePayment(ctx("k1")), undefined);
  assert.equal(await a.beforePayment(ctx("k1")), undefined);
  await Promise.all([a.beforePayment(ctx("k1")), a.beforePayment(ctx("k1"))]);
  assert.equal(a.openReservations().length, 1);
  assert.equal(a.budgets.remaining("a"), 900n);
  assert.equal(a.ledger.entries.filter((e) => e.reason === "idempotent_reuse").length, 3);
});
test("idempotency: settled key is denied; released key may book again; opts.idempotencyKey(ctx) works", async () => {
  const a = mk();
  const c = ctx("k2");
  await a.beforePayment(c);
  await a.onPayment({ paymentPayload: pay("0x" + "01".repeat(32)), url: "https://seller.example/a" });
  await a.onAfterPay(landed(), { url: "https://seller.example/a", paymentPayload: pay("0x" + "01".repeat(32)) });
  assert.equal((await a.beforePayment(ctx("k2"))).reason, "audit deny: duplicate_idempotency_key");
  const b = mk({ idempotencyKey: (x) => x.selectedRequirements.amount + ":" + x.paymentRequired.resource.url });
  const c3 = ctx(null, "300");
  await b.beforePayment(c3);
  await b.onDecision({ allowed: false, url: "https://seller.example/a", verdict: "skip", reason_code: "price_mismatch" }, c3); // releases
  assert.equal(b.openReservations().length, 0);
  assert.equal(await b.beforePayment(ctx(null, "300")), undefined);
  assert.equal(b.openReservations().length, 1);
});
test("settling the same payment twice has no extra effect", async () => {
  const a = mk();
  const url = "https://seller.example/a", p = pay("0x" + "02".repeat(32));
  await a.beforePayment(ctx("k3"));
  await a.onPayment({ paymentPayload: p, url });
  await a.onAfterPay(landed(), { url, paymentPayload: p });
  const n = a.ledger.entries.length, left = a.budgets.remaining("a");
  await a.onAfterPay(landed(), { url, paymentPayload: p });
  await a.onAfterPay(landed(), { url, paymentPayload: p });
  assert.equal(a.ledger.entries.filter((e) => e.type === "settled").length, 1);
  assert.equal(a.budgets.remaining("a"), left);
  assert.ok(a.ledger.entries.length - n <= 2, "at most informational entries, no new settlement");
  assert.equal((await a.verifyChain()).valid, true);
});
test("shared store: two instances on one file see each other's bookings", { skip: NO }, async () => {
  const path = tmp();
  const a = mk({ store: await openAuditStore(path, { shared: true }) });
  const b = mk({ store: await openAuditStore(path, { shared: true }) });
  assert.equal(await a.beforePayment(ctx("x", "600")), undefined);
  assert.equal((await b.beforePayment(ctx("y", "600"))).reason, "audit deny: budget_exhausted");
  assert.equal(await b.beforePayment(ctx("x", "600")), undefined, "same key from the other instance reuses");
  assert.equal(b.openReservations().length, 1);
  await Promise.all([a.beforePayment(ctx("p", "200")), b.beforePayment(ctx("q", "200")), a.beforePayment(ctx("r", "200"))]);
  assert.equal((await b.beforePayment(ctx("z", "1"))).reason, "audit deny: budget_exhausted", "600 + 3x200 = budget");
  assert.equal((await a.verifyChain()).valid, true);
  await a.close(); await b.close();
  const c = mk({ store: await openAuditStore(path) });
  assert.equal((await c.verifyChain()).valid, true);
  const live = (await c.exportState()).reservations.filter((r) => r.status === "open");
  assert.ok(live.reduce((s, r) => s + Number(r.amount), 0) <= 1000);
  await c.close();
});
test("shared store: UNIQUE index refuses a second live reservation for a key (DB-level)", { skip: NO }, async () => {
  const path = tmp();
  const a = mk({ store: await openAuditStore(path, { shared: true }) });
  await a.beforePayment(ctx("dup"));
  await a.close();
  const d = new sqlite.DatabaseSync(path);
  const rec = JSON.parse(d.prepare("SELECT rec FROM reservations").get().rec);
  assert.throws(() => d.prepare("INSERT INTO reservations (id, rec, rev) VALUES (?, ?, 99)").run("rsv_other", JSON.stringify({ ...rec, id: "rsv_other" })), /UNIQUE/);
  d.close();
});
test("shared store: a single-writer file still refuses a second opener; shared mode opens", { skip: NO }, async () => {
  const path = tmp();
  const one = await openAuditStore(path);
  await assert.rejects(openAuditStore(path, { shared: true, busyTimeoutMs: 100 }), /unavailable/);
  one.close();
  const s1 = await openAuditStore(path, { shared: true }), s2 = await openAuditStore(path, { shared: true });
  s1.close(); s2.close();
});
test("shared store: 4 processes x 60 contested keys, kill one mid-run, restart: no double booking", { skip: NO }, async () => {
  const path = tmp();
  const W = new URL("../scripts/p2-worker.mjs", import.meta.url).pathname;
  const run = (wid, killAt = "") => new Promise((res) => { const p = spawn(process.execPath, ["--no-warnings", W, path, String(wid), "60", "1500", killAt]); let o = ""; p.stdout.on("data", (x) => (o += x)); p.on("exit", (code, sig) => res({ code, sig, o })); });
  const rs = await Promise.all([run(0), run(1), run(2, "30"), run(3)]);
  assert.equal(rs[2].sig, "SIGKILL");
  assert.ok(rs.filter((r) => !r.sig).every((r) => r.code === 0));
  assert.equal((await run(2)).code, 0);
  const d = new sqlite.DatabaseSync(path);
  const live = d.prepare("SELECT rec FROM reservations").all().map((r) => JSON.parse(r.rec)).filter((r) => r.status === "open");
  d.close();
  assert.equal(new Set(live.map((r) => r.idem)).size, live.length, "no key booked twice");
  assert.ok(live.reduce((s, r) => s + Number(r.amount), 0) <= 1500);
  const a = mk({ store: await openAuditStore(path, { shared: true }) });
  assert.equal((await a.verifyChain()).valid, true);
  await a.close();
});
