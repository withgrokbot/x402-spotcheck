# Results (for quoting)

Measured numbers from the battle-test phases. Each one cites the test `[T:…]` or script `[S:…]` that produces it, and `npm run docs:check` (in CI) fails if a cited test or script is missing. Testnet runs and the mainnet self-test are **one-off observations** with dates. They are not repeatable CI tests.

## Repeatable (rerun any time)
<!-- claims -->
- **88,196 fuzz/property cases** at `FC_RUNS=10000` in the P4 run (2026-10-20). The total varies slightly between runs because the number of audit contexts is generated; a rerun the same day gave 88,365. They cover malformed 402s, junk headers, junk payment-status answers, junk audit contexts and ledger tampering, and none crashed or over-booked [T:fuzz.test.mjs#fuzz totals] [T:fuzz.test.mjs#checkBeforePay on malformed 402 accepts never throws] [T:property.test.mjs#allowed reservations never exceed the daily budget]. Reproduce: `FC_RUNS=10000 node --test test/fuzz.test.mjs test/property.test.mjs` (the `fuzz totals` line prints the counts).
- **1,000 crash, restart and concurrency runs** with processes killed at random points: no double booking, no false tamper alarm, and every chain verifies [S:scripts/crash-1000.mjs] [T:audit-shared.test.mjs#kill one mid-run, restart: no double booking]. Reproduce: `npm run crash:1000`.
- **15 on-disk tamper variants** (edited, deleted, reordered, truncated and renumbered rows, reservation edits, a removed head anchor, a truncated file and overwritten bytes): every one is refused [T:audit-tamper.test.mjs#untampered copy opens and works (control)] [T:audit-tamper.test.mjs#delete the last row (tail truncation)].
<!-- /claims -->

## One-off observations
<!-- claims -->
- **P3 remote authorize service, localhost + Base Sepolia (observed 2026-10-20).**
  - Over 300 loopback authorize calls, the overhead was +1.46 ms p50 and +1.74 ms p95.
  - The client refused to pay when the service was down, slow (timeout after 304 ms), returned a bad signature, or faced a forged client. A replay was refused with 401.
  - 3 paid Sepolia calls went through the service, and the 4th was refused by budget before signing. Spend: 0.03 test USDC. Example tx: [0xf4770f65…](https://sepolia.basescan.org/tx/0xf4770f654b7cd22a353502da0208c99950af29c0a7bc380c0f99e4bc670d9038).
  - [S:scripts/p3-demo.mjs] [T:audit-remote.test.mjs#refuses: service down, slow (timeout)].
- **P4 Base Sepolia run against our harness seller (observed 2026-10-20).**
  - 20 calls: 18 paid and verified on-chain by the service, and 2 facilitator rejections (`invalid_exact_evm_transaction_failed`, held, not settled).
  - A lying client's claim was refused (`authorization_nonce_not_in_tx`).
  - 1 budget refusal before signing.
  - Spend: 0.18 test USDC. Median call 1,225 ms; median on-chain verification 189 ms.
  - Tx: [0x9aa51213…](https://sepolia.basescan.org/tx/0x9aa5121325494fc5b8d1be9aad204e6774fbc7ec95638d78b0c2047bdc0bb0cb), [0xd8abcf93…](https://sepolia.basescan.org/tx/0xd8abcf932d66974b662536af49e96f052641f5285d33c5ae3162b025fb838e95), [0x30278e40…](https://sepolia.basescan.org/tx/0x30278e407d0ca0a1da5fa3dd45b2b500eceda710462f1f343934fdf2186055b1).
  - [S:scripts/e2e-battle.mjs] [T:audit-verify.test.mjs#lie table, one fresh reservation each].
- **Mainnet v1 X-PAYMENT self-test against live 402xAgent (observed 2026-10-20). Self-checked, not a sale.** One $0.02 USDC call on Base, where the wallet paid itself (payer = payTo, `ref=self-checked`). x402-spotcheck chose the `X-PAYMENT` header for an x402Version 1 payload, and it settled and delivered (receipt `sc-85c8963fb57e7b25`, access tier paid). Tx: [0x2d3babfd…](https://basescan.org/tx/0x2d3babfd5d5f7b851a9229c629343ecbcadd565d8220c2b1096fc162e0e8733a). Header choice is tested [T:version-header.test.mjs#afterPay sends X-PAYMENT for a v1 payment header]. The paid call itself was a one-off and is not repeated in CI.
<!-- /claims -->
