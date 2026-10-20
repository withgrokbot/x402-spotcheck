// P0: read-only Base Sepolia smoke (no signing, no spend). Key file from X402_TESTNET_KEY_FILE; only the address is printed.
import { loadTestnetConfig, loadTestnetAccount, readBalances } from "../test/harness/testnet.mjs";
const cfg = loadTestnetConfig("base-sepolia");
const acct = await loadTestnetAccount();
if (!acct) { console.log("X402_TESTNET_KEY_FILE not set: skipping balance check"); process.exit(0); }
const t0 = performance.now();
const b = await readBalances(cfg, acct.address);
const fac = await fetch(cfg.facilitatorUrl + "/supported").then((r) => r.json()).catch((e) => ({ error: String(e) }));
const kinds = (fac.kinds || []).filter((k) => k.network === cfg.network || k.network === "base-sepolia").map((k) => `v${k.x402Version}:${k.scheme}:${k.network}`);
console.log(JSON.stringify({ network: cfg.network, chainId: b.chainId, address: acct.address, eth: Number(b.ethWei) / 1e18, usdc: Number(b.usdcAtomic) / 1e6, facilitatorSupports: kinds, ms: Math.round(performance.now() - t0) }, null, 1));
