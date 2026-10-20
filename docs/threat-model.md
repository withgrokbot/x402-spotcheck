# Threat model: x402-spotcheck audit layer

Scope: the buyer-side audit layer (`x402-spotcheck/audit`), its SQLite store (`/audit/sqlite`), the localhost authorize service (`/audit/server`, `/audit/remote`) and on-chain settlement checks (`/audit/evm-verify`). Spot-check verdicts are covered where the audit layer depends on them.

Citations look like `[T:file#title]`. Each one names a test in `test/` whose title (or table case) contains the quoted text. `npm run docs:check` fails, and so does CI, if a cited test does not exist.

## Assets
- The buyer's money: every signature is a spend.
- The daily budget and the open reservations that hold it.
- The ledger: an append-only, hash-chained record of every decision.
- Sealed payment payloads (AES-GCM) and the service keys (HMAC client secrets, the Ed25519 response key).

## Attackers and what stops them
<!-- claims -->
- **A malicious or wrong seller (402 terms).** A price, payTo or network mismatch against the expected listing gives `skip`, and nothing is signed [T:v1.test.mjs#local skip blocks only with a reason code; nothing is signed]. Malformed 402s never crash the check and always return a verdict [T:fuzz.test.mjs#checkBeforePay on malformed 402 accepts never throws].
- **Junk or hostile headers.** Payment headers that are not base64 or not JSON never throw, and only v1/v2 select a proof header [T:fuzz.test.mjs#payment headers (junk base64/JSON) never throw]. An unknown x402Version sends nothing [T:version-header.test.mjs#an unknown or unreadable x402Version is a clear error and nothing is sent].
- **A lying or broken payment-status answer.** An unverified receipt never says `safe_to_resign` [T:after.test.mjs#a receipt that does not verify can never say safe_to_resign]. Junk answers never settle [T:fuzz.test.mjs#afterPay on junk payment-status answers never throws]. Settlement advice never re-signs an unverified or landed result [T:audit.test.mjs#settlement advice never re-signs an unverified or landed result].
- **Overspending by concurrency.** Concurrent reserves in one process cannot share one remaining budget [T:audit.test.mjs#concurrent reserves cannot share one remaining budget] [T:property.test.mjs#concurrent reserves are serialised]. Across processes on one shared store there is no double booking, including when a process is killed and restarted [T:audit-shared.test.mjs#4 processes x 60 contested keys, kill one mid-run, restart: no double booking].
- **Retries and duplicate intents.** An idempotency key holds at most one live reservation [T:audit-shared.test.mjs#a retried open key reuses its reservation], also on disk [T:audit-shared.test.mjs#UNIQUE index refuses a second live reservation]. Settling twice has no effect [T:audit-shared.test.mjs#settling the same payment twice has no extra effect].
- **Crashes.** A crash inside a write leaves the previous state [T:audit-sqlite.test.mjs#crash: exit inside an open write transaction leaves the previous state]. SIGKILL during reserves leaves a chain that verifies [T:audit-sqlite.test.mjs#SIGKILL during a reserve loop leaves a chain that verifies].
- **Local tampering with the store file (inconsistent edits).** Each of these is refused and fails closed:
  - edited rows [T:audit-tamper.test.mjs#edit amount in a ledger row];
  - deleted rows [T:audit-tamper.test.mjs#delete a middle row];
  - tail truncation [T:audit-tamper.test.mjs#delete the last row (tail truncation)];
  - reordered rows [T:audit-tamper.test.mjs#reorder two rows];
  - a lowered reservation amount [T:audit-tamper.test.mjs#lower a reservation amount (not chained)];
  - a reopened release [T:audit-tamper.test.mjs#reopen a released reservation];
  - a truncated file [T:audit-tamper.test.mjs#truncate the file].
  Random single edits are detected [T:fuzz.test.mjs#any single edit, deletion, swap or middle truncation of the ledger is detected].
- **A store that is corrupt, locked or unavailable.** Payments are refused, not waved through [T:audit-sqlite.test.mjs#a file locked by another process refuses to open; a failed write aborts the payment] [T:audit-sqlite.test.mjs#a corrupt or truncated file refuses to open].
- **Payload theft from the store.** Payloads are encrypted at rest and kept off the chain [T:audit.test.mjs#payload is encrypted at rest and absent from the chain]. They are bound to their reservation id, so a swapped blob fails to decrypt [T:audit-sqlite.test.mjs#a swapped payload blob fails AES-GCM].
- **A network attacker or a forged service response (remote mode).** A response that has been tampered with, or that is signed by the wrong key, is refused [T:audit-remote.test.mjs#a tampered response is refused] [T:audit-remote.test.mjs#wrong pinned key].
- **Replayed or stale requests to the service.** Both are refused [T:audit-remote.test.mjs#replay and stale timestamps are refused].
- **An unauthenticated client.** It is refused and books nothing [T:audit-remote.test.mjs#wrong client key].
- **The service is down or slow.** The client refuses to pay [T:audit-remote.test.mjs#refuses: service down, slow (timeout)].
- **A client lying about payment-status to the service.** Without a verifier the claim is held as unverified [T:audit-verify.test.mjs#no verifier: client-reported status is downgraded to unverified]. With the on-chain verifier, these are all refused:
  - a wrong, missing or reverted tx, the wrong payee or amount, or another authorization's nonce [T:audit-verify.test.mjs#lie table, one fresh reservation each];
  - a false not_landed [T:audit-verify.test.mjs#a false not_landed (authorization already used) cannot free the budget];
  - another client's reservation, or an unbound payer [T:audit-verify.test.mjs#settle for another client's reservation, or with an unbound payer, is refused].
- **The service exposed to a network.** In this phase the server refuses a non-loopback bind [T:audit-remote.test.mjs#server refuses a non-loopback bind].
<!-- /claims -->

## Not defended (see limits.md)
Someone with write access who re-hashes the whole store consistently. A compromised buyer machine or key. A facilitator that lies. Solana settlement checks. These are listed with their tests in [limits.md](limits.md).
