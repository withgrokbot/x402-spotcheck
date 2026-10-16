// x402-spotcheck test kit: a local mock seller (plain node:http, no deps, no network, no real payments).
// Each path returns one 402 case; /payment-status answers like 402xAgent payment status, from signed local fixtures.
import { createServer } from "node:http";
import { receiptSigningInput } from "../../receipt.js";

export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const SELLER = "0x1111111111111111111111111111111111111111";
export const OTHER = "0x2222222222222222222222222222222222222222";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const req = (over = {}) => ({ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "10000", payTo: SELLER, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" }, ...over });

// path -> { accepts, listing (what the buyer expects), expect (verdict), code (reason code), note }
export const CASES = {
  "/good": { accepts: [req()], listing: { price: 0.01, payTo: SELLER }, expect: "pay", code: "price_ok" },
  "/price-mismatch": { accepts: [req({ amount: "50000" })], listing: { price: 0.01, payTo: SELLER }, expect: "skip", code: "price_mismatch" },
  "/wrong-payto": { accepts: [req({ payTo: OTHER })], listing: { price: 0.01, payTo: SELLER }, expect: "skip", code: "pay_to_mismatch" },
  "/expired": { accepts: [req({ maxTimeoutSeconds: 0, extra: { name: "USD Coin", version: "2", validBefore: 1700000000 } })], listing: { price: 0.01, payTo: SELLER }, expect: "pay", code: "price_ok", note: "pre-pay rules don't judge expiry; afterPay does (an expired, unused authorization is not_landed and safe to re-sign)" },
  "/malformed": { accepts: [req({ amount: "lots", payTo: "not-an-address" })], listing: { price: 0.01, payTo: SELLER }, expect: "skip", code: "bad_challenge" },
  "/double-pay": { accepts: [req()], listing: { price: 0.01, payTo: SELLER }, expect: "pay", code: "price_ok", note: "paid retry: the payment lands but the response times out" },
};

export async function startMockSeller({ port = 0, hangMs = 2000 } = {}) {
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  const kid = "test-kit-local";
  const sign = async (body) => {
    const r = { ...body, kid };
    const sig = await crypto.subtle.sign("Ed25519", privateKey, receiptSigningInput(r));
    return { ...r, signature: Buffer.from(sig).toString("base64url") };
  };
  const stats = { paidAttempts: {}, statusCalls: 0 };
  const server = createServer(async (rq, rs) => {
    const path = rq.url.split("?")[0];
    if (path === "/payment-status" && rq.method === "POST") {
      stats.statusCalls++;
      let body = ""; for await (const c of rq) body += c;
      const p = JSON.parse(body || "{}");
      let decoded = ""; try { decoded = Buffer.from(String(p.payment_payload || ""), "base64").toString("utf8"); } catch { /* fixture only */ }
      const which = decoded.includes("landed-nonce") ? "landed" : "expired";
      const ans = which === "landed"
        ? { status: "landed", reason: "settled_onchain", safe_to_retry_same_payload: true, safe_to_resign: false, why: "the payment settled on-chain; do not pay again" }
        : { status: "not_landed", reason: "expired_unused", safe_to_retry_same_payload: true, safe_to_resign: true, why: "nonce unused and past validBefore: it can never settle" };
      const receipt = await sign({ id: "ps-testkit-" + which, type: "payment-status", ...ans });
      rs.writeHead(200, { "content-type": "application/json" });
      return rs.end(JSON.stringify({ ...ans, receipt }));
    }
    const c = CASES[path];
    if (!c) { rs.writeHead(404); return rs.end(); }
    const pay = rq.headers["payment-signature"] || rq.headers["x-payment"];
    if (pay) {
      stats.paidAttempts[path] = (stats.paidAttempts[path] || 0) + 1;
      if (path === "/double-pay") return setTimeout(() => { try { rs.writeHead(200); rs.end("{}"); } catch { /* client gone */ } }, hangMs); // landed, but slow
      rs.writeHead(200, { "content-type": "application/json" }); return rs.end('{"ok":true}');
    }
    const pr = { x402Version: 2, error: "payment required", resource: { url: "http://mock" + path }, accepts: c.accepts };
    rs.writeHead(402, { "content-type": "application/json", "payment-required": b64(pr) });
    rs.end(JSON.stringify(pr));
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, server, stats, publicKey: { ...jwk, kid }, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
