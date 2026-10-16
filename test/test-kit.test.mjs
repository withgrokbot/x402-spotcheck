// Runs examples/test-kit end to end (local mock seller, no network, no payments).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { runKit } from "../examples/test-kit/run.mjs";

test("test kit: every case gives the expected verdict; double-pay retry is not re-signed", async () => {
  const rows = await runKit({ quiet: true });
  assert.deepEqual(rows.map((r) => [r.case, r.verdict, r.code]), [
    ["good", "pay", "price_ok"], ["price-mismatch", "skip", "price_mismatch"], ["wrong-payto", "skip", "pay_to_mismatch"],
    ["expired", "pay", "price_ok"], ["expiring-soon", "pay", "price_ok"], ["malformed", "skip", "bad_challenge"], ["double-pay", "pay", "price_ok"],
    ["good +checkExpiry", "pay", "price_ok"], ["expired +checkExpiry", "skip", "challenge_expired"], ["expiring-soon +checkExpiry", "skip", "challenge_expired"],
  ]);
  assert.ok(rows.every((r) => r.ok), JSON.stringify(rows.filter((r) => !r.ok)));
  assert.match(rows.find((r) => r.case === "double-pay").after, /landed, safe_to_resign=false, receipt verified -> do NOT re-sign/);
  assert.match(rows.find((r) => r.case === "expired").after, /not_landed, safe_to_resign=true/);
});

test("test kit: run.mjs exits 0 and prints the table", () => {
  const out = execFileSync(process.execPath, ["--no-warnings", new URL("../examples/test-kit/run.mjs", import.meta.url).pathname], { encoding: "utf8" });
  assert.match(out, /^case\s+expected\s+got\s+ok\s+reason/m);
  assert.match(out, /all 10 rows as expected/);
});
