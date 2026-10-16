export interface ApprovedPayment { scheme: string; network: string; asset: string; asset_is_usdc: boolean | null; amount_atomic: string; amount_usd: number | null; pay_to: string }
export interface SpotDecision { url: string; mode: "local" | "service" | "none"; verdict: "pay" | "skip" | "recheck" | "unavailable"; reason_code: string | null; reason: string; allowed: boolean; checked: boolean; raw?: any; fits?: (requirement: any) => Promise<string>; approved: { payment: ApprovedPayment } | { sha256: string } | null; receiptUrl: string | null }
export interface AutoPayCheckOptions {
  /** wraps a fetch with your x402 client, e.g. (f) => wrapFetchWithPayment(f, client) */
  wrapFetch: (f: (input: any, init?: any) => Promise<Response>) => (input: any, init?: any) => Promise<Response>;
  /** max USD for one check */
  maxPerCheck: number;
  /** max USD per UTC day (this instance, plus spendStore if given) */
  dailyCap: number;
  /** max fee / target price, (0, 0.25], default 0.25 */
  maxFraction?: number;
  /** optional persistence of the daily total, in USDC atomic units */
  spendStore?: { get(day: string): number | Promise<number>; add(day: string, atomic: number): void | Promise<void> };
}
export declare const CHECK_FEE_TERMS: { readonly scheme: string; readonly network: string; readonly asset: string; readonly payTo: string; readonly minAtomic: number; readonly maxAtomic: number; readonly flatAtomic: number };
export declare function isDocumentedCheckFee(fee: number | string, targetQuotesAtomic: number[]): boolean;
export declare function expectedCheckFee(targetAtomic: number | string): number;
export interface SpotCheckOptions {
  /** 1.2.0, opt-in: after a PAID call times out, answers 5xx or 402 again, ask 402xAgent payment status; outcome on `.afterPay` of the response/error. Fail-open. */
  afterPay?: boolean | import("./after.js").AfterPayOptions;
  /** 1.3.0 hosted mode (opt-in): integrator key "402x_live_<id>_<secret>", sent only to 402xAgent as a Bearer token. */
  apiKey?: string;
  /** 1.3.0: optional opaque end-agent id sent with apiKey (402xAgent stores only a salted hash). */
  endUser?: string;
  /** 1.0.0: "local" (default: judge the 402 you received, no network calls) or "service" (ask 402xAgent; opt-in) */
  mode?: "local" | "service";
  /** judge Solana mainnet too (default false: non-Base requirements pass through untouched) */
  solana?: boolean;
  /** local price tolerance, fraction (default 0.01) */
  tolerance?: number;
  /** service: how long a failed check is remembered, ms (default 10000) */
  unavailableTtlMs?: number;
  /** service only, opt-in (never sent by default): your client id (gets the free daily check; first-router ids get a 1,000-check pool) */
  client?: string;
  /** a fetch that can pay 402xAgent's own x402 price, e.g. wrapFetchWithPayment(fetch, client) */
  payFetch?: (input: any, init?: any) => Promise<Response>;
  /** max USD to pay for one check (default 0.05) */
  maxCheckUsd?: number;
  /** 0.5.0, opt-in: pay 402xAgent's fee within caps when the free check is used up (off = 0.4.1 behaviour) */
  autoPayCheck?: AutoPayCheckOptions;
  /** service: what to do on verdict "recheck" (1.0.0 default "allow": unknown means pay) */
  onRecheck?: "block" | "allow";
  /** what to do when 402xAgent cannot answer (default "allow" so an outage never stops your payments) */
  onUnavailable?: "allow" | "block";
  /** your listing for this URL: the price / payTo / network you expect */
  expected?: (url: string, intent: { network: string | null; payTo: string | null; priceUsd: number | null } | null) => { price?: number; payTo?: string; network?: string } | undefined | Promise<{ price?: number; payTo?: string; network?: string } | undefined>;
  onDecision?: (d: SpotDecision) => void | Promise<void>;
  cacheTtlMs?: number;
  /** service: hard deadline for the check, ms (default 1500); on expiry onUnavailable applies */
  timeoutMs?: number;
  endpoint?: string;
  /** service only, opt-in: attribution tag (1.0.0 sends none by default) */
  ref?: string;
  fetch?: typeof fetch;
}
export declare class SpotCheckBlockedError extends Error { decision: SpotDecision; reason: string; receiptUrl: string | null }
export declare function termsString(t: any): string;
export declare function termsMismatch(requirement: any, approved: SpotDecision["approved"]): Promise<string>;
export declare function narrowRequirements(accepts: any[], approved: SpotDecision["approved"]): Promise<{ kept: any[]; reasons: string[] }>;
export declare function assertApprovedPayment(decision: SpotDecision, requirement: any): Promise<true>;
export declare const DEFAULT_ENDPOINT: string;
/** the pre-0.3.0 default (same service, still valid) */
export declare const LEGACY_ENDPOINT: string;
export declare const DEFAULT_REF: string;
export declare const VERSION: string;
export declare const DEFAULT_TIMEOUT_MS: number;
export declare const SERVICE_SKIP_CODES: readonly string[];
type BeforePaymentHook = (ctx: { paymentRequired: any; selectedRequirements: any }) => Promise<void | { abort: true; reason: string }>;
/** x402 (x402-foundation/x402) onBeforePaymentCreation hook */
export declare function spotCheckBeforePaymentHook(opts?: SpotCheckOptions & { method?: string | ((url: string) => string | Promise<string>) }): BeforePaymentHook;
export declare function composeBeforePaymentHooks(...hooks: Array<BeforePaymentHook | undefined | null>): BeforePaymentHook;
/** three.ws mcp-bridge: pass its buildSpendingCapHook; the cap runs first */
export declare function threeWsSpendingCapThenSpotCheck(buildSpendingCapHook: () => BeforePaymentHook, opts?: SpotCheckOptions): BeforePaymentHook;
export { judgeRequirement, judge402 } from "./rules.js";
export { verifyReceipt, canonicalize, receiptSigningInput, RECEIPT_KEYS_URL } from "./receipt.js";
export declare function spotCheckFetch<F extends (input: any, init?: any) => Promise<Response>>(fetchImpl?: F, opts?: SpotCheckOptions): F;
export declare function spotCheckAxios<A>(instance: A, opts?: SpotCheckOptions): A;
export declare function createSpotChecker(opts?: SpotCheckOptions): (url: string, o?: { method?: string; intent?: any; target?: { accepts: any[] } | null }) => Promise<SpotDecision>;
export declare function checkBeforePay(url: string, o?: SpotCheckOptions & { price?: number; payTo?: string; network?: string; method?: string; accepts?: any[] }): Promise<SpotDecision>;
export declare function readPaymentIntent(headerValue: string): { network: string | null; payTo: string | null; priceUsd: number | null } | null;
export { afterPay, needsAfterPay, PAYMENT_STATUS_URL, AfterPayResult, AfterPayOptions, AfterPayRef } from "./after.js";
export default spotCheckFetch;
export function checkApiKey(k: unknown): string | null;
