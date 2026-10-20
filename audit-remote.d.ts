import type { AuditHook } from "./audit.js";
export declare const PROTOCOL: "x402-audit/1";
export declare const WINDOW_MS: number;
export declare class AuditServiceError extends Error { code: string; cause?: unknown }
export declare function requestSigningInput(r: { method: string; path: string; ts: number; nonce: string; body: string }): string;
export declare function hmac(key: string | Uint8Array, input: string): string;
export declare function safeEqual(a: string, b: string): boolean;
export declare function signEnvelope(privateKey: any, kid: string, env: Record<string, any>): Record<string, any>;
export declare function verifyEnvelope(publicKey: any, env: any): boolean;
export interface RemoteAuditOptions {
  url: string; clientId: string; clientKey: string | Uint8Array;
  /** The service's Ed25519 public key (JWK, PEM or KeyObject), pinned; never fetched. */
  servicePublicKey: any;
  timeoutMs?: number; fetch?: typeof fetch; now?: () => number; deny?: "abort" | "throw";
  idempotencyKey?: (ctx: any) => string | null | undefined;
}
export interface RemoteAudit {
  beforePayment: AuditHook;
  onPayment(info: { paymentPayload?: string; url?: string | null }): Promise<any>;
  onAfterPay(result: any, ctx?: { url?: string; paymentPayload?: string | null }): Promise<any>;
  onDecision(d: any, ctx?: any): Promise<any>;
  chain(range?: { from?: number }): Promise<{ entries: any[]; verify: { valid: boolean; seq: number; reason: string } }>;
}
export declare function remoteAudit(opts: RemoteAuditOptions): RemoteAudit;
