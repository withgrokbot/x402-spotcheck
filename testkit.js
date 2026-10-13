// x402-spotcheck/testkit: a contract any pre-payment check integration should pass. Works with vitest and node:test:
//   import { test } from "node:test";      // or: import { it as test } from "vitest";
//   import { spotcheckContract } from "x402-spotcheck/testkit";
//   spotcheckContract(test, ({ enabled, fetch, timeoutMs }) => enabled ? myHook({ fetch, timeoutMs }) : undefined);
// `build` returns an x402 onBeforePaymentCreation hook (or undefined when the feature is off). It must use the `fetch`
// it is given for any network call. Cases: flag off makes no calls; a hung check lets the payment through within the
// timeout; an empty {} answer lets it through; a skip with a rules.json reason code blocks.
import assert from "node:assert/strict";

export const SAMPLE_REQUIREMENT = Object.freeze({ scheme: "exact", network: "eip155:8453", amount: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x" + "ab".repeat(20), maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } });
export function sampleContext(url = "https://seller.example/api") {
  return { paymentRequired: { x402Version: 2, resource: { url }, accepts: [SAMPLE_REQUIREMENT] }, selectedRequirements: SAMPLE_REQUIREMENT };
}
/** Mock fetches: each records its calls in .calls. */
export const mocks = {
  counting: () => { const f = async () => { f.calls++; return Response.json({ verdict: "pay", reason_code: "price_ok" }); }; f.calls = 0; return f; },
  hanging: () => { const f = (u, init = {}) => { f.calls++; return new Promise((_, rej) => init.signal && init.signal.addEventListener("abort", () => rej(new Error("aborted")))); }; f.calls = 0; return f; },
  empty: () => { const f = async () => { f.calls++; return Response.json({}); }; f.calls = 0; return f; },
  skip: (code = "pay_to_mismatch") => { const f = async () => { f.calls++; return Response.json({ verdict: "skip", reason_code: code, reason: code }); }; f.calls = 0; return f; },
};
async function run(hook, ctx) {
  if (typeof hook !== "function") return undefined; // no hook installed = payment proceeds
  return hook(ctx);
}
const isAbort = (r) => !!(r && r.abort === true && typeof r.reason === "string");

/** Register the four contract tests with your runner's test/it function. */
export function spotcheckContract(test, build, { timeoutMs = 100, slackMs = 400, name = "spotcheck contract" } = {}) {
  test(`${name}: flag off makes no calls and the payment proceeds`, async () => {
    const f = mocks.counting();
    const orig = globalThis.fetch; let globalCalls = 0;
    globalThis.fetch = async (...a) => { globalCalls++; return orig(...a); };
    try {
      const r = await run(await build({ enabled: false, fetch: f, timeoutMs }), sampleContext());
      assert.equal(isAbort(r), false);
    } finally { globalThis.fetch = orig; }
    assert.equal(f.calls + globalCalls, 0, "no network calls when off");
  });
  test(`${name}: a timeout lets the payment through within the timeout`, async () => {
    const f = mocks.hanging();
    const t0 = Date.now();
    const r = await run(await build({ enabled: true, fetch: f, timeoutMs }), sampleContext());
    assert.equal(isAbort(r), false, "timeout must not block");
    assert.ok(Date.now() - t0 < timeoutMs + slackMs, `took ${Date.now() - t0} ms, timeout ${timeoutMs} ms`);
  });
  test(`${name}: an empty {} answer lets the payment through`, async () => {
    const r = await run(await build({ enabled: true, fetch: mocks.empty(), timeoutMs }), sampleContext());
    assert.equal(isAbort(r), false);
  });
  test(`${name}: a skip with a reason code blocks`, async () => {
    const f = mocks.skip("pay_to_mismatch");
    const r = await run(await build({ enabled: true, fetch: f, timeoutMs }), sampleContext());
    assert.equal(isAbort(r), true, "skip must return { abort: true, reason }");
    assert.ok(f.calls >= 1);
  });
}
