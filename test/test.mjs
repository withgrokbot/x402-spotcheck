import assert from "node:assert/strict";
import { spotCheckFetch, spotCheckAxios, checkBeforePay, readPaymentIntent, SpotCheckBlockedError, createSpotChecker } from "../index.js";
import { world, fakeWrapFetchWithPayment, TERMS, USDC } from "./mock.mjs";
import { createHash } from "node:crypto";
import { termsString, termsMismatch, assertApprovedPayment } from "../index.js";
const sha = (t) => createHash("sha256").update(termsString(t)).digest("hex");
const acc = (o = {}) => ({ scheme: "exact", network: "eip155:8453", amount: "10000", asset: USDC, payTo: "0x" + "ab".repeat(20), maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" }, ...o });

const T = [];
const test = (n, f) => T.push([n, f]);

test("pay verdict: payment goes through; unpaid requests never trigger a check", async () => {
  const w = world();
  const pay = fakeWrapFetchWithPayment(spotCheckFetch(w.fetch, { client: "my-router" }));
  const r = await pay("https://good.test/api");
  assert.equal(r.status, 200);
  assert.equal(w.log.spot.length, 1, "one check, right before paying");
  assert.equal(w.log.spot[0].client, "my-router");
  assert.equal(w.log.spot[0].ref, "x402-spotcheck");
  assert.deepEqual(w.log.target.map((t) => t.paid), [false, true]);
});

test("skip verdict: throws SpotCheckBlockedError and the payment is never sent", async () => {
  const w = world({ verdicts: { "https://bad.test/api": ["skip", "network_mismatch"] } });
  const pay = fakeWrapFetchWithPayment(spotCheckFetch(w.fetch));
  await assert.rejects(pay("https://bad.test/api"), (e) => e instanceof SpotCheckBlockedError && e.decision.reason === "network_mismatch");
  assert.deepEqual(w.log.target.map((t) => t.paid), [false], "signed header never left the process");
});

test("recheck: blocks by default, allowed with onRecheck: 'allow'", async () => {
  const w = world({ verdicts: { "https://flaky.test/api": ["recheck", "ambiguous"] } });
  await assert.rejects(fakeWrapFetchWithPayment(spotCheckFetch(w.fetch))("https://flaky.test/api"), SpotCheckBlockedError);
  const r = await fakeWrapFetchWithPayment(spotCheckFetch(w.fetch, { onRecheck: "allow" }))("https://flaky.test/api");
  assert.equal(r.status, 200);
});

test("Spot-Check unavailable (5xx or unpaid 402): allow by default, block with onUnavailable: 'block'", async () => {
  for (const spotStatus of [503, 402]) {
    const w = world({ spotStatus });
    const decisions = [];
    const r = await fakeWrapFetchWithPayment(spotCheckFetch(w.fetch, { onDecision: (d) => decisions.push(d) }))("https://good.test/api");
    assert.equal(r.status, 200);
    assert.equal(decisions[0].verdict, "unavailable");
    await assert.rejects(fakeWrapFetchWithPayment(spotCheckFetch(w.fetch, { onUnavailable: "block" }))("https://good.test/api"), SpotCheckBlockedError);
  }
});

test("payFetch pays Spot-Check's own price only up to maxCheckUsd", async () => {
  const w = world({ spotStatus: 402, spotPrice: "10000" });
  const payFetch = fakeWrapFetchWithPayment(w.fetch);
  const r = await fakeWrapFetchWithPayment(spotCheckFetch(w.fetch, { payFetch, onUnavailable: "block" }))("https://good.test/api");
  assert.equal(r.status, 200);
  assert.equal(w.log.paidSpot, 1);
  const pricey = world({ spotStatus: 402, spotPrice: "250000" });
  await assert.rejects(fakeWrapFetchWithPayment(spotCheckFetch(pricey.fetch, { payFetch: fakeWrapFetchWithPayment(pricey.fetch), onUnavailable: "block" }))("https://good.test/api"), SpotCheckBlockedError);
  assert.equal(pricey.log.paidSpot, 0, "$0.25 > default maxCheckUsd $0.05");
});

test("expected listing is forwarded; POST is probed as POST; verdicts are cached", async () => {
  const w = world();
  const seen = [];
  const g = fakeWrapFetchWithPayment(spotCheckFetch(w.fetch, { expected: (url, intent) => { seen.push(intent); return { price: 0.01, payTo: "0x" + "cd".repeat(20), network: "eip155:8453" }; } }));
  await g("https://good.test/api", { method: "POST", body: "{}" });
  await g("https://good.test/api", { method: "POST", body: "{}" });
  assert.equal(w.log.spot.length, 1, "second payment within TTL uses the cached verdict");
  assert.equal(w.log.spot[0].method, "POST");
  assert.equal(w.log.spot[0].claimed_price, "0.01");
  assert.equal(w.log.spot[0].pay_to, "0x" + "cd".repeat(20));
  assert.equal(w.log.spot[0].network, "eip155:8453");
  assert.deepEqual(seen.find(Boolean), { network: "eip155:8453", payTo: "0x" + "ab".repeat(20), priceUsd: 0.01 });
});

test("axios: request interceptor checks only requests that carry a payment header", async () => {
  const w = world({ verdicts: { "https://bad.test/api?q=1": ["skip", "pay_to_mismatch"] } });
  const handlers = [];
  const inst = { interceptors: { request: { use: (f) => handlers.push(f) }, response: { use: () => {} } } };
  spotCheckAxios(inst, { fetch: w.fetch });
  const run = (cfg) => handlers.reduce((p, f) => p.then(f), Promise.resolve(cfg));
  assert.deepEqual(await run({ url: "https://bad.test/api", params: { q: 1 }, headers: {} }), { url: "https://bad.test/api", params: { q: 1 }, headers: {} });
  assert.equal(w.log.spot.length, 0);
  await assert.rejects(run({ url: "/api", baseURL: "https://bad.test", params: { q: 1 }, method: "get", headers: { "X-PAYMENT": "e30=" } }), SpotCheckBlockedError);
  assert.equal(w.log.spot[0].url, "https://bad.test/api?q=1");
});

test("checkBeforePay for agents/MCP and readPaymentIntent", async () => {
  const w = world({ verdicts: { "https://bad.test/api": ["skip", "price_mismatch"] } });
  const d = await checkBeforePay("https://bad.test/api", { fetch: w.fetch, price: 0.01 });
  assert.deepEqual([d.verdict, d.allowed], ["skip", false]);
  assert.equal(w.log.spot[0].claimed_price, "0.01");
  assert.equal(readPaymentIntent("not base64"), null);
  assert.equal(typeof createSpotChecker(), "function");
});

test("PAY STEP (paid terms): matching 402 is signed; the signed payment is exactly the approved one", async () => {
  const w = world({ approve: TERMS });
  const r = await fakeWrapFetchWithPayment(spotCheckFetch(w.fetch))("https://good.test/api");
  assert.equal(r.status, 200);
  const sent = w.log.target.find((t) => t.paid).accepted;
  assert.deepEqual([sent.network, sent.asset, sent.amount, sent.payTo], [TERMS.network, TERMS.asset, TERMS.amount_atomic, TERMS.pay_to]);
});

for (const [name, over, re] of [
  ["pay_to", { payTo: "0x" + "ee".repeat(20) }, /pay_to differs/],
  ["network", { network: "eip155:84532" }, /network differs/],
  ["asset", { asset: "0x" + "99".repeat(20) }, /asset differs/],
  ["amount above approved", { amount: "10001" }, /amount above approved/],
]) {
  test(`PAY STEP: 402 with a different ${name} -> refuse to sign, no spend, error carries reason + receipt URL`, async () => {
    const w = world({ approve: TERMS, targetAccepts: [acc(over)] });
    // the guard sits under the client, like wrapFetchWithPayment(spotCheckFetch(fetch), client)
    const pay = fakeWrapFetchWithPayment(spotCheckFetch(w.fetch));
    await assert.rejects(pay("https://good.test/api"), (e) => e instanceof SpotCheckBlockedError && re.test(e.message) && /refused to sign/.test(e.message) && e.receiptUrl.endsWith("/v1/receipts/sc-test") && e.message.includes(e.receiptUrl));
    assert.equal(w.log.target.filter((t) => t.paid).length, 0);
  });
}

test("PAY STEP: lower amount is fine; mixed 402 is narrowed to the requirement that fits", async () => {
  const w = world({ approve: TERMS, targetAccepts: [acc({ amount: "9000" })] });
  assert.equal((await fakeWrapFetchWithPayment(spotCheckFetch(w.fetch))("https://good.test/api")).status, 200);
  const m = world({ approve: TERMS, targetAccepts: [acc({ payTo: "0x" + "ee".repeat(20) }), acc()] });
  assert.equal((await fakeWrapFetchWithPayment(spotCheckFetch(m.fetch))("https://good.test/api")).status, 200);
  assert.equal(m.log.target.find((t) => t.paid).accepted.payTo, TERMS.pay_to, "the client could only pick the approved requirement");
});

test("PAY STEP (free tier hash): matching terms pass, any change refuses to sign", async () => {
  const ok = world({ hash: sha(TERMS) });
  assert.equal((await fakeWrapFetchWithPayment(spotCheckFetch(ok.fetch))("https://good.test/api")).status, 200);
  const bad = world({ hash: sha(TERMS), targetAccepts: [acc({ amount: "9000" })] });
  await assert.rejects(fakeWrapFetchWithPayment(spotCheckFetch(bad.fetch))("https://good.test/api"), /terms differ from the approved payment/);
  assert.equal(bad.log.target.filter((t) => t.paid).length, 0);
});

test("PAY STEP: skip = no signature (the 402 never reaches the client)", async () => {
  const w = world({ verdicts: { "https://bad.test/api": ["skip", "pay_to_mismatch"] } });
  let sawChallenge = false;
  const client = async (i, init) => { const r = await spotCheckFetch(w.fetch)(i, init); if (r.status === 402) sawChallenge = true; return r; };
  await assert.rejects(client("https://bad.test/api"), /pay_to_mismatch.*receipt: https:\/\/verified-catalog-lookup/);
  assert.equal(sawChallenge, false);
});

test("PAY STEP: last-line check refuses a signed header that doesn't fit; assertApprovedPayment for self-signing agents", async () => {
  const w = world({ approve: TERMS });
  const g = spotCheckFetch(w.fetch);
  const hdr = Buffer.from(JSON.stringify({ x402Version: 2, accepted: acc({ amount: "20000" }), payload: {} })).toString("base64");
  await assert.rejects(g("https://good.test/api", { headers: { "PAYMENT-SIGNATURE": hdr } }), /refused to send: amount above approved/);
  const d = await checkBeforePay("https://good.test/api", { fetch: w.fetch });
  assert.equal(await assertApprovedPayment(d, acc()), true);
  await assert.rejects(assertApprovedPayment(d, acc({ network: "eip155:1" })), /network differs/);
  assert.equal(await termsMismatch(acc(), null), "");
});

let ok = 0;
for (const [n, f] of T) {
  try { await f(); ok++; console.log("PASS " + n); } catch (e) { console.log("FAIL " + n + "\n  " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n  ")); }
}
console.log(`${ok}/${T.length} tests passed`);
process.exit(ok === T.length ? 0 : 1);
