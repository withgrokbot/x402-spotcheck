// P0 demo: full pay -> after-pay -> reconcile cycle against our own local seller (offline, Base Sepolia terms, no signing).
import { randomBytes } from "node:crypto";
import { createAudit } from "../audit.js";
import { afterPay } from "../after.js";
import { loadTestnetConfig } from "../test/harness/testnet.mjs";
import { startSeller, mockProof } from "../test/harness/seller.mjs";

const cfg = loadTestnetConfig("base-sepolia");
const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));
const N = Number(process.env.E2E_CALLS || 5);
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`); };

for (const version of [2, 1]) {
  const seller = await startSeller({ cfg, mode: "mock", x402Version: version });
  const audit = createAudit({ agentId: "p0-e2e", payloadKey: randomBytes(32), policy: { version: "p0", dailyBudgetAtomic: 30000 } });
  console.log(`x402 v${version} seller at ${seller.url} (${cfg.network}, USDC ${cfg.assets.USDC.address})`);
  const t0 = performance.now();
  let paid = 0, denied = 0;
  for (let i = 0; i < N; i++) {
    const r402 = await fetch(seller.url);
    const required = unb64(r402.headers.get("payment-required"));
    const sel = required.accepts[0];
    const deny = await audit.beforePayment({ paymentRequired: required, selectedRequirements: sel });
    if (deny?.abort) { denied++; if (denied === 1) console.log(`  call ${i + 1}: audit denied -> ${deny.reason}`); continue; }
    const proof = mockProof(required, { nonce: "0x" + randomBytes(32).toString("hex") });
    await audit.onPayment({ paymentPayload: proof, url: seller.url });
    const r = await fetch(seller.url, { headers: { [version === 2 ? "payment-signature" : "x-payment"]: proof } });
    const tx = unb64(r.headers.get("payment-response") || "e30=").transaction;
    const status = await afterPay({ txHash: tx, network: cfg.network }, { url: seller.statusUrl, paymentHeader: proof, publicKey: seller.receiptKey });
    const advice = await audit.onAfterPay(status, { url: seller.url, paymentPayload: proof });
    if (r.status === 200 && status.status === "landed") paid++;
    if (i === 0) console.log(`  call 1: seller ${r.status}, payment-status sent ${JSON.stringify(seller.stats.headersSeen.at(-1))} -> ${status.status}, advice ${JSON.stringify(advice).slice(0, 90)}`);
  }
  // replay the last nonce: seller must refuse
  const required = unb64((await fetch(seller.url)).headers.get("payment-required"));
  const nonce = "0x" + "77".repeat(32);
  const p = mockProof(required, { nonce });
  await fetch(seller.url, { headers: { "payment-signature": p } });
  const replay = await fetch(seller.url, { headers: { "payment-signature": p } });
  const rec = await audit.reconcile();
  const chain = await audit.verifyChain();
  const ms = (performance.now() - t0).toFixed(0);
  check(paid + denied === N, `${N} attempts: paid=${paid} denied=${denied} (budget 30000 atomic = 0.03 USDC, price 0.01)`);
  check(paid === Math.min(N, 3), "budget caps paid calls at 3");
  check(replay.status === 402 && (await replay.json()).error === "nonce_reused", "seller refuses a replayed nonce");
  check(chain.valid, `ledger chain valid: ${JSON.stringify(chain)}`);
  check(audit.openReservations().length === 0, `open reservations after settle: ${audit.openReservations().length}; reconcile checked=${rec.checked}`);
  console.log(`  seller stats ${JSON.stringify({ ...seller.stats, headersSeen: [...new Set(seller.stats.headersSeen.flat())] })}, ${ms} ms`);
  await seller.close();
}
console.log(failures ? `E2E MOCK: ${failures} FAILED` : "E2E MOCK: all checks passed");
process.exit(failures ? 1 : 0);
