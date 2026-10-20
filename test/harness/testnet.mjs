// P0 harness: testnet config + throwaway key loader. Refuses non-testnet configs; never prints key material.
import { readFileSync, statSync } from "node:fs";
const MAINNET_IDS = new Set(["eip155:8453", "eip155:1", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);
export function loadTestnetConfig(name = "base-sepolia") {
  const cfg = JSON.parse(readFileSync(new URL(`../../testnet/${name}.json`, import.meta.url), "utf8"));
  if (cfg.testnet !== true || MAINNET_IDS.has(cfg.network)) throw new Error(`refusing non-testnet config ${name}`);
  return Object.freeze(cfg);
}
/** Reads a 0x-hex private key from X402_TESTNET_KEY_FILE (must be mode 600). Returns a viem account; the key never leaves this function's scope in printable form. */
export async function loadTestnetAccount(file = process.env.X402_TESTNET_KEY_FILE) {
  if (!file) return null;
  const st = statSync(file);
  if ((st.mode & 0o077) !== 0) throw new Error("testnet key file must be mode 600");
  const raw = readFileSync(file, "utf8").trim();
  let hex = raw.startsWith("{") ? (JSON.parse(raw).privateKey ?? JSON.parse(raw).private_key) : raw;
  hex = String(hex ?? "").trim(); if (/^[0-9a-fA-F]{64}$/.test(hex)) hex = "0x" + hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error("testnet key file: unrecognised format");
  const { privateKeyToAccount } = await import("viem/accounts");
  const acct = privateKeyToAccount(hex);
  return { address: acct.address, account: acct, toJSON: () => ({ address: acct.address }) };
}
/** Read-only JSON-RPC: chain id, ETH and USDC balance. No signing. */
export async function readBalances(cfg, address, fetchImpl = fetch) {
  const rpc = async (method, params) => { const r = await fetchImpl(cfg.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
  const chainId = parseInt(await rpc("eth_chainId", []), 16);
  if (chainId !== cfg.chainId) throw new Error(`rpc chain ${chainId} != ${cfg.chainId}`);
  const eth = BigInt(await rpc("eth_getBalance", [address, "latest"]));
  const usdc = BigInt(await rpc("eth_call", [{ to: cfg.assets.USDC.address, data: "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0") }, "latest"]));
  return { chainId, ethWei: eth, usdcAtomic: usdc };
}
