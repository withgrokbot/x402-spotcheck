#!/usr/bin/env node
// x402-spotcheck test kit: node examples/test-kit/run.mjs
// Starts the local mock seller, runs the pre-pay check on every 402 case, shows afterPay on the double-pay retry
// and the expired case, prints a table, exits 1 on any unexpected verdict. Local only: no network, no payments.
import { spotCheckFetch, afterPay, SpotCheckBlockedError } from "../../index.js";
import { startMockSeller, CASES } from "./mock-seller.mjs";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const paymentHeader = (accepted, marker) => b64({ x402Version: 2, accepted, payload: { signature: "0x" + "00".repeat(65), authorization: { from: "0x" + "33".repeat(20), to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: String(accepted.extra?.validBefore ?? 4102444800), nonce: "0x" + "44".repeat(32) } }, testkit: marker });

export async function runKit({ quiet = false, hangMs = 2000, timeoutMs = 300 } = {}) {
  const mock = await startMockSeller({ hangMs });
  const rows = [];
  try {
    for (const [path, c] of Object.entries(CASES)) {
      let decision = null;
      const guarded = spotCheckFetch(fetch, {
        expected: () => c.listing,
        onDecision: (d) => { decision = d; },
        afterPay: { url: mock.base + "/payment-status", publicKey: mock.publicKey },
      });
      let verdict, code, reason, after = "";
      try {
        const res = await guarded(mock.base + path);
        verdict = res.status === 402 ? "pay" : "pay?";
        code = decision?.reason_code ?? null; reason = decision?.reason ?? "";
      } catch (e) {
        if (!(e instanceof SpotCheckBlockedError)) throw e;
        verdict = "skip"; code = e.decision?.reason_code ?? decision?.reason_code ?? null; reason = e.decision?.reason ?? e.message;
      }
      let ok = verdict === c.expect && code === c.code;
      if (path === "/double-pay") {
        // the agent pays; the seller takes the money but the response never comes back in time
        const hdr = paymentHeader(c.accepts[0], "landed-nonce");
        let ap = null;
        try { await guarded(mock.base + path, { headers: { "payment-signature": hdr }, signal: AbortSignal.timeout(timeoutMs) }); }
        catch (e) { ap = e.afterPay ?? null; }
        const resign = !!(ap && ap.safe_to_resign); // the retry rule: only sign a NEW payment when safe_to_resign is true
        after = ap ? `afterPay: ${ap.status}, safe_to_resign=${ap.safe_to_resign}, receipt ${ap.receipt_verified ? "verified" : "NOT verified"} -> ${resign ? "re-sign" : "do NOT re-sign"}` : "afterPay: no answer";
        ok = ok && ap?.status === "landed" && ap.safe_to_resign === false && ap.receipt_verified === true && !resign && mock.stats.paidAttempts[path] === 1;
      }
      if (path === "/expired") {
        const ap = await afterPay({ paymentPayload: paymentHeader(c.accepts[0], "expired-nonce") }, { url: mock.base + "/payment-status", publicKey: mock.publicKey });
        after = `afterPay: ${ap.status}, safe_to_resign=${ap.safe_to_resign}, receipt ${ap.receipt_verified ? "verified" : "NOT verified"}`;
        ok = ok && ap.status === "not_landed" && ap.safe_to_resign === true && ap.receipt_verified === true;
      }
      rows.push({ case: path.slice(1), expected: `${c.expect}/${c.code}`, verdict, code, ok, reason: String(reason).slice(0, 90), after });
    }
  } finally {
    await mock.close();
  }
  if (!quiet) {
    const w = (s, n) => String(s).padEnd(n).slice(0, n);
    console.log(w("case", 15) + w("expected", 22) + w("got", 22) + w("ok", 5) + "reason");
    for (const r of rows) {
      console.log(w(r.case, 15) + w(r.expected, 22) + w(`${r.verdict}/${r.code}`, 22) + w(r.ok ? "yes" : "NO", 5) + r.reason);
      if (r.after) console.log(" ".repeat(15) + "└ " + r.after);
    }
    const bad = rows.filter((r) => !r.ok).length;
    console.log(bad ? `\n${bad} unexpected result(s)` : `\nall ${rows.length} cases as expected (local mock, no network, no payments)`);
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = await runKit();
  process.exit(rows.every((r) => r.ok) ? 0 : 1);
}
