// 1.4.0 opt-in checkExpiry. node --test test/expiry.test.mjs (no network)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { judgeExpiry, checkBeforePay, EXPIRY_CODE, MAX_SKEW_S, spotCheckFetch, SpotCheckBlockedError } from "../index.js";
import { expiryOpts, toUnixS } from "../expiry.js";
import { judgeRequirement } from "../rules.js";

const NOW = 1_800_000_000; // fixed clock (s)
const eo = (o = {}) => expiryOpts({ now: () => NOW * 1000, ...o });
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const R = (extra = {}, more = {}) => ({ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "10000", payTo: "0x" + "11".repeat(20), maxTimeoutSeconds: 60, extra, ...more });

test("toUnixS: seconds, ms, ISO; garbage is null", () => {
  assert.equal(toUnixS(NOW), NOW); assert.equal(toUnixS(String(NOW)), NOW); assert.equal(toUnixS(NOW * 1000), NOW);
  assert.equal(toUnixS(new Date(NOW * 1000).toISOString()), NOW);
  for (const v of [null, "", "soon", true, -5, 0, {}, "2026-13-99T"]) assert.equal(toUnixS(v), null);
});

test("fields: validBefore / expiresAt / expiry / deadline in extra; first readable decides", () => {
  for (const f of ["validBefore", "expiresAt", "expiry", "deadline"]) {
    assert.match(judgeExpiry(R({ [f]: NOW - 1 }), null, eo()), /^challenge_expired: extra\./, f);
    assert.equal(judgeExpiry(R({ [f]: NOW + 31 }), null, eo()), "", f);
  }
  assert.equal(judgeExpiry(R({ validBefore: "garbage", expiresAt: NOW + 3600 }), null, eo()), "", "garbage skipped, next readable decides");
  assert.equal(judgeExpiry(R({ validBefore: "garbage" }), null, eo()), "", "unparseable never blocks");
  assert.equal(judgeExpiry(R(), null, eo()), "", "absent never blocks");
});

test("skew boundaries (default 30s), capped at 300s", () => {
  assert.match(judgeExpiry(R({ validBefore: NOW + 30 }), null, eo()), /under the 30s skew/, "exactly now+skew = expired");
  assert.equal(judgeExpiry(R({ validBefore: NOW + 31 }), null, eo()), "");
  assert.equal(judgeExpiry(R({ validBefore: NOW + 5 }), null, eo({ skewS: 0 })), "");
  assert.equal(eo({ skewS: 10_000 }).skewS, MAX_SKEW_S); assert.equal(MAX_SKEW_S, 300);
  assert.match(judgeExpiry(R({ validBefore: NOW + 299 }), null, eo({ skewS: 10_000 })), /under the 300s skew/);
  assert.equal(judgeExpiry(R({ validBefore: NOW + 301 }), null, eo({ skewS: 10_000 })), "");
  assert.equal(eo({ skewS: -4 }).skewS, 0);
});

test("maxTimeoutSeconds: <= minWindowS (5) only; missing = no opinion", () => {
  for (const [v, hit] of [[0, true], [5, true], [6, false], [300, false], [undefined, false], ["", false]]) assert.equal(!!judgeExpiry(R({}, { maxTimeoutSeconds: v }), null, eo()), hit, String(v));
  assert.equal(!!judgeExpiry(R({}, { maxTimeoutSeconds: 8 }), null, eo({ minWindowS: 10 })), true);
});

test("signed authorization validBefore (paid path) is checked first", () => {
  assert.match(judgeExpiry(R(), { validBefore: String(NOW - 10) }, eo()), /authorization\.validBefore .* expired 10s ago/);
  assert.equal(judgeExpiry(R(), { validBefore: String(NOW + 600) }, eo()), "");
});

test("decisions: checkExpiry skips with challenge_expired; without it the verdict is unchanged", async () => {
  const accepts = [R({ validBefore: 1700000000 })];
  const on = await checkBeforePay("https://s.test/x", { accepts, price: 0.01, checkExpiry: { now: () => NOW * 1000 } });
  assert.deepEqual([on.verdict, on.reason_code, on.allowed], ["skip", EXPIRY_CODE, false]);
  const off = await checkBeforePay("https://s.test/x", { accepts, price: 0.01 });
  assert.deepEqual([off.verdict, off.reason_code, off.allowed], ["pay", "price_ok", true]);
  // one fresh option left -> not skipped; the expired one is narrowed away by fits()
  const mixed = await checkBeforePay("https://s.test/x", { accepts: [accepts[0], R({ validBefore: NOW + 3600 })], checkExpiry: { now: () => NOW * 1000 } });
  assert.equal(mixed.allowed, true); assert.match(await mixed.fits(accepts[0]), /^challenge_expired/); assert.equal(await mixed.fits(R({ validBefore: NOW + 3600 })), "");
  // an existing skip keeps its own reason
  const price = await checkBeforePay("https://s.test/x", { accepts: [R({ validBefore: 1 }, { amount: "90000" })], price: 0.01, checkExpiry: true });
  assert.equal(price.reason_code, "price_mismatch");
});

test("paid path: spotCheckFetch refuses to SEND a payment whose authorization already expired (flag on only)", async () => {
  let sent = 0;
  const f = async () => { sent++; return new Response("{}"); };
  const accepted = R();
  const hdr = Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { authorization: { validBefore: String(Math.floor(Date.now() / 1000) - 60) } } })).toString("base64");
  await assert.rejects(spotCheckFetch(f, { checkExpiry: true })("https://s.test/x", { headers: { "payment-signature": hdr } }), (e) => e instanceof SpotCheckBlockedError && e.decision.reason_code === EXPIRY_CODE);
  assert.equal(sent, 0);
  await spotCheckFetch(f)("https://s.test/x", { headers: { "payment-signature": hdr } });
  assert.equal(sent, 1, "flag off: unchanged (sent)");
});

test("no-change: with checkExpiry unset, every verdict over a broad fixture grid equals the plain rules", async () => {
  const grid = [];
  for (const amount of ["10000", "50000", "abc"]) for (const payTo of ["0x" + "11".repeat(20), "0x" + "22".repeat(20)]) for (const extra of [{}, { validBefore: 1 }, { expiresAt: "2000-01-01T00:00:00Z" }, { deadline: NOW * 1000 }]) for (const mt of [0, 5, 60, undefined])
    grid.push(R(extra, { amount, payTo, maxTimeoutSeconds: mt }));
  const listing = { price: 0.01, payTo: "0x" + "11".repeat(20) };
  for (const a of grid) {
    const d = await checkBeforePay("https://s.test/g", { accepts: [a], ...listing });
    const r = judgeRequirement(a, { listing });
    const want = r.verdict === "skip" ? ["skip", r.reason_code] : ["pay", r.reason_code];
    assert.deepEqual([d.verdict, d.reason_code], want, JSON.stringify(a));
    assert.equal(await d.fits(a), r.verdict === "skip" ? `${r.reason_code}: ${r.reason}` : "");
  }
  assert.ok(grid.length >= 96);
  assert.ok(!readFileSync(new URL("../rules.js", import.meta.url), "utf8").includes("challenge_expired"), "vendored rules untouched");
});

test("service mode: the opt-in flag adds check_expiry=1 (+ skew_s) to the 402xAgent query; absent otherwise", async () => {
  const urls = [];
  const fake = async (u) => { urls.push(String(u)); return Response.json({ verdict: "pay", reason: "price_ok", payment_terms_sha256: null }); };
  await checkBeforePay("https://s.test/q", { mode: "service", fetch: fake, accepts: [R()] });
  await checkBeforePay("https://s.test/q", { mode: "service", fetch: fake, accepts: [R()], checkExpiry: { skewS: 999 } });
  assert.doesNotMatch(urls[0], /check_expiry/);
  assert.match(urls[1], /check_expiry=1&skew_s=300/);
});
