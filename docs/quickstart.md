# Quickstart: the audit layer on Base Sepolia in 10 minutes

Testnet only. You need Node 22.13+ (for the SQLite store), a throwaway key with a little Base Sepolia test USDC from https://faucet.circle.com, and no ETH (the facilitator pays gas).

1. Install: `npm i x402-spotcheck @x402/fetch @x402/evm`
2. Put the throwaway key in a mode-600 file and set `X402_TESTNET_KEY_FILE` to it. Never commit it.
3. Wire the audit hook before signing:
```js
import { createAudit } from "x402-spotcheck/audit";
import { openAuditStore } from "x402-spotcheck/audit/sqlite";
import { presets } from "x402-spotcheck/networks";
const audit = createAudit({
  store: await openAuditStore("./audit.db"),       // survives restarts
  networkConfig: presets.baseSepolia,              // anything else is denied before signing
  payloadKey: crypto.getRandomValues(new Uint8Array(32)),
  policy: { version: "qs-1", dailyBudgetAtomic: 30_000 }, // 0.03 test USDC per UTC day
});
client.onBeforePaymentCreation(audit.beforePayment);
```
4. After each paid call, pass the payment-status result to `audit.onAfterPay(result, { url, paymentPayload })`.
5. From a clone of the repo, try it against the repo's own seller: `npm run e2e:mock` (offline, no key), then `X402_TESTNET_KEY_FILE=… npm run e2e:battle` (real Sepolia, about 0.2 test USDC).

## What you get
<!-- claims -->
- Calls outside the Base Sepolia preset are denied before anything is signed [T:networks.test.mjs#baseSepolia preset: Sepolia USDC allowed (any address case), mainnet denied, unknown asset denied].
- The daily budget is never exceeded [T:property.test.mjs#allowed reservations never exceed the daily budget].
- The ledger, reservations and sealed payloads survive a restart [T:audit-sqlite.test.mjs#restart: chain, reservations and the sealed (AAD-bound) payload survive].
- A tampered store refuses payments [T:audit-sqlite.test.mjs#a tampered ledger row aborts payments instead of trusting the chain].
<!-- /claims -->
