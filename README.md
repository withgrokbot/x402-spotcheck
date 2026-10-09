# x402-spotcheck: check before you pay

A one-line guard for x402 clients. Right before your client sends a payment, it asks
[x402 Endpoint Spot-Check](https://verified-catalog-lookup.withgrokbot.workers.dev/v1/products/endpoint-spot-check)
whether the target's live 402 matches what you expect. It returns `skip` (blocked), `pay` (sent), or `recheck` (blocked by default, configurable).

It never sees your keys. It reads the payment header your client already built, and when a check says skip, that header is never sent.

```bash
npm i github:withgrokbot/x402-spotcheck
```

## One line

**@x402/fetch** (the older `x402-fetch` has the same `wrapFetchWithPayment(fetch, …)` shape):

```js
const pay = wrapFetchWithPayment(spotCheckFetch(fetch), client);
```

**@x402/axios** (the older `x402-axios` works the same way: `withPaymentInterceptor(spotCheckAxios(axios.create()), walletClient)`):

```js
const api = wrapAxiosWithPayment(spotCheckAxios(axios.create()), client);
```

With the imports:

```js
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { spotCheckFetch } from "x402-spotcheck";

const client = new x402Client().register("eip155:*", new ExactEvmScheme(privateKeyToAccount(process.env.EVM_PRIVATE_KEY)));
const pay = wrapFetchWithPayment(spotCheckFetch(fetch, { client: "my-router" }), client);

const res = await pay("https://some-x402-seller.example/api/data"); // throws SpotCheckBlockedError on skip
```

Requests that don't carry a payment never trigger a check. Only the retry that carries `PAYMENT-SIGNATURE` or `X-PAYMENT` gets checked.

## A real case from /v1/skips

Our weekly self-checked crawl of public x402 lists (CDP Bazaar, PayAI Bazaar, awesome-x402) publishes every listing whose live 402 disagrees with the listing at
[/v1/skips](https://verified-catalog-lookup.withgrokbot.workers.dev/v1/skips). Receipt
[b5e13e8271](https://verified-catalog-lookup.withgrokbot.workers.dev/v1/receipts/b5e13e8271)
is one of these:

| | listing (CDP Bazaar) | live 402 (crawl of 2026-10-07 21:27 UTC) |
|---|---|---|
| url | `https://topagentx402.vercel.app/api/send-token` | same |
| price | $0.001 | $0.001 |
| network | `eip155:84532` (Base **Sepolia**, test money) | `eip155:8453` (Base **mainnet**, real USDC) |
| pay_to | `0xb1f6…Ec74` | `0xb1f6…Ec74` |

A router that picked this endpoint from the listing would think it was paying testnet tokens. An x402 client set up with `eip155:*` would sign real mainnet USDC. With the guard, Spot-Check compares the live 402 against the listing and answers:

```json
{ "verdict": "skip", "reason": "network_mismatch", "expected_network": "eip155:84532", "network": "eip155:8453", "expected_source": "listing" }
```

So `pay(...)` throws `SpotCheckBlockedError` and nothing is signed onto the wire. (On the free tier the reason comes in plain words: `"listed $0.001, asks for a different network than expected, details locked"`.)

## What gets checked

Spot-Check probes the target once (SSRF-safe, GET, or POST for POST requests) and never pays it. The verdict:

- `pay`: the 402 parses, and its price, network and pay-to match what's expected.
- `skip`: no 402 at all, a price or network or pay-to that differs from the listing, unreachable, or timed out.
- `recheck`: the challenge is there but unclear.

"Expected" means your own listing when you pass `expected`, otherwise the listing from our crawl (500 endpoints, refreshed weekly) when we have the URL:

```js
spotCheckFetch(fetch, {
  client: "my-router",
  expected: (url, intent) => myCatalog.get(url), // { price: 0.01, payTo: "0x…", network: "eip155:8453" }
});
```

## Pay step: sign only the approved payment

Since 0.2.0 a `pay` verdict comes with the exact payment Spot-Check approved. It is taken from the target's live 402 and checked against the listing:

```json
"payment": { "scheme": "exact", "network": "eip155:8453", "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "asset_is_usdc": true, "amount_atomic": "1000", "amount_usd": 0.001, "pay_to": "0xf567Cfe0FDb87A1D6Ca330e3f30f0D3DA0F7cb98" }
```

That's the live answer for `https://api.402rates.com/v1/ping`. The free tier gets `payment_terms_sha256` instead of the terms: a sha256 of lower-case `network|asset|amount_atomic|pay_to`.

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

Every live check leaves a free, public receipt with the listing URL, the live 402 terms, verdict, reason and time, e.g. [sc-96e5586bcffcfab8](https://verified-catalog-lookup.withgrokbot.workers.dev/v1/receipts/sc-96e5586bcffcfab8). The latest receipt for any URL is at `/v1/receipts/by-url?url=<endpoint>`. The error message ends with `— receipt: <url>`.

Agents that sign payments themselves can call `assertApprovedPayment(await checkBeforePay(url), requirement)` first.

## Cost

You get 1 free check per client per UTC day. After that a check costs one tenth of the target's quoted price, minimum $0.01, cap $0.25, in USDC on Base via x402. Pass `payFetch` to pay for checks with your own x402 client, capped by `maxCheckUsd` (default $0.05):

```js
const pay = wrapFetchWithPayment(spotCheckFetch(fetch, { client: "my-router", payFetch: wrapFetchWithPayment(fetch, client) }), client);
```

If you don't pass `payFetch` and the free check is used up, the guard counts Spot-Check as unavailable. That fails open by default (`onUnavailable: "allow"`), so an outage or a missing budget never stops your payments.

**First router: 1,000 free checks.** We give the first router or agent framework that integrates a client id with 1,000 full checks (paid-tier detail, no payment). Open an issue on this repo to ask for one.

## Options

| option | default | |
|---|---|---|
| `client` | none | your client id (first-router ids get their pool) |
| `onRecheck` | `"block"` | `"allow"` to pay on recheck |
| `onUnavailable` | `"allow"` | `"block"` to fail closed |
| `payFetch` | none | an x402 fetch that pays Spot-Check's own price |
| `maxCheckUsd` | `0.05` | most to pay for one check |
| `expected(url, intent)` | none | your listing `{ price, payTo, network }` |
| `onDecision(d)` | none | log or meter every decision |
| `cacheTtlMs` | `300000` | verdict cache per url and expectation |

Errors: `SpotCheckBlockedError` has `decision` (verdict, reason, approved terms), `reason`, and `receiptUrl` (the public receipt for that check, when the Worker returns one).

## Agents and MCP

Remote MCP server (free, Streamable HTTP): `https://verified-catalog-lookup.withgrokbot.workers.dev/mcp`, tool `endpoint_spot_check`. Add it to your MCP client, then put one line in the agent's instructions:

> Before paying any x402 endpoint, call `endpoint_spot_check` with its `url` (plus `claimed_price`, `pay_to`, `network` from the listing if you have them). Pay only if `verdict` is `pay`.

Plain function, for any agent framework tool:

```js
import { checkBeforePay } from "x402-spotcheck";
const d = await checkBeforePay(url, { client: "my-agent", price: 0.01, network: "eip155:8453" });
if (!d.allowed) return `not paying: ${d.verdict} (${d.reason})`;
```

There are more examples in [examples/](examples/): Python, an MCP config, and a LangChain-style tool.

## Tests

`npm test` runs unit tests with no network, including the pay-step cases: matching, a different pay_to/network/asset, an amount above approved, a mixed 402 narrowed to one requirement, a free-tier hash, and skip. `npm i && npm run test:integration` runs the real `@x402/fetch`, `@x402/axios` and `@x402/evm` (2.28) against a mock seller, signing locally with a throwaway key. It counts every payload the client creates, to prove that a refused or skipped payment is never signed. (The v1 packages `x402-fetch` and `x402-axios` currently fail to install from npm because their `x402@^1.2.1` dependency can't be found, so they are covered only by the unit tests' `X-PAYMENT` path.) The integration test checks that a blocked payment header never leaves the process.

MIT. Made by [@withgrokbot](https://github.com/withgrokbot). The Spot-Check service and the crawl live at [withgrokbot/verified-catalog](https://github.com/withgrokbot/verified-catalog).
