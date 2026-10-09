// Real client libraries (@x402/fetch, @x402/axios, @x402/evm) against the mock world. Signs locally with a
// throwaway key; nothing touches a chain. Run: npm i && npm run test:integration
import assert from "node:assert/strict";
import axios from "axios";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { wrapAxiosWithPayment } from "@x402/axios";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { spotCheckFetch, spotCheckAxios, SpotCheckBlockedError } from "../index.js";
import { world, TERMS, USDC } from "./mock.mjs";

const client = new x402Client().register("eip155:*", new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())));
const w = world({ verdicts: { "https://bad.test/api": ["skip", "pay_to_mismatch"] } });

// @x402/fetch: the one-line adoption
const pay = wrapFetchWithPayment(spotCheckFetch(w.fetch, { client: "int-test" }), client);
const ok = await pay("https://good.test/api");
assert.equal(ok.status, 200);
assert.equal(w.log.spot.length, 1);
await assert.rejects(pay("https://bad.test/api"), (e) => e instanceof SpotCheckBlockedError || e?.cause instanceof SpotCheckBlockedError || /spotcheck blocked/.test(String(e?.message)));
assert.equal(w.log.target.filter((t) => t.url === "https://bad.test/api" && t.paid).length, 0, "@x402/fetch: blocked payment never sent");
console.log("PASS @x402/fetch", ok.status);

// @x402/axios (fetch adapter so the mock world serves it)
globalThis.fetch = w.fetch;
const api = wrapAxiosWithPayment(spotCheckAxios(axios.create({ adapter: "fetch" }), { client: "int-test", fetch: w.fetch }), client);
const r = await api.get("https://good.test/api?a=1");
assert.equal(r.status, 200);
await assert.rejects(api.get("https://bad.test/api"), (e) => /spotcheck blocked/.test(String(e?.message)) || e instanceof SpotCheckBlockedError);
assert.equal(w.log.target.filter((t) => t.url.startsWith("https://bad.test/api") && t.paid).length, 0, "@x402/axios: blocked payment never sent");
console.log("PASS @x402/axios", r.status);
// PAY STEP with the real libraries: count every payload the x402 client creates (= signatures).
let signatures = 0;
const counting = new x402Client().register("eip155:*", new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())));
counting.onBeforePaymentCreation(async () => { signatures++; });
const other = { scheme: "exact", network: "eip155:8453", amount: "10000", asset: USDC, payTo: "0x" + "ee".repeat(20), maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
const good = { ...other, payTo: TERMS.pay_to };

// a) terms match -> signed once, paid
let pw = world({ approve: TERMS });
assert.equal((await wrapFetchWithPayment(spotCheckFetch(pw.fetch), counting)("https://good.test/api")).status, 200);
assert.equal(signatures, 1);
// b) 402 pays a different wallet -> no signature, no spend, reason + receipt in the error
pw = world({ approve: TERMS, targetAccepts: [other] });
await assert.rejects(wrapFetchWithPayment(spotCheckFetch(pw.fetch), counting)("https://good.test/api"), (e) => /refused to sign: pay_to differs/.test(String(e.message)) && /receipts\/sc-test/.test(String(e.message)));
assert.equal(signatures, 1, "@x402/fetch created no payment");
assert.equal(pw.log.target.filter((t) => t.paid).length, 0);
// c) mixed 402 -> the client can only pick the approved requirement
pw = world({ approve: TERMS, targetAccepts: [other, good] });
assert.equal((await wrapFetchWithPayment(spotCheckFetch(pw.fetch), counting)("https://good.test/api")).status, 200);
assert.equal(pw.log.target.find((t) => t.paid).accepted.payTo, TERMS.pay_to);
// d) skip -> no signature
pw = world({ verdicts: { "https://bad.test/api": ["skip", "network_mismatch"] } });
const before = signatures;
await assert.rejects(wrapFetchWithPayment(spotCheckFetch(pw.fetch), counting)("https://bad.test/api"), /network_mismatch/);
assert.equal(signatures, before);
console.log("PASS @x402/fetch PAY STEP (match, refuse, narrow, skip)");

// axios PAY STEP
for (const [accepts, ok] of [[[good], true], [[{ ...good, amount: "20000" }], false], [[other, good], true]]) {
  const aw = world({ approve: TERMS, targetAccepts: accepts });
  globalThis.fetch = aw.fetch;
  const n0 = signatures;
  const api2 = wrapAxiosWithPayment(spotCheckAxios(axios.create({ adapter: "fetch" }), { fetch: aw.fetch }), counting);
  if (ok) {
    assert.equal((await api2.get("https://good.test/api")).status, 200);
    assert.equal(aw.log.target.find((t) => t.paid).accepted.payTo, TERMS.pay_to);
  } else {
    await assert.rejects(api2.get("https://good.test/api"), /refused to sign: amount above approved/);
    assert.equal(signatures, n0, "@x402/axios created no payment");
    assert.equal(aw.log.target.filter((t) => t.paid).length, 0);
  }
}
console.log("PASS @x402/axios PAY STEP (match, refuse, narrow)");
console.log("integration passed");
