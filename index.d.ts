export interface ApprovedPayment { scheme: string; network: string; asset: string; asset_is_usdc: boolean | null; amount_atomic: string; amount_usd: number | null; pay_to: string }
export interface SpotDecision { url: string; verdict: "pay" | "skip" | "recheck" | "unavailable"; reason: string; allowed: boolean; checked: boolean; raw?: any; approved: { payment: ApprovedPayment } | { sha256: string } | null; receiptUrl: string | null }
export interface SpotCheckOptions {
  /** your client id (gets the free daily check; first-router ids get a 1,000-check pool) */
  client?: string;
  /** a fetch that can pay Spot-Check's own x402 price, e.g. wrapFetchWithPayment(fetch, client) */
  payFetch?: (input: any, init?: any) => Promise<Response>;
  /** max USD to pay for one check (default 0.05) */
  maxCheckUsd?: number;
  /** what to do on verdict "recheck" (default "block") */
  onRecheck?: "block" | "allow";
  /** what to do when Spot-Check cannot answer (default "allow" so an outage never stops your payments) */
  onUnavailable?: "allow" | "block";
  /** your listing for this URL: the price / payTo / network you expect */
  expected?: (url: string, intent: { network: string | null; payTo: string | null; priceUsd: number | null } | null) => { price?: number; payTo?: string; network?: string } | undefined | Promise<{ price?: number; payTo?: string; network?: string } | undefined>;
  onDecision?: (d: SpotDecision) => void | Promise<void>;
  cacheTtlMs?: number;
  timeoutMs?: number;
  endpoint?: string;
  ref?: string;
  fetch?: typeof fetch;
}
export declare class SpotCheckBlockedError extends Error { decision: SpotDecision; reason: string; receiptUrl: string | null }
export declare function termsString(t: any): string;
export declare function termsMismatch(requirement: any, approved: SpotDecision["approved"]): Promise<string>;
export declare function narrowRequirements(accepts: any[], approved: SpotDecision["approved"]): Promise<{ kept: any[]; reasons: string[] }>;
export declare function assertApprovedPayment(decision: SpotDecision, requirement: any): Promise<true>;
export declare const DEFAULT_ENDPOINT: string;
export declare function spotCheckFetch<F extends (input: any, init?: any) => Promise<Response>>(fetchImpl?: F, opts?: SpotCheckOptions): F;
export declare function spotCheckAxios<A>(instance: A, opts?: SpotCheckOptions): A;
export declare function createSpotChecker(opts?: SpotCheckOptions): (url: string, o?: { method?: string; intent?: any }) => Promise<SpotDecision>;
export declare function checkBeforePay(url: string, o?: SpotCheckOptions & { price?: number; payTo?: string; network?: string; method?: string }): Promise<SpotDecision>;
export declare function readPaymentIntent(headerValue: string): { network: string | null; payTo: string | null; priceUsd: number | null } | null;
export default spotCheckFetch;
