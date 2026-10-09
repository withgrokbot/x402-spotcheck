// Shared mock world: a Spot-Check endpoint and two x402 targets (no network).
import { DEFAULT_ENDPOINT } from "../index.js";
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const challenge = (url) => ({
  x402Version: 2, error: "Payment required", resource: { url },
  accepts: [{ scheme: "exact", network: "eip155:8453", amount: "10000", asset: USDC, payTo: "0x" + "ab".repeat(20), maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }],
});
export function world({ verdicts = {}, spotStatus = 200, spotPrice = "10000" } = {}) {
  const log = { spot: [], target: [], paidSpot: 0 };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
  const fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const h = new Headers(init.headers || (typeof input === "string" ? {} : input.headers));
    if (url.startsWith(DEFAULT_ENDPOINT)) {
      const q = new URL(url).searchParams;
      log.spot.push(Object.fromEntries(q));
      if (spotStatus === 402 && !h.get("payment-signature")) {
        const req = { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", amount: spotPrice, asset: USDC, payTo: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674" }] };
        return new Response(JSON.stringify(req), { status: 402, headers: { "payment-required": b64(req) } });
      }
      if (h.get("payment-signature")) log.paidSpot++;
      if (spotStatus >= 500) return new Response("down", { status: spotStatus });
      const v = verdicts[q.get("url")] || ["pay", "price_ok"];
      return Response.json({ verdict: v[0], reason: v[1], access: { tier: "free" } });
    }
    const paid = h.get("payment-signature") || h.get("x-payment");
    log.target.push({ url, paid: !!paid, method: init.method || "GET" });
    if (!paid) { const c = challenge(url); return new Response(JSON.stringify(c), { status: 402, headers: { "content-type": "application/json", "payment-required": b64(c) } }); }
    return Response.json({ ok: true, data: "paid content" });
  };
  return { fetch, log };
}
// Minimal stand-in for an x402 client wrapper: on 402, attach a (fake) signed payment header and retry.
export function fakeWrapFetchWithPayment(f) {
  return async (input, init = {}) => {
    const r = await f(input, init);
    if (r.status !== 402) return r;
    const c = JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString());
    const payload = { x402Version: 2, resource: c.resource, accepted: c.accepts[0], payload: { signature: "0x00", authorization: { to: c.accepts[0].payTo, value: c.accepts[0].amount } } };
    return f(input, { ...init, headers: { ...(init.headers || {}), "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") } });
  };
}
