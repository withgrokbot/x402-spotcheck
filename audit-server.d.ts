import type { AuditLayer, PolicyConfig } from "./audit.js";
export interface AuditServerOptions {
  dbPath: string;
  /** clientId -> HMAC secret */
  clients: Record<string, string | Uint8Array>;
  /** Ed25519 private key (KeyObject or PEM) used to sign every response. */
  signingKey: any;
  kid?: string; host?: string; port?: number; allowNonLoopback?: boolean;
  /** P4: verify client-reported payment-status (e.g. createEvmSettlementVerifier). Without it claims are held as unverified. */
  settlementVerifier?: (c: import("./evm-verify.js").SettlementCheck) => Promise<import("./evm-verify.js").SettlementVerdict>;
  /** P4: opt back in to trusting authenticated clients' payment-status (not recommended). */
  trustClientStatus?: boolean;
  /** P4: optional clientId -> payer address binding. */
  payers?: Record<string, string>;
  policy?: PolicyConfig; networkConfig?: any; payloadKey?: Uint8Array | string; now?: () => number;
}
export interface AuditServer {
  url: string; publicKey: Record<string, any>;
  stats: { requests: number; ok: number; refused: { auth: number; replay: number; stale: number }; verify: Record<string, number> };
  audit: AuditLayer;
  close(): Promise<void>;
}
/** Localhost-only in this phase. Needs node:sqlite (Node >= 22.13). */
export declare function startAuditServer(opts: AuditServerOptions): Promise<AuditServer>;
