// 1.6.0 (unreleased): network/asset presets. Additive: no networkConfig = 1.5.x behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createAudit, createPolicy } from "../audit.js";
import { presets, networkConfig, checkNetworkAsset } from "../networks.js";
import { SAMPLE_REQUIREMENT } from "../testkit.js";

const SEP_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const DEV_SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", DEV_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SOL_PAYTO = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const ctx = (over = {}, url = "https://seller.example/x") => { const req = { ...SAMPLE_REQUIREMENT, ...over }; return { paymentRequired: { x402Version: 2, resource: { url }, accepts: [req] }, selectedRequirements: req }; };
const audit = (extra = {}) => createAudit({ agentId: "a", payloadKey: randomBytes(32), policy: { version: "p", dailyBudgetAtomic: 100000 }, ...extra });
const verified = (status, extra = {}) => ({ status, receipt_verified: true, id: "ps-" + randomBytes(8).toString("hex"), tx: { hash: "sig1", confirmations: 40 }, finality: { confirmations: 40, min_confirmations: 32, reorg_safe: true }, ...extra });

test("no networkConfig: 1.5.x behaviour (Base mainnet USDC allowed, Base Sepolia USDC allowed as before)", async () => {
  const a = audit();
  assert.equal(await a.beforePayment(ctx()), undefined);
  assert.equal(await a.beforePayment(ctx({ network: "eip155:84532", asset: SEP_USDC })), undefined);
});
test("baseMainnet preset == default for Base mainnet USDC; denies other networks/assets", async () => {
  const a = audit({ networkConfig: presets.baseMainnet });
  assert.equal(await a.beforePayment(ctx()), undefined);
  assert.equal((await a.beforePayment(ctx({ network: "eip155:84532", asset: SEP_USDC }))).reason, "audit deny: network_not_configured");
  assert.equal((await a.beforePayment(ctx({ asset: "0x" + "de".repeat(20) }))).reason, "audit deny: asset_not_configured");
  assert.equal((await a.beforePayment(ctx({ asset: undefined }))).reason, "audit deny: asset_not_configured");
});
test("baseSepolia preset: Sepolia USDC allowed (any address case), mainnet denied, unknown asset denied", async () => {
  const a = audit({ networkConfig: presets.baseSepolia });
  assert.equal(await a.beforePayment(ctx({ network: "eip155:84532", asset: SEP_USDC.toLowerCase() })), undefined);
  assert.equal(await a.beforePayment(ctx({ network: "base-sepolia", asset: SEP_USDC })), undefined, "v1 network name maps to CAIP-2");
  assert.equal((await a.beforePayment(ctx())).reason, "audit deny: network_not_configured");
  assert.equal((await a.beforePayment(ctx({ network: "eip155:84532", asset: "0x" + "de".repeat(20) }))).reason, "audit deny: asset_not_configured");
  assert.equal((await a.verifyChain()).valid, true);
  const denied = a.ledger.entries.filter((e) => e.type === "denied").map((e) => e.reason);
  assert.deepEqual(denied, ["network_not_configured", "asset_not_configured"]);
});
test("presets combine; createPolicy accepts networkConfig directly", () => {
  const cfg = networkConfig(presets.baseSepolia, presets.solanaDevnet);
  assert.equal(checkNetworkAsset(cfg, "eip155:84532", SEP_USDC).decimals, 6);
  assert.equal(checkNetworkAsset(cfg, DEV_SOL, DEV_USDC.toLowerCase()).reason, "asset_not_configured", "Solana mints are case-sensitive");
  const p = createPolicy({ networkConfig: presets.baseSepolia });
  assert.equal(p.evaluate({ amount: "1", network: "eip155:8453", asset: SAMPLE_REQUIREMENT.asset }).reason, "network_not_configured");
  assert.throws(() => networkConfig({ "eip155:1": { kind: "evm", assets: { "0xabc": { decimals: "6" } } } }), /decimals/);
  assert.throws(() => networkConfig({ "eip155:1": { assets: {} } }), /kind/);
});
test("Solana devnet: a reservation settles on a verified landed status", async () => {
  const a = audit({ networkConfig: presets.solanaDevnet });
  const url = "https://seller.example/sol";
  const c = ctx({ network: DEV_SOL, asset: DEV_USDC, payTo: SOL_PAYTO, amount: "10000" }, url);
  assert.equal(await a.beforePayment(c), undefined);
  assert.equal(a.openReservations().length, 1);
  const payload = b64({ x402Version: 2, accepted: { scheme: "exact", network: DEV_SOL, amount: "10000", asset: DEV_USDC, payTo: SOL_PAYTO }, payload: { transaction: "AQAB" } });
  await a.onPayment({ paymentPayload: payload, url });
  const adv = await a.onAfterPay(verified("landed"), { url, paymentPayload: payload });
  assert.equal(adv.move, "settle");
  assert.equal(a.openReservations().length, 0);
  assert.ok(a.ledger.entries.some((e) => e.type === "settled"));
});
test("Solana devnet with settlement:false: cleanly rejected up front, nothing reserved", async () => {
  const a = audit({ networkConfig: networkConfig(presets.baseSepolia, { [DEV_SOL]: { ...presets.solanaDevnet[DEV_SOL], settlement: false } }) });
  const r = await a.beforePayment(ctx({ network: DEV_SOL, asset: DEV_USDC, payTo: SOL_PAYTO }));
  assert.equal(r.reason, "audit deny: network_unsupported_for_settlement");
  assert.equal(a.openReservations().length, 0);
  assert.equal(await a.beforePayment(ctx({ network: "eip155:84532", asset: SEP_USDC })), undefined);
});
test("Solana mainnet is not in the devnet preset", async () => {
  const a = audit({ networkConfig: presets.solanaDevnet });
  const r = await a.beforePayment(ctx({ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", payTo: SOL_PAYTO }));
  assert.equal(r.reason, "audit deny: network_not_configured");
});
