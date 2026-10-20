// 1.1.0: verifyReceipt (ed25519 over RFC 8785 JCS of the receipt minus `signature`). Ephemeral keys only, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyReceipt, canonicalize, receiptSigningInput, RECEIPT_KEYS_URL } from "../index.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-1" };
const signed = (r) => ({ ...r, signature: sign(null, receiptSigningInput(r), privateKey).toString("base64url") });
// Flip a bit in R (byte 0). The old tamper replaced the last 2 chars with "AA" (= last byte 0x00),
// but the top byte of an Ed25519 S is always < 0x10, so it was a no-op in ~1/16 runs.
const flip = (sig) => { const b = Buffer.from(sig, "base64url"); b[0] ^= 1; return b.toString("base64url"); };
const R = { id: "sc-abc", kid: "test-1", verdict: "pay", amount_atomic: "20000", n: 1.5, nested: { z: 1, a: [true, null, "é"] } };

test("JCS: RFC 8785 vectors (key order, numbers, escapes)", () => {
  assert.equal(canonicalize({ b: 2, a: 1, c: { y: [1, "x"], x: null } }), '{"a":1,"b":2,"c":{"x":null,"y":[1,"x"]}}');
  assert.equal(canonicalize([1e21, 1e-7, 0.1, -0, 100]), "[1e+21,1e-7,0.1,0,100]");
  assert.equal(canonicalize({ "\u20ac": 1, "\r": 2, "1": 3, "\ud83d\ude00": 4, "\u0080": 5 }), '{"\\r":2,"1":3,"\u0080":5,"\u20ac":1,"\ud83d\ude00":4}');
  assert.equal(canonicalize("\u2028\u000f"), '"\u2028\\u000f"');
  assert.throws(() => canonicalize(NaN));
});
test("valid with a passed JWK, JWKS, or raw base64url key; kid-matched", async () => {
  const r = signed(R);
  assert.equal((await verifyReceipt(r, { publicKey: jwk })).valid, true);
  assert.equal((await verifyReceipt(r, { publicKey: { keys: [{ ...jwk, kid: "other", x: "A".repeat(43) }, jwk] } })).valid, true);
  assert.equal((await verifyReceipt(r, { publicKey: jwk.x })).valid, true);
  assert.equal((await verifyReceipt(JSON.parse(JSON.stringify(r)), { publicKey: jwk })).valid, true, "key order irrelevant after round-trip");
  const res = await verifyReceipt(r, { publicKey: { keys: [{ ...jwk, kid: "other" }] } });
  assert.equal(res.valid, false); assert.match(res.reason, /kid test-1/);
});
test("fetches the key set from /.well-known when no key is passed", async () => {
  const seen = [];
  const fetch = async (u) => { seen.push(String(u)); return Response.json({ keys: [jwk] }); };
  assert.equal((await verifyReceipt(signed(R), { fetch })).valid, true);
  assert.deepEqual(seen, [RECEIPT_KEYS_URL]);
  assert.match(RECEIPT_KEYS_URL, /\/\.well-known\/402xagent-keys\.json$/);
  const down = await verifyReceipt(signed(R), { fetch: async () => new Response("x", { status: 503 }) });
  assert.equal(down.valid, false);
});
test("tampering, unsigned, wrong key, junk: invalid, never throws", async () => {
  const r = signed(R);
  for (const bad of [{ ...r, verdict: "skip" }, { ...r, kid: "test-2" }, { ...r, extra: 1 }, { ...r, signature: flip(r.signature) }]) {
    assert.equal((await verifyReceipt(bad, { publicKey: { ...jwk, kid: bad.kid } })).valid, false);
  }
  assert.match((await verifyReceipt(R, { publicKey: jwk })).reason, /unsigned/);
  const other = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
  assert.equal((await verifyReceipt(r, { publicKey: { ...other, kid: "test-1" } })).valid, false);
  assert.equal((await verifyReceipt(null)).valid, false);
  assert.equal((await verifyReceipt({ ...r, signature: "!!" }, { publicKey: jwk })).valid, false);
});
