# x402-spotcheck: check before you pay

A guard for x402 clients and routers. Right before your client signs, it judges the 402 the seller sent: are these sane USDC terms on Base, and do they match your listing (price, pay-to, network)? A `skip` blocks the payment, with a reason code. Anything else, including unknown, a timeout or an error, lets the payment through.

- **Local by default (1.0.0).** It judges the 402 your client already received with [spotcheck-rules](https://github.com/withgrokbot/spotcheck-rules) (MIT, vendored as `x402-spotcheck/rules`). It makes no network calls, needs no service and has no dependencies.
- **Unknown means pay.** A `skip` blocks only with a reason code from [rules.json](https://402xagent.com/rules.json): `price_mismatch`, `pay_to_mismatch`, `network_mismatch`, `asset_not_usdc`, `bad_challenge` (local), plus `network_unsupported`, `ssrf_blocked`, `ambiguous` (service). A recipient with no score or history is never refused.
- **No tracking.** By default it sends no client id, no ref and no headers. Local mode sends nothing at all.
- **Base only by default.** Requirements on other chains pass through untouched. Solana is opt-in with `solana: true`.
- **The 402xAgent service is opt-in** (`mode: "service"`). Its timeout is a hard deadline (`timeoutMs`, default 1500 ms) and fails open by default. `onUnavailable: "block"` is honored exactly, on a timeout and on any error.
- It never sees your keys.

```bash
npm i github:withgrokbot/x402-spotcheck#v1.0.0
```

## One line

**@x402/fetch**:

```js
const pay = wrapFetchWithPayment(spotCheckFetch(fetch, { expected: (url) => myListing.get(url) }), client);
```

**x402 client hook** (`onBeforePaymentCreation`, [x402-foundation/x402](https://github.com/x402-foundation/x402) `@x402/core` 2.x; register your spending cap first):

```js
client.onBeforePaymentCreation(mySpendingCap).onBeforePaymentCreation(spotCheckBeforePaymentHook({ expected: (url) => myListing.get(url) }));
```

**three.ws mcp-bridge** (`buildSpendingCapHook` in `mcp-bridge/src/x402-axios-client.js`; the cap runs first):

```js
client.onBeforePaymentCreation(threeWsSpendingCapThenSpotCheck(buildSpendingCapHook));
```

**@x402/axios**: `wrapAxiosWithPayment(spotCheckAxios(axios.create(), opts), client)`.

`expected(url, intent)` returns your listing `{ price, payTo, network }` or nothing. Without a listing, it checks the terms themselves: a readable amount, a valid pay-to address and canonical USDC.

## Semver promise

The verdict behavior (what pays, what skips and why) changes only on a major version. Minor and patch releases may add options (off by default), fix crashes or improve docs. They never turn a `pay` into a `skip`. Pin exactly:

```bash
npm i github:withgrokbot/x402-spotcheck#v1.0.0       # package.json: "x402-spotcheck": "github:withgrokbot/x402-spotcheck#v1.0.0"
npm i github:withgrokbot/spotcheck-rules#v1.0.0      # the rules alone
```

## Migrating from 0.x

0.x installs that are pinned to a tag are not affected. To keep the 0.5 behavior, pin `github:withgrokbot/x402-spotcheck#v0.5.0`. To get it on 1.0.0:

```js
spotCheckFetch(fetch, { mode: "service", ref: "via-x402-spotcheck", onRecheck: "block", solana: true, timeoutMs: 15000 });
```

What changed in 1.0.0: local mode is the default (0.x always called 402xAgent); `recheck`, a `skip` without a known code, and a free-tier terms-hash mismatch that the local rules can't name now pay; no `ref` is sent by default; non-Base requirements pass through unless `solana: true`; the service timeout is 1.5 s and a hard deadline (it was 15 s); and a failed check is remembered for 10 s, so the signed retry doesn't wait a second time (`unavailableTtlMs`). Paid-tier terms are still enforced, with reason codes.

## Test kit (vitest and node:test)

Any integration that calls a pre-payment check can prove four things: with the flag off it makes no calls; a timeout lets the payment through; a `{}` answer lets it through; a skip blocks.

```js
import { test } from "node:test"; // or: import { it as test } from "vitest";
import { spotcheckContract } from "x402-spotcheck/testkit";
spotcheckContract(test, ({ enabled, fetch, timeoutMs }) => (enabled ? myHook({ fetch, timeoutMs }) : undefined));
```

`build` returns an x402 `onBeforePaymentCreation` hook and must use the `fetch` it is given.

---

Everything below describes the opt-in **service mode** (`mode: "service"`), where 402xAgent probes the target itself.

## A real case from /v1/skips

Our weekly self-checked crawl of public x402 lists (CDP Bazaar, PayAI Bazaar, awesome-x402) publishes every listing whose live 402 disagrees with the listing at
[/v1/skips](https://402xagent.com/v1/skips). Receipt
[b5e13e8271](https://402xagent.com/v1/receipts/b5e13e8271)
is one of these:

| | listing (CDP Bazaar) | live 402 (crawl of 2026-10-07 21:27 UTC) |
|---|---|---|
| url | `https://topagentx402.vercel.app/api/send-token` | same |
| price | $0.001 | $0.001 |
| network | `eip155:84532` (Base **Sepolia**, test money) | `eip155:8453` (Base **mainnet**, real USDC) |
| pay_to | `0xb1f6…Ec74` | `0xb1f6…Ec74` |

A router that picked this endpoint from the listing would think it was paying testnet tokens. An x402 client set up with `eip155:*` would sign real mainnet USDC. With the guard, 402xAgent compares the live 402 against the listing and answers:

```json
{ "verdict": "skip", "reason": "network_mismatch", "expected_network": "eip155:84532", "network": "eip155:8453", "expected_source": "listing" }
```

So `pay(...)` throws `SpotCheckBlockedError` and nothing is signed onto the wire. (On the free tier the reason comes in plain words: `"listed $0.001, asks for a different network than expected, details locked"`.)

## What gets checked

402xAgent probes the target once (SSRF-safe, GET, or POST for POST requests) and never pays it. The verdict:

- `pay`: the 402 parses, it asks for the canonical USDC on a supported mainnet, and its price, network and pay-to match what's expected.
- `skip`: no paywall (no 402 terms at all), a price, network or pay-to that differs from the listing, a testnet or unsupported network, a token other than canonical USDC, or an unreadable 402.
- `recheck`: only transient cases (timeout, network error, 5xx) and `free_trial_active` (the target sends `x-free-trial` headers). Blocked by default (`onRecheck`).

402xAgent reuses one probe per URL for 5 minutes, so two checks in a row agree.

"Expected" means your own listing when you pass `expected`, otherwise the listing from our crawl (500 endpoints, refreshed weekly) when we have the URL:

```js
spotCheckFetch(fetch, {
  mode: "service",
  expected: (url, intent) => myCatalog.get(url), // { price: 0.01, payTo: "0x…", network: "eip155:8453" }
});
```

## Pay step: sign only the approved payment

Since 0.2.0 a `pay` verdict comes with the exact payment 402xAgent approved. It is taken from the target's live 402 and checked against the listing:

```json
"payment": { "scheme": "exact", "network": "eip155:8453", "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "asset_is_usdc": true, "amount_atomic": "1000", "amount_usd": 0.001, "pay_to": "0xf567Cfe0FDb87A1D6Ca330e3f30f0D3DA0F7cb98" }
```

That's the live answer for `https://api.402rates.com/v1/ping`. The free tier gets `payment_terms_sha256` instead of the terms: a sha256 of `network|asset|amount_atomic|pay_to`, with the network lower-cased, EVM asset and pay_to lower-cased, and Solana mint and pay_to kept as-is (base58 is case-sensitive; since 0.5.0, matching the Worker).

The guard enforces those terms before your x402 client can sign anything:

- **`skip` means no signature and no spend.** The 402 never reaches the client; `SpotCheckBlockedError` is thrown.
- **The 402 is narrowed to the requirements that fit.** Network, asset and `pay_to` must be identical, and the amount must be at or below the approved one; on the free tier the terms hash must match. If nothing fits, it throws `refused to sign: pay_to differs (402 0x…, approved 0x…)`, or `network differs`, `asset differs`, `amount above approved`.
- **A last check before sending.** If a signed `PAYMENT-SIGNATURE` still doesn't fit, it throws `refused to send: …`.

```js
try {
  await pay(url);
} catch (e) {
  if (e instanceof SpotCheckBlockedError) console.log(e.reason, e.receiptUrl); // show as the abort reason
}
```

Every live check leaves a free, public receipt with the listing URL, the live 402 terms, verdict, reason and time, e.g. [sc-96e5586bcffcfab8](https://402xagent.com/v1/receipts/sc-96e5586bcffcfab8). The latest receipt for any URL is at `/v1/receipts/by-url?url=<endpoint>`. The error message ends with `— receipt: <url>`.

Agents that sign payments themselves can call `assertApprovedPayment(await checkBeforePay(url), requirement)` first.

## Cost

You get 1 free check per client per UTC day. After that a check costs one tenth of the target's quoted price, minimum $0.01, cap $0.25, in USDC on Base via x402. Pass `payFetch` to pay for checks with your own x402 client, capped by `maxCheckUsd` (default $0.05):

```js
const pay = wrapFetchWithPayment(spotCheckFetch(fetch, { mode: "service", payFetch: wrapFetchWithPayment(fetch, client) }), client);
```

If you don't pass `payFetch` and the free check is used up, the guard counts 402xAgent as unavailable. That fails open by default (`onUnavailable: "allow"`), so an outage or a missing budget never stops your payments.

**First router: 1,000 free checks.** We give the first router or agent framework that integrates a client id with 1,000 full checks (paid-tier detail, no payment). Open an issue on this repo to ask for one.

Routers: ask for a router client id and checks cost $0.001 each. They're billed as one $0.01 x402 payment per 10-check pack, and the other 9 are prepaid on that id. A router tier is needed because the facilitator charges about $0.002 per settlement, so a $0.001 payment per check would not cover it.

## Verify a Bazaar result before paying (paid check)

[402xagent.com/bazaar](https://402xagent.com/bazaar) shows a daily free check of top [CDP Bazaar](https://docs.cdp.coinbase.com/x402/bazaar) results. That is a snapshot. Before your agent pays one, run its own check against what Bazaar lists, then re-fetch the live 402 and sign only if it still fits. With `payFetch`, the check is the paid tier (full approved terms; same price as above, capped by `maxCheckUsd`):

```js
import { checkBeforePay, assertApprovedPayment } from "x402-spotcheck";

// 1. Pick a Bazaar result (public discovery API, no key needed)
const q = new URLSearchParams({ query: "weather forecast", limit: "20" });
const { resources } = await (await fetch("https://api.cdp.coinbase.com/platform/v2/x402/discovery/search?" + q)).json();
const r = resources[0];
const listed = r.accepts.find((a) => a.network === "eip155:8453") || r.accepts[0];
const method = r.extensions?.bazaar?.info?.input?.method || "GET";

// 2. Check it against the listing (paid: payFetch pays the check, up to maxCheckUsd)
const decision = await checkBeforePay(r.resource, {
  mode: "service",
  method,
  price: Number(listed.amount) / 1e6, // USDC has 6 decimals
  payTo: listed.payTo,
  network: listed.network,
  payFetch: wrapFetchWithPayment(fetch, client),
  maxCheckUsd: 0.05,
});
if (!decision.allowed) throw new Error(`skip: ${decision.reason}`); // no signature, no spend

// 3. Re-fetch the live 402 right before paying and sign only a requirement that matches the approved terms
const live = await fetch(r.resource, { method });
if (live.status !== 402) throw new Error(`no live 402 (HTTP ${live.status}); recheck later`);
const pr = live.headers.get("payment-required"); // x402 v2 header, else v1 body
const { accepts } = pr ? JSON.parse(atob(pr)) : await live.json();
const requirement = accepts.find((a) => a.network === decision.approved?.payment?.network) || accepts[0];
await assertApprovedPayment(decision, requirement); // throws "refused to sign: ..." if terms changed since the check
// ...now pay with your x402 client
```

## Options

| option | default | |
|---|---|---|
| `mode` | `"local"` | `"service"` asks 402xAgent (opt-in) |
| `expected(url, intent)` | none | your listing `{ price, payTo, network }` |
| `solana` | `false` | judge Solana mainnet too; otherwise non-Base passes through |
| `tolerance` | `0.01` | local price tolerance |
| `onDecision(d)` | none | log or meter every decision (errors in it are ignored) |
| `timeoutMs` | `1500` | service: hard deadline for one check |
| `onUnavailable` | `"allow"` | service: `"block"` to fail closed on timeout or error |
| `onRecheck` | `"allow"` | service: `"block"` to refuse on recheck |
| `client`, `ref` | not sent | service: opt-in attribution |
| `payFetch`, `maxCheckUsd` | none, `0.05` | service: pay 402xAgent's own price |
| `autoPayCheck` | off | service: capped auto-pay of the check fee (below) |
| `cacheTtlMs` | `300000` | service: verdict cache |
| `endpoint` | `https://api.402xagent.com/v1/products/endpoint-spot-check` | service: check URL; earlier hosts still work (`LEGACY_ENDPOINT`) |

Errors: `SpotCheckBlockedError` has `decision` (verdict, reason, approved terms), `reason`, and `receiptUrl` (the public receipt for that check, when the Worker returns one).

## Agents and MCP

Remote MCP server (free, Streamable HTTP): `https://api.402xagent.com/mcp`, tool `endpoint_spot_check`. Add it to your MCP client, then put one line in the agent's instructions:

> Before paying any x402 endpoint, call `endpoint_spot_check` with its `url` (plus `claimed_price`, `pay_to`, `network` from the listing if you have them). Pay only if `verdict` is `pay`.

Plain function, for any agent framework tool:

```js
import { checkBeforePay } from "x402-spotcheck";
const d = await checkBeforePay(url, { accepts, price: 0.01, network: "eip155:8453" }); // local; add mode: "service" to ask 402xAgent
if (!d.allowed) return `not paying: ${d.verdict} (${d.reason})`;
```

There are more examples in [examples/](examples/): Python, an MCP config, and a LangChain-style tool.

## Tests

`npm test` runs unit tests with no network: the 1.0.0 contract (local default, timeout, unknown = pay, no tracking, Base only, hooks with a real `@x402/core` client, the test kit), including the pay-step cases: matching, a different pay_to/network/asset, an amount above approved, a mixed 402 narrowed to one requirement, a free-tier hash, and skip. `npm i && npm run test:integration` runs the real `@x402/fetch`, `@x402/axios` and `@x402/evm` (2.28) against a mock seller, signing locally with a throwaway key. It counts every payload the client creates, to prove that a refused or skipped payment is never signed. (The v1 packages `x402-fetch` and `x402-axios` currently fail to install from npm because their `x402@^1.2.1` dependency can't be found, so they are covered only by the unit tests' `X-PAYMENT` path.) The integration test checks that a blocked payment header never leaves the process.

MIT. Made by [@withgrokbot](https://github.com/withgrokbot). The 402xAgent service and the crawl live at [withgrokbot/verified-catalog](https://github.com/withgrokbot/verified-catalog).

### Auto-pay the check (opt-in, service mode)

When the free check is used up, `autoPayCheck` pays the 402xAgent fee with the same x402 client, before it pays the seller:

```js
const pay = wrapFetchWithPayment(spotCheckFetch(fetch, {
  mode: "service",
  autoPayCheck: { wrapFetch: (f) => wrapFetchWithPayment(f, client), maxPerCheck: 0.05, dailyCap: 1 },
}), client);
```

It pays only when all of these hold: the fee is at most `maxPerCheck`; the fee plus today's spend (UTC, per instance) is at most `dailyCap`; the fee is at most 25% of the target's price (`maxFraction` can set a lower limit, not a higher one); the fee is exactly 1/10 of the target's USDC price ($0.01 to $0.25); and the 402 asks for x402 v2 `exact` USDC on Base to 402xAgent's documented pay_to. The fee is always paid on Base, including for Solana targets, so the client needs an EVM signer registered. Your fetch wrapper can sign only that one payment, once. To share the daily total across restarts, pass `spendStore: { get(day), add(day, atomic) }`. If any rule fails or anything errors, the check counts as unavailable, the same as without it. With `autoPayCheck` set, `payFetch` is not used for the fee. Without `autoPayCheck`, nothing changes.

