import test from "node:test";
import assert from "node:assert/strict";
import { spotCheckFetch, createSpotChecker, checkApiKey, afterPay, VERSION } from "../index.js";

const KEY = "402x_live_0a1b2c3d_" + "A".repeat(43);
const okBody = { verdict: "pay", reason: "price_ok", payment_terms_sha256: null, access: { tier: "hosted" } };

test("1.3.0 apiKey: bad shapes refused up front; null/undefined ok", () => {
  assert.equal(VERSION, "1.5.1");
  assert.equal(checkApiKey(undefined), null);
  assert.equal(checkApiKey(KEY), KEY);
  for (const k of ["", "sk-abc", "402x_live_zz_short", 42]) assert.throws(() => checkApiKey(k), TypeError);
  assert.throws(() => spotCheckFetch(async () => new Response(""), { mode: "service", apiKey: "nope" }), TypeError);
});

test("1.3.0 apiKey: sent as Bearer ONLY to the 402xAgent endpoint (+ end-user id), never to the seller", async () => {
  const seen = [];
  const f = async (u, init = {}) => {
    const h = new Headers(init.headers || {});
    seen.push([String(u), h.get("authorization"), h.get("x-402xagent-end-user")]);
    if (String(u).startsWith("https://api.402xagent.com/")) return Response.json(okBody);
    return new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "1000", payTo: "0x" + "ab".repeat(20) }] })).toString("base64") } });
  };
  const g = spotCheckFetch(f, { mode: "service", apiKey: KEY, endUser: "agent-7" });
  await g("https://seller.test/x").catch(() => {});
  const ours = seen.filter(([u]) => u.startsWith("https://api.402xagent.com/"));
  assert.ok(ours.length >= 1);
  assert.ok(ours.every(([, a, e]) => a === "Bearer " + KEY && e === "agent-7"));
  assert.ok(seen.filter(([u]) => u.startsWith("https://seller.test/")).every(([, a]) => a === null), "seller never sees the key");
});

test("1.3.0 without apiKey: no authorization header (unchanged)", async () => {
  const seen = [];
  const check = createSpotChecker({ fetch: async (u, init = {}) => { seen.push(new Headers(init.headers || {}).get("authorization")); return Response.json(okBody); } });
  await check("https://seller.test/y");
  assert.deepEqual(seen, [null]);
});

test("1.3.0 afterPay passes apiKey", async () => {
  let auth = null;
  await afterPay({ txHash: "0x" + "11".repeat(32) }, { apiKey: KEY, verify: false, fetch: async (u, i) => { auth = i.headers.authorization; return Response.json({ status: "landed", safe_to_resign: false }); } });
  assert.equal(auth, "Bearer " + KEY);
});
