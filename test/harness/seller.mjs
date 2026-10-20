// P0 harness: our own x402 seller. mode "mock" (offline, checks the proof structurally, single-use nonces)
// or "sepolia" (forwards to the x402.org facilitator /verify + /settle on Base Sepolia only).
// Also serves a mock 402xAgent payment-status at POST /payment-status.
import { createServer } from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";
import { receiptSigningInput } from "../../index.js";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s) => { try { return JSON.parse(Buffer.from(String(s), "base64").toString("utf8")); } catch { return null; } };
export async function startSeller({ cfg, mode = "mock", payTo = "0x" + "5e".repeat(20), amount = "10000", port = 0, x402Version = 2 } = {}) {
  if (!cfg?.testnet) throw new Error("seller: testnet config required");
  const usdc = cfg.assets.USDC;
  const settled = new Map(); // nonce -> tx
  // Ephemeral receipt key (test only): payment-status answers carry a signed receipt, verified with `receiptKey`.
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const receiptKey = { ...publicKey.export({ format: "jwk" }), kid: "p0-mock" };
  const signR = (r) => ({ ...r, signature: sign(null, receiptSigningInput(r), privateKey).toString("base64url") });
  const stats = { challenges: 0, paid: 0, rejected: 0, statusCalls: 0, headersSeen: [] };
  const srv = createServer(async (req, res) => {
    const url = `http://127.0.0.1:${srv.address().port}${req.url}`;
    const req402 = { scheme: "exact", network: x402Version === 1 ? "base-sepolia" : cfg.network, amount, ...(x402Version === 1 ? { maxAmountRequired: amount } : {}), asset: usdc.address, payTo, maxTimeoutSeconds: 120, resource: url, extra: usdc.eip712 };
    const required = { x402Version, resource: { url }, accepts: [req402] };
    if (req.method === "POST" && req.url === "/payment-status") {
      stats.statusCalls++;
      let body = ""; for await (const c of req) body += c;
      stats.headersSeen.push(Object.keys(req.headers).filter((h) => /payment/.test(h)));
      const proof = unb64(req.headers["payment-signature"] || req.headers["x-payment"]);
      const nonce = proof?.payload?.authorization?.nonce;
      const tx = nonce && settled.get(nonce);
      res.writeHead(200, { "content-type": "application/json" });
      const ans = tx ? { status: "landed", safe_to_resign: false, safe_to_retry_same_payload: false, tx: { hash: tx, confirmations: 12 }, finality: { confirmations: 12, min_confirmations: 10, reorg_safe: true } } : { status: "not_landed", safe_to_resign: true, safe_to_retry_same_payload: true };
      return res.end(JSON.stringify({ ...ans, receipt: signR({ id: "ps-" + (nonce || "none").slice(2, 18), kid: "p0-mock", status: ans.status, tx_hash: tx || null, network: cfg.network }) }));
    }
    const header = req.headers["payment-signature"] || req.headers["x-payment"];
    if (!header) { stats.challenges++; res.writeHead(402, { "content-type": "application/json", "payment-required": b64(required) }); return res.end(JSON.stringify(required)); }
    const proof = unb64(header);
    const auth = proof?.payload?.authorization;
    const reject = (why) => { stats.rejected++; res.writeHead(402, { "content-type": "application/json", "payment-required": b64(required) }); res.end(JSON.stringify({ ...required, error: why })); };
    if (!auth) return reject("malformed_payment");
    if (String(auth.to).toLowerCase() !== payTo.toLowerCase() || String(auth.value) !== amount) return reject("terms_mismatch");
    if (settled.has(auth.nonce)) return reject("nonce_reused");
    let tx;
    if (mode === "sepolia") {
      const body = JSON.stringify({ x402Version: proof.x402Version, paymentPayload: proof, paymentRequirements: req402 });
      const post = (p) => fetch(cfg.facilitatorUrl + p, { method: "POST", headers: { "content-type": "application/json" }, body }).then((r) => r.json());
      const v = await post("/verify"); if (!v.isValid) return reject(v.invalidReason || "verify_failed");
      const s = await post("/settle"); if (!s.success) return reject(s.errorReason || "settle_failed");
      tx = s.transaction;
    } else tx = "0x" + Buffer.from(String(auth.nonce)).toString("hex").padEnd(64, "0").slice(0, 64);
    settled.set(auth.nonce, tx); stats.paid++;
    res.writeHead(200, { "content-type": "application/json", "payment-response": b64({ success: true, transaction: tx, network: cfg.network }) });
    res.end(JSON.stringify({ ok: true, tx }));
  });
  await new Promise((r) => srv.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { url: base + "/paid", statusUrl: base + "/payment-status", stats, receiptKey, close: () => new Promise((r) => srv.close(r)) };
}
/** Offline buyer: builds a structurally valid (unsigned) EIP-3009-shaped proof. Mock mode only. */
export function mockProof(required, { nonce, from = "0x" + "b0".repeat(20), validBefore = Math.floor(Date.now() / 1000) + 120 } = {}) {
  const a = required.accepts[0];
  return b64({ x402Version: required.x402Version, accepted: a, payload: { signature: "0x" + "00".repeat(65), authorization: { from, to: a.payTo, value: a.amount, validAfter: "0", validBefore: String(validBefore), nonce } } });
}
