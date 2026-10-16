# x402-spotcheck test kit

A local mock seller plus a runner that shows what x402-spotcheck does on common x402 failure cases. Everything runs on your machine: there are no network calls and no payments.

```sh
node examples/test-kit/run.mjs
```

| case | the mock 402 | expected |
|---|---|---|
| good | $0.01 to the listed wallet | pay (`price_ok`) |
| price-mismatch | asks $0.05, listed $0.01 | skip (`price_mismatch`) |
| wrong-payto | pays a different wallet than listed | skip (`pay_to_mismatch`) |
| expired | terms past `validBefore` | pay: the pre-pay rules don't judge expiry. `afterPay` reports the expired, unused authorization as `not_landed`, `safe_to_resign=true` |
| malformed | unreadable amount / payTo | skip (`bad_challenge`) |
| double-pay | the paid call lands but the response times out | pay; `afterPay` reports `landed`, `safe_to_resign=false`, so the retry does not re-sign |

- `mock-seller.mjs`: plain `node:http`. It also answers `/payment-status` from fixtures signed with a throwaway ed25519 key, so `afterPay` verifies the receipt the same way it does in production.
- `run.mjs`: prints the table and exits 1 on any unexpected verdict. `npm test` runs it (`test/test-kit.test.mjs`).
- To add a case, add an entry to `CASES` in `mock-seller.mjs` with its `accepts`, the `listing` you expect, and the expected verdict and code.
