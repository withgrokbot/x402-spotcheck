export declare const AUDIT_VERSION: "1";
export declare const SKIPS_URL: string;
export declare const RECONCILE_AFTER_MS: number;
export declare const ESCALATE_AFTER_MS: number;
export declare const RISK_WINDOW_MS: number;

export type LedgerType = "decision" | "reserved" | "denied" | "settled" | "released" | "reconciled" | "risk_flag";
export type Resign = "never" | "allowed" | "resend" | "new_decision";
export interface LedgerEntry {
  seq: number;
  prev_hash: string;
  type: LedgerType;
  ts: string;
  agent: string | null;
  url: string | null;
  amount_usdc: string | null;
  amount_atomic: string | null;
  pay_to: string | null;
  network: string | null;
  policy_version: string | null;
  reason: string | null;
  reservation_id: string | null;
  spotcheck_receipt: string | null;
  settlement_tx: string | null;
  status_receipt: string | null;
  safe_to_resign: boolean | null;
  resign: Resign | null;
  final: boolean | null;
  observe: boolean;
  receipt_verified: boolean | null;
  flag: string | null;
  hash: string;
}
export interface SettlementAdvice { move: "settle" | "release" | "hold"; resign: Resign; reason?: string; flag?: string }
export declare function settlementAdvice(result: { status?: string; receipt_verified?: boolean; safe_to_resign?: boolean }): SettlementAdvice;

export interface Ledger {
  entries: LedgerEntry[];
  append(partial: Record<string, any>): Promise<LedgerEntry>;
  verify(): Promise<{ valid: boolean; seq: number; reason: string }>;
  exportChain(range?: { from?: number; to?: number }): { from: number; to: number; entries: LedgerEntry[]; receipts: string[]; keys_url: string };
  decision?: (d: any) => Promise<void>;
  settle?: (result: any, ctx?: any) => Promise<SettlementAdvice>;
}
export declare function createLedger(opts?: { now?: () => number }): Ledger;

export declare class BudgetExceededError extends Error { code: "budget_exhausted" }
export interface Budgets {
  remaining(budgetId: string, at?: number): bigint | null;
  reserve(budgetId: string, amount: bigint | number | string, meta?: Record<string, any>): { id: string };
  get(id: string): any;
  list(): any[];
  listOpen(): any[];
  settle(id: string, info?: { txHash?: string | null }): any;
  release(id: string, info?: { resign?: Resign; flag?: string | null; status?: string }): any;
}
export declare function createBudgets(opts?: { dailyBudgetAtomic?: bigint | number | string | null; now?: () => number }): Budgets;

export interface PolicyConfig {
  version?: string;
  perCallCeilingAtomic?: bigint | number | string | null;
  dailyBudgetAtomic?: bigint | number | string | null;
  networks?: string[];
  payToDeny?: string[];
  payToAllow?: string[] | null;
  velocity?: { max: number; windowMs?: number };
  failClosedAboveAtomic?: bigint | number | string;
  assetAllow?: string[];
  remaining?: (budgetId: string, now: number) => bigint | null;
}
export interface PolicyVerdict { allow: boolean; reason: string; budgetId?: string }
export interface Policy {
  version: string;
  evaluate(input: { agent?: string; url?: string | null; amount?: bigint | number | string | null; payTo?: string | null; network?: string | null; asset?: string | null; approved?: boolean; now?: number; budgetId?: string }): PolicyVerdict | Promise<PolicyVerdict>;
  noteAllow?(agent: string, now: number): void;
}
export declare function createPolicy(opts?: PolicyConfig): Policy;

export type AuditHook = (ctx: any) => Promise<void | { abort: true; reason: string }>;
export declare function auditPolicyHook(opts: {
  policy: Policy;
  budgets: Budgets;
  ledger: { append(partial: Record<string, any>): Promise<any> };
  mode?: "enforce" | "observe";
  agentId?: string | ((ctx: any) => string | Promise<string>);
  failClosedAboveAtomic?: bigint | number | string;
  now?: () => number;
  deny?: "abort" | "throw";
  onReserved?: (ctx: any, id: string) => void;
}): AuditHook;

export interface AuditLayer {
  version: typeof AUDIT_VERSION;
  mode: "enforce" | "observe";
  policy: Policy;
  budgets: Budgets;
  ledger: Ledger;
  risk: { features(payTo: string, opts?: { network?: string | null; asset?: string | null; now?: number }): { action: "deny" | "step_up" | "allow"; reason: string | null }; view(now?: number): { payTo: any[]; host: any[] } };
  beforePayment: AuditHook;
  /** ctx: the before-payment hook context; when given, the reservation made for that ctx is the one released on a skip. */
  onDecision(d: any, ctx?: any): Promise<void>;
  onPayment(info: { paymentPayload?: string; url?: string | null }): Promise<void>;
  onAfterPay(result: any, ctx?: { url?: string; paymentPayload?: string | null }): Promise<SettlementAdvice>;
  composeWith(spotHook: AuditHook): AuditHook;
  reconcile(): Promise<{ checked: number; escalations: any[] }>;
  ingestSkips(list?: any[]): Promise<{ added: number; error?: string; view: { payTo: any[]; host: any[] } }>;
  mayResign(id: string): boolean;
  openReservations(): any[];
  decision(d: any): Promise<void>;
  settle(result: any, ctx?: any): Promise<SettlementAdvice>;
  exportChain(range?: { from?: number; to?: number }): ReturnType<Ledger["exportChain"]>;
  verifyChain(): Promise<{ valid: boolean; seq: number; reason: string }>;
  /** The persistent store, when one was passed (x402-spotcheck/audit/sqlite). */
  store: import("./audit-sqlite.js").AuditStore | null;
  /** Flush and close the store (no-op without one). */
  close(): Promise<void>;
  exportState(): Promise<{ entries: LedgerEntry[]; payloads: Record<string, any>; reservations: any[] }>;
}
export interface AuditOptions {
  agentId?: string | ((ctx: any) => string | Promise<string>);
  mode?: "enforce" | "observe";
  policy?: Policy | PolicyConfig;
  budgets?: Budgets;
  ledger?: Ledger;
  dailyBudgetAtomic?: bigint | number | string | null;
  failClosedAboveAtomic?: bigint | number | string;
  /** Use a random 32-byte key (Uint8Array), or a string that is itself a high-entropy secret (or HKDF-derived). A string is SHA-256 hashed once, unsalted: never pass a passphrase. */
  payloadKey?: string | Uint8Array;
  /** Opt-in persistence: `await openAuditStore(path)` from x402-spotcheck/audit/sqlite (Node >= 22.13). Default: in memory. */
  store?: import("./audit-sqlite.js").AuditStore;
  publicKey?: any;
  apiKey?: string;
  now?: () => number;
  fetch?: typeof fetch;
  paymentStatusUrl?: string;
  skipsUrl?: string;
  timeoutMs?: number;
  verify?: boolean;
  deny?: "abort" | "throw";
  riskWindowMs?: number;
  assetAllow?: string[];
  onEscalate?: (rows: any[]) => void | Promise<void>;
  onUnknownKid?: (kid: string, reason?: string) => void;
}
export declare function createAudit(opts?: AuditOptions): AuditLayer;
export declare function skipReasonCode(row: { reason_code?: string; reason?: string }): string | null;
export declare function fetchSkips(opts?: { fetch?: typeof fetch; url?: string; maxPages?: number }): Promise<any[]>;

export declare class StoreUnavailableError extends Error { code: "audit_store_unavailable"; cause?: unknown }
