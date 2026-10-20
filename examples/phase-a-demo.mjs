// Phase A demo. Offline/mocked: no network, no signing, no spend.
// Run with: node examples/phase-a-demo.mjs   (the ledger part needs Node >= 22.13 for node:sqlite)
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterPay } from "../after.js";
import { createAudit } from "../audit.js";
import { SAMPLE_REQUIREMENT } from "../testkit.js";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const KEY = new Uint8Array(32).fill(7); // demo-only key
const URL_ = "https://seller.example/paid";
const ctx = (amount) => { const req = { ...SAMPLE_REQUIREMENT, amount }; return { paymentRequired: { x402Version: 2, resource: { url: URL_ }, accepts: [req] }, selectedRequirements: req }; };
const make = async (path) => { const { openAuditStore } = await import("../audit-sqlite.js"); return createAudit({ store: await openAuditStore(path), agentId: "demo", payloadKey: KEY, policy: { version: "p1", dailyBudgetAtomic: 1000 } }); };

const [mode, db] = process.argv.slice(2);
if (mode === "write") {
  const a = await make(db);
  console.log("  [proc 1] reserve 700 ->", (await a.beforePayment(ctx("700"))) ?? "allowed");
  await a.onPayment({ paymentPayload: b64({ x402Version: 2, payload: { authorization: { value: "700", validBefore: "1700000000", nonce: "0x" + "22".repeat(32) } } }), url: URL_ });
  console.log("  [proc 1] entries:", (await a.exportState()).entries.length, "| process exits");
  await a.close();
} else if (mode === "read") {
  const a = await make(db);
  const st = await a.exportState();
  console.log("  [proc 2] entries after restart:", st.entries.length, "| open reservations:", st.reservations.filter((r) => !r.settled && !r.released).length, "| sealed payloads:", Object.keys(st.payloads).length);
  console.log("  [proc 2] verifyChain:", JSON.stringify(await a.verifyChain()));
  console.log("  [proc 2] reserve 600 (budget 1000, 700 held) ->", JSON.stringify(await a.beforePayment(ctx("600"))));
  await a.close();
} else {
  console.log("1) Proof header by x402Version (mock fetch captures what would be sent)");
  for (const v of [1, 2, 3]) {
    let sent = null;
    const fetch = async (_u, init) => { sent = init.headers; return new Response(JSON.stringify({ status: "pending" }), { headers: { "content-type": "application/json" } }); };
    const r = await afterPay({ txHash: "0x" + "ab".repeat(32), network: "eip155:84532" }, { fetch, paymentHeader: b64({ x402Version: v, payload: {} }), verify: false });
    const h = sent ? Object.keys(sent).filter((k) => /payment/.test(k)) : "nothing sent";
    console.log(`  x402Version ${v}: header=${JSON.stringify(h)} status=${r.status}${r.error ? " error=" + r.error : ""}`);
  }
  let sqlite = true; try { await import("node:sqlite"); } catch { sqlite = false; }
  if (!sqlite) { console.log("2) skipped: node:sqlite needs Node >= 22.13"); process.exit(0); }
  console.log("2) SQLite ledger survives a process restart");
  const path = join(mkdtempSync(join(tmpdir(), "phasea-")), "audit.db");
  for (const m of ["write", "read"]) { const r = spawnSync(process.execPath, ["--no-warnings", new URL(import.meta.url).pathname, m, path], { stdio: "inherit" }); if (r.status) process.exit(r.status); }
}
