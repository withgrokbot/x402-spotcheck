// P1 demo: REAL Base Sepolia end-to-end with the baseSepolia preset against our own harness seller in Sepolia mode.
// Testnet only: refuses non-testnet config. Key from X402_TESTNET_KEY_FILE (mode 600); only addresses are printed.
import { randomBytes } from "node:crypto";
import { x402Client, wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { createAudit } from "../audit.js";
import { presets } from "../networks.js";
import { afterPay } from "../after.js";
import { loadTestnetConfig, loadTestnetAccount, readBalances } from "../test/harness/testnet.mjs";
import { startSeller } from "../test/harness/seller.mjs";

const cfg = loadTestnetConfig("base-sepolia");
const buyer = await loadTestnetAccount();
if (!buyer) { console.error("set X402_TESTNET_KEY_FILE"); process.exit(2); }
const payTo = process.env.E2E_PAY_TO || "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674"; // our BM-001 address (testnet funds recoverable)
const N = Number(process.env.E2E_CALLS || 4), PRICE = "10000", BUDGET = Number(process.env.E2E_BUDGET || 30000);
const before = await readBalances(cfg, buyer.address);
console.log(`buyer ${buyer.address}  payTo ${payTo}  start: ${Number(before.usdcAtomic) / 1e6} test USDC, ${Number(before.ethWei) / 1e18} ETH`);

const seller = await startSeller({ cfg, mode: "sepolia", payTo, amount: PRICE, x402Version: 2 });
const audit = createAudit({ agentId: "p1-sepolia", payloadKey: randomBytes(32), networkConfig: presets.baseSepolia, policy: { version: "p1", dailyBudgetAtomic: BUDGET } });
const client = new x402Client();
registerExactEvmScheme(client, { signer: buyer.account });
client.onBeforePaymentCreation(audit.beforePayment);
let lastProof = null;
const tap = async (input, init) => { const h = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined)); lastProof = h.get("payment-signature") || lastProof; return fetch(input, init); };
const pay = wrapFetchWithPayment(tap, client);

// Preset sanity (no network): mainnet USDC and an unknown Sepolia asset never reach signing.
const fake = (network, asset) => { const req = { scheme: "exact", network, amount: PRICE, asset, payTo, maxTimeoutSeconds: 120, extra: {} }; return { paymentRequired: { x402Version: 2, resource: { url: seller.url }, accepts: [req] }, selectedRequirements: req }; };
console.log("preset: Base mainnet USDC ->", (await audit.beforePayment(fake("eip155:8453", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"))).reason);
console.log("preset: unknown Sepolia asset ->", (await audit.beforePayment(fake("eip155:84532", "0x" + "de".repeat(20)))).reason);

const rpc = (m, p) => fetch(cfg.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) }).then((x) => x.json()).then((j) => j.result);
const rows = [];
for (let i = 1; i <= N; i++) {
  const t0 = performance.now(); lastProof = null;
  let r, err = null;
  try { r = await pay(seller.url); } catch (e) { err = e; }
  const ms = Math.round(performance.now() - t0);
  if (err) { console.log(`call ${i}: not paid (${ms} ms): ${String(err.message || err).slice(0, 110)}`); rows.push({ i, paid: false, ms }); continue; }
  const pr = r.headers.get("payment-response");
  const tx = pr ? decodePaymentResponseHeader(pr).transaction : null;
  let advice = null;
  if (lastProof) { // paid OR re-402'd: ask payment-status (needsAfterPay), so a non-landed proof releases its reservation
    await audit.onPayment({ paymentPayload: lastProof, url: seller.url });
    const st = await afterPay({ txHash: tx, network: cfg.network }, { url: seller.statusUrl, paymentHeader: lastProof, publicKey: seller.receiptKey });
    advice = await audit.onAfterPay(st, { url: seller.url, paymentPayload: lastProof });
  }
  if (tx && process.env.E2E_WAIT_RECEIPT !== "0") { // let the facilitator's view of the buyer's state catch up before the next call
    for (let k = 0; k < 30 && !(await rpc("eth_getTransactionReceipt", [tx])); k++) await new Promise((res) => setTimeout(res, 500));
  }
  console.log(`call ${i}: HTTP ${r.status} in ${ms} ms  tx ${tx ? cfg.explorer + "/tx/" + tx : "-"}  audit ${advice ? advice.move : "-"}${tx ? "" : " (" + (seller.stats.rejections.at(-1) || "no proof") + ")"}`);
  rows.push({ i, paid: r.status === 200 && !!tx, tx, ms });
}
// on-chain confirmation (read-only)
for (const row of rows.filter((x) => x.tx)) { const rc = await rpc("eth_getTransactionReceipt", [row.tx]); row.onchain = rc ? (rc.status === "0x1" ? "success" : "reverted") + " block " + parseInt(rc.blockNumber, 16) : "pending"; }
await new Promise((r) => setTimeout(r, 3000));
const after = await readBalances(cfg, buyer.address);
const paid = rows.filter((x) => x.paid);
console.log(JSON.stringify({ calls: N, paid: paid.length, denied_or_failed: N - paid.length, onchain: paid.map((x) => x.onchain), spend_test_usdc: Number(before.usdcAtomic - after.usdcAtomic) / 1e6, end_test_usdc: Number(after.usdcAtomic) / 1e6, eth_spent: Number(before.ethWei - after.ethWei) / 1e18, ms_paid_calls: paid.map((x) => x.ms), open_reservations: audit.openReservations().length, chain: await audit.verifyChain(), denied: audit.ledger.entries.filter((e) => e.type === "denied").map((e) => e.reason), seller: seller.stats.paid + " settled / " + seller.stats.rejected + " rejected", seller_rejections: seller.stats.rejections }, null, 1));
await seller.close();
