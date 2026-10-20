// P3 demo: remote authorize service on 127.0.0.1 (never public). Part A offline: latency overhead, down, slow,
// bad signature, replay. Part B (only with X402_TESTNET_KEY_FILE): real Base Sepolia calls authorised by the service.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAuditServer } from "../audit-server.js";
import { remoteAudit, requestSigningInput, hmac } from "../audit-remote.js";
import { createAudit } from "../audit.js";
import { openAuditStore } from "../audit-sqlite.js";
import { presets } from "../networks.js";
import { SAMPLE_REQUIREMENT } from "../testkit.js";

const dir = mkdtempSync(join(tmpdir(), "p3demo-"));
const clientKey = randomBytes(32).toString("base64url"); // demo-only secret, never printed
const { privateKey } = generateKeyPairSync("ed25519");
const policy = { version: "p3", dailyBudgetAtomic: Number(process.env.P3_BUDGET || 30000) };
const srv = await startAuditServer({ dbPath: join(dir, "svc.db"), clients: { "agent-7": clientKey, "bench": clientKey }, signingKey: privateKey, policy: { version: "p3-bench", dailyBudgetAtomic: 10 ** 12 }, networkConfig: [presets.baseMainnet, presets.baseSepolia] });
console.log(`service ${srv.url} (loopback only), kid ${srv.publicKey.kid}`);
const ctx = (key, net = "eip155:8453", asset = SAMPLE_REQUIREMENT.asset) => { const req = { ...SAMPLE_REQUIREMENT, network: net, asset, amount: "10" }; return { paymentRequired: { x402Version: 2, resource: { url: "https://seller.example/" + key }, accepts: [req] }, selectedRequirements: req, idempotencyKey: key }; };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const time = async (n, fn) => { const out = []; for (let i = 0; i < n; i++) { const t = performance.now(); await fn(i); out.push(performance.now() - t); } return out; };

// A1 latency: local shared-sqlite audit vs the same decision through the service
const N = Number(process.env.P3_N || 300);
const local = createAudit({ store: await openAuditStore(join(dir, "local.db"), { shared: true }), agentId: "bench", policy: { version: "b", dailyBudgetAtomic: 10 ** 12 } });
const remote = remoteAudit({ url: srv.url, clientId: "bench", clientKey, servicePublicKey: srv.publicKey });
await time(20, (i) => remote.beforePayment(ctx("warm" + i))); await time(20, (i) => local.beforePayment(ctx("warm" + i)));
const tl = await time(N, (i) => local.beforePayment(ctx("l" + i)));
const tr = await time(N, (i) => remote.beforePayment(ctx("r" + i)));
await local.close();
const lat = { calls: N, local_p50_ms: +pct(tl, 0.5).toFixed(2), local_p95_ms: +pct(tl, 0.95).toFixed(2), remote_p50_ms: +pct(tr, 0.5).toFixed(2), remote_p95_ms: +pct(tr, 0.95).toFixed(2) };
lat.overhead_p50_ms = +(lat.remote_p50_ms - lat.local_p50_ms).toFixed(2); lat.overhead_p95_ms = +(lat.remote_p95_ms - lat.local_p95_ms).toFixed(2);
console.log("A1 latency (authorize, loopback):", JSON.stringify(lat));

// A2 refusals
const down = remoteAudit({ url: "http://127.0.0.1:9", clientId: "agent-7", clientKey, servicePublicKey: srv.publicKey });
console.log("A2 service down      ->", JSON.stringify(await down.beforePayment(ctx("down"))));
const hang = createServer(() => {}); await new Promise((r) => hang.listen(0, "127.0.0.1", r));
const slow = remoteAudit({ url: `http://127.0.0.1:${hang.address().port}`, clientId: "agent-7", clientKey, servicePublicKey: srv.publicKey, timeoutMs: 300 });
let t0 = performance.now();
console.log("A2 service slow      ->", JSON.stringify(await slow.beforePayment(ctx("slow"))), `after ${Math.round(performance.now() - t0)} ms`);
hang.closeAllConnections(); hang.close();
const wrongPin = remoteAudit({ url: srv.url, clientId: "agent-7", clientKey, servicePublicKey: generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) });
console.log("A2 bad signature     ->", JSON.stringify(await wrongPin.beforePayment(ctx("pin"))));
const forger = remoteAudit({ url: srv.url, clientId: "agent-7", clientKey: "guessed", servicePublicKey: srv.publicKey });
console.log("A2 forged client     ->", JSON.stringify(await forger.beforePayment(ctx("forge"))));
const body = JSON.stringify({ ctx: ctx("replay") }), ts = Date.now(), nonce = randomBytes(16).toString("base64url");
const headers = { "content-type": "application/json", "x-audit-client": "agent-7", "x-audit-ts": String(ts), "x-audit-nonce": nonce, "x-audit-signature": hmac(clientKey, requestSigningInput({ method: "POST", path: "/v1/authorize", ts, nonce, body })) };
const r1 = await (await fetch(srv.url + "/v1/authorize", { method: "POST", headers, body })).json();
const r2 = await fetch(srv.url + "/v1/authorize", { method: "POST", headers, body });
console.log("A2 replay            -> first:", r1.ok, r1.result.allow, "| same request again:", r2.status, (await r2.json()).error);
console.log("A2 service stats     ->", JSON.stringify(srv.stats));

// B: real Base Sepolia through the service (testnet only)
if (process.env.X402_TESTNET_KEY_FILE) {
  const { x402Client, wrapFetchWithPayment, decodePaymentResponseHeader } = await import("@x402/fetch");
  const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
  const { afterPay } = await import("../after.js");
  const { loadTestnetConfig, loadTestnetAccount, readBalances } = await import("../test/harness/testnet.mjs");
  const { startSeller } = await import("../test/harness/seller.mjs");
  const cfg = loadTestnetConfig("base-sepolia");
  const buyer = await loadTestnetAccount();
  const svc = await startAuditServer({ dbPath: join(dir, "sepolia.db"), clients: { "agent-7": clientKey }, signingKey: privateKey, policy, networkConfig: presets.baseSepolia });
  const agent = remoteAudit({ url: svc.url, clientId: "agent-7", clientKey, servicePublicKey: svc.publicKey });
  const seller = await startSeller({ cfg, mode: "sepolia", payTo: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674", amount: "10000" });
  const before = await readBalances(cfg, buyer.address);
  console.log(`B  Sepolia: buyer ${buyer.address} start ${Number(before.usdcAtomic) / 1e6} test USDC; budget ${policy.dailyBudgetAtomic / 1e6} via service`);
  const client = new x402Client(); registerExactEvmScheme(client, { signer: buyer.account });
  let authMs = 0; client.onBeforePaymentCreation(async (c) => { const t = performance.now(); const r = await agent.beforePayment(c); authMs = performance.now() - t; return r; });
  let proof = null; const tap = async (i, init) => { proof = new Headers(init?.headers || (i instanceof Request ? i.headers : undefined)).get("payment-signature") || proof; return fetch(i, init); };
  const pay = wrapFetchWithPayment(tap, client);
  const rpc = (m, p) => fetch(cfg.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) }).then((x) => x.json()).then((j) => j.result);
  for (let i = 1; i <= 4; i++) {
    proof = null; const t = performance.now();
    try {
      const r = await pay(seller.url);
      if (r.status !== 200) { // seller/facilitator refused: ask payment-status so the service can release the hold
        const st = proof ? await afterPay({}, { url: seller.statusUrl, paymentHeader: proof, publicKey: seller.receiptKey }) : null;
        const adv = st ? await agent.onAfterPay(st, { url: seller.url, paymentPayload: proof }) : null;
        console.log(`B  call ${i}: seller HTTP ${r.status} (${seller.stats.rejections.at(-1)}) service:${adv?.move}`); continue;
      }
      const tx = decodePaymentResponseHeader(r.headers.get("payment-response")).transaction;
      await agent.onPayment({ paymentPayload: proof, url: seller.url });
      const st = await afterPay({ txHash: tx, network: cfg.network }, { url: seller.statusUrl, paymentHeader: proof, publicKey: seller.receiptKey });
      const adv = await agent.onAfterPay(st, { url: seller.url, paymentPayload: proof });
      for (let k = 0; k < 30 && !(await rpc("eth_getTransactionReceipt", [tx])); k++) await new Promise((x) => setTimeout(x, 500));
      console.log(`B  call ${i}: HTTP ${r.status} ${Math.round(performance.now() - t)} ms (authorize ${authMs.toFixed(1)} ms) ${cfg.explorer}/tx/${tx} service:${adv.move}`);
    } catch (e) { console.log(`B  call ${i}: refused before signing (authorize ${authMs.toFixed(1)} ms): ${String(e.message).split(": ").pop()}`); }
  }
  await new Promise((x) => setTimeout(x, 3000));
  const after = await readBalances(cfg, buyer.address);
  const ch = await agent.chain();
  console.log("B  summary:", JSON.stringify({ spend_test_usdc: Number(before.usdcAtomic - after.usdcAtomic) / 1e6, end_test_usdc: Number(after.usdcAtomic) / 1e6, chain: ch.verify, ledger: ch.entries.map((e) => e.type + (e.reason ? ":" + e.reason : "")) }));
  await seller.close(); await svc.close();
}
await srv.close();
