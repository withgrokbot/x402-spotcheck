// P4 (unreleased): service-side check of a client-reported payment-status against the chain (EVM, EIP-3009 USDC).
// The authorize service must not settle or release on a client's word. A "landed" claim needs a successful tx
// receipt containing, from the reservation's asset contract, BOTH Transfer(from, payTo, amount) and
// AuthorizationUsed(from, nonce). A "not_landed" claim needs authorizationState(from, nonce) == false AND the
// authorization to have expired (validBefore in the past); otherwise it could still land.
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const AUTH_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
const AUTH_STATE = "0xe94a0102"; // authorizationState(address,bytes32)
const word = (hex) => "0x" + String(hex).toLowerCase().replace(/^0x/, "").padStart(64, "0");
const addrWord = (a) => word(a);

export function createEvmSettlementVerifier({ rpcUrl, fetch: f = globalThis.fetch, minConfirmations = 1, timeoutMs = 5000, now = () => Date.now() } = {}) {
  if (!rpcUrl) throw new TypeError("createEvmSettlementVerifier needs rpcUrl");
  let id = 0;
  async function rpc(method, params) {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await f(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: ac.signal });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || "rpc error");
      return j.result;
    } finally { clearTimeout(t); }
  }
  /** -> { ok: true, status, txHash?, confirmations? } | { ok: false, reason } */
  return async function verify({ claim, reservation, authorization }) {
    const from = authorization?.from, nonce = authorization?.nonce;
    if (!reservation || !from || !nonce) return { ok: false, reason: "no_authorization_to_check" };
    const asset = String(reservation.asset || "").toLowerCase(), payTo = String(reservation.payTo || "").toLowerCase(), amount = BigInt(reservation.amount);
    try {
      if (claim?.status === "landed") {
        const tx = claim.tx?.hash || claim.settlement_tx || claim.transaction || claim.txHash;
        if (!/^0x[0-9a-fA-F]{64}$/.test(String(tx || ""))) return { ok: false, reason: "no_tx_hash" };
        const rc = await rpc("eth_getTransactionReceipt", [tx]);
        if (!rc) return { ok: false, reason: "tx_not_found" };
        if (rc.status !== "0x1") return { ok: false, reason: "tx_reverted" };
        const logs = (rc.logs || []).filter((l) => String(l.address).toLowerCase() === asset);
        const paid = logs.some((l) => l.topics?.[0] === TRANSFER && l.topics[1] === addrWord(from) && l.topics[2] === addrWord(payTo) && BigInt(l.data) === amount);
        if (!paid) return { ok: false, reason: "no_matching_transfer" };
        const used = logs.some((l) => l.topics?.[0] === AUTH_USED && l.topics[1] === addrWord(from) && l.topics[2] === word(nonce));
        if (!used) return { ok: false, reason: "authorization_nonce_not_in_tx" };
        const head = Number(BigInt(await rpc("eth_blockNumber", [])));
        // A receipt already means >= 1 confirmation. Load-balanced RPCs can answer eth_blockNumber from a node that is
        // behind the one that served the receipt (seen on sepolia.base.org: head < receipt block), so clamp at 1.
        const conf = Math.max(1, head - Number(BigInt(rc.blockNumber)) + 1);
        if (conf < minConfirmations) return { ok: false, reason: "not_enough_confirmations" };
        return { ok: true, status: "landed", txHash: tx, confirmations: conf };
      }
      if (claim?.status === "not_landed") {
        const r = await rpc("eth_call", [{ to: asset, data: AUTH_STATE + addrWord(from).slice(2) + word(nonce).slice(2) }, "latest"]);
        if (BigInt(r || "0x0") !== 0n) return { ok: false, reason: "authorization_already_used" };
        const vb = Number(authorization.validBefore);
        if (!Number.isFinite(vb) || now() <= vb * 1000) return { ok: false, reason: "authorization_still_valid" };
        return { ok: true, status: "not_landed" };
      }
      return { ok: false, reason: "unverifiable_status" };
    } catch (e) {
      return { ok: false, reason: "rpc_unavailable" };
    }
  };
}
export const EVENT_TOPICS = Object.freeze({ TRANSFER, AUTH_USED, AUTH_STATE });
