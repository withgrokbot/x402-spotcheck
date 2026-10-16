# Changelog



## 1.4.0 (2026-10-16)
- New opt-in `checkExpiry` (`true` or `{ skewS = 30 (max 300), minWindowS = 5, now }`). When it's set, a 402 or a signed payment that has already expired, or expires within the skew, gets `skip` with the new reason `challenge_expired`.
- What it reads: the signed authorization's `validBefore`; then `extra.validBefore` / `expiresAt` / `expiry` / `deadline` (seconds, ms or ISO); then `maxTimeoutSeconds` <= `minWindowS`. Unreadable values never block.
- In service mode the flag sends `check_expiry=1&skew_s=` (402xAgent 0.42.0+).
- Off by default, so default verdicts are unchanged: a no-change test covers 96 fixtures. The vendored rules are untouched.
- Test kit: new `expiring-soon` case and `+checkExpiry` rows.
## 1.3.0 (2026-10-16)
- Opt-in hosted mode: `apiKey` (`402x_live_<id>_<secret>`, shape-checked) on `spotCheckFetch` / `createSpotChecker` (service mode) and `afterPay`. Sent only to the 402xAgent endpoints as `Authorization: Bearer`; optional `endUser` id (`x-402xagent-end-user`). Hosted checks are billed on the integrator's monthly invoice, so no x402 per check.
- Without `apiKey` nothing changes. No verdict changes.
## 1.2.0 (2026-10-16)

- New opt-in `afterPay(ref, opts)`. It asks 402xAgent payment status (`POST https://api.402xagent.com/v1/products/payment-status`, needs 402xAgent 0.40.0) whether a payment landed. It returns `status` (landed | not_landed | pending | canceled | unknown), `safe_to_retry_same_payload` (always true) and `safe_to_resign`. `safe_to_resign` is true only on the service's strict two-source + expiry rule and only if the signed receipt verifies.
- `afterPay` never throws. On a timeout, network error, 5xx, 402 or bad reply it returns `{ status: "unknown", safe_to_resign: false, error }`.
- `spotCheckFetch(fetch, { afterPay: true | opts })`: a paid call that throws, answers 5xx, or answers 402 again triggers `afterPay`. The outcome lands on `response.afterPay` / `error.afterPay` and goes to `opts.onResult`.
- Fail-open: the response or error is exactly what 1.1.0 returns. The hook uses the same inner fetch.
- Off by default. Without `afterPay`, nothing changes and no extra calls are made.
- New `needsAfterPay`, `PAYMENT_STATUS_URL`, and an `x402-spotcheck/after` subpath.
- No verdict, reason-code or default changes.

## 1.1.0 (2026-10-15)

- Service mode `autoPayCheck`: accepts the flat $0.02 check fee (`20000` atomic USDC, `CHECK_FEE_TERMS.flatAtomic`) that 402xAgent 0.38.0 charges, alongside the old 1/10 rule (min $0.01, cap $0.25), so it works before, during and after the Worker change. All other rules unchanged: documented pay_to/asset/network, `maxPerCheck`, `dailyCap`, fee at most 25% of the target price (`maxFraction`). New `isDocumentedCheckFee(fee, quotes)`.
- New `verifyReceipt(receipt, { publicKey?, keysUrl?, fetch? })`: verifies ed25519 signatures over RFC 8785 (JCS) canonical JSON of the receipt minus `signature`, with the key passed in or fetched from `/.well-known/402xagent-keys.json` and matched by `kid`. Also exports `canonicalize`, `receiptSigningInput`, `RECEIPT_KEYS_URL`, and a `x402-spotcheck/receipt` subpath.
- README: 5 free checks per day (matches the Worker), flat $0.02 pricing, receipt verification.
- No verdict, reason-code or default changes. Local mode is untouched and still makes no network calls.

## 1.0.0

- Local rules by default; service mode opt-in. See README "Migrating from 0.x".
