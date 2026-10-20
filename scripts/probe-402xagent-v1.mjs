// P4: v1 X-PAYMENT compatibility probe against the LIVE 402xAgent (mainnet-only). NO PAYMENT IS MADE: every header
// sent is unsigned or junk, so nothing can settle. Run with node --max-http-header-size=65536.
import { checkBeforePay } from "../index.js";
import { afterPay, PAYMENT_STATUS_URL, paymentHeaderVersion, proofHeaderForVersion } from "../after.js";
const BASE = "https://api.402xagent.com";
const PAID = `${BASE}/v1/lookup/paid?task=web-search&max_price=0.01&client=x402-spotcheck-p4-probe`;
const UA = { "user-agent": "x402-spotcheck-p4-probe (no payment)" };
const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64");
const unb64 = (s) => { try { return JSON.parse(Buffer.from(s, "base64").toString("utf8")); } catch { return null; } };
const rows = [];
const show = async (label, r) => { let body = null; try { body = await r.json(); } catch { body = null; } const row = { label, status: r.status, error: body?.error ?? body?.code ?? null, delivered: r.status === 200, settlement: !!(r.headers.get("payment-response") || r.headers.get("x-payment-response")) }; rows.push(row); console.log(JSON.stringify(row)); return body; };

const r0 = await fetch(PAID, { headers: UA });
const pr = unb64(r0.headers.get("payment-required") || "");
const body0 = await show("no header (expect 402)", r0);
const acc = pr?.accepts?.[0] || body0?.accepts?.[0];
console.log("402 terms:", JSON.stringify({ x402Version: pr?.x402Version, scheme: acc?.scheme, network: acc?.network, amount: acc?.amount ?? acc?.maxAmountRequired, asset: acc?.asset, payTo: acc?.payTo, header_bytes: (r0.headers.get("payment-required") || "").length }));
const d = await checkBeforePay(PAID, { accepts: pr?.accepts || [], price: "0.02", payTo: acc?.payTo, network: "base" });
  const dWrong = await checkBeforePay(PAID, { accepts: pr?.accepts || [], price: "0.01", network: "base" });
  console.log("spot-check with a wrong expected price (0.01):", dWrong.verdict, dWrong.reason_code);
console.log("spot-check parses the live 402:", JSON.stringify({ verdict: d.verdict, reason_code: d.reason_code }));

const auth = { from: "0x" + "00".repeat(19) + "01", to: acc?.payTo, value: String(acc?.amount ?? acc?.maxAmountRequired ?? "0"), validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 60), nonce: "0x" + "00".repeat(32) };
const v1 = { x402Version: 1, scheme: "exact", network: "base", payload: { signature: "0x" + "00".repeat(65), authorization: auth } };
const v2 = { x402Version: 2, accepted: acc, payload: { signature: "0x" + "00".repeat(65), authorization: auth } };
console.log("our header choice: v1 ->", proofHeaderForVersion(paymentHeaderVersion(b64(v1))), "| v2 ->", proofHeaderForVersion(paymentHeaderVersion(b64(v2))));
await show("X-PAYMENT: not base64", await fetch(PAID, { headers: { ...UA, "x-payment": "%%%not-base64%%%" } }));
await show("X-PAYMENT: base64 non-JSON", await fetch(PAID, { headers: { ...UA, "x-payment": b64("hello") } }));
await show("X-PAYMENT: v1 exact, zero signature (unsigned)", await fetch(PAID, { headers: { ...UA, "x-payment": b64(v1) } }));
await show("X-PAYMENT: v1, wrong network (base-sepolia)", await fetch(PAID, { headers: { ...UA, "x-payment": b64({ ...v1, network: "base-sepolia" }) } }));
await show("PAYMENT-SIGNATURE: v2, zero signature (control)", await fetch(PAID, { headers: { ...UA, "payment-signature": b64(v2) } }));
// payment-status (afterPay) with a v1 header: free tier
const ps = await afterPay({ txHash: "0x" + "00".repeat(32), network: "eip155:8453", client: "x402-spotcheck-p4-probe" }, { paymentHeader: b64(v1), verify: true, timeoutMs: 15000 });
console.log("payment-status with X-PAYMENT (v1, unsigned):", JSON.stringify({ status: ps.status, error: ps.error ?? ps.code ?? null, safe_to_resign: ps.safe_to_resign, receipt_verified: ps.receipt_verified ?? null }));
const crashes = rows.filter((r) => r.status >= 500).length, delivered = rows.filter((r) => r.delivered || r.settlement).length;
console.log(JSON.stringify({ probes: rows.length, server_errors_5xx: crashes, delivered_or_settled: delivered, endpoint: PAYMENT_STATUS_URL }));
