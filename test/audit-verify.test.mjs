// P4: the authorize service must not blindly trust client-reported payment-status. Mock Base Sepolia RPC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createEvmSettlementVerifier, EVENT_TOPICS } from "../evm-verify.js";
import { remoteAudit } from "../audit-remote.js";
let sqlite = null;
try { sqlite = await import("node:sqlite"); } catch { /* Node < 22.13 */ }
const { startAuditServer } = sqlite ? await import("../audit-server.js") : {};
const skip = !sqlite && "node:sqlite not available";
const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e", PAYTO = "0x" + "5e".repeat(20), BUYER = "0x" + "b0".repeat(20), OTHER = "0x" + "0f".repeat(20);
const w = (h) => "0x" + h.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const nonceOf = (i) => "0x" + String(i).padStart(64, "0");
const payload = (n, from = BUYER, validBefore = 1) => b64({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:84532", amount: "10000", asset: USDC, payTo: PAYTO }, payload: { authorization: { from, to: PAYTO, value: "10000", validAfter: "0", validBefore: String(validBefore), nonce: n } } });
const tx = (i) => "0x" + String(i).padStart(64, "a");
// chain state: txs and used nonces
const chain = { txs: new Map(), used: new Set(), head: 1000 };
function mine(i, { from = BUYER, to = PAYTO, value = 10000n, nonce = nonceOf(i), status = "0x1", asset = USDC } = {}) {
  chain.txs.set(tx(i), { status, blockNumber: "0x" + (990).toString(16), logs: [
    { address: asset, topics: [EVENT_TOPICS.AUTH_USED, w(from), w(nonce)], data: "0x" },
    { address: asset, topics: [EVENT_TOPICS.TRANSFER, w(from), w(to)], data: "0x" + value.toString(16) },
  ] });
  chain.used.add(from.toLowerCase() + nonce);
}
const rpcFetch = async (_u, init) => {
  const { method, params, id } = JSON.parse(init.body);
  let result = null;
  if (method === "eth_getTransactionReceipt") result = chain.txs.get(params[0]) || null;
  if (method === "eth_blockNumber") result = "0x" + chain.head.toString(16);
  if (method === "eth_call") { const d = params[0].data; const from = "0x" + d.slice(10 + 24, 74), n = "0x" + d.slice(74); result = w(chain.used.has(from + n) ? "1" : "0"); }
  return Response.json({ jsonrpc: "2.0", id, result });
};
const KEYS = { "agent-a": randomBytes(32).toString("base64url"), "agent-b": randomBytes(32).toString("base64url") };
async function boot(extra = {}) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const srv = await startAuditServer({ dbPath: join(mkdtempSync(join(tmpdir(), "p4v-")), "s.db"), clients: KEYS, signingKey: privateKey, policy: { version: "v", dailyBudgetAtomic: 30000 }, ...extra });
  const cl = (id = "agent-a") => remoteAudit({ url: srv.url, clientId: id, clientKey: KEYS[id], servicePublicKey: srv.publicKey });
  return { srv, cl };
}
const req = { scheme: "exact", network: "eip155:84532", amount: "10000", asset: USDC, payTo: PAYTO, maxTimeoutSeconds: 60, extra: {} };
const ctx = (k) => ({ paymentRequired: { x402Version: 2, resource: { url: "http://seller.local/" + k }, accepts: [req] }, selectedRequirements: req, idempotencyKey: k });
async function paid(a, i, n = nonceOf(i), from = BUYER, vb = 1) { const c = ctx("k" + i); assert.equal(await a.beforePayment(c), undefined); await a.onPayment({ paymentPayload: payload(n, from, vb), url: c.paymentRequired.resource.url }); return { c, p: payload(n, from, vb) }; }
const landedClaim = (h) => ({ status: "landed", receipt_verified: true, safe_to_resign: false, tx: { hash: h, confirmations: 99 }, finality: { confirmations: 99, min_confirmations: 1, reorg_safe: true } });

test("no verifier: client-reported status is downgraded to unverified (hold), never settles or releases", { skip }, async () => {
  const { srv, cl } = await boot();
  const a = cl();
  const { c, p } = await paid(a, 1);
  const r = await a.onAfterPay(landedClaim(tx(1)), { url: c.paymentRequired.resource.url, paymentPayload: p });
  assert.equal(r.verified, false); assert.equal(r.verification, "client_status_unverified"); assert.equal(r.move, "hold");
  const r2 = await a.onAfterPay({ status: "not_landed", receipt_verified: true, safe_to_resign: true }, { url: c.paymentRequired.resource.url, paymentPayload: p });
  assert.notEqual(r2.move, "release");
  assert.equal(srv.audit.openReservations().length, 1);
  await srv.close();
});
test("on-chain verifier: truthful landed settles; lies are refused (wrong tx, missing tx, reverted, wrong payee/amount, other nonce)", { skip }, async () => {
  const verifier = createEvmSettlementVerifier({ rpcUrl: "http://rpc.mock", fetch: rpcFetch });
  const { srv, cl } = await boot({ settlementVerifier: verifier });
  const a = cl();
  mine(10);
  const ok = await paid(a, 10);
  const good = await a.onAfterPay(landedClaim(tx(10)), { url: ok.c.paymentRequired.resource.url, paymentPayload: ok.p });
  assert.equal(good.move, "settle"); assert.equal(good.verification, "onchain");
  const lies = [
    ["cites someone else's real tx", () => { mine(21, { from: OTHER, nonce: nonceOf(9021) }); return tx(21); }, "no_matching_transfer"],
    ["cites a tx that does not exist", () => tx(22), "tx_not_found"],
    ["cites a reverted tx", () => { mine(23, { status: "0x0" }); return tx(23); }, "tx_reverted"],
    ["right payer, wrong payee", () => { mine(24, { to: OTHER }); return tx(24); }, "no_matching_transfer"],
    ["right payee, lower amount", () => { mine(25, { value: 1n }); return tx(25); }, "no_matching_transfer"],
    ["a real transfer, but another authorization nonce", () => { mine(26, { nonce: nonceOf(7026) }); return tx(26); }, "authorization_nonce_not_in_tx"],
  ];
  for (const [i, [label, mk, why]] of lies.entries()) {
    const { c, p } = i < 2 ? await paid(a, 30 + i) : { c: ok.c, p: null };
    if (!p) { await srv.close(); break; }
    const r = await a.onAfterPay(landedClaim(mk()), { url: c.paymentRequired.resource.url, paymentPayload: p });
    assert.equal(r.verified, false, label); assert.equal(r.verification, why, label); assert.notEqual(r.move, "settle", label);
  }
});
test("on-chain verifier: lie table, one fresh reservation each", { skip }, async () => {
  const verifier = createEvmSettlementVerifier({ rpcUrl: "http://rpc.mock", fetch: rpcFetch });
  const cases = [
    ["reverted tx", (i) => { mine(i, { status: "0x0" }); return tx(i); }, "tx_reverted"],
    ["wrong payee", (i) => { mine(i, { to: OTHER }); return tx(i); }, "no_matching_transfer"],
    ["lower amount", (i) => { mine(i, { value: 1n }); return tx(i); }, "no_matching_transfer"],
    ["other nonce in tx", (i) => { mine(i, { nonce: nonceOf(8000 + i) }); return tx(i); }, "authorization_nonce_not_in_tx"],
    ["no tx hash", () => "0x123", "no_tx_hash"],
  ];
  for (const [k, [label, mk, why]] of cases.entries()) {
    const { srv, cl } = await boot({ settlementVerifier: verifier });
    const a = cl();
    const { c, p } = await paid(a, 100 + k);
    const r = await a.onAfterPay(landedClaim(mk(100 + k)), { url: c.paymentRequired.resource.url, paymentPayload: p });
    assert.equal(r.verification, why, label); assert.equal(r.move, "hold", label);
    assert.equal(srv.audit.openReservations().length, 1, label + ": budget still held");
    await srv.close();
  }
});
test("on-chain verifier: a false not_landed (authorization already used) cannot free the budget", { skip }, async () => {
  const verifier = createEvmSettlementVerifier({ rpcUrl: "http://rpc.mock", fetch: rpcFetch });
  const { srv, cl } = await boot({ settlementVerifier: verifier });
  const a = cl();
  mine(40);
  const { c, p } = await paid(a, 40);
  const lie = await a.onAfterPay({ status: "not_landed", receipt_verified: true, safe_to_resign: true }, { url: c.paymentRequired.resource.url, paymentPayload: p });
  assert.equal(lie.verification, "authorization_already_used"); assert.notEqual(lie.move, "release");
  const live = await paid(a, 41, nonceOf(41), BUYER, Math.floor(Date.now() / 1000) + 600);
  const early = await a.onAfterPay({ status: "not_landed", receipt_verified: true, safe_to_resign: true }, { url: live.c.paymentRequired.resource.url, paymentPayload: live.p });
  assert.equal(early.verification, "authorization_still_valid");
  const exp = await paid(a, 42);
  const truthful = await a.onAfterPay({ status: "not_landed", receipt_verified: true, safe_to_resign: true }, { url: exp.c.paymentRequired.resource.url, paymentPayload: exp.p });
  assert.equal(truthful.verification, "onchain"); assert.equal(truthful.move, "release");
  await srv.close();
});
test("settle for another client's reservation, or with an unbound payer, is refused", { skip }, async () => {
  const verifier = createEvmSettlementVerifier({ rpcUrl: "http://rpc.mock", fetch: rpcFetch });
  const { srv, cl } = await boot({ settlementVerifier: verifier, payers: { "agent-a": BUYER } });
  const a = cl(), b = cl("agent-b");
  mine(50);
  const { c, p } = await paid(a, 50);
  const r = await b.onAfterPay(landedClaim(tx(50)), { url: c.paymentRequired.resource.url, paymentPayload: p });
  assert.equal(r.verification, "no_reservation_for_this_client");
  mine(51, { from: OTHER });
  const x = await paid(a, 51, nonceOf(51), OTHER);
  const r2 = await a.onAfterPay(landedClaim(tx(51)), { url: x.c.paymentRequired.resource.url, paymentPayload: x.p });
  assert.equal(r2.verification, "payer_not_bound_to_client");
  await srv.close();
});
