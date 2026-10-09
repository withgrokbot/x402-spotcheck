// Real client libraries (@x402/fetch, @x402/axios, @x402/evm) against the mock world. Signs locally with a
// throwaway key; nothing touches a chain. Run: npm i && npm run test:integration
import assert from "node:assert/strict";
import axios from "axios";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { wrapAxiosWithPayment } from "@x402/axios";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { spotCheckFetch, spotCheckAxios, SpotCheckBlockedError } from "../index.js";
import { world } from "./mock.mjs";

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
console.log("integration passed");
