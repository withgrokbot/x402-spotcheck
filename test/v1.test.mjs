// 1.0.0 contract: local by default, hard fail-open timeout, unknown = pay, no tracking, Base-only, hooks, test kit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spotCheckFetch, spotCheckBeforePaymentHook, composeBeforePaymentHooks, threeWsSpendingCapThenSpotCheck, checkBeforePay, SpotCheckBlockedError, DEFAULT_ENDPOINT, DEFAULT_TIMEOUT_MS, VERSION } from "../index.js";
import { spotcheckContract, sampleContext, SAMPLE_REQUIREMENT } from "../testkit.js";
import { fakeWrapFetchWithPayment } from "./mock.mjs";

const RULES_SHA = "7dd1089b30d825b7e6cc7787e7d957040e29e65c41309d0b2a76b73d6c7ec695"; // sha256 of spotcheck-rules 1.0.0 index.js (vendored as rules.js minus its first line)
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAYTO = "0x" + "ab".repeat(20);
const acc = (o = {}) => ({ ...SAMPLE_REQUIREMENT, ...o });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
function world(accepts = [acc()], spot = () => Response.json({ verdict: "pay", reason_code: "price_ok" })) {
  const log = { spot: [], target: [] };
  const fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const h = new Headers(init.headers || {});
    if (url.startsWith(DEFAULT_ENDPOINT)) { log.spot.push({ url, headers: [...h.entries()] }); return spot(init); }
    const paid = h.get("payment-signature");
    log.target.push(paid ? "paid" : "402");
    if (paid) return Response.json({ ok: 1 });
    const c = { x402Version: 2, resource: { url }, accepts };
    return new Response(JSON.stringify(c), { status: 402, headers: { "payment-required": b64(c) } });
  };
  return { fetch, log };
}
const pay = (w, o) => fakeWrapFetchWithPayment(spotCheckFetch(w.fetch, o))("https://seller.test/api");

test("version and defaults", () => {
  assert.equal(VERSION, "1.4.0");
  assert.equal(DEFAULT_TIMEOUT_MS, 1500);
  assert.equal(JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version, "1.4.0");
});
test("vendored rules.js is spotcheck-rules 1.0.0 byte for byte", () => {
  const src = readFileSync(new URL("../rules.js", import.meta.url), "utf8").split("\n").slice(1).join("\n");
  assert.equal(createHash("sha256").update(src).digest("hex"), RULES_SHA);
});
test("default = local: no call to 402xAgent, sane payment goes through", async () => {
  const w = world();
  assert.equal((await pay(w)).status, 200);
  assert.equal(w.log.spot.length, 0);
  assert.deepEqual(w.log.target, ["402", "paid"]);
});
test("local skip blocks only with a reason code; nothing is signed", async () => {
  const w = world();
  await assert.rejects(pay(w, { expected: () => ({ payTo: "0x" + "cd".repeat(20) }) }), (e) => e instanceof SpotCheckBlockedError && e.decision.reason_code === "pay_to_mismatch");
  assert.deepEqual(w.log.target, ["402"]);
  const a = world([acc({ asset: "0x" + "99".repeat(20) })]);
  await assert.rejects(pay(a), /asset_not_usdc|token other than USDC/);
  const m = world([acc({ asset: "0x" + "99".repeat(20) }), acc()]); // mixed: narrowed to the good accept
  assert.equal((await pay(m)).status, 200);
});
test("unknown means pay: unreadable 402, {} 402, expected() throwing", async () => {
  for (const accepts of [[], [{}], [{ network: "eip155:8453" }].slice(1)]) assert.equal((await pay(world(accepts.length ? accepts : [acc()]), {})).status, 200);
  const garbage = { fetch: async (i, init = {}) => (new Headers(init.headers).get("payment-signature") ? Response.json({ ok: 1 }) : new Response("{}", { status: 402 })) };
  const r = await spotCheckFetch(garbage.fetch)("https://seller.test/api");
  assert.equal(r.status, 402, "unreadable 402 passes through untouched");
  assert.equal((await pay(world(), { expected: () => { throw new Error("db down"); } })).status, 200);
});
test("non-Base chains pass through untouched (no call, no change); Solana opt-in", async () => {
  const sol = acc({ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "junk", payTo: "x" });
  for (const mode of ["local", "service"]) {
    const w = world([sol]);
    assert.equal((await pay(w, { mode, expected: () => ({ payTo: "0x" + "cd".repeat(20) }) })).status, 200);
    assert.equal(w.log.spot.length, 0, mode);
  }
  const w = world([sol]);
  await assert.rejects(pay(w, { solana: true }), /bad_challenge|no readable/);
});
test("service mode: no caller-tracking by default (no client, no ref, only an accept header)", async () => {
  const w = world();
  await pay(w, { mode: "service" });
  assert.equal(w.log.spot.length, 1);
  const u = new URL(w.log.spot[0].url);
  assert.deepEqual([...u.searchParams.keys()], ["url"]);
  assert.deepEqual(w.log.spot[0].headers, [["accept", "application/json"]]);
  const o = world();
  await pay(o, { mode: "service", client: "r1", ref: "via-r1" });
  assert.deepEqual([...new URL(o.log.spot[0].url).searchParams.keys()], ["url", "client", "ref"], "opt-in only");
});
test("timeout: honored exactly, fails open by default, fails closed only when the caller says so", async () => {
  const hang = () => new Promise(() => {}); // ignores the abort signal entirely
  for (const ms of [50, 200]) {
    const w = world([acc()], hang);
    const t0 = Date.now();
    assert.equal((await pay(w, { mode: "service", timeoutMs: ms })).status, 200);
    const el = Date.now() - t0;
    assert.ok(el >= ms - 5 && el < ms + 150, `timeout ${ms} took ${el}`);
  }
  await assert.rejects(pay(world([acc()], hang), { mode: "service", timeoutMs: 30, onUnavailable: "block" }), (e) => /timeout \(30 ms\)/.test(e.message));
  await assert.rejects(pay(world([acc()], () => { throw new Error("ECONNRESET"); }), { mode: "service", onUnavailable: "block" }), SpotCheckBlockedError);
  assert.equal((await pay(world([acc()], () => { throw new Error("ECONNRESET"); }), { mode: "service" })).status, 200);
});
test("service answers: {} pays, recheck pays, skip with code blocks, 5xx pays", async () => {
  for (const [body, ok] of [[{}, true], [{ verdict: "recheck", reason_code: "timeout" }, true], [{ verdict: "skip" }, true], [{ verdict: "skip", reason_code: "no_paywall" }, true], [{ verdict: "skip", reason_code: "network_mismatch" }, false]]) {
    const p = pay(world([acc()], () => Response.json(body)), { mode: "service" });
    if (ok) assert.equal((await p).status, 200, JSON.stringify(body)); else await assert.rejects(p, SpotCheckBlockedError);
  }
  assert.equal((await pay(world([acc()], () => new Response("x", { status: 503 })), { mode: "service" })).status, 200);
  assert.equal((await pay(world([acc()], () => new Response("not json", { status: 200 })), { mode: "service" })).status, 200);
});
test("x402 onBeforePaymentCreation hook (local + service); spending cap composes first", async () => {
  assert.equal(await spotCheckBeforePaymentHook()(sampleContext()), undefined);
  const r = await spotCheckBeforePaymentHook({ expected: () => ({ price: 0.001 }) })(sampleContext());
  assert.equal(r.abort, true); assert.match(r.reason, /price_mismatch/);
  assert.equal(await spotCheckBeforePaymentHook()(null), undefined);
  let spotCalls = 0;
  const f = async () => { spotCalls++; return Response.json({ verdict: "skip", reason_code: "pay_to_mismatch" }); };
  const cap = async ({ selectedRequirements }) => (BigInt(selectedRequirements.amount) > 5000n ? { abort: true, reason: "over cap" } : undefined);
  const both = composeBeforePaymentHooks(cap, spotCheckBeforePaymentHook({ mode: "service", fetch: f }));
  assert.deepEqual(await both(sampleContext()), { abort: true, reason: "over cap" });
  assert.equal(spotCalls, 0, "cap refused first; the check never ran");
  const tw = threeWsSpendingCapThenSpotCheck(() => async () => undefined, { mode: "service", fetch: f });
  assert.match((await tw(sampleContext())).reason, /pay_to_mismatch/);
  assert.equal(spotCalls, 1);
  assert.throws(() => threeWsSpendingCapThenSpotCheck(null), /buildSpendingCapHook/);
});
test("real @x402/core client: the hook aborts before the scheme is asked to sign", async (t) => {
  let core;
  try { core = await import("@x402/core/client"); } catch { t.skip("@x402/core not installed"); return; }
  let signs = 0;
  const mk = () => { const c = new core.x402Client(); c.setSpendControls(false); return c.register("eip155:*", scheme); };
  const scheme = { scheme: "exact", createPaymentPayload: async () => { signs++; return { x402Version: 2, payload: {} }; } };
  const client = mk().onBeforePaymentCreation(spotCheckBeforePaymentHook({ expected: () => ({ payTo: "0x" + "cd".repeat(20) }) }));
  await assert.rejects(client.createPaymentPayload(sampleContext().paymentRequired), /aborted: x402-spotcheck: pay_to_mismatch/);
  assert.equal(signs, 0);
  const ok = mk().onBeforePaymentCreation(spotCheckBeforePaymentHook());
  await ok.createPaymentPayload(sampleContext().paymentRequired).catch(() => {});
  assert.equal(signs, 1, "no listing: the payment proceeds to the signer");
});
test("checkBeforePay: local needs the 402 accepts; without them it pays (unknown)", async () => {
  assert.equal((await checkBeforePay("https://s.test", { accepts: [acc()], payTo: "0x" + "cd".repeat(20) })).allowed, false);
  assert.equal((await checkBeforePay("https://s.test", {})).allowed, true);
});

// The exported test kit, run against our own service-mode hook.
spotcheckContract(test, ({ enabled, fetch, timeoutMs }) => (enabled ? spotCheckBeforePaymentHook({ mode: "service", fetch, timeoutMs }) : undefined), { name: "testkit/x402-spotcheck" });
