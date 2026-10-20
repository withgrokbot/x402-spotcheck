// P3 (unreleased): remote audit/authorize service. LOCALHOST/TESTNET ONLY in this phase: binds 127.0.0.1 by default.
// State lives in the P2 shared SQLite store (Node >= 22.13), so several service processes can share one file.
//
//   import { startAuditServer } from "x402-spotcheck/audit/server";
//   const srv = await startAuditServer({ dbPath, clients: { "agent-7": hmacKey }, signingKey: ed25519PrivateKey, policy, networkConfig });
//
// Requests must carry x-audit-client / -ts / -nonce / -signature (HMAC, see audit-remote.js). Timestamps outside
// +-30 s and any nonce already seen inside the window are refused (401 replay). Every response, errors included,
// is an Ed25519-signed envelope that echoes the request nonce.
import { createServer } from "node:http";
import { createPublicKey, randomBytes } from "node:crypto";
import { createAudit } from "./audit.js";
import { openAuditStore } from "./audit-sqlite.js";
import { requestSigningInput, hmac, safeEqual, signEnvelope, WINDOW_MS } from "./audit-remote.js";

export async function startAuditServer(opts = {}) {
  const { dbPath, clients, signingKey } = opts;
  if (!dbPath || !clients || !signingKey) throw new TypeError("startAuditServer needs dbPath, clients and signingKey");
  const host = opts.host || "127.0.0.1";
  if (!opts.allowNonLoopback && !/^(127\.|::1$|localhost$)/.test(host)) throw new Error("audit server: non-loopback host refused in this phase (allowNonLoopback)");
  const now = opts.now || (() => Date.now());
  const kid = opts.kid || "audit-1";
  const store = await openAuditStore(dbPath, { shared: true });
  const audit = createAudit({ store, agentId: (ctx) => ctx.__client, payloadKey: opts.payloadKey || randomBytes(32), policy: opts.policy, networkConfig: opts.networkConfig, idempotencyKey: (ctx) => ctx.idempotencyKey });
  // P4: client-reported payment-status is NOT trusted by default. With settlementVerifier (e.g. evm-verify.js) the
  // claim is checked on-chain; without one it is downgraded to unverified (hold) unless trustClientStatus: true.
  const verifier = opts.settlementVerifier || null;
  const payers = opts.payers || null; // optional clientId -> payer address binding
  const decodeAuth = (p) => { try { const j = JSON.parse(Buffer.from(String(p), "base64").toString("utf8")); return j?.payload?.authorization || null; } catch { return null; } };
  async function settle(client, claim, ctx) {
    const authz = decodeAuth(ctx.paymentPayload);
    const rec = authz?.nonce ? audit.budgets.list().find((r) => r.nonce === String(authz.nonce)) : null;
    const owned = rec && (rec.agent === client || rec.budgetId === client);
    let checked;
    if (!rec || !owned) checked = { ok: false, reason: "no_reservation_for_this_client" };
    else if (payers && payers[client] && String(authz.from).toLowerCase() !== String(payers[client]).toLowerCase()) checked = { ok: false, reason: "payer_not_bound_to_client" };
    else if (verifier) checked = await verifier({ claim, reservation: rec, authorization: authz });
    else checked = opts.trustClientStatus === true ? { ok: true, trusted: true } : { ok: false, reason: "client_status_unverified" };
    stats.verify[checked.ok ? "ok" : checked.reason] = (stats.verify[checked.ok ? "ok" : checked.reason] || 0) + 1;
    const effective = checked.ok
      ? (checked.trusted ? claim : { ...claim, status: checked.status, receipt_verified: true, safe_to_resign: checked.status === "not_landed", tx: checked.txHash ? { hash: checked.txHash, confirmations: checked.confirmations } : claim.tx, finality: checked.txHash ? { confirmations: checked.confirmations, min_confirmations: 1, reorg_safe: true } : claim.finality })
      : { status: "unknown", receipt_verified: false, safe_to_resign: false, error: checked.reason };
    const advice = await audit.onAfterPay(effective, ctx);
    return { ...advice, verified: checked.ok, verification: checked.ok ? (checked.trusted ? "trusted_client" : "onchain") : checked.reason };
  }
  const seen = new Map(); // `${client}:${nonce}` -> expiry
  const stats = { requests: 0, refused: { auth: 0, replay: 0, stale: 0 }, ok: 0, verify: {} };
  const publicJwk = { ...createPublicKey(signingKey).export({ format: "jwk" }), kid };

  const server = createServer(async (req, res) => {
    stats.requests++;
    let body = ""; for await (const c of req) body += c;
    const nonce = String(req.headers["x-audit-nonce"] || "");
    const send = (status, env) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(signEnvelope(signingKey, kid, { ...env, req_nonce: nonce || null, ts: now() }))); };
    const path = req.url;
    if (req.method === "GET" && path === "/.well-known/audit-keys.json") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ keys: [publicJwk] })); }
    // authenticate
    const client = String(req.headers["x-audit-client"] || ""), ts = Number(req.headers["x-audit-ts"]), sig = String(req.headers["x-audit-signature"] || "");
    const key = Object.hasOwn(clients, client) ? clients[client] : null;
    if (!key || !nonce || !Number.isFinite(ts) || !safeEqual(sig, hmac(key, requestSigningInput({ method: req.method, path, ts, nonce, body })))) { stats.refused.auth++; return send(401, { ok: false, error: "bad_request_signature" }); }
    if (Math.abs(now() - ts) > WINDOW_MS) { stats.refused.stale++; return send(401, { ok: false, error: "stale_timestamp" }); }
    const t = now(); for (const [k, exp] of seen) if (exp < t) seen.delete(k);
    if (seen.has(client + ":" + nonce)) { stats.refused.replay++; return send(401, { ok: false, error: "replay" }); }
    seen.set(client + ":" + nonce, ts + WINDOW_MS);
    let input = {};
    try { input = body ? JSON.parse(body) : {}; } catch { return send(400, { ok: false, error: "bad_json" }); }
    try {
      let result;
      if (req.method === "POST" && path === "/v1/authorize") {
        const ctx = { ...(input.ctx || {}), __client: client };
        const r = await audit.beforePayment(ctx);
        result = r?.abort ? { allow: false, reason: String(r.reason).replace(/^audit deny: /, "") } : { allow: true, reservationId: ctx.audit?.reservationId || null };
      } else if (req.method === "POST" && path === "/v1/payment") {
        await audit.onPayment({ paymentPayload: input.paymentPayload, url: input.url }); result = { recorded: true };
      } else if (req.method === "POST" && path === "/v1/settle") {
        result = await settle(client, input.result || {}, input.ctx || {});
      } else if (req.method === "POST" && path === "/v1/release") {
        const ctx = input.reservationId ? { audit: { reservationId: String(input.reservationId) }, paymentRequired: { resource: { url: input.url } } } : undefined;
        await audit.onDecision({ ...(input.decision || {}), allowed: input.decision?.allowed ?? false }, ctx); result = { released: true };
      } else if (req.method === "GET" && path.startsWith("/v1/chain")) {
        const from = Number(new URL(path, "http://x").searchParams.get("from")) || 1;
        result = { ...audit.exportChain({ from }), verify: await audit.verifyChain() };
      } else return send(404, { ok: false, error: "not_found" });
      stats.ok++;
      return send(200, { ok: true, result });
    } catch (e) {
      return send(503, { ok: false, error: e?.code === "audit_store_unavailable" ? "audit_store_unavailable" : "internal" });
    }
  });
  let closed = false;
  await new Promise((r) => server.listen(opts.port || 0, host, r));
  const url = `http://${host}:${server.address().port}`;
  return { url, publicKey: publicJwk, stats, audit, close: async () => { if (closed) return; closed = true; const done = new Promise((r) => server.close(r)); server.closeAllConnections(); await done; await audit.close(); } };
}
