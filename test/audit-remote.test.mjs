// P3: remote authorize service + client. Server needs node:sqlite (Node >= 22.13); localhost only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { remoteAudit, requestSigningInput, hmac } from "../audit-remote.js";
import { SAMPLE_REQUIREMENT } from "../testkit.js";
let sqlite = null;
try { sqlite = await import("node:sqlite"); } catch { /* Node < 22.13 */ }
const { startAuditServer } = sqlite ? await import("../audit-server.js") : {};
const skip = !sqlite && "node:sqlite not available";
const ctx = (key, amount = "100") => { const req = { ...SAMPLE_REQUIREMENT, amount }; return { paymentRequired: { x402Version: 2, resource: { url: "https://seller.example/a" }, accepts: [req] }, selectedRequirements: req, ...(key ? { idempotencyKey: key } : {}) }; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const pay = (nonce, amount = "600") => b64({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453", amount, asset: SAMPLE_REQUIREMENT.asset, payTo: SAMPLE_REQUIREMENT.payTo }, payload: { authorization: { from: "0x" + "11".repeat(20), to: SAMPLE_REQUIREMENT.payTo, value: amount, validBefore: "1700000000", nonce } } });
const landed = () => ({ status: "landed", receipt_verified: true, id: "ps-0123456789abcdef", tx: { hash: "0xabc", confirmations: 12 }, finality: { confirmations: 12, min_confirmations: 10, reorg_safe: true } });
const KEYS = { "agent-a": randomBytes(32).toString("base64url"), "agent-b": randomBytes(32).toString("base64url") };
async function boot(extra = {}) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const dbPath = join(mkdtempSync(join(tmpdir(), "p3-")), "svc.db");
  const srv = await startAuditServer({ dbPath, clients: KEYS, signingKey: privateKey, policy: { version: "p3", dailyBudgetAtomic: 1000 }, ...extra });
  const { after } = await import("node:test");
  after(() => srv.close().catch(() => {}));
  const client = (id = "agent-a", o = {}) => remoteAudit({ url: srv.url, clientId: id, clientKey: KEYS[id], servicePublicKey: srv.publicKey, ...o });
  return { srv, client, dbPath };
}

test("authorize -> payment -> settle -> chain; budget enforced by the service", { skip }, async () => {
  const { srv, client } = await boot();
  const a = client();
  const c = ctx("k1", "600");
  assert.equal(await a.beforePayment(c), undefined);
  assert.match(c.audit.reservationId, /^rsv_/);
  assert.equal((await a.beforePayment(ctx("k2", "600"))).reason, "audit deny: budget_exhausted");
  assert.equal(await a.beforePayment(ctx("k1", "600")), undefined, "idempotent retry");
  await a.onPayment({ paymentPayload: pay("0x" + "01".repeat(32)), url: "https://seller.example/a" });
  const adv = await a.onAfterPay(landed(), { url: "https://seller.example/a", paymentPayload: pay("0x" + "01".repeat(32)) });
  assert.equal(adv.move, "settle");
  const again = await a.onAfterPay(landed(), { url: "https://seller.example/a", paymentPayload: pay("0x" + "01".repeat(32)) });
  assert.notEqual(again.move, "release");
  const ch = await a.chain();
  assert.equal(ch.verify.valid, true);
  assert.equal(ch.entries.filter((e) => e.type === "settled").length, 1, JSON.stringify(ch.entries.map((e) => e.type + ":" + e.reason)) + JSON.stringify(again));
  await srv.close();
});
test("release frees the reservation; budgets are per client", { skip }, async () => {
  const { srv, client } = await boot();
  const a = client(), b = client("agent-b");
  const c = ctx("r1", "900");
  await a.beforePayment(c);
  assert.equal(await b.beforePayment(ctx("r2", "900")), undefined, "agent-b has its own budget");
  assert.equal((await a.beforePayment(ctx("r3", "900"))).reason, "audit deny: budget_exhausted");
  await a.onDecision({ verdict: "skip", reason_code: "price_mismatch", url: "https://seller.example/a" }, c);
  assert.equal(await a.beforePayment(ctx("r3", "900")), undefined);
  await srv.close();
});
test("refuses: service down, slow (timeout), wrong pinned key, wrong client key", { skip }, async () => {
  const { srv, client } = await boot();
  const down = remoteAudit({ url: "http://127.0.0.1:9", clientId: "agent-a", clientKey: KEYS["agent-a"], servicePublicKey: srv.publicKey });
  assert.equal((await down.beforePayment(ctx("d"))).reason, "audit deny: audit_service_unavailable");
  const slowSrv = createServer(() => { /* never answers */ });
  await new Promise((r) => slowSrv.listen(0, "127.0.0.1", r));
  const slow = remoteAudit({ url: `http://127.0.0.1:${slowSrv.address().port}`, clientId: "agent-a", clientKey: KEYS["agent-a"], servicePublicKey: srv.publicKey, timeoutMs: 150 });
  const t0 = Date.now(); const r = await slow.beforePayment(ctx("s"));
  assert.equal(r.reason, "audit deny: audit_service_unavailable"); assert.equal(r.detail, "timeout"); assert.ok(Date.now() - t0 < 1000);
  slowSrv.closeAllConnections(); slowSrv.close();
  const other = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
  assert.equal((await client("agent-a", { servicePublicKey: other }).beforePayment(ctx("w"))).reason, "audit deny: audit_service_bad_signature");
  const imp = remoteAudit({ url: srv.url, clientId: "agent-a", clientKey: "not-the-key", servicePublicKey: srv.publicKey });
  assert.equal((await imp.beforePayment(ctx("i"))).reason, "audit deny: audit_service_unavailable");
  assert.equal(srv.stats.refused.auth, 1);
  // The wrong-pin call reached the real service, which booked; the client refused to pay, so the hold is safe
  // (released by reconcile/skip). Refused-auth and down/slow calls booked nothing.
  assert.equal(srv.audit.openReservations().length, 1);
  await srv.close();
});
test("replay and stale timestamps are refused; a tampered response is refused", { skip }, async () => {
  const { srv, client } = await boot();
  const body = JSON.stringify({ ctx: ctx("rp") }), ts = Date.now(), nonce = "n-" + randomBytes(6).toString("hex");
  const h = (t, n) => ({ "content-type": "application/json", "x-audit-client": "agent-a", "x-audit-ts": String(t), "x-audit-nonce": n, "x-audit-signature": hmac(KEYS["agent-a"], requestSigningInput({ method: "POST", path: "/v1/authorize", ts: t, nonce: n, body })) });
  const first = await (await fetch(srv.url + "/v1/authorize", { method: "POST", headers: h(ts, nonce), body })).json();
  assert.equal(first.ok, true);
  const replay = await fetch(srv.url + "/v1/authorize", { method: "POST", headers: h(ts, nonce), body });
  assert.equal(replay.status, 401); assert.equal((await replay.json()).error, "replay");
  const stale = await fetch(srv.url + "/v1/authorize", { method: "POST", headers: h(ts - 60_000, "n2"), body });
  assert.equal((await stale.json()).error, "stale_timestamp");
  assert.equal(srv.audit.openReservations().length, 1, "the replay did not book again");
  // tampered response: proxy flips allow
  const proxy = createServer(async (req, res) => { let b = ""; for await (const c of req) b += c; const up = await fetch(srv.url + req.url, { method: req.method, headers: req.headers, body: b || undefined }); const j = await up.json(); j.result = { allow: true, reservationId: "rsv_forged" }; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(j)); });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const via = remoteAudit({ url: `http://127.0.0.1:${proxy.address().port}`, clientId: "agent-a", clientKey: KEYS["agent-a"], servicePublicKey: srv.publicKey });
  assert.equal((await via.beforePayment(ctx("t", "5000"))).reason, "audit deny: audit_service_bad_signature");
  proxy.close();
  await srv.close();
});
test("server refuses a non-loopback bind in this phase; restart keeps state", { skip }, async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  await assert.rejects(startAuditServer({ dbPath: join(mkdtempSync(join(tmpdir(), "p3-")), "x.db"), clients: KEYS, signingKey: privateKey, host: "0.0.0.0" }), /non-loopback/);
  const { srv, dbPath } = await boot();
  const a = remoteAudit({ url: srv.url, clientId: "agent-a", clientKey: KEYS["agent-a"], servicePublicKey: srv.publicKey });
  await a.beforePayment(ctx("keep", "700"));
  await srv.close();
  const srv2 = await startAuditServer({ dbPath, clients: KEYS, signingKey: privateKey, policy: { version: "p3", dailyBudgetAtomic: 1000 } });
  const a2 = remoteAudit({ url: srv2.url, clientId: "agent-a", clientKey: KEYS["agent-a"], servicePublicKey: srv2.publicKey });
  assert.equal((await a2.beforePayment(ctx("more", "700"))).reason, "audit deny: budget_exhausted");
  assert.equal((await a2.chain()).verify.valid, true);
  await srv2.close();
});
