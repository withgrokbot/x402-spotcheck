// P4: ~20 real Base Sepolia calls through the localhost authorize service, with the service verifying every
// client-reported payment-status ON-CHAIN (evm-verify.js), plus one live lie. Testnet only; keys never printed.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { x402Client, wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { startAuditServer } from "../audit-server.js";
import { remoteAudit } from "../audit-remote.js";
import { createEvmSettlementVerifier } from "../evm-verify.js";
import { presets } from "../networks.js";
import { afterPay } from "../after.js";
import { loadTestnetConfig, loadTestnetAccount, readBalances } from "../test/harness/testnet.mjs";
import { startSeller } from "../test/harness/seller.mjs";

const cfg = loadTestnetConfig("base-sepolia");
const buyer = await loadTestnetAccount();
if (!buyer) { console.error("set X402_TESTNET_KEY_FILE"); process.exit(2); }
const N = Number(process.env.E2E_CALLS || 20), PRICE = 10000, PAYTO = "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674";
const clientKey = randomBytes(32).toString("base64url");
const { privateKey } = generateKeyPairSync("ed25519");
const svc = await startAuditServer({ dbPath: join(mkdtempSync(join(tmpdir(), "p4e2e-")), "svc.db"), clients: { "agent-7": clientKey }, payers: { "agent-7": buyer.address }, signingKey: privateKey, policy: { version: "p4", dailyBudgetAtomic: (N + 1) * PRICE }, networkConfig: presets.baseSepolia, settlementVerifier: createEvmSettlementVerifier({ rpcUrl: cfg.rpcUrl }) });
const agent = remoteAudit({ url: svc.url, clientId: "agent-7", clientKey, servicePublicKey: svc.publicKey, timeoutMs: 8000 });
const seller = await startSeller({ cfg, mode: "sepolia", payTo: PAYTO, amount: String(PRICE) });
const rpc = (m, p) => fetch(cfg.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) }).then((x) => x.json()).then((j) => j.result);
const before = await readBalances(cfg, buyer.address);
console.log(`buyer ${buyer.address} start ${Number(before.usdcAtomic) / 1e6} test USDC | service ${svc.url} verifies on ${cfg.rpcUrl} | budget ${((N + 1) * PRICE) / 1e6}`);
const client = new x402Client(); registerExactEvmScheme(client, { signer: buyer.account });
client.onBeforePaymentCreation((c) => agent.beforePayment(c));
let proof = null; const tap = async (i, init) => { proof = new Headers(init?.headers || (i instanceof Request ? i.headers : undefined)).get("payment-signature") || proof; return fetch(i, init); };
const pay = wrapFetchWithPayment(tap, client);
const out = { paid: 0, settled_onchain: 0, failed: 0, refused: 0, txs: [], ms: [], verify_ms: [] };
let lastTx = null;
for (let i = 1; i <= N + 2; i++) {
  if (i === N + 1 && lastTx) { // live lie: a fresh reservation, an unsigned fabricated authorization, and the previous call's real tx
    const req = { scheme: "exact", network: cfg.network, amount: String(PRICE), asset: cfg.assets.USDC.address, payTo: PAYTO, maxTimeoutSeconds: 120, extra: {} };
    const c = { paymentRequired: { x402Version: 2, resource: { url: seller.url + "?lie" }, accepts: [req] }, selectedRequirements: req, idempotencyKey: "lie" };
    const ok = await agent.beforePayment(c);
    const fake = Buffer.from(JSON.stringify({ x402Version: 2, payload: { authorization: { from: buyer.address, to: PAYTO, value: String(PRICE), validBefore: "1", nonce: "0x" + randomBytes(32).toString("hex") } } })).toString("base64");
    await agent.onPayment({ paymentPayload: fake, url: c.paymentRequired.resource.url });
    const r = await agent.onAfterPay({ status: "landed", receipt_verified: true, tx: { hash: lastTx, confirmations: 50 }, finality: { confirmations: 50, min_confirmations: 1, reorg_safe: true } }, { url: c.paymentRequired.resource.url, paymentPayload: fake });
    console.log(`LIE  reserved=${ok === undefined} claims landed with previous real tx ${lastTx.slice(0, 12)}… -> service move=${r.move} verified=${r.verified} (${r.verification})`);
    out.lie = r.verification;
    continue;
  }
  proof = null; const t0 = performance.now();
  let r;
  try { r = await pay(seller.url); } catch (e) { out.refused++; console.log(`call ${i}: refused before signing: ${String(e.message).split(": ").pop()}`); continue; }
  if (r.status !== 200) { out.failed++; console.log(`call ${i}: seller ${r.status} (${seller.stats.rejections.at(-1)})`); if (proof) { await agent.onPayment({ paymentPayload: proof, url: seller.url }); const adv = await agent.onAfterPay(await afterPay({}, { url: seller.statusUrl, paymentHeader: proof, publicKey: seller.receiptKey }), { url: seller.url, paymentPayload: proof }); console.log(`        service ${adv.move}/${adv.verification}`); } continue; }
  const tx = decodePaymentResponseHeader(r.headers.get("payment-response")).transaction;
  out.paid++; lastTx = tx; out.txs.push(tx);
  for (let k = 0; k < 40 && !(await rpc("eth_getTransactionReceipt", [tx])); k++) await new Promise((x) => setTimeout(x, 500));
  await agent.onPayment({ paymentPayload: proof, url: seller.url });
  const st = await afterPay({ txHash: tx, network: cfg.network }, { url: seller.statusUrl, paymentHeader: proof, publicKey: seller.receiptKey });
  const tv = performance.now();
  const adv = await agent.onAfterPay(st, { url: seller.url, paymentPayload: proof });
  out.verify_ms.push(performance.now() - tv); out.ms.push(performance.now() - t0);
  if (adv.move === "settle" && adv.verification === "onchain") out.settled_onchain++;
  console.log(`call ${i}: HTTP 200 ${Math.round(performance.now() - t0)} ms  ${cfg.explorer}/tx/${tx}  service ${adv.move}/${adv.verification} (${Math.round(out.verify_ms.at(-1))} ms)`);
}
await new Promise((x) => setTimeout(x, 3000));
const after = await readBalances(cfg, buyer.address);
const ch = await agent.chain();
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.floor(s.length / 2)] || 0); };
console.log(JSON.stringify({ attempts: N + 2, paid: out.paid, settled_verified_onchain: out.settled_onchain, seller_failed: out.failed, refused_by_budget: out.refused, live_lie: out.lie, spend_test_usdc: Number(before.usdcAtomic - after.usdcAtomic) / 1e6, end_test_usdc: Number(after.usdcAtomic) / 1e6, median_call_ms: med(out.ms), median_onchain_verify_ms: med(out.verify_ms), chain: ch.verify, service_verify_stats: svc.stats.verify, open_holds: svc.audit.openReservations().length }, null, 1));
await seller.close(); await svc.close();
