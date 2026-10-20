export declare class StoreUnavailableError extends Error { code: "audit_store_unavailable"; cause?: unknown }
export interface AuditStore {
  kind: "sqlite";
  path: string;
  load(): { entries: any[]; reservations: any[]; payloads: Map<string, any> };
  flush(state: { entries: any[]; reservations: any[]; payloads: Map<string, any> }): void;
  close(): void;
}
/** Opt-in persistent audit store. Needs node:sqlite (Node >= 22.13). Rejects with StoreUnavailableError when unsafe. */
export declare function openAuditStore(path: string, opts?: { busyTimeoutMs?: number }): Promise<AuditStore>;
