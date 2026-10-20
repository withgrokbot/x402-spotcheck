// 1.6.0 (unreleased): network/asset presets for the audit layer. Opt-in via createAudit({ networkConfig }).
// Without networkConfig the audit layer behaves exactly as 1.5.x (baseMainnet is the implicit default).
import { caip } from "./rules.js";

const freeze = (o) => Object.freeze(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Object.freeze({ ...v, assets: Object.freeze(v.assets) })])));

/** Base mainnet + Solana mainnet USDC: the 1.5.x behaviour, made explicit. */
export const baseMainnet = freeze({
  "eip155:8453": { kind: "evm", testnet: false, settlement: "eip3009", assets: { "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6 } } },
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": { kind: "svm", testnet: false, settlement: "svm", assets: { EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", decimals: 6 } } },
});
/** Base Sepolia testnet USDC (EIP-712 name "USDC", version "2"). */
export const baseSepolia = freeze({
  "eip155:84532": { kind: "evm", testnet: true, settlement: "eip3009", assets: { "0x036cbd53842c5426634e7929541ec2318f3dcf7e": { symbol: "USDC", decimals: 6 } } },
});
/** Solana devnet USDC. Settlement is matched by transaction signature; set settlement: false to reject Solana reservations up front. */
export const solanaDevnet = freeze({
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": { kind: "svm", testnet: true, settlement: "svm", assets: { "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": { symbol: "USDC", decimals: 6 } } },
});
export const presets = Object.freeze({ baseMainnet, baseSepolia, solanaDevnet });

/** Merge presets/maps into one normalised config. Later entries win. */
export function networkConfig(...parts) {
  const out = {};
  for (const p of parts.flat()) {
    if (!p || typeof p !== "object") throw new TypeError("networkConfig: expected preset objects");
    for (const [net, v] of Object.entries(p)) {
      const id = caip(net);
      if (!v || (v.kind !== "evm" && v.kind !== "svm")) throw new TypeError(`networkConfig: ${net} needs kind "evm" or "svm"`);
      const assets = {};
      for (const [a, meta] of Object.entries(v.assets || {})) {
        const d = meta?.decimals;
        if (!Number.isInteger(d) || d < 0 || d > 36) throw new TypeError(`networkConfig: ${net} asset ${a} needs integer decimals`);
        assets[v.kind === "evm" ? a.toLowerCase() : a] = { symbol: String(meta.symbol || ""), decimals: d };
      }
      out[id] = { kind: v.kind, testnet: !!v.testnet, settlement: v.settlement === false ? false : v.settlement || (v.kind === "evm" ? "eip3009" : "svm"), assets };
    }
  }
  return Object.freeze(out);
}

/** Check a payment requirement against a config: { ok: true, network, asset } or { ok: false, reason }. */
export function checkNetworkAsset(cfg, network, asset) {
  const id = network ? caip(network) : "";
  const n = cfg[id];
  if (!n) return { ok: false, reason: "network_not_configured" };
  if (n.settlement === false) return { ok: false, reason: "network_unsupported_for_settlement" };
  if (!asset) return { ok: false, reason: "asset_not_configured" };
  const key = n.kind === "evm" ? String(asset).toLowerCase() : String(asset);
  const meta = n.assets[key];
  if (!meta) return { ok: false, reason: "asset_not_configured" };
  return { ok: true, network: id, asset: key, ...meta, kind: n.kind };
}
