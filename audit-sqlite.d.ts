export declare class StoreUnavailableError extends Error { code: "audit_store_unavailable"; cause?: unknown }
export interface AuditStore {
  kind: "sqlite";
  path: string;
  /** P2: true when opened with { shared: true } (multi-process, one machine). */
  shared: boolean;
  begin(): Promise<void>;
  changes(): { entries: any[]; reservations: any[]; payloads: [string, any][] };
  commit(): void;
  rollback(): void;
  load(): { entries: any[]; reservations: any[]; payloads: Map<string, any> };
  flush(state: { entries: any[]; reservations: any[]; payloads: Map<string, any> }): void;
  close(): void;
}
/** Opt-in persistent audit store. Needs node:sqlite (Node >= 22.13). Rejects with StoreUnavailableError when unsafe. */
export declare function openAuditStore(path: string, opts?: { busyTimeoutMs?: number; /** P2: multi-process mode (default false = single writer) */ shared?: boolean }): Promise<AuditStore>;
