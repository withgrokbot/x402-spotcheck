// Phase A: afterPay picks the proof header from x402Version (ported from Gatecheck test/x402-version.test.mjs).
// No network: fetch is mocked. The @x402/core parity check runs only when @x402/core is installed (npm i).
import test from "node:test";
import assert from "node:assert/strict";
import { afterPay, proofHeaderForVersion, paymentHeaderVersion } from "../after.js";

const pay = (v) => Buffer.from(JSON.stringify({ x402Version: v, payload: { signature: "0x", authorization: {} } })).toString("base64");
function recorder() {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, headers: init.headers }); return Response.json({ status: "pending", safe_to_resign: false }); };
  return { calls, fetch };
}

test("proofHeaderForVersion: v1 X-PAYMENT, v2 PAYMENT-SIGNATURE, anything else null", () => {
  assert.equal(proofHeaderForVersion(1), "X-PAYMENT");
  assert.equal(proofHeaderForVersion("1"), "X-PAYMENT");
  assert.equal(proofHeaderForVersion(2), "PAYMENT-SIGNATURE");
  assert.equal(proofHeaderForVersion("2"), "PAYMENT-SIGNATURE");
  for (const v of [0, 3, null, undefined, "v2", {}]) assert.equal(proofHeaderForVersion(v), null);
  assert.equal(paymentHeaderVersion(pay(2)), 2);
  assert.equal(paymentHeaderVersion("not base64 json"), null);
});

test("afterPay sends PAYMENT-SIGNATURE for a v2 payment header (unchanged from 1.5.x)", async () => {
  const { calls, fetch } = recorder();
  await afterPay({ txHash: "0x" + "ab".repeat(32) }, { fetch, verify: false, paymentHeader: pay(2) });
  assert.equal(calls[0].headers["payment-signature"], pay(2));
  assert.equal(calls[0].headers["x-payment"], undefined);
});

test("afterPay sends X-PAYMENT for a v1 payment header", async () => {
  const { calls, fetch } = recorder();
  await afterPay({ txHash: "0x" + "ab".repeat(32) }, { fetch, verify: false, paymentHeader: pay(1) });
  assert.equal(calls[0].headers["x-payment"], pay(1));
  assert.equal(calls[0].headers["payment-signature"], undefined);
});

test("afterPay: explicit x402Version overrides the decoded one", async () => {
  const { calls, fetch } = recorder();
  await afterPay({ txHash: "0x" + "ab".repeat(32) }, { fetch, verify: false, paymentHeader: pay(2), x402Version: 1 });
  assert.ok(calls[0].headers["x-payment"]);
});

test("afterPay: an unknown or unreadable x402Version is a clear error and nothing is sent", async () => {
  for (const h of [pay(3), pay(null), "garbage"]) {
    const { calls, fetch } = recorder();
    const r = await afterPay({ txHash: "0x" + "ab".repeat(32) }, { fetch, verify: false, paymentHeader: h });
    assert.equal(calls.length, 0);
    assert.equal(r.status, "unknown");
    assert.equal(r.error, "unsupported_x402_version");
    assert.equal(r.safe_to_resign, false);
    assert.match(r.why, /only 1 \(X-PAYMENT\) and 2 \(PAYMENT-SIGNATURE\)/);
  }
});

test("afterPay without a payment header sends no proof header (free status call, unchanged)", async () => {
  const { calls, fetch } = recorder();
  await afterPay({ txHash: "0x" + "ab".repeat(32) }, { fetch, verify: false });
  assert.equal(calls[0].headers["payment-signature"], undefined);
  assert.equal(calls[0].headers["x-payment"], undefined);
});

let http = null;
try { http = await import("@x402/core/http"); } catch { /* optional dev dependency */ }
test("parity with @x402/core x402HTTPClient.encodePaymentSignatureHeader", { skip: !http && "@x402/core not installed" }, async () => {
  const { x402Client } = await import("@x402/core/client");
  const c = new http.x402HTTPClient(new x402Client());
  for (const v of [1, 2]) {
    const p = { x402Version: v, payload: {}, accepted: { scheme: "exact", network: "eip155:84532" }, scheme: "exact", network: "base-sepolia" };
    assert.equal(Object.keys(c.encodePaymentSignatureHeader(p))[0], proofHeaderForVersion(v));
  }
  assert.throws(() => c.encodePaymentSignatureHeader({ x402Version: 3 }), /Unsupported x402 version/);
});
