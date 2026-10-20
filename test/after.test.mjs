// 1.2.0 afterPay: opt-in, fail-open. node --test test/after.test.mjs (no network: every fetch is mocked)
import test from "node:test";
import assert from "node:assert/strict";
import { afterPay, needsAfterPay, PAYMENT_STATUS_URL, spotCheckFetch, VERSION } from "../index.js";
import { canonicalize } from "../receipt.js";

const PAY = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453", amount: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x" + "d4".repeat(20) }, payload: { signature: "0x" + "ee".repeat(65), authorization: { from: "0x" + "a1".repeat(20), to: "0x" + "d4".repeat(20), value: "10000", validAfter: "0", validBefore: "1900000000", nonce: "0x" + "b2".repeat(32) } } })).toString("base64");

async function signed(body) {
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const x = (await crypto.subtle.exportKey("jwk", publicKey)).x;
  const rc = { ...body, kid: "t-1" };
  const sig = Buffer.from(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(canonicalize(rc)))).toString("base64url");
  return { receipt: { ...rc, signature: sig }, key: { kid: "t-1", x } };
}
const svc = (reply, calls = []) => async (url, init = {}) => {
  calls.push([String(url), init]);
  if (String(url).endsWith("/.well-known/402xagent-keys.json")) return Response.json({ keys: reply.keys || [] });
  if (String(url) === PAYMENT_STATUS_URL) return typeof reply.ps === "function" ? reply.ps(init) : Response.json(reply.ps, { status: reply.status || 200 });
  throw new Error("unexpected " + url);
};

test("version 1.5.0", () => assert.equal(VERSION, "1.5.0"));

test("afterPay: posts the payment payload + seller url, returns the answer, verifies the signed receipt", async () => {
  const base = { status: "not_landed", safe_to_resign: true, safe_to_retry_same_payload: true };
  const { receipt, key } = await signed(base);
  const calls = [];
  const r = await afterPay({ paymentPayload: PAY, sellerUrl: "https://seller.test/x" }, { fetch: svc({ ps: { ...base, receipt }, keys: [{ kty: "OKP", crv: "Ed25519", kid: "t-1", x: key.x }] }, calls) });
  assert.equal(r.status, "not_landed"); assert.equal(r.safe_to_resign, true); assert.equal(r.receipt_verified, true);
  const sent = JSON.parse(calls[0][1].body);
  assert.deepEqual(sent, { payment_payload: PAY, seller_url: "https://seller.test/x" });
  assert.equal(calls[0][1].method, "POST");
});

test("afterPay: a receipt that does not verify can never say safe_to_resign", async () => {
  const base = { status: "not_landed", safe_to_resign: true };
  const { receipt } = await signed(base);
  const r = await afterPay({ paymentPayload: PAY }, { fetch: svc({ ps: { ...base, receipt: { ...receipt, status: "landed" } }, keys: [] }) });
  assert.equal(r.receipt_verified, false); assert.equal(r.safe_to_resign, false);
});

test("afterPay fail-open: timeout, network error, 5xx/503, 402, bad JSON, missing reference -> unknown + safe_to_resign false + same payload safe", async () => {
  const cases = [
    [async (u, i) => new Promise((_, rej) => i.signal.addEventListener("abort", () => { const e = new Error("t"); e.name = "AbortError"; rej(e); })), "timeout"],
    [async () => { throw new TypeError("fetch failed"); }, "unreachable"],
    [svc({ ps: { code: "chain_unavailable" }, status: 503 }), "chain_unavailable"],
    [svc({ ps: { x402Version: 2 }, status: 402 }), "payment_required"],
    [async () => new Response("<html>", { status: 200 }), "http_200"],
  ];
  for (const [f, code] of cases) {
    const r = await afterPay({ paymentPayload: PAY }, { fetch: f, timeoutMs: 30 });
    assert.deepEqual([r.status, r.safe_to_resign, r.safe_to_retry_same_payload, r.error], ["unknown", false, true, code], code);
  }
  const m = await afterPay({}, { fetch: () => { throw new Error("never called"); } });
  assert.equal(m.error, "missing_reference");
});

test("needsAfterPay: errors, 5xx and repeated 402 only", () => {
  assert.equal(needsAfterPay(new Error("x")), true);
  assert.equal(needsAfterPay({ status: 502 }), true);
  assert.equal(needsAfterPay({ status: 402 }), true);
  assert.equal(needsAfterPay({ status: 200 }), false);
  assert.equal(needsAfterPay({ status: 404 }), false);
});

test("spotCheckFetch: afterPay is opt-in (off = 1.1.0 behaviour, no extra calls)", async () => {
  const calls = [];
  const inner = async (u) => { calls.push(String(u)); return new Response("err", { status: 502 }); };
  const f = spotCheckFetch(inner, {});
  const r = await f("https://seller.test/x", { headers: { "payment-signature": PAY } });
  assert.equal(r.status, 502); assert.equal(r.afterPay, undefined); assert.deepEqual(calls, ["https://seller.test/x"]);
});

test("spotCheckFetch afterPay: a paid call that 5xxs gets .afterPay; a paid call that throws rethrows the SAME error with .afterPay; 200 is untouched", async () => {
  const seen = [];
  const answer = { status: "landed", safe_to_resign: false, safe_to_retry_same_payload: true };
  let mode = "502";
  const inner = async (u, i = {}) => {
    if (String(u) === PAYMENT_STATUS_URL) { seen.push(JSON.parse(i.body)); return Response.json(answer); }
    if (mode === "throw") throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    return new Response("x", { status: mode === "ok" ? 200 : 502 });
  };
  const results = [];
  const payloads = [];
  const f = spotCheckFetch(inner, { afterPay: { fetch: inner, verify: false, onResult: (r, ctx) => { results.push(r.status); payloads.push(ctx && ctx.paymentPayload); } } });
  const r = await f("https://seller.test/x", { headers: { "payment-signature": PAY } });
  assert.equal(r.status, 502); assert.equal(r.afterPay.status, "landed"); assert.equal(r.afterPay.safe_to_resign, false);
  assert.deepEqual(seen[0], { payment_payload: PAY, seller_url: "https://seller.test/x" });
  mode = "throw";
  await assert.rejects(f("https://seller.test/x", { headers: { "payment-signature": PAY } }), (e) => e.message === "socket hang up" && e.afterPay.status === "landed");
  mode = "ok";
  const ok = await f("https://seller.test/x", { headers: { "payment-signature": PAY } });
  assert.equal(ok.status, 200); assert.equal(ok.afterPay, undefined);
  assert.deepEqual(results, ["landed", "landed"]);
  assert.deepEqual(payloads, [PAY, PAY]);
  // the status service itself down: original result unchanged, outcome unknown
  const down = spotCheckFetch(async (u) => { if (String(u) === PAYMENT_STATUS_URL) throw new Error("down"); return new Response("x", { status: 503 }); }, { afterPay: true });
  const d = await down("https://seller.test/x", { headers: { "payment-signature": PAY } });
  assert.equal(d.status, 503); assert.equal(d.afterPay.status, "unknown"); assert.equal(d.afterPay.safe_to_resign, false);
});
