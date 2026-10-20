export interface AssetMeta { symbol: string; decimals: number }
export interface NetworkEntry { kind: "evm" | "svm"; testnet?: boolean; settlement?: "eip3009" | "svm" | false; assets: Record<string, AssetMeta> }
export type NetworkConfig = Readonly<Record<string, NetworkEntry>>;
export const baseMainnet: NetworkConfig;
export const baseSepolia: NetworkConfig;
export const solanaDevnet: NetworkConfig;
export const presets: Readonly<{ baseMainnet: NetworkConfig; baseSepolia: NetworkConfig; solanaDevnet: NetworkConfig }>;
export function networkConfig(...parts: (NetworkConfig | Record<string, NetworkEntry> | (NetworkConfig | Record<string, NetworkEntry>)[])[]): NetworkConfig;
export function checkNetworkAsset(cfg: NetworkConfig, network: string | null | undefined, asset: string | null | undefined):
  | ({ ok: true; network: string; asset: string; kind: "evm" | "svm" } & AssetMeta)
  | { ok: false; reason: "network_not_configured" | "asset_not_configured" | "network_unsupported_for_settlement" };
