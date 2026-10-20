import type { AuditLayer, PolicyConfig } from "./audit.js";
export interface AuditServerOptions {
  dbPath: string;
  /** clientId -> HMAC secret */
  clients: Record<string, string | Uint8Array>;
  /** Ed25519 private key (KeyObject or PEM) used to sign every response. */
  signingKey: any;
  kid?: string; host?: string; port?: number; allowNonLoopback?: boolean;
  policy?: PolicyConfig; networkConfig?: any; payloadKey?: Uint8Array | string; now?: () => number;
}
export interface AuditServer {
  url: string; publicKey: Record<string, any>;
  stats: { requests: number; ok: number; refused: { auth: number; replay: number; stale: number } };
  audit: AuditLayer;
  close(): Promise<void>;
}
/** Localhost-only in this phase. Needs node:sqlite (Node >= 22.13). */
export declare function startAuditServer(opts: AuditServerOptions): Promise<AuditServer>;
