# Changelog

## 1.1.0 (2026-10-15)

- Service mode `autoPayCheck`: accepts the flat $0.02 check fee (`20000` atomic USDC, `CHECK_FEE_TERMS.flatAtomic`) that 402xAgent 0.38.0 charges, alongside the old 1/10 rule (min $0.01, cap $0.25), so it works before, during and after the Worker change. All other rules unchanged: documented pay_to/asset/network, `maxPerCheck`, `dailyCap`, fee at most 25% of the target price (`maxFraction`). New `isDocumentedCheckFee(fee, quotes)`.
- New `verifyReceipt(receipt, { publicKey?, keysUrl?, fetch? })`: verifies ed25519 signatures over RFC 8785 (JCS) canonical JSON of the receipt minus `signature`, with the key passed in or fetched from `/.well-known/402xagent-keys.json` and matched by `kid`. Also exports `canonicalize`, `receiptSigningInput`, `RECEIPT_KEYS_URL`, and a `x402-spotcheck/receipt` subpath.
- README: 5 free checks per day (matches the Worker), flat $0.02 pricing, receipt verification.
- No verdict, reason-code or default changes. Local mode is untouched and still makes no network calls.

## 1.0.0

- Local rules by default; service mode opt-in. See README "Migrating from 0.x".
